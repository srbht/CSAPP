import { useQuery } from '@tanstack/react-query';
import { ASSIGNMENT_ROLE_LABELS, PERMISSIONS } from '@cps/shared';
import { ArrowLeft, ArrowUpDown, FileText, GraduationCap, Hash, ListChecks, Pencil, Plus, Printer, Settings, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ConfirmDialog, EmptyState, PageHeader, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext } from '@/lib/hooks';
import type { Assignment, DivisionOverview, StudentRow } from '@/lib/types';
import { cn } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';
import { StudentsTable } from './students';

const P = PERMISSIONS;
const MY_ROLE: Record<string, string> = ASSIGNMENT_ROLE_LABELS;

// ======================================================================= all classes

export function ClassesOverviewPage() {
  const { can } = useAuth();
  const overview = useStudentsOverview();
  return (
    <>
      <PageHeader
        title="Classes"
        description="Every division with its students, class teacher and operator. Click a division to see its students."
        actions={can(P.ACADEMICS_MANAGE) && <Button variant="outline" asChild><Link to="/academics/classes"><Settings /> Add or change classes</Link></Button>}
      />
      <QueryView query={overview} empty={(d) => (d.sections.length ? null : <Card><EmptyState icon={GraduationCap} title="No divisions to show" description="You are not assigned to any division yet. The Headmaster assigns divisions in Who teaches what." /></Card>)}>
        {(d) => (
          <div className="grid gap-8">
            {d.byMedium.map((m) => (
              <section key={m.code}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-lg font-semibold">{m.name}</h2>
                  <p className="text-sm text-muted-foreground">{m.divisions} divisions · {m.students} students</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {d.sections.filter((s) => s.schoolClass.medium.code === m.code).map((s) => <DivisionCard key={s.sectionId} d={s} />)}
                </div>
              </section>
            ))}
          </div>
        )}
      </QueryView>
    </>
  );
}

function DivisionCard({ d }: { d: DivisionOverview }) {
  const fill = d.capacity ? Math.min(100, Math.round((d.students / d.capacity) * 100)) : null;
  return (
    <Link to={`/classes/${d.sectionId}`} className="group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <Card className={cn('h-full p-4 transition-colors group-hover:border-primary/50', d.myRoles.includes('CLASS_TEACHER') && 'border-primary/50 ring-1 ring-primary/20')}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">Std</p>
            <p className="text-xl font-semibold">{d.schoolClass.standard.code} <span className="text-muted-foreground">·</span> {d.name}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">{d.students}</p>
            <p className="text-xs text-muted-foreground">students</p>
          </div>
        </div>
        {fill !== null && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" title={`${d.students} of ${d.capacity} seats`}>
            <div className="h-full rounded-full bg-primary/60" style={{ width: `${fill}%` }} />
          </div>
        )}
        <p className="mt-3 truncate text-sm"><span className="text-muted-foreground">Class teacher:</span> {d.classTeacher?.name ?? <span className="text-warning">not assigned</span>}</p>
        <p className="truncate text-xs text-muted-foreground">{d.boys} male · {d.girls} female{d.operators.length ? ` · Operator ${d.operators.map((o) => o.name).join(', ')}` : ''}</p>
        {d.myRoles.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{d.myRoles.map((r) => <Badge key={r}>{r === 'CLASS_TEACHER' ? 'My class' : MY_ROLE[r]}</Badge>)}</div>}
      </Card>
    </Link>
  );
}

// ======================================================================= one division

