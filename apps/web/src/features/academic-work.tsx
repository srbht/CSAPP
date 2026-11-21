import { useQuery } from '@tanstack/react-query';
import { examSchema, monthLabel, monthsBetween, PERMISSIONS, PROGRESS_LABELS, type ProgressBucket } from '@cps/shared';
import { ArrowRight, BookCheck, CalendarCheck, ChevronDown, ChevronRight, ClipboardCheck, FileSpreadsheet, Inbox, Pencil, Plus, Settings } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { applyServerErrors, EmptyState, PageHeader, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext } from '@/lib/hooks';
import { cn, formatDate, formatDateTime, isoDay } from '@/lib/utils';
import { err, useZodForm } from './settings';
import { MarkSheetsPage } from './blank-sheets';
import {
  BUCKET_ORDER, BUCKET_STYLE, BucketChip, BucketLegend, type Exam, ProgressBar, sheetHref, type Summary, type SummaryDivision, useExams, useTasks,
} from './workflow-ui';

const P = PERMISSIONS;
const divLabel = (d: SummaryDivision) => `${d.schoolClass.displayName} ${d.name}`;

function useSummary(params: { recordType: 'MARKS' | 'ATTENDANCE'; examId?: number | null; period?: string | null }, enabled = true) {
  const { yearId } = useWorkingContext();
  return useQuery({
    queryKey: ['workflow', 'summary', params, yearId],
    queryFn: () => api.get<Summary>(`/workflow/summary${qs({ academicYearId: yearId, recordType: params.recordType, examId: params.examId, period: params.period })}`),
    enabled: enabled && !!yearId,
  });
}

