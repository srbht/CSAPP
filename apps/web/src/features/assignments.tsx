import { useQuery } from '@tanstack/react-query';
import { ASSIGNMENT_ROLE_LABELS, PERMISSIONS } from '@cps/shared';
import { History, Plus, Repeat2, UserMinus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog, EmptyState, PageHeader, QueryView, Section, StatusBadge, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { api, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext } from '@/lib/hooks';
import type { Assignment, ClassSubject, Staff } from '@/lib/types';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { MediumFilter, useClasses } from './academics';

const P = PERMISSIONS;
type Role = Assignment['role'];
const INVALIDATE = [['assignments'], ['classes'], ['dashboard'], ['me']];

const useActiveStaff = () => useQuery({ queryKey: ['staff', 'active-all'], queryFn: () => api.get<Page<Staff>>('/staff?status=ACTIVE&pageSize=100&sort=name') });

/**
 * Headmaster's Academic Assignment Management (docs/07 §2):
 * operators, subject teachers, class teachers, attendance verifiers, and the change history.
 */
export function AssignmentsPage() {
  const { can } = useAuth();
  const canEdit = can(P.ASSIGNMENTS_MANAGE);
  const ctx = useWorkingContext();
  const [mediumId, setMediumId] = useState<number | ''>(ctx.mediumId ?? '');
  return (
    <>
      <PageHeader
        title="Academic Assignments"
        description={`${ctx.year?.name ?? ''} · Operators enter data → Subject teachers verify → Class teachers approve → Headmaster gives final approval.`}
        actions={<MediumFilter value={mediumId} onChange={setMediumId} />}
      />
      <Tabs defaultValue="teachers">
        <TabsList className="flex-wrap">
          <TabsTrigger value="teachers">Subject & class teachers</TabsTrigger>
          <TabsTrigger value="operators">Operators</TabsTrigger>
          <TabsTrigger value="history"><History className="mr-1 size-3.5" /> History</TabsTrigger>
        </TabsList>
        <TabsContent value="teachers"><TeacherMatrix yearId={ctx.yearId} mediumId={mediumId} canEdit={canEdit} /></TabsContent>
        <TabsContent value="operators"><OperatorsTab yearId={ctx.yearId} mediumId={mediumId} canEdit={canEdit} /></TabsContent>
        <TabsContent value="history"><HistoryTab yearId={ctx.yearId} /></TabsContent>
      </Tabs>
    </>
  );
}

// ------------------------------------------------------------------ matrix: subject teachers, class teacher, attendance verifier
function TeacherMatrix({ yearId, mediumId, canEdit }: { yearId: number | null; mediumId: number | ''; canEdit: boolean }) {
  const classes = useClasses(yearId, mediumId);
  const [classId, setClassId] = useState<number | ''>('');
  useEffect(() => {
    if (classes.data && !classes.data.some((c) => c.id === classId)) setClassId(classes.data[0]?.id ?? '');
  }, [classes.data, classId]);
  const cls = classes.data?.find((c) => c.id === classId);
  const subjects = useQuery({ queryKey: ['class-subjects', String(classId)], queryFn: () => api.get<ClassSubject[]>(`/classes/${classId}/subjects`), enabled: !!classId });
  const assignments = useQuery({ queryKey: ['assignments', yearId, 'class', classId], queryFn: () => api.get<Assignment[]>(`/assignments${qs({ academicYearId: yearId, classId })}`), enabled: !!classId && !!yearId });
  const staff = useActiveStaff();
  const divisions = (cls?.sections ?? []).filter((s) => s.status === 'ACTIVE');
  const activeSubjects = (subjects.data ?? []).filter((s) => s.status === 'ACTIVE').sort((a, b) => a.displayOrder - b.displayOrder);

  // Changing a person uses "replace" so history records the hand-over; empty choice ends the assignment.
  const change = useSave(async (v: { role: Role; sectionId: number; classSubjectId?: number; staffId: number | null; current?: Assignment }) => {
    if (v.current && v.staffId) return api.post(`/assignments/${v.current.id}/replace`, { staffId: v.staffId, reason: 'Changed in assignment matrix' });
    if (v.current) return api.post(`/assignments/${v.current.id}/end`, {});
    return api.post('/assignments', { academicYearId: yearId, staffId: v.staffId, role: v.role, sectionId: v.sectionId, classSubjectId: v.classSubjectId ?? null });
  }, { invalidate: INVALIDATE, success: 'Assignment updated' });

  const find = (sectionId: number, role: Role, classSubjectId?: number) =>
    assignments.data?.find((a) => a.sectionId === sectionId && a.role === role && (classSubjectId === undefined || a.classSubjectId === classSubjectId));
  const people = staff.data?.data ?? [];

  const cell = (d: { id: number; name: string }, role: Role, label: string, classSubjectId?: number) => {
    const cur = find(d.id, role, classSubjectId);
    return (
      <TD key={d.id}>
        <Select
          aria-label={`${label} — division ${d.name}`}
          className={cn('h-8 text-xs', !cur && 'text-muted-foreground')}
          value={cur?.staffId ?? ''}
          disabled={!canEdit || change.isPending}
          onChange={(e) => change.mutate({ role, sectionId: d.id, classSubjectId, staffId: e.target.value ? Number(e.target.value) : null, current: cur })}
        >
          <option value="">— Not assigned —</option>
          {people.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </TD>
    );
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Class" className="w-48" value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}>
          {classes.data?.length === 0 && <option value="">No classes</option>}
          {classes.data?.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
        </Select>
        {staff.isSuccess && people.length === 0 && <span className="text-sm">No active staff yet — <Link className="text-primary underline" to="/staff">add staff</Link>.</span>}
      </div>
      {!cls ? (
        <QueryView query={classes} empty={() => <Card><EmptyState title="No class selected" description="Create classes first." /></Card>}>{() => null}</QueryView>
      ) : divisions.length === 0 ? (
        <Card><EmptyState title={`${cls.displayName} has no divisions`} action={<Button asChild variant="outline"><Link to="/academics/classes">Add divisions</Link></Button>} /></Card>
      ) : (
        <Section title={cls.displayName} description={change.isPending ? 'Saving…' : 'One class teacher per division. Each subject teacher verifies only their subject.'}>
          <QueryView query={assignments}>
            {() => (
              <Table>
                <THead><TR><TH className="min-w-48">Responsibility</TH>{divisions.map((d) => <TH key={d.id} className="min-w-52">Division {d.name}</TH>)}</TR></THead>
                <TBody>
                  <TR className="bg-accent/30"><TD className="font-semibold">Class teacher</TD>{divisions.map((d) => cell(d, 'CLASS_TEACHER', 'Class teacher'))}</TR>
                  <TR className="bg-accent/15"><TD className="font-medium">Attendance verifier <span className="block text-xs font-normal text-muted-foreground">optional; else class teacher</span></TD>{divisions.map((d) => cell(d, 'ATTENDANCE_VERIFIER', 'Attendance verifier'))}</TR>
                  {activeSubjects.length === 0 && (
                    <TR><TD colSpan={divisions.length + 1} className="text-muted-foreground">No subjects in this class. <Link className="text-primary underline" to={`/academics/classes/${cls.id}/subjects`}>Add subjects</Link>.</TD></TR>
                  )}
                  {activeSubjects.map((cs) => (
                    <TR key={cs.id}>
                      <TD className={cn(cs.subject.parentSubjectId && 'pl-6')}>{cs.subject.nameEn}</TD>
                      {divisions.map((d) => cell(d, 'SUBJECT_TEACHER', `${cs.subject.nameEn} teacher`, cs.id))}
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </QueryView>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ operators
function OperatorsTab({ yearId, mediumId, canEdit }: { yearId: number | null; mediumId: number | ''; canEdit: boolean }) {
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const list = useQuery({
    queryKey: ['assignments', yearId, 'operators', mediumId, status],
    queryFn: () => api.get<Assignment[]>(`/assignments${qs({ academicYearId: yearId, role: 'OPERATOR', mediumId, includeEnded: status === 'all' })}`),
    enabled: !!yearId,
  });
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<Assignment | null>(null);
  const [ending, setEnding] = useState<Assignment | null>(null);
  const end = useSave((a: Assignment) => api.post(`/assignments/${a.id}/end`, {}), { invalidate: INVALIDATE, success: 'Operator removed from division', onSuccess: () => setEnding(null) });

  return (
    <Section
      title="Operators"
      description="Operators enter marks, attendance and student academic data for their divisions only. A division may have several operators; an operator may cover several divisions."
      actions={<div className="flex gap-2">
        <Select aria-label="Show" className="h-8 w-32 text-xs" value={status} onChange={(e) => setStatus(e.target.value as 'active')}><option value="active">Active</option><option value="all">Include ended</option></Select>
        {canEdit && <Button size="sm" onClick={() => setAdding(true)}><Plus /> Assign operator</Button>}
      </div>}
    >
      <QueryView query={list} empty={(d) => (d.length ? null : <EmptyState icon={Users} title="No operators assigned" description="Create staff with an Operator login, then assign them to divisions." />)}>
        {(rows) => (
          <Table>
            <THead><TR><TH>Operator</TH><TH>Medium</TH><TH>Class</TH><TH>Division</TH><TH>From</TH><TH>Status</TH>{canEdit && <TH />}</TR></THead>
            <TBody>
              {rows.map((a) => (
                <TR key={a.id} className={cn(a.status !== 'ACTIVE' && 'text-muted-foreground')}>
                  <TD className="font-medium">{a.staff.name}</TD>
                  <TD><Badge variant="secondary">{a.section.schoolClass.medium.code}</Badge></TD>
                  <TD>{a.section.schoolClass.displayName}</TD>
                  <TD>{a.section.name}</TD>
                  <TD>{formatDate(a.validFrom)}{a.validTo ? ` – ${formatDate(a.validTo)}` : ''}</TD>
                  <TD><StatusBadge status={a.status} /></TD>
                  {canEdit && (
                    <TD>
                      {a.status === 'ACTIVE' && (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setReplacing(a)}><Repeat2 /> Replace</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEnding(a)} aria-label="Remove"><UserMinus /></Button>
                        </div>
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </QueryView>
      {adding && yearId && <AddOperatorDialog yearId={yearId} mediumId={mediumId} onClose={() => setAdding(false)} />}
      {replacing && <ReplaceDialog assignment={replacing} onClose={() => setReplacing(null)} />}
      {ending && (
        <ConfirmDialog open onOpenChange={(o) => !o && setEnding(null)} destructive confirmLabel="Remove"
          title={`Remove ${ending.staff.name} from ${ending.section.schoolClass.displayName}-${ending.section.name}?`}
          description="The assignment ends today and stays in history. Records they already entered keep their name."
          loading={end.isPending} onConfirm={() => end.mutate(ending)} />
      )}
    </Section>
  );
}

function AddOperatorDialog({ yearId, mediumId, onClose }: { yearId: number; mediumId: number | ''; onClose: () => void }) {
  const staff = useActiveStaff();
  const classes = useClasses(yearId, mediumId);
  const [staffId, setStaffId] = useState<number | ''>('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<string[]>([]);
  const save = useSave(async () => {
    const out: string[] = [];
    for (const sectionId of picked) {
      try {
        await api.post('/assignments', { academicYearId: yearId, staffId, role: 'OPERATOR', sectionId });
      } catch (e) {
        out.push(e instanceof Error ? e.message : 'Failed');
      }
    }
    setResults(out);
    if (!out.length) onClose();
  }, { invalidate: INVALIDATE, success: undefined });
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Assign operator" description="Pick the person and every division they will enter data for." wide>
        <Field label="Operator" htmlFor="op" required hint="The person also needs a login with the Operator role (Users).">
          <Select id="op" value={staffId} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Choose…</option>{staff.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.employeeCode})</option>)}
          </Select>
        </Field>
        <div className="grid max-h-80 gap-3 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
          {classes.data?.map((c) => (
            <div key={c.id}>
              <p className="mb-1 text-sm font-medium">{c.displayName} <span className="text-xs text-muted-foreground">{c.medium.nameEn}</span></p>
              <div className="flex flex-wrap gap-3">
                {c.sections.filter((s) => s.status === 'ACTIVE').map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5 text-sm"><Checkbox checked={picked.has(s.id)} onChange={() => toggle(s.id)} /> {s.name}</label>
                ))}
                {c.sections.length === 0 && <span className="text-xs text-muted-foreground">No divisions</span>}
              </div>
            </div>
          ))}
        </div>
        {results.length > 0 && <ul className="list-inside list-disc text-sm text-destructive" role="alert">{results.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!staffId || picked.size === 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>Assign to {picked.size} division{picked.size === 1 ? '' : 's'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceDialog({ assignment, onClose }: { assignment: Assignment; onClose: () => void }) {
  const staff = useActiveStaff();
  const [staffId, setStaffId] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const save = useSave(() => api.post(`/assignments/${assignment.id}/replace`, { staffId, reason }), { invalidate: INVALIDATE, success: 'Assignment handed over', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Replace ${assignment.staff.name}`}
        description={`${ASSIGNMENT_ROLE_LABELS[assignment.role]} · ${assignment.section.schoolClass.displayName}-${assignment.section.name}. Past entries and approvals stay with ${assignment.staff.name}; the new person takes over from today.`}
      >
        <Field label="New person" htmlFor="np" required>
          <Select id="np" value={staffId} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Choose…</option>{staff.data?.data.filter((s) => s.id !== assignment.staffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Reason" htmlFor="rs" required hint="Kept in the assignment history"><Input id="rs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. on leave until December" /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!staffId || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>Replace</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ history
interface HistoryRow { id: number; at: string; action: string; reason: string | null; by: string | null; assignment: Assignment | null }

function HistoryTab({ yearId }: { yearId: number | null }) {
  const q = useQuery({ queryKey: ['assignments', yearId, 'history'], queryFn: () => api.get<HistoryRow[]>(`/assignments/history?academicYearId=${yearId}`), enabled: !!yearId });
  return (
    <Section title="Assignment history" description="Every assignment, hand-over and removal, newest first (last 200).">
      <QueryView query={q} empty={(d) => (d.length ? null : <EmptyState title="No changes yet" />)}>
        {(rows) => (
          <Table>
            <THead><TR><TH>When</TH><TH>By</TH><TH>Change</TH><TH>Person</TH><TH>Responsibility</TH><TH>Reason</TH></TR></THead>
            <TBody>
              {rows.map((h) => (
                <TR key={h.id}>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(h.at)}</TD>
                  <TD>{h.by ?? '—'}</TD>
                  <TD><Badge variant={h.action === 'END' ? 'secondary' : 'success'}>{h.action === 'END' ? 'Ended' : 'Assigned'}</Badge></TD>
                  <TD className="font-medium">{h.assignment?.staff.name ?? '—'}</TD>
                  <TD>{h.assignment ? `${ASSIGNMENT_ROLE_LABELS[h.assignment.role]} · ${h.assignment.section.schoolClass.displayName}-${h.assignment.section.name}${h.assignment.classSubject ? ` · ${h.assignment.classSubject.subject.nameEn}` : ''}` : '—'}</TD>
                  <TD className="max-w-xs text-sm text-muted-foreground">{h.reason ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </QueryView>
    </Section>
  );
}