export function DivisionPage() {
  const { sectionId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { yearId } = useWorkingContext();
  const overview = useStudentsOverview();
  const d = overview.data?.sections.find((s) => String(s.sectionId) === sectionId);
  const students = useQuery({
    queryKey: ['students', 'list', { section: sectionId, all: true, yearId }],
    queryFn: () => api.get<Page<StudentRow>>(`/students${qs({ academicYearId: yearId, sectionId, pageSize: 100 })}`),
    enabled: !!yearId,
  });
  const teachers = useQuery({
    queryKey: ['assignments', { sectionId, yearId }],
    queryFn: () => api.get<Assignment[]>(`/assignments${qs({ academicYearId: yearId, sectionId })}`),
    enabled: !!yearId && can(P.STAFF_READ),
  });
  const canEdit = can(P.STUDENTS_WRITE) && !!overview.data?.scopeAll;
  const listState = useClassList(Number(sectionId));
  const [confirm, setConfirm] = useState(false);
  const renumber = useSave(() => api.post<{ renumbered: number }>(`/sections/${sectionId}/renumber`), {
    invalidate: [['students']], success: 'Roll numbers arranged alphabetically', onSuccess: () => setConfirm(false),
  });

  if (overview.isPending) return <QueryView query={overview}>{() => null}</QueryView>;
  if (!d) return <EmptyState title="Division not found" description="It may belong to another year, or you are not assigned to it." action={<Button variant="outline" asChild><Link to="/classes">All classes</Link></Button>} />;

  const subjectTeachers = (teachers.data ?? []).filter((a) => a.role === 'SUBJECT_TEACHER');
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2 print:hidden" asChild><Link to="/classes"><ArrowLeft /> Classes</Link></Button>
      <PageHeader
        title={divisionLabel(d)}
        description={`${d.schoolClass.medium.nameEn} · ${overview.data?.year.name} · ${d.students} students (${d.boys} male, ${d.girls} female)`}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="outline" onClick={() => window.print()}><Printer /> Print class list</Button>
          {can(P.MARKS_READ) && <Button variant="outline" asChild><Link to={`/report-cards?section=${d.sectionId}`}><FileText /> Report cards</Link></Button>}
          {(can(P.STUDENTS_PROMOTE) || canEdit || d.myRoles.includes('OPERATOR')) && <Button variant="outline" asChild><Link to={`/classes/${d.sectionId}/promote`}><GraduationCap /> Promote</Link></Button>}
          {listState.data?.can.editRolls && <Button variant="outline" onClick={() => setConfirm(true)}><ArrowUpDown /> Roll numbers A–Z</Button>}
          {canEdit && <Button asChild><Link to={`/students/new?section=${d.sectionId}`}><Plus /> Admit student</Link></Button>}
        </div>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3 print:hidden">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Class teacher</p><p className="font-medium">{d.classTeacher?.name ?? '—'}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Operator (data entry)</p><p className="font-medium">{d.operators.map((o) => o.name).join(', ') || '—'}</p></Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">My role here</p>
          <p className="font-medium">{d.myRoles.length ? d.myRoles.map((r) => MY_ROLE[r]).join(', ') : overview.data?.scopeAll ? 'Whole school access' : '—'}</p>
        </Card>
      </div>

      <ClassListCard sectionId={Number(sectionId)} rows={students.data?.data ?? []} />

      {subjectTeachers.length > 0 && (
        <Card className="mb-5 p-4 print:hidden">
          <p className="mb-2 text-sm font-medium">Subject teachers</p>
          <div className="flex flex-wrap gap-2">
            {subjectTeachers.map((a) => (
              <span key={a.id} className="rounded-md border bg-muted/30 px-2.5 py-1 text-sm">
                <span className="text-muted-foreground">{a.classSubject?.subject.nameEn}:</span> {a.staff.name}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <UsersRound className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Students</h2>
          <span className="text-sm text-muted-foreground">in roll number order</span>
        </div>
        <QueryView query={students} empty={(r) => (r.data.length ? null : <EmptyState title="No students in this division yet" />)}>
          {(r) => <StudentsTable rows={byRoll(r.data)} showClass={false} onOpen={(s) => navigate(`/students/${s.id}`)} />}
        </QueryView>
      </Card>

      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} title="Arrange roll numbers alphabetically?"
        description={`All ${d.students} students of ${divisionLabel(d)} get new roll numbers 1–${d.students} in A–Z order of their full name. This is usually done once at the start of the year.`}
        confirmLabel="Arrange A–Z" loading={renumber.isPending} onConfirm={() => renumber.mutate(undefined)}
      />
    </>
  );
}

interface ClassListState {
  status: 'DRAFT' | 'READY' | 'CONFIRMED' | 'FINAL'; note: string | null; readyAt: string | null; confirmedAt: string | null; finalAt: string | null; examNosAt: string | null;
  examPrefix: string; divisions: { name: string; listStatus: string }[]; allFinal: boolean;
  can: { ready: boolean; withdraw: boolean; confirm: boolean; editRolls: boolean; finalize: boolean; sendBackToTeacher: boolean; generate: boolean };
}
const useClassList = (sectionId: number) => useQuery({ queryKey: ['class-list', sectionId], queryFn: () => api.get<ClassListState>(`/sections/${sectionId}/list`), enabled: !!sectionId });

const STEPS: { key: ClassListState['status'] | 'EXAM'; label: string }[] = [
  { key: 'DRAFT', label: 'Prepared' }, { key: 'READY', label: 'Class teacher checks' }, { key: 'CONFIRMED', label: 'Headmaster finalizes' }, { key: 'FINAL', label: 'Final' }, { key: 'EXAM', label: 'Exam Nos' },
];

/** Class list: prepared → class teacher (may change roll numbers) → confirmed → Headmaster finalizes → Generate Exam Nos. */
function ClassListCard({ sectionId, rows }: { sectionId: number; rows: StudentRow[] }) {
  const q = useClassList(sectionId);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const inv = { invalidate: [['class-list'], ['students']] as unknown[][] };
  const ready = useSave(() => api.post(`/sections/${sectionId}/list/ready`), { ...inv, success: 'Class list sent to the class teacher' });
  const back = useSave(() => api.post(`/sections/${sectionId}/list/return`, { note }), { ...inv, success: 'Class list sent back', onSuccess: () => { setReturning(false); setNote(''); } });
  const confirm = useSave(() => api.post(`/sections/${sectionId}/list/confirm`), { ...inv, success: 'Class list confirmed and sent to the Headmaster' });
  const finalize = useSave(() => api.post<{ divisionsWaiting: number }>(`/sections/${sectionId}/list/finalize`), {
    ...inv, onSuccess: (r) => toast.success(r.divisionsWaiting ? `Finalized. Exam Nos can be generated once the other division${r.divisionsWaiting > 1 ? 's are' : ' is'} final too.` : 'Finalized: Exam Nos can now be generated'),
  });
  const generate = useSave(() => api.post<{ generated: number }>(`/sections/${sectionId}/exam-nos`), { ...inv, onSuccess: (r) => toast.success(`${r.generated} Exam Nos generated`) });
  const l = q.data;
  if (!l) return null;
  const stepIdx = l.examNosAt ? 4 : ['DRAFT', 'READY', 'CONFIRMED', 'FINAL'].indexOf(l.status);
  const notFinal = l.divisions.filter((x) => x.listStatus !== 'FINAL').map((x) => x.name);
  const text = l.examNosAt
    ? `Exam Nos generated (${l.examPrefix}-001 …). Students joining later get the next number.`
    : l.status === 'DRAFT' ? 'Arrange the roll numbers (A–Z or by hand), then send the list to the class teacher.'
    : l.status === 'READY' ? 'The class teacher checks the list and may change roll numbers, then confirms. After that it cannot be changed.'
    : l.status === 'CONFIRMED' ? 'Confirmed by the class teacher and locked. Waiting for the Headmaster to finalize (or send it back to the class teacher).'
    : notFinal.length ? `Final. Exam Nos ${l.examPrefix}-001 … can be generated when division${notFinal.length > 1 ? 's' : ''} ${notFinal.join(', ')} ${notFinal.length > 1 ? 'are' : 'is'} final too.`
    : `Final. Generate the Exam Nos (${l.examPrefix}-001 …, in roll-number order).`;
  return (
    <Card className={cn('mb-5 p-4 print:hidden', l.examNosAt || l.status === 'FINAL' ? 'border-emerald-200 bg-emerald-50/70' : l.status === 'DRAFT' ? 'bg-card' : 'border-amber-300 bg-amber-50')}>
      <ol className="mb-3 flex flex-wrap items-center gap-1 text-xs">
        {STEPS.map((st, i) => (
          <li key={st.key} className="flex items-center gap-1">
            <span className={cn('rounded-full px-2 py-0.5 font-medium', i < stepIdx ? 'bg-emerald-600 text-white' : i === stepIdx ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{i + 1}. {st.label}</span>
            {i < STEPS.length - 1 && <span className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Class list</p>
          <p className="text-sm text-muted-foreground">{text}</p>
          {l.note && (l.status === 'DRAFT' || l.status === 'READY') && <p className="mt-1 text-sm text-red-800">Note: <b>{l.note}</b></p>}
        </div>
        {l.can.editRolls && <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit roll numbers</Button>}
        {l.can.ready && <Button onClick={() => ready.mutate(undefined)} loading={ready.isPending}>Send to class teacher</Button>}
        {l.can.confirm && <Button onClick={() => confirm.mutate(undefined)} loading={confirm.isPending}>Confirm class list</Button>}
        {l.can.finalize && <Button onClick={() => finalize.mutate(undefined)} loading={finalize.isPending}>Finalize</Button>}
        {l.can.generate && <Button onClick={() => generate.mutate(undefined)} loading={generate.isPending}><Hash /> Generate Exam Nos</Button>}
        {(l.can.withdraw || l.can.sendBackToTeacher) && <Button variant="outline" onClick={() => setReturning(true)}>{l.can.sendBackToTeacher ? 'Send back to class teacher' : l.can.confirm ? 'Send back' : 'Withdraw'}</Button>}
      </div>
      {returning && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Input className="min-w-64 flex-1 bg-white" placeholder="What should be corrected? (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <Button variant="destructive" loading={back.isPending} onClick={() => back.mutate(undefined)}>Send back</Button>
          <Button variant="ghost" onClick={() => setReturning(false)}>Cancel</Button>
        </div>
      )}
      {editing && <RollNumbersDialog sectionId={sectionId} rows={rows} onClose={() => setEditing(false)} />}
    </Card>
  );
}

/** Roll numbers by hand: every student needs a different number. */
function RollNumbersDialog({ sectionId, rows, onClose }: { sectionId: number; rows: StudentRow[]; onClose: () => void }) {
  const list = byRoll(rows.filter((r) => r.status === 'ACTIVE'));
  const [values, setValues] = useState<Record<number, string>>(() => Object.fromEntries(list.map((r) => [r.enrollmentId, r.rollNo ? String(r.rollNo) : ''])));
  const nums = list.map((r) => Number(values[r.enrollmentId]));
  const dup = new Set(nums.filter((n, i) => nums.indexOf(n) !== i));
  const bad = list.some((r) => { const n = Number(values[r.enrollmentId]); return !Number.isInteger(n) || n < 1 || n > 999; });
  const save = useSave(() => api.put(`/sections/${sectionId}/roll-numbers`, { items: list.map((r) => ({ enrollmentId: r.enrollmentId, rollNo: Number(values[r.enrollmentId]) })) }), {
    invalidate: [['students'], ['class-list']], success: 'Roll numbers saved', onSuccess: onClose,
  });
  const az = () => setValues(Object.fromEntries([...list].sort((a, b) => a.fullName.localeCompare(b.fullName)).map((r, i) => [r.enrollmentId, String(i + 1)])));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Edit roll numbers" description="Type each student's roll number. Numbers must be different; the list is shown in roll-number order after saving.">
        <div className="mb-2 flex justify-end"><Button type="button" size="sm" variant="outline" onClick={az}><ArrowUpDown /> Fill A–Z</Button></div>
        <div className="max-h-[55vh] overflow-y-auto rounded-lg border">
          {list.map((r) => {
            const n = Number(values[r.enrollmentId]);
            return (
              <div key={r.enrollmentId} className="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0">
                <Input aria-label={`Roll number of ${r.fullName}`} inputMode="numeric" className={cn('h-8 w-20 tabular-nums', dup.has(n) && 'border-destructive')} value={values[r.enrollmentId]}
                  onChange={(e) => setValues((v) => ({ ...v, [r.enrollmentId]: e.target.value.replace(/\D/g, '') }))} />
                <span className="min-w-0 flex-1 truncate text-sm">{r.fullName}</span>
                {dup.has(n) && <span className="text-xs text-destructive">used twice</span>}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={bad || dup.size > 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save roll numbers</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Roll-number order; students without a roll number (e.g. provisional) at the end, by name. */
function byRoll(rows: StudentRow[]) {
  return [...rows].sort((a, b) => (a.rollNo ?? 99999) - (b.rollNo ?? 99999) || a.fullName.localeCompare(b.fullName));
}

// ======================================================================= all class lists (who is it waiting for?)

type ListStep = 'PREPARE' | 'CLASS_TEACHER' | 'HEADMASTER' | 'OTHER_DIVISIONS' | 'GENERATE' | 'DONE';
interface ClassListRow {
  sectionId: number; name: string; classId: number; className: string; medium: string; students: number; classTeacher: string | null;
  listStatus: string; note: string | null; step: ListStep; mine: boolean; examNosAt: string | null; examPrefix: string;
}
const STEP_INFO: Record<ListStep, { label: string; waiting: string; action: string; tone: string }> = {
  PREPARE: { label: '1. Being prepared', waiting: 'Office / operator', action: 'Prepare', tone: 'bg-muted text-foreground' },
  CLASS_TEACHER: { label: '2. With class teacher', waiting: 'Class teacher', action: 'Check and confirm', tone: 'bg-amber-100 text-amber-900' },
  HEADMASTER: { label: '3. With Headmaster', waiting: 'Headmaster', action: 'Finalize', tone: 'bg-orange-100 text-orange-900' },
  OTHER_DIVISIONS: { label: '4. Final', waiting: 'Other divisions of the class', action: 'Open', tone: 'bg-teal-100 text-teal-900' },
  GENERATE: { label: '4. Final', waiting: 'Generate Exam Nos (Headmaster / office)', action: 'Generate Exam Nos', tone: 'bg-indigo-100 text-indigo-900' },
  DONE: { label: '5. Exam Nos generated', waiting: '—', action: 'Open', tone: 'bg-emerald-100 text-emerald-900' },
};
const STEP_ORDER: ListStep[] = ['PREPARE', 'CLASS_TEACHER', 'HEADMASTER', 'GENERATE', 'OTHER_DIVISIONS', 'DONE'];

/** Every division's class list, with whose turn it is; "Waiting for me" shows exactly the lists this user must act on. */
export function ClassListsPage() {
  const { yearId } = useWorkingContext();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['class-lists', 'all', yearId], queryFn: () => api.get<{ year: { name: string }; rows: ClassListRow[] }>(`/class-lists${qs({ academicYearId: yearId })}`), enabled: !!yearId });
  const filter = params.get('show') ?? (params.get('mine') ? 'MINE' : 'ALL');
  const set = (v: string) => { const n = new URLSearchParams(params); n.set('show', v); n.delete('mine'); setParams(n, { replace: true }); };
  return (
    <>
      <PageHeader icon={ListChecks} title="Class lists" description="Each division's class list: prepared by the office or operator, checked by the class teacher, finalized by the Headmaster, then Exam Nos are generated." />
      <QueryView query={q}>
        {(d) => {
          const mine = d.rows.filter((r) => r.mine);
          const count = (st: ListStep) => d.rows.filter((r) => r.step === st).length;
          const rows = filter === 'MINE' ? mine : filter === 'ALL' ? d.rows : d.rows.filter((r) => r.step === filter);
          const chip = (key: string, label: string, n: number) => (
            <button key={key} onClick={() => set(key)} className={cn('rounded-full border px-3 py-1 text-sm', filter === key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted', key === 'MINE' && n > 0 && filter !== key && 'border-amber-400 bg-amber-50 font-medium')}>
              {label} <span className="tabular-nums opacity-80">({n})</span>
            </button>
          );
          return (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                {chip('MINE', 'Waiting for me', mine.length)}
                {chip('ALL', 'All divisions', d.rows.length)}
                {chip('PREPARE', 'Being prepared', count('PREPARE'))}
                {chip('CLASS_TEACHER', 'With class teacher', count('CLASS_TEACHER'))}
                {chip('HEADMASTER', 'With Headmaster', count('HEADMASTER'))}
                {chip('GENERATE', 'Ready for Exam Nos', count('GENERATE'))}
                {chip('DONE', 'Exam Nos generated', count('DONE'))}
              </div>
              <Card className="overflow-x-auto">
                {rows.length === 0 ? (
                  <EmptyState icon={ListChecks} title={filter === 'MINE' ? 'Nothing is waiting for you' : 'No divisions here'} description={filter === 'MINE' ? 'Class lists that need your action will appear here.' : undefined} />
                ) : (
                  <Table>
                    <THead><TR><TH>Class</TH><TH className="text-right">Students</TH><TH>Class teacher</TH><TH>Step</TH><TH>Waiting for</TH><TH /></TR></THead>
                    <TBody>
                      {[...rows].sort((a, b) => Number(b.mine) - Number(a.mine) || STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step)).map((r) => {
                        const info = STEP_INFO[r.step];
                        return (
                          <TR key={r.sectionId} className={cn(r.mine && 'bg-amber-50/60')}>
                            <TD className="font-medium whitespace-nowrap">{r.className} {r.name}<span className="block text-xs font-normal text-muted-foreground">{r.medium}</span></TD>
                            <TD className="text-right tabular-nums">{r.students}</TD>
                            <TD>{r.classTeacher ?? <span className="text-muted-foreground">not assigned</span>}</TD>
                            <TD>
                              <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', info.tone)}>{info.label}</span>
                              {r.note && (r.step === 'PREPARE' || r.step === 'CLASS_TEACHER') && <span className="mt-1 block text-xs text-red-800">Sent back: {r.note}</span>}
                            </TD>
                            <TD className="text-sm">{r.mine ? <b>You</b> : info.waiting}</TD>
                            <TD className="text-right">
                              <Button size="sm" variant={r.mine ? 'default' : 'outline'} asChild><Link to={`/classes/${r.sectionId}`}>{r.mine ? info.action : 'Open'}</Link></Button>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                )}
              </Card>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