function ExamPicker({ exams, value, onChange }: { exams: Exam[]; value: number | null; onChange: (id: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Exam">
      {exams.map((e) => (
        <button key={e.id} role="tab" aria-selected={value === e.id} onClick={() => onChange(e.id)}
          className={cn('rounded-full border px-3 py-1 text-sm transition-colors', value === e.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>
          {e.nameEn}
        </button>
      ))}
    </div>
  );
}

// ======================================================================= Exams & Marks

export function MarksPage() {
  const { can } = useAuth();
  // Operators enter marks only on the blank mark sheets the Headmaster generated.
  if (can(P.MARKS_ENTER) && !can(P.EXAMS_MANAGE) && !can(P.MARKS_VERIFY_SUBJECT) && !can(P.MARKS_VERIFY_CLASS)) return <MarkSheetsPage />;
  return <MarksOverview />;
}

function MarksOverview() {
  const { can } = useAuth();
  const exams = useExams();
  const [params, setParams] = useSearchParams();
  const examId = Number(params.get('examId')) || exams.data?.[0]?.id || null;
  const summary = useSummary({ recordType: 'MARKS', examId }, !!examId);
  const exam = exams.data?.find((e) => e.id === examId);
  return (
    <>
      <PageHeader
        title="Exams & Marks"
        description="Each coloured box is one subject of one division. Click it to enter, check or approve the marks."
        actions={can(P.EXAMS_MANAGE) && <Button variant="outline" asChild><Link to="/exams"><Settings /> Set up exams</Link></Button>}
      />
      <QueryView query={exams} empty={(e) => (e.length ? null : <Card><EmptyState icon={BookCheck} title="No exams yet" description={can(P.EXAMS_MANAGE) ? 'Add Semester I and Semester II in Set up exams.' : 'The exam coordinator has not created the exams yet.'} action={can(P.EXAMS_MANAGE) && <Button asChild><Link to="/exams"><Plus /> Set up exams</Link></Button>} /></Card>)}>
        {(list) => (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ExamPicker exams={list} value={examId} onChange={(id) => setParams({ examId: String(id) }, { replace: true })} />
              {exam?.marksDueDate && <p className="text-sm text-muted-foreground">Marks due by <b className="text-foreground">{formatDate(exam.marksDueDate)}</b></p>}
            </div>
            <BucketLegend />
            <QueryView query={summary} empty={(s) => (s.divisions.length ? null : <Card><EmptyState title="No divisions to show" description="You are not assigned to any division for this exam." /></Card>)}>
              {(s) => (
                <>
                  {s.myPending > 0 && <MyWorkBanner n={s.myPending} />}
                  <div className="grid gap-3">
                    {s.divisions.map((d) => (
                      <Card key={d.sectionId} className="p-4">
                        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h3 className="font-semibold">{divLabel(d)}</h3>
                          <span className="text-xs text-muted-foreground">{d.buckets.APPROVED}/{d.total} approved</span>
                          {d.myPending > 0 && <Badge>{d.myPending} for you</Badge>}
                          <Link to={`/marksheet?examId=${examId}&sectionId=${d.sectionId}`} className="ml-auto inline-flex items-center gap-1 text-sm text-primary hover:underline"><FileSpreadsheet className="size-4" /> Marksheet</Link>
                        </div>
                        <ProgressBar buckets={d.buckets} total={d.total} className="mb-3" />
                        <div className="flex flex-wrap gap-2">
                          {d.items.map((i) => (
                            <Link key={i.key} to={sheetHref({ recordType: 'MARKS', examId: examId!, sectionId: d.sectionId, classSubjectId: i.classSubjectId! })}
                              className={cn('rounded-lg border px-2.5 py-1.5 text-sm transition-shadow hover:shadow-sm', BUCKET_STYLE[i.bucket].chip, i.mine && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
                              title={`${i.label}: ${PROGRESS_LABELS[i.bucket]}${i.mine ? ' (your turn)' : ''}`}>
                              <span className="font-medium">{i.label}</span>
                              <span className="block text-[11px] opacity-80">{BUCKET_STYLE[i.bucket].short}{i.mine ? ' · your turn' : ''}</span>
                            </Link>
                          ))}
                        </div>
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </QueryView>
          </div>
        )}
      </QueryView>
    </>
  );
}

function MyWorkBanner({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
      <Inbox className="size-4 text-primary" />
      <span><b>{n}</b> {n === 1 ? 'sheet is' : 'sheets are'} waiting for you. They have a blue outline below.</span>
    </div>
  );
}

// ======================================================================= Attendance

export function AttendancePage() {
  const { year } = useWorkingContext();
  const months = useMemo(() => (year ? monthsBetween(year.startDate, year.endDate).filter((m) => m <= new Date().toISOString().slice(0, 7) && !m.endsWith('-05')) : []), [year]);
  const summary = useSummary({ recordType: 'ATTENDANCE' }, !!year);
  return (
    <>
      <PageHeader title="Attendance" description="Monthly attendance for every division: working days and days present per student. Click a month to enter or check it." />
      <div className="mb-3"><BucketLegend /></div>
      <QueryView query={summary} empty={(s) => (s.divisions.length ? null : <Card><EmptyState icon={CalendarCheck} title="No divisions to show" /></Card>)}>
        {(s) => (
          <>
            {s.myPending > 0 && <div className="mb-3"><MyWorkBanner n={s.myPending} /></div>}
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <tr><th className="sticky left-0 bg-muted/40 px-3 py-2">Division</th>{months.map((m) => <th key={m} className="px-2 py-2 text-center whitespace-nowrap">{monthLabel(m)}</th>)}</tr>
                </thead>
                <tbody>
                  {s.divisions.map((d) => (
                    <tr key={d.sectionId} className="border-b last:border-0">
                      <td className="sticky left-0 bg-card px-3 py-2 font-medium whitespace-nowrap">{divLabel(d)}</td>
                      {months.map((m) => {
                        const it = d.items.find((i) => i.period === m);
                        if (!it) return <td key={m} />;
                        return (
                          <td key={m} className="px-1.5 py-1.5 text-center">
                            <Link to={sheetHref({ recordType: 'ATTENDANCE', sectionId: d.sectionId, period: m })} title={`${PROGRESS_LABELS[it.bucket]}${it.mine ? ' (your turn)' : ''}`}
                              className={cn('inline-block w-full min-w-20 rounded-md border px-1.5 py-1 text-[11px] font-medium', BUCKET_STYLE[it.bucket].chip, it.mine && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}>
                              {BUCKET_STYLE[it.bucket].short}
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </QueryView>
    </>
  );
}

// ======================================================================= Approvals overview

type Group = { key: string; label: string; medium: string; divisions: SummaryDivision[]; total: number; buckets: Record<ProgressBucket, number>; myPending: number };
function groupByStandard(divs: SummaryDivision[]): Group[] {
  const map = new Map<string, Group>();
  for (const d of divs) {
    const key = `${d.schoolClass.medium.code}:${d.schoolClass.standard.code}`;
    const g = map.get(key) ?? { key, label: `Std ${d.schoolClass.standard.code}`, medium: d.schoolClass.medium.nameEn, divisions: [], total: 0, buckets: Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0])) as Record<ProgressBucket, number>, myPending: 0 };
    g.divisions.push(d);
    g.total += d.total;
    g.myPending += d.myPending;
    for (const b of BUCKET_ORDER) g.buckets[b] += d.buckets[b];
    map.set(key, g);
  }
  return [...map.values()];
}

export function ApprovalsPage() {
  const exams = useExams();
  const tasks = useTasks();
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') === 'ATTENDANCE' ? 'ATTENDANCE' : 'MARKS') as 'MARKS' | 'ATTENDANCE';
  const examId = Number(params.get('examId')) || exams.data?.[0]?.id || null;
  const summary = useSummary({ recordType: type, examId: type === 'MARKS' ? examId : null }, type === 'ATTENDANCE' || !!examId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n, { replace: true }); };
  const waiting = (t: 'MARKS' | 'ATTENDANCE') => tasks.data?.items.filter((x) => x.recordType === t).length ?? 0;

  return (
    <>
      <PageHeader title="Approvals" description="How many sheets are waiting at each step, for every standard you can see. Pending = not yet approved by the Headmaster." />

      <Tabs value={type} onValueChange={(v) => set('type', v)} className="mb-4">
        <TabsList>
          <TabsTrigger value="MARKS">Marks{waiting('MARKS') ? ` (${waiting('MARKS')})` : ''}</TabsTrigger>
          <TabsTrigger value="ATTENDANCE">Attendance{waiting('ATTENDANCE') ? ` (${waiting('ATTENDANCE')})` : ''}</TabsTrigger>
        </TabsList>
      </Tabs>

      <MyTasks tasks={tasks.data} recordType={type} />
      {type === 'MARKS' && exams.data && <div className="mt-3"><ExamPicker exams={exams.data} value={examId} onChange={(id) => set('examId', String(id))} /></div>}

      <QueryView query={summary}>
        {(s) => {
          const groups = groupByStandard(s.divisions);
          const t = s.totals;
          const total = BUCKET_ORDER.reduce((n, b) => n + t[b], 0);
          const pending = total - t.APPROVED;
          return (
            <div className="mt-4 grid gap-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <BigStat label="Approved" value={t.APPROVED} total={total} tone="ok" />
                <BigStat label="Pending approval" value={pending} total={total} tone="warn" />
                <BigStat label="Waiting for teachers" value={t.SUBJECT_VERIFY + t.CLASS_APPROVE} total={total} sub={`${t.SUBJECT_VERIFY} subject · ${t.CLASS_APPROVE} class`} />
                <BigStat label="Waiting for Headmaster" value={t.HEADMASTER_APPROVE} total={total} sub={t.CORRECTION ? `${t.CORRECTION} sent back for correction` : undefined} />
              </div>
              <BucketLegend />
              <Card className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Standard</TH>
                      {BUCKET_ORDER.map((b) => <TH key={b} className="text-center whitespace-nowrap">{BUCKET_STYLE[b].short}</TH>)}
                      <TH className="w-40">Progress</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {groups.map((g) => {
                      const isOpen = open.has(g.key);
                      return (
                        <Fragment key={g.key}>
                          <TR className="cursor-pointer" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}>
                            <TD className="font-medium whitespace-nowrap">
                              {isOpen ? <ChevronDown className="mr-1 inline size-4" /> : <ChevronRight className="mr-1 inline size-4" />}
                              {g.label} <span className="font-normal text-muted-foreground">· {g.medium}</span>
                              {g.myPending > 0 && <Badge className="ml-2">{g.myPending} for you</Badge>}
                            </TD>
                            {BUCKET_ORDER.map((b) => <TD key={b} className="text-center tabular-nums">{g.buckets[b] ? <span className={cn('inline-block min-w-7 rounded px-1.5 py-0.5 text-xs font-semibold', BUCKET_STYLE[b].chip)}>{g.buckets[b]}</span> : <span className="text-muted-foreground/50">·</span>}</TD>)}
                            <TD><ProgressBar buckets={g.buckets} total={g.total} /></TD>
                          </TR>
                          {isOpen && g.divisions.map((d) => (
                            <TR key={d.sectionId} className="bg-muted/20">
                              <TD className="pl-9">
                                <Link to={type === 'MARKS' ? `/marks?examId=${examId}` : '/attendance'} className="text-primary hover:underline">Division {d.name}</Link>
                                <span className="ml-2 text-xs text-muted-foreground">{d.items.filter((i) => i.bucket !== 'APPROVED' && i.bucket !== 'NOT_STARTED').slice(0, 3).map((i) => `${i.label}: ${BUCKET_STYLE[i.bucket].short}`).join(' · ')}</span>
                              </TD>
                              {BUCKET_ORDER.map((b) => <TD key={b} className="text-center text-xs tabular-nums">{d.buckets[b] || <span className="text-muted-foreground/50">·</span>}</TD>)}
                              <TD><ProgressBar buckets={d.buckets} total={d.total} /></TD>
                            </TR>
                          ))}
                        </Fragment>
                      );
                    })}
                  </TBody>
                </Table>
              </Card>
              <p className="text-xs text-muted-foreground">{type === 'MARKS' ? 'Each count is one subject of one division.' : 'Each count is one month of one division, up to this month.'} {s.scopeAll ? 'You see the whole school.' : 'You see only the divisions you are assigned to.'}</p>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

function BigStat({ label, value, total, sub, tone }: { label: string; value: number; total: number; sub?: string; tone?: 'ok' | 'warn' }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-3xl font-semibold tabular-nums', tone === 'ok' && 'text-emerald-600 dark:text-emerald-400', tone === 'warn' && value > 0 && 'text-amber-600 dark:text-amber-400')}>{value}</p>
      <p className="text-xs text-muted-foreground">{sub ?? `of ${total}`}</p>
    </Card>
  );
}

const STAGE_WORD: Record<string, string> = { SUBJECT_VERIFY: 'Verify', CLASS_APPROVE: 'Approve (class teacher)', HEADMASTER_APPROVE: 'Final approval' };
/** Sheets waiting for this user; on the Approvals page only the chosen kind (marks or attendance). */
export function MyTasks({ tasks: allTasks, compact, recordType }: { tasks?: ReturnType<typeof useTasks>['data']; compact?: boolean; recordType?: 'MARKS' | 'ATTENDANCE' }) {
  const [all, setAll] = useState(false);
  if (!allTasks) return null;
  const list = recordType ? allTasks.items.filter((t) => t.recordType === recordType) : allTasks.items;
  const tasks = recordType
    ? { items: list, review: list.filter((t) => t.status !== 'CORRECTION_REQUIRED').length, corrections: list.filter((t) => t.status === 'CORRECTION_REQUIRED').length }
    : allTasks;
  const kind = recordType === 'MARKS' ? 'marks' : recordType === 'ATTENDANCE' ? 'attendance' : '';
  if (!tasks.items.length) {
    return compact ? null : <Card className="mb-5 flex items-center gap-2 p-4 text-sm text-muted-foreground"><ClipboardCheck className="size-4 text-emerald-600" /> No {kind || 'sheets'} waiting for you right now.</Card>;
  }
  const limit = compact ? 6 : 8;
  const items = all ? tasks.items : tasks.items.slice(0, limit);
  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Inbox className="size-4 text-primary" />
        <h2 className="font-semibold">Waiting for you{recordType ? ` · ${recordType === 'MARKS' ? 'Marks' : 'Attendance'}` : ''}</h2>
        {tasks.review > 0 && <Badge>{tasks.review} to check</Badge>}
        {tasks.corrections > 0 && <Badge variant="destructive">{tasks.corrections} to correct</Badge>}
        {compact && <Link to="/approvals" className="ml-auto text-sm text-primary hover:underline">See all</Link>}
      </div>
      <ul className="divide-y">
        {items.map((t) => (
          <li key={t.submissionId}>
            <Link to={sheetHref(t.unit)} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40">
              {t.status === 'CORRECTION_REQUIRED' ? <BucketChip bucket="CORRECTION" label="Correct" /> : <BucketChip bucket={t.stage as ProgressBucket} label={STAGE_WORD[t.stage] ?? t.stage} />}
              <span className="min-w-0 flex-1 truncate">
                <b>{t.section.schoolClass.displayName} {t.section.name}</b> · {t.recordType === 'MARKS' ? `${t.exam?.nameEn} · ${t.subject}` : `Attendance ${monthLabel(t.period!)}`}
              </span>
              <span className="hidden text-xs text-muted-foreground sm:inline">{formatDateTime(t.since)}</span>
              <ArrowRight className="size-4 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
      {!compact && tasks.items.length > limit && (
        <button className="w-full border-t px-4 py-2 text-sm text-primary hover:bg-muted/40" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${tasks.items.length}`}
        </button>
      )}
    </Card>
  );
}

// ======================================================================= Exam setup (exam coordinator / Headmaster)

export function ExamsSetupPage() {
  const { can } = useAuth();
  const exams = useExams();
  const [dlg, setDlg] = useState<Exam | 'new' | null>(null);
  const terms = new Set(exams.data?.map((e) => e.reportTerm));
  const canAdd = can(P.EXAMS_MANAGE) && !(terms.has('TERM1') && terms.has('TERM2'));
  return (
    <>
      <PageHeader
        title="Set up exams"
        description="As on the Greensheet: Semester I (Formative Evaluation I + Summative Evaluation I) and Semester II (FE-II + SE-II). Each class gets its mark pattern automatically."
        actions={<>
          <Button variant="outline" asChild><Link to="/exams/pattern"><Settings /> Mark pattern</Link></Button>
          {canAdd && <Button onClick={() => setDlg('new')}><Plus /> Add semester</Button>}
        </>}
      />
      <QueryView query={exams} empty={(e) => (e.length ? null : <Card><EmptyState icon={BookCheck} title="No exams yet" description="Add Semester I and Semester II. The mark pattern of every class (OBS, Oral, Activity … Written, Oral) is filled in from the school's Greensheet." action={canAdd && <Button onClick={() => setDlg('new')}><Plus /> Add semester</Button>} /></Card>)}>
        {(list) => (
          <Card>
            <Table>
              <THead><TR><TH>Exam</TH><TH>Holds</TH><TH>Report card</TH><TH>Marks due</TH><TH>Subjects</TH><TH /></TR></THead>
              <TBody>
                {list.map((e) => (
                  <TR key={e.id}>
                    <TD><span className="font-medium">{e.nameEn}</span> <span className="font-mono text-xs text-muted-foreground">{e.code}</span></TD>
                    <TD>{e.reportTerm === 'TERM2' ? 'FE-II + SE-II' : 'FE-I + SE-I'}</TD>
                    <TD>{e.reportTerm === 'TERM1' ? 'Semester I card' : 'Final card and Greensheet'}</TD>
                    <TD>{formatDate(e.marksDueDate)}</TD>
                    <TD className="tabular-nums">{e.subjectCount}</TD>
                    <TD className="text-right whitespace-nowrap">
                      {can(P.EXAMS_MANAGE) && <Button size="sm" variant="ghost" onClick={() => setDlg(e)} aria-label={`Edit ${e.nameEn}`}><Pencil /></Button>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        )}
      </QueryView>
      {dlg && <ExamDialog exam={dlg === 'new' ? null : dlg} taken={terms} onClose={() => setDlg(null)} />}
    </>
  );
}

function ExamDialog({ exam, taken, onClose }: { exam: Exam | null; taken: Set<string | null>; onClose: () => void }) {
  const firstFree = taken.has('TERM1') ? 'TERM2' : 'TERM1';
  const term = (exam?.reportTerm as 'TERM1' | 'TERM2') ?? firstFree;
  const form = useZodForm(examSchema, {
    code: exam?.code ?? (term === 'TERM1' ? 'SEM1' : 'SEM2'), nameEn: exam?.nameEn ?? (term === 'TERM1' ? 'Semester I' : 'Semester II'), kind: 'SEMESTER',
    reportTerm: term, sequence: exam?.sequence ?? (term === 'TERM1' ? 1 : 2), marksDueDate: isoDay(exam?.marksDueDate),
  });
  const save = useSave((v: z.output<typeof examSchema>) => (exam ? api.patch(`/exams/${exam.id}`, v) : api.post('/exams', v)), {
    invalidate: [['exams'], ['workflow']], success: 'Exam saved', onSuccess: onClose, onError: (e) => applyServerErrors(e, form.setError, Object.keys(examSchema.shape)),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={exam ? `Edit ${exam.nameEn}` : 'Add semester'} description={exam ? undefined : 'Every class subject gets its Greensheet mark pattern. You can change it in Mark pattern.'}>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Semester" htmlFor="rt" required error={err(e.reportTerm)} className="sm:col-span-2">
            <Select id="rt" disabled={!!exam} {...form.register('reportTerm', { onChange: (ev) => { const t2 = ev.target.value === 'TERM2'; form.setValue('nameEn', t2 ? 'Semester II' : 'Semester I'); form.setValue('code', t2 ? 'SEM2' : 'SEM1'); form.setValue('sequence', t2 ? 2 : 1); } })}>
              <option value="TERM1" disabled={!exam && taken.has('TERM1')}>Semester I: Formative Evaluation I + Summative Evaluation I</option>
              <option value="TERM2" disabled={!exam && taken.has('TERM2')}>Semester II: Formative Evaluation II + Summative Evaluation II (final)</option>
            </Select>
          </Field>
          <Field label="Name" htmlFor="en" required error={err(e.nameEn)}><Input id="en" {...form.register('nameEn')} /></Field>
          <Field label="Short code" htmlFor="ec" required error={err(e.code)}><Input id="ec" {...form.register('code')} /></Field>
          <Field label="Marks due by" htmlFor="md" error={err(e.marksDueDate)}><Input id="md" type="date" {...form.register('marksDueDate')} /></Field>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
