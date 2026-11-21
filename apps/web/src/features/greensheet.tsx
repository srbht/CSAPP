import { useQuery } from '@tanstack/react-query';
import {
  countedMax, GREENSHEET_RESULTS, type GreensheetResult, MARK_PARTS, type MarkPart, type MarkPartKey, PATTERN_PART_KEYS, partStage, PERMISSIONS,
} from '@cps/shared';
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Copy, FileSpreadsheet, Lock, Printer, RotateCcw, Save, Wand2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, PageHeader, QueryView, useSave } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext } from '@/lib/hooks';
import type { SchoolClass } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/utils';

const P = PERMISSIONS;
const label = (k: string) => MARK_PARTS[k as MarkPartKey]?.label ?? k;

// ======================================================================= Mark pattern (Headmaster / exam coordinator)

interface PatternData {
  class: { id: number; displayName: string; medium: string; standardCode: string; year: string };
  exams: { id: number; code: string; nameEn: string; reportTerm: string | null }[];
  subjects: {
    classSubjectId: number; code: string; name: string; subjectType: string; includeInTotal: boolean; defaultParts: MarkPart[];
    exams: { examId: number; parts: MarkPart[] | null; locked: boolean; hasMarks: boolean }[];
  }[];
}
type Draft = Record<number, Record<string, { max: string; countAs: string }>>;

const toDraft = (parts: MarkPart[] | null) => Object.fromEntries((parts ?? []).map((p) => [p.key, { max: String(p.max), countAs: p.countAs ? String(p.countAs) : '' }]));
const fromDraft = (d: Record<string, { max: string; countAs: string }>): MarkPart[] =>
  Object.entries(d).filter(([, v]) => v.max.trim() !== '').map(([key, v]) => ({ key: key as MarkPartKey, max: Number(v.max), countAs: v.countAs.trim() ? Number(v.countAs) : null }));

export function MarkPatternPage() {
  const { can } = useAuth();
  const { yearId } = useWorkingContext();
  const [params, setParams] = useSearchParams();
  const classes = useQuery({ queryKey: ['classes', yearId], queryFn: () => api.get<SchoolClass[]>(`/classes${qs({ academicYearId: yearId })}`) });
  const classId = Number(params.get('classId')) || classes.data?.[0]?.id || null;
  const q = useQuery({ queryKey: ['mark-pattern', classId], queryFn: () => api.get<PatternData>(`/exams/pattern?classId=${classId}`), enabled: !!classId });
  const [examTab, setExamTab] = useState<'BOTH' | number>('BOTH');
  const [draft, setDraft] = useState<Draft>({});
  const [copyOpen, setCopyOpen] = useState(false);
  const edit = can(P.EXAMS_MANAGE);

  // "Both" shows the later semester: Semester I may still hold marks entered as two totals before the Greensheet.
  const source = (s: PatternData['subjects'][number]) => (examTab === 'BOTH' ? s.exams[s.exams.length - 1] : s.exams.find((e) => e.examId === examTab)) ?? null;
  useEffect(() => {
    if (!q.data) return;
    setDraft(Object.fromEntries(q.data.subjects.map((s) => [s.classSubjectId, toDraft(source(s)?.parts ?? null)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, examTab]);

  const save = useSave(() => api.put('/exams/pattern', {
    classId, examIds: examTab === 'BOTH' ? q.data!.exams.map((e) => e.id) : [examTab],
    items: q.data!.subjects.map((s) => ({ classSubjectId: s.classSubjectId, parts: fromDraft(draft[s.classSubjectId] ?? {}) })),
  }), {
    invalidate: [['mark-pattern'], ['sheet']],
    onSuccess: (r) => {
      const res = r as { changed: number; skipped: string[] };
      if (res.skipped.length) toast.warning(`Saved ${res.changed} change${res.changed === 1 ? '' : 's'}. Kept as they are (marks already submitted): ${res.skipped.join(', ')}`, { duration: 10000 });
      else toast.success(res.changed ? 'Mark pattern saved' : 'Nothing changed');
    },
  });

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/exams"><ArrowLeft /> Set up exams</Link></Button>
      <PageHeader title="Mark pattern" description="The parts the operator types for each subject, with their maximum marks, as on the Greensheet. Totals (A), (B), (C), (D) are always calculated." />
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="Class" htmlFor="pc">
          <Select id="pc" className="w-56" value={classId ?? ''} onChange={(e) => setParams({ classId: e.target.value })}>
            {classes.data?.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </Select>
        </Field>
        <Field label="Applies to" htmlFor="pe">
          <Select id="pe" className="w-80" value={String(examTab)} onChange={(e) => setExamTab(e.target.value === 'BOTH' ? 'BOTH' : Number(e.target.value))}>
            <option value="BOTH">Both semesters</option>
            {q.data?.exams.map((e) => <option key={e.id} value={e.id}>{e.nameEn} only</option>)}
          </Select>
        </Field>
        {edit && q.data && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDraft(Object.fromEntries(q.data.subjects.map((s) => [s.classSubjectId, toDraft(s.defaultParts)])))}><Wand2 /> School default</Button>
            <Button variant="outline" onClick={() => setCopyOpen(true)}><Copy /> Copy to other classes</Button>
            <Button loading={save.isPending} onClick={() => save.mutate(undefined)}><Save /> Save pattern</Button>
          </div>
        )}
      </Card>
      <QueryView query={q} empty={(d) => (d.exams.length ? null : <Card><EmptyState title="No semesters set up" description="Add Semester I and Semester II in Set up exams first." /></Card>)}>
        {(d) => (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr className="text-center">
                    <th />
                    <th colSpan={PATTERN_PART_KEYS.filter((k) => partStage(k) === 'FE').length + 1} className="border-x px-2 py-1.5 font-semibold text-foreground">Formative Evaluation</th>
                    <th colSpan={PATTERN_PART_KEYS.filter((k) => partStage(k) === 'SE').length + 1} className="border-x px-2 py-1.5 font-semibold text-foreground">Summative Evaluation</th>
                    <th />
                  </tr>
                  <tr>
                    <th className="px-3 py-2 text-left">Subject</th>
                    {PATTERN_PART_KEYS.filter((k) => partStage(k) === 'FE').map((k) => <th key={k} className="px-1 py-2" title={MARK_PARTS[k].long}>{label(k)}</th>)}
                    <th className="border-r px-2 py-2">Total</th>
                    {PATTERN_PART_KEYS.filter((k) => partStage(k) === 'SE').map((k) => <th key={k} className="px-1 py-2">{label(k)}</th>)}
                    <th className="border-r px-2 py-2">Total</th>
                    <th className="px-2 py-2">Out of</th>
                  </tr>
                </thead>
                <tbody>
                  {d.subjects.map((s) => {
                    const st = source(s);
                    const locked = examTab === 'BOTH' ? s.exams.every((e) => e.locked) : !!st?.locked;
                    const partlyLocked = examTab === 'BOTH' && !locked && s.exams.some((e) => e.locked);
                    const legacy = (st?.parts ?? []).some((p) => p.key === 'FE_TOTAL' || p.key === 'SE_TOTAL');
                    const row = draft[s.classSubjectId] ?? {};
                    const parts = fromDraft(row);
                    const fe = parts.filter((p) => partStage(p.key) === 'FE').reduce((t, p) => t + (countedMax(p) || 0), 0);
                    const se = parts.filter((p) => partStage(p.key) === 'SE').reduce((t, p) => t + (countedMax(p) || 0), 0);
                    const set = (k: string, v: Partial<{ max: string; countAs: string }>) => setDraft((x) => ({ ...x, [s.classSubjectId]: { ...x[s.classSubjectId], [k]: { ...{ max: '', countAs: '' }, ...x[s.classSubjectId]?.[k], ...v } } }));
                    const cell = (k: MarkPartKey) => (
                      <td key={k} className="px-1 py-1.5 text-center">
                        <Input aria-label={`${s.name} ${label(k)} maximum`} className="mx-auto h-8 w-12 px-1 text-center tabular-nums" disabled={!edit || locked} value={row[k]?.max ?? ''} placeholder="–" onChange={(e) => set(k, { max: e.target.value })} />
                        {k === 'MCQ' && row[k]?.max && <Input aria-label={`${s.name} MCQ counted out of`} title="Counted out of (MCQ Avg.)" className="mx-auto mt-1 h-7 w-12 px-1 text-center text-xs tabular-nums" disabled={!edit || locked} value={row[k]?.countAs ?? ''} placeholder="avg" onChange={(e) => set(k, { countAs: e.target.value })} />}
                      </td>
                    );
                    return (
                      <tr key={s.classSubjectId} className={cn('border-b last:border-0', locked && 'bg-muted/30')}>
                        <td className="px-3 py-1.5">
                          <span className="font-medium">{s.name}</span>
                          {!s.includeInTotal && <Badge variant="secondary" className="ml-1.5">not in total</Badge>}
                          {locked && <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> marks submitted</span>}
                          {partlyLocked && <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> {d.exams.filter((e) => s.exams.find((x) => x.examId === e.id)?.locked).map((e) => e.nameEn).join(', ')}: marks submitted, kept as is</span>}
                          {legacy && <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle className="size-3" /> entered as two totals before the Greensheet{!locked ? ': set the parts to switch' : ''}</span>}
                        </td>
                        {PATTERN_PART_KEYS.filter((k) => partStage(k) === 'FE').map(cell)}
                        <td className="border-r px-2 text-center font-medium tabular-nums">{fe || '–'}</td>
                        {PATTERN_PART_KEYS.filter((k) => partStage(k) === 'SE').map(cell)}
                        <td className="border-r px-2 text-center font-medium tabular-nums">{se || '–'}</td>
                        <td className={cn('px-2 text-center font-semibold tabular-nums', fe + se !== 100 && fe + se > 0 && 'text-amber-700 dark:text-amber-300')}>{fe + se || '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t p-3 text-xs text-muted-foreground">
              Leave a part empty when the subject does not have it. MCQ can be typed out of 40 and counted out of 10 (second box). Subjects whose marks are already submitted cannot change: the Headmaster reopens the sheet first.
              Changing a pattern while marks are being entered keeps the values of the parts that stay.
            </p>
          </Card>
        )}
      </QueryView>
      {copyOpen && q.data && <CopyPatternDialog from={q.data.class} classes={classes.data ?? []} onClose={() => setCopyOpen(false)} />}
    </>
  );
}

function CopyPatternDialog({ from, classes, onClose }: { from: PatternData['class']; classes: SchoolClass[]; onClose: () => void }) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const copy = useSave(() => api.post<{ copied: number; skipped: string[] }>('/exams/pattern/copy', { fromClassId: from.id, toClassIds: [...sel] }), {
    invalidate: [['mark-pattern']], success: 'Pattern copied', onSuccess: onClose,
  });
  const others = classes.filter((c) => c.id !== from.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Copy ${from.displayName}'s pattern`} description="Saved pattern only. Subjects are matched by code; subjects with submitted marks are skipped.">
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto">
          {others.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={sel.has(c.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} /> {c.displayName}
            </label>
          ))}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={copy.isPending} disabled={!sel.size} onClick={() => copy.mutate(undefined)}>Copy to {sel.size} class{sel.size === 1 ? '' : 'es'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Greensheet

interface SemCell { parts: Record<string, number | null>; fe: number | null; se: number | null; total: number | null; max: number; grade: string | null; absent: boolean; entered: boolean }
interface GsStudent {
  enrollmentId: number; examNo: string | null; rollNo: number | null; grNo: string; name: string; gender: string; status: string; left: boolean; absentAll: boolean;
  rows: { classSubjectId: number; sem: (SemCell | null)[]; average: number | null; averageGrade: string | null; grace: number; passed: boolean | null }[];
  semTotals: ({ fe: number; seParts: Record<string, number>; se: number; total: number; max: number; grade: string | null } | null)[];
  averageTotal: number | null; graceTotal: number; averageGrade: string | null; percentage: number | null; attendance: { present: number; working: number } | null;
  suggested: GreensheetResult | null; decision: { result: GreensheetResult | null; grace: Record<string, number>; remark: string | null } | null; result: GreensheetResult | null;
}
type Count = { boys: number; girls: number; total: number };
interface GsData {
  section: { id: number; name: string; className: string; label: string; medium: string };
  year: { id: number; name: string };
  school: { name: string; motto: string | null; address: string; logoFileId: number | null; principalTitle: string };
  classTeacher: string | null;
  status: 'DRAFT' | 'APPROVED'; approvedAt: string | null; approvedByName: string | null;
  exams: ({ id: number; name: string; reportTerm: string } | null)[];
  subjects: { classSubjectId: number; name: string; short: string; type: string; includeInTotal: boolean; patterns: (MarkPart[] | null)[] }[];
  columns: { fe: string[]; se: string[] };
  maxRows: { label: string; patterns: (MarkPart[] | null)[]; subjectIds: number[] }[];
  students: GsStudent[];
  summary: { students: Count; left: Count; absent: Count; appeared: Count; passed: Count; reExam: Count; undecided: Count; passPercent: { boys: number | null; girls: number | null; total: number | null } };
  gate: { ready: boolean; required: number; approved: number; missing: { kind: string; label: string; status: string; unit?: Record<string, unknown> }[] };
  resultLabels: Record<GreensheetResult, string>;
  can: { decide: boolean; approve: boolean; reopen: boolean };
}

export function GreensheetListPage() {
  const { yearId } = useWorkingContext();
  const q = useQuery({ queryKey: ['greensheet', 'list', yearId], queryFn: () => api.get<{ year: { name: string }; divisions: { sectionId: number; name: string; className: string; medium: string; students: number; status: string; approvedAt: string | null }[] }>(`/greensheet${qs({ academicYearId: yearId })}`) });
  return (
    <>
      <PageHeader icon={FileSpreadsheet} title="Greensheet" description="The yearly result register of each division: Year Work, Result and the two cover sheets, made from the approved marks and attendance." />
      <QueryView query={q} empty={(d) => (d.divisions.length ? null : <Card><EmptyState title="No divisions" description="You are not class teacher or operator of any division." /></Card>)}>
        {(d) => {
          const groups = [...new Set(d.divisions.map((x) => x.medium))];
          return (
            <div className="grid gap-4">
              {groups.map((m) => (
                <Card key={m} className="p-4">
                  <h2 className="mb-3 font-semibold">{m}</h2>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {d.divisions.filter((x) => x.medium === m).map((x) => (
                      <Link key={x.sectionId} to={`/greensheet/${x.sectionId}`} className="flex items-center justify-between rounded-lg border p-3 hover:border-primary hover:bg-primary/5">
                        <span><span className="font-medium">{x.className} {x.name}</span><span className="block text-xs text-muted-foreground">{x.students} students</span></span>
                        {x.status === 'APPROVED' ? <Badge variant="success"><Lock className="size-3" /> Approved</Badge> : <Badge variant="secondary">Draft</Badge>}
                      </Link>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

type DecisionDraft = Record<number, { result: GreensheetResult | ''; grace: Record<string, string>; remark: string }>;

export function GreensheetPage() {
  const { sectionId } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['greensheet', sectionId], queryFn: () => api.get<GsData>(`/greensheet/${sectionId}`) });
  const [draft, setDraft] = useState<DecisionDraft>({});
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [graceFor, setGraceFor] = useState<GsStudent | null>(null);
  const [reopen, setReopen] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setDraft(Object.fromEntries(q.data.students.map((s) => [s.enrollmentId, {
      result: s.decision?.result ?? '', grace: Object.fromEntries(Object.entries(s.decision?.grace ?? {}).map(([k, v]) => [k, String(v)])), remark: s.decision?.remark ?? '',
    }])));
    setDirty(false);
  }, [q.data]);
  const items = () => Object.entries(draft).map(([id, v]) => ({
    enrollmentId: Number(id), result: v.result || null, remark: v.remark || null,
    grace: Object.fromEntries(Object.entries(v.grace).filter(([, g]) => g.trim() !== '' && Number(g) > 0).map(([k, g]) => [k, Number(g)])),
  }));
  const saveResults = useSave(() => api.put(`/greensheet/${sectionId}/results`, { items: items() }), { invalidate: [['greensheet']], success: 'Results saved' });
  const approve = useSave(async () => { if (dirty) await api.put(`/greensheet/${sectionId}/results`, { items: items() }); return api.post(`/greensheet/${sectionId}/approve`, {}); }, { invalidate: [['greensheet']], success: 'Greensheet approved and locked' });

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2 print:hidden" asChild><Link to="/greensheet"><ArrowLeft /> Greensheet</Link></Button>
      <QueryView query={q}>
        {(d) => {
          const upd = (id: number, p: Partial<DecisionDraft[number]>) => { setDraft((x) => ({ ...x, [id]: { ...x[id], ...p } })); setDirty(true); };
          const subjectName = (id: number) => d.subjects.find((s) => s.classSubjectId === id)?.name ?? '';
          return (
            <div className="grid gap-4">
              <style>{PRINT_CSS}</style>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{d.section.medium} · {d.year.name}</p>
                  <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Greensheet · {d.section.className} {d.section.name}</h1>
                  <p className="text-sm text-muted-foreground">Class: {d.section.label}{d.classTeacher ? ` · Class teacher ${d.classTeacher}` : ''}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {d.status === 'APPROVED'
                    ? <Badge variant="success" className="text-sm"><Lock className="size-3.5" /> Approved {d.approvedByName ? `by ${d.approvedByName}` : ''} {formatDateTime(d.approvedAt)}</Badge>
                    : <Badge variant="secondary" className="text-sm">Draft</Badge>}
                  <PrintMenu onPick={(part) => navigate(`/greensheet/${sectionId}/print?part=${part}`)} />
                </div>
              </div>

              {/* Readiness */}
              <Card className={cn('p-4', d.gate.ready ? 'border-emerald-200 dark:border-emerald-900' : 'border-amber-200 dark:border-amber-900')}>
                <div className="flex flex-wrap items-center gap-3">
                  {d.gate.ready ? <CheckCircle2 className="size-5 text-emerald-600" /> : <AlertTriangle className="size-5 text-amber-600" />}
                  <p className="text-sm">
                    {d.gate.ready
                      ? <>All marks of both semesters and all attendance are <b>approved</b>. {d.status === 'APPROVED' ? 'The Greensheet is final.' : 'The Headmaster can decide the results and approve the Greensheet.'}</>
                      : <><b>{d.gate.approved} of {d.gate.required}</b> sheets approved. Until everything is approved this Greensheet is a <b>draft</b> (numbers can still change).</>}
                  </p>
                  {!d.gate.ready && <Button size="sm" variant="ghost" onClick={() => setShowMissing((x) => !x)}>{showMissing ? 'Hide' : 'Show'} what is still open</Button>}
                </div>
                {showMissing && (
                  <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
                    {d.gate.missing.slice(0, 60).map((m, i) => <li key={i} className="flex justify-between gap-2 rounded border px-2 py-1"><span>{m.label}</span><span className="text-muted-foreground">{m.status}</span></li>)}
                  </ul>
                )}
              </Card>

              <SummaryCard d={d} />

              {/* Students */}
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                  <h2 className="font-semibold">Result of each student</h2>
                  {d.can.decide && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => { setDraft((x) => Object.fromEntries(Object.entries(x).map(([id, v]) => { const s = d.students.find((y) => y.enrollmentId === Number(id)); return [id, { ...v, result: v.result || s?.suggested || '' }]; }))); setDirty(true); }}><Wand2 /> Accept suggested results</Button>
                      <Button size="sm" variant="outline" loading={saveResults.isPending} disabled={!dirty} onClick={() => saveResults.mutate(undefined)}><Save /> Save results</Button>
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="w-8" /><th className="px-2 py-2">Exam No</th><th className="px-2 py-2">Student</th><th className="px-2 py-2 text-right">Sem I %</th><th className="px-2 py-2 text-right">Sem II %</th><th className="px-2 py-2 text-right">Average</th>
                        <th className="px-2 py-2 text-right">%</th><th className="px-2 py-2">Grade</th><th className="px-2 py-2">Below pass</th><th className="px-2 py-2">Attendance</th>
                        <th className="px-2 py-2">Suggested</th><th className="px-2 py-2">Result</th><th className="px-2 py-2">Grace</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.students.map((s) => {
                        const v = draft[s.enrollmentId] ?? { result: '', grace: {}, remark: '' };
                        const failing = s.rows.filter((r) => r.passed === false && d.subjects.find((x) => x.classSubjectId === r.classSubjectId)?.includeInTotal);
                        const graceSum = Object.values(v.grace).reduce((t, g) => t + (Number(g) || 0), 0);
                        const isOpen = open.has(s.enrollmentId);
                        return (
                          <Fragment key={s.enrollmentId}>
                            <tr className={cn('border-b', (s.left || s.absentAll) && 'text-muted-foreground')}>
                              <td className="px-2"><button aria-label={isOpen ? 'Hide marks' : 'Show marks'} className="rounded p-1 hover:bg-muted" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(s.enrollmentId)) n.delete(s.enrollmentId); else n.add(s.enrollmentId); return n; })}>{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button></td>
                              <td className="px-2 py-1.5 font-mono text-xs">{s.examNo ?? '—'}</td>
                              <td className="px-2 py-1.5"><span className="font-medium">{s.name}</span><span className="block text-xs text-muted-foreground">{s.grNo}{s.left ? ' · left' : s.absentAll ? ' · absent for the exam' : ''}</span></td>
                              {[0, 1].map((si) => { const t = s.semTotals[si]; return <td key={si} className="px-2 py-1.5 text-right tabular-nums">{t && t.max ? ((t.total / t.max) * 100).toFixed(2) : '—'}</td>; })}
                              <td className="px-2 py-1.5 text-right tabular-nums">{s.averageTotal ?? '—'}{s.graceTotal ? `+${s.graceTotal}` : ''}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{s.percentage == null ? '—' : `${s.percentage.toFixed(2)}`}</td>
                              <td className="px-2 py-1.5">{s.averageGrade ?? '—'}</td>
                              <td className="px-2 py-1.5 text-xs">{failing.length ? <span className="text-destructive">{failing.map((r) => subjectName(r.classSubjectId)).join(', ')}</span> : s.averageTotal == null ? '—' : <span className="text-muted-foreground">none</span>}</td>
                              <td className="px-2 py-1.5 tabular-nums">{s.attendance ? `${s.attendance.present} / ${s.attendance.working}` : '—'}</td>
                              <td className="px-2 py-1.5">{s.suggested ? d.resultLabels[s.suggested] : '—'}</td>
                              <td className="px-2 py-1.5">
                                {d.can.decide && !s.left && !s.absentAll
                                  ? <Select aria-label={`Result of ${s.name}`} className="h-8 w-32" value={v.result} onChange={(e) => upd(s.enrollmentId, { result: e.target.value as GreensheetResult })}>
                                    <option value="">— decide —</option>
                                    {GREENSHEET_RESULTS.map((r) => <option key={r} value={r}>{d.resultLabels[r]}</option>)}
                                  </Select>
                                  : <b>{s.decision?.result ? d.resultLabels[s.decision.result] : '—'}</b>}
                              </td>
                              <td className="px-2 py-1.5">
                                {d.can.decide && !s.left && !s.absentAll
                                  ? <Button size="sm" variant="ghost" onClick={() => setGraceFor(s)}>{graceSum ? `+${graceSum}` : 'Add'}</Button>
                                  : graceSum ? `+${graceSum}` : ''}
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b bg-muted/20"><td colSpan={13} className="p-3"><div className="overflow-x-auto rounded border bg-white p-2 text-black"><ResultTable d={d} students={[s]} /></div></td></tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border print:hidden">
                <p className="text-sm text-muted-foreground">
                  {d.status === 'APPROVED' ? 'Approved and locked. The final report cards show these results.'
                    : d.can.decide ? `${d.summary.undecided.total} result${d.summary.undecided.total === 1 ? '' : 's'} still to decide${dirty ? ' · unsaved changes' : ''}`
                      : 'The Headmaster decides the results and approves the Greensheet.'}
                </p>
                <div className="flex gap-2">
                  {d.can.decide && <Button loading={approve.isPending} disabled={!d.can.approve} title={d.gate.ready ? undefined : 'Every sheet must be approved first'} onClick={() => approve.mutate(undefined)}><Lock /> Approve Greensheet</Button>}
                  {d.can.reopen && <Button variant="outline" onClick={() => setReopen(true)}><RotateCcw /> Reopen</Button>}
                </div>
              </div>

              {graceFor && (
                <GraceDialog s={graceFor} d={d} value={draft[graceFor.enrollmentId]} onClose={() => setGraceFor(null)}
                  onSave={(grace, remark) => { upd(graceFor.enrollmentId, { grace, remark }); setGraceFor(null); }} />
              )}
              {reopen && <ReopenDialog sectionId={d.section.id} onClose={() => setReopen(false)} />}
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

function PrintMenu({ onPick }: { onPick: (part: string) => void }) {
  const [part, setPart] = useState('all');
  return (
    <div className="flex items-center gap-1">
      <Select aria-label="What to print" className="h-9 w-72" value={part} onChange={(e) => setPart(e.target.value)}>
        <option value="all">Complete Greensheet (all pages)</option>
        <option value="fe-cover">Formative Evaluation cover sheet</option>
        <option value="yearwork">Greensheet for Year Work</option>
        <option value="result">Greensheet for Result</option>
        <option value="result-cover">Result cover sheet</option>
      </Select>
      <Button onClick={() => onPick(part)}><Printer /> Print</Button>
    </div>
  );
}

function SummaryCard({ d }: { d: GsData }) {
  const rows: [string, Count | { boys: number | null; girls: number | null; total: number | null }, boolean?][] = [
    ['No. of Students', d.summary.students], ['Left', d.summary.left], ['Absent', d.summary.absent], ['Appeared', d.summary.appeared],
    ['Passed', d.summary.passed], ['Re-Exam / Detained', d.summary.reExam], ['Passing Percentage', d.summary.passPercent, true],
  ];
  return (
    <Card className="p-4">
      <h2 className="mb-2 font-semibold">Summary</h2>
      <Table>
        <THead><TR><TH>Particulars</TH><TH className="text-right">Boys</TH><TH className="text-right">Girls</TH><TH className="text-right">Total</TH></TR></THead>
        <TBody>
          {rows.map(([l, c, pct]) => (
            <TR key={l}><TD>{l}</TD>{(['boys', 'girls', 'total'] as const).map((k) => <TD key={k} className="text-right tabular-nums">{c[k] == null ? '—' : pct ? `${(c[k] as number).toFixed(2)} %` : c[k]}</TD>)}</TR>
          ))}
        </TBody>
      </Table>
      {d.summary.undecided.total > 0 && <p className="mt-2 text-xs text-muted-foreground">Passed / Re-Exam use the suggested result until the Headmaster decides ({d.summary.undecided.total} not decided yet).</p>}
    </Card>
  );
}

function GraceDialog({ s, d, value, onClose, onSave }: { s: GsStudent; d: GsData; value: DecisionDraft[number] | undefined; onClose: () => void; onSave: (grace: Record<string, string>, remark: string) => void }) {
  const [grace, setGrace] = useState<Record<string, string>>(value?.grace ?? {});
  const [remark, setRemark] = useState(value?.remark ?? '');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Grace marks · ${s.name}`} description="Added to the subject average and printed as 34+1. The percentage is not changed, as on the school's Greensheet.">
        <div className="grid gap-2">
          {d.subjects.filter((x) => x.includeInTotal).map((x) => {
            const r = s.rows.find((y) => y.classSubjectId === x.classSubjectId);
            return (
              <div key={x.classSubjectId} className="flex items-center justify-between gap-3 text-sm">
                <span>{x.name} <span className="text-muted-foreground">average {r?.average ?? '—'}{r?.passed === false ? ' (below pass)' : ''}</span></span>
                <Input aria-label={`Grace for ${x.name}`} className="h-8 w-20" inputMode="numeric" value={grace[String(x.classSubjectId)] ?? ''} placeholder="0" onChange={(e) => setGrace((g) => ({ ...g, [String(x.classSubjectId)]: e.target.value }))} />
              </div>
            );
          })}
          <Field label="Remark (optional)" htmlFor="gr"><Textarea id="gr" rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => onSave(grace, remark)}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReopenDialog({ sectionId, onClose }: { sectionId: number; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useSave(() => api.post(`/greensheet/${sectionId}/reopen`, { reason }), { invalidate: [['greensheet']], success: 'Greensheet reopened', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Reopen the Greensheet" description="It becomes a draft again so results can be changed. The reason is recorded.">
        <Field label="Reason" htmlFor="rr" required><Textarea id="rr" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="destructive" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate(undefined)}>Reopen</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------- printed pages (same layout as the school's sheets)

const v = (x: number | null | undefined, absent?: boolean) => (absent ? 'AB' : x == null ? '–' : String(x));
const partOf = (p: MarkPart[] | null, k: string) => p?.find((x) => x.key === k) ?? null;

/** Greensheet for Result: FE (A) + SE (B) = grand total & grade, FE (C) + SE (D), average marks & grade. */
function ResultTable({ d, students }: { d: GsData; students: GsStudent[] }) {
  const se = d.columns.se;
  const semCols = 1 + se.length + 1 + 2; // FE, SE parts, Total, Grand, Grade
  const inTotal = d.subjects.filter((s) => s.includeInTotal);
  const notInTotal = d.subjects.filter((s) => !s.includeInTotal);
  const cellsFor = (cell: SemCell | null, p: MarkPart[] | null) => {
    if (!cell) return [<td key="x" colSpan={semCols} className="gs-c">–</td>];
    const hasFe = !!p?.some((x) => partStage(x.key) === 'FE');
    return [
      <td key="fe" className="gs-c">{hasFe ? v(cell.fe, cell.absent) : '–'}</td>,
      ...se.map((k) => <td key={k} className="gs-c">{partOf(p, k) ? v(cell.parts[k], cell.absent) : '–'}</td>),
      <td key="se" className="gs-c">{p?.some((x) => partStage(x.key) === 'SE') ? v(cell.se, cell.absent) : '–'}</td>,
      <td key="t" className="gs-c font-semibold">{v(cell.total, false)}</td>,
      <td key="g" className="gs-c">{cell.grade ?? ''}</td>,
    ];
  };
  return (
    <table className="gs-table">
      <thead>
        <tr>
          <th rowSpan={2} className="gs-l">Exam.No.,<br />GR No.,<br />Name</th>
          {[0, 1].map((si) => (
            <Fragment key={si}>
              <th rowSpan={2}>Formative<br />Evaluation<br />{si ? 'II' : 'I'}<br />({si ? 'C' : 'A'})</th>
              <th colSpan={se.length + 1}>Summative<br />Evaluation-{si ? 'II' : 'I'}</th>
              <th rowSpan={2}>Grand<br />Total<br />({si ? 'C+D' : 'A+B'})</th>
              <th rowSpan={2}>Grade</th>
            </Fragment>
          ))}
          <th colSpan={2}>Average</th>
        </tr>
        <tr>
          {[0, 1].map((si) => <Fragment key={si}>{se.map((k) => <th key={k}>{label(k)}</th>)}<th>Total<br />({si ? 'D' : 'B'})</th></Fragment>)}
          <th>Marks<br />Obtained</th><th>Grade</th>
        </tr>
        {d.maxRows.map((m) => (
          <tr key={m.label} className="gs-max">
            <td className="gs-l">Max.{m.label}</td>
            {[0, 1].map((si) => {
              const p = m.patterns[si];
              const fe = p?.filter((x) => partStage(x.key) === 'FE').reduce((t, x) => t + countedMax(x), 0) ?? 0;
              const seT = p?.filter((x) => partStage(x.key) === 'SE').reduce((t, x) => t + countedMax(x), 0) ?? 0;
              return (
                <Fragment key={si}>
                  <td className="gs-c">{fe || '–'}</td>
                  {se.map((k) => <td key={k} className="gs-c">{partOf(p, k)?.max ?? '–'}</td>)}
                  <td className="gs-c">{seT || '–'}</td>
                  <td className="gs-c font-semibold">{fe + seT || '–'}</td>
                  <td />
                </Fragment>
              );
            })}
            <td className="gs-c font-semibold">100</td><td />
          </tr>
        ))}
      </thead>
      {students.map((s) => {
        const byId = new Map(s.rows.map((r) => [r.classSubjectId, r]));
        const subjectRow = (x: GsData['subjects'][number]) => {
          const r = byId.get(x.classSubjectId)!;
          return (
            <tr key={x.classSubjectId}>
              <td className="gs-l pl-2">{x.name}</td>
              {[0, 1].map((si) => <Fragment key={si}>{cellsFor(r.sem[si], x.patterns[si])}</Fragment>)}
              <td className="gs-c font-bold">{r.average ?? '–'}{r.grace ? `+${r.grace}` : ''}</td>
              <td className="gs-c font-bold">{r.averageGrade ?? ''}</td>
            </tr>
          );
        };
        return (
          <tbody key={s.enrollmentId} className="gs-student">
            <tr><td colSpan={1 + semCols * 2 + 2} className="gs-l pt-2 font-bold">{[s.examNo, s.grNo, s.name].filter(Boolean).join(' - ')}</td></tr>
            {inTotal.map(subjectRow)}
            <tr className="gs-total">
              <td className="gs-l">Total</td>
              {[0, 1].map((si) => {
                const t = s.semTotals[si];
                if (!t) return <td key={si} colSpan={semCols} className="gs-c">–</td>;
                return (
                  <Fragment key={si}>
                    <td className="gs-c">{t.fe}</td>
                    {se.map((k) => <td key={k} className="gs-c">{t.seParts[k] ?? '–'}</td>)}
                    <td className="gs-c">{t.se}</td><td className="gs-c">{t.total}</td><td className="gs-c">{t.grade ?? ''}</td>
                  </Fragment>
                );
              })}
              <td className="gs-c font-bold">{s.averageTotal ?? '–'}{s.graceTotal ? `+${s.graceTotal}` : ''}</td>
              <td className="gs-c font-bold">{s.averageGrade ?? ''}</td>
            </tr>
            {notInTotal.map(subjectRow)}
            <tr className="gs-foot">
              <td colSpan={1 + semCols * 2 + 2}>
                <div className="flex justify-between gap-4">
                  <span>Percentage : <b>{s.percentage == null ? '' : `${s.percentage.toFixed(2)} %`}</b></span>
                  <span>Result : <b>{s.left ? 'LEFT' : s.absentAll ? 'ABSENT' : s.decision?.result ? d.resultLabels[s.decision.result].toUpperCase() : s.suggested ? `${d.resultLabels[s.suggested].toUpperCase()} (suggested)` : ''}</b></span>
                  <span>Attendance : <b>{s.attendance ? `${s.attendance.present} / ${s.attendance.working}` : ''}</b></span>
                </div>
              </td>
            </tr>
          </tbody>
        );
      })}
    </table>
  );
}

/** Greensheet for Year Work: Formative Evaluation I and II part by part. */
function YearWorkTable({ d }: { d: GsData }) {
  // MCQ counted out of 10 also shows its "MCQ Avg." column, as on the IX–X sheet.
  const cols = d.columns.fe.flatMap((k) => (k === 'MCQ' ? ['MCQ', 'MCQ_AVG'] : [k]));
  const head = (k: string) => (k === 'MCQ_AVG' ? 'MCQ Avg.' : label(k));
  const val = (cell: SemCell | null, p: MarkPart[] | null, k: string) => {
    const part = partOf(p, k === 'MCQ_AVG' ? 'MCQ' : k);
    if (!cell || !part) return '–';
    if (cell.absent) return 'AB';
    const raw = cell.parts[part.key] as number | string | null | undefined;
    if (raw == null) return '';
    if (typeof raw === 'string') return raw; // AB for this part only
    return k === 'MCQ_AVG' && part.countAs ? String(Math.floor((raw * part.countAs) / part.max + 0.5)) : String(raw);
  };
  const maxOf = (p: MarkPart[] | null, k: string) => {
    const part = partOf(p, k === 'MCQ_AVG' ? 'MCQ' : k);
    return part ? (k === 'MCQ_AVG' ? part.countAs ?? '–' : k === 'MCQ' && part.countAs ? part.max : countedMax(part)) : '–';
  };
  return (
    <table className="gs-table">
      <thead>
        <tr>
          <th rowSpan={2} className="gs-l">Exam.No.,<br />GR No.,<br />Name</th>
          <th colSpan={cols.length + 1}>Formative Evaluation-I</th>
          <th colSpan={cols.length + 1}>Formative Evaluation-II</th>
        </tr>
        <tr>{[0, 1].map((si) => <Fragment key={si}>{cols.map((k) => <th key={k}>{head(k)}</th>)}<th>Total<br />({si ? 'B' : 'A'})</th></Fragment>)}</tr>
        {d.maxRows.map((m) => (
          <tr key={m.label} className="gs-max">
            <td className="gs-l">Max.{m.label}</td>
            {[0, 1].map((si) => (
              <Fragment key={si}>
                {cols.map((k) => <td key={k} className="gs-c">{maxOf(m.patterns[si], k)}</td>)}
                <td className="gs-c font-semibold">{m.patterns[si]?.filter((x) => partStage(x.key) === 'FE').reduce((t, x) => t + countedMax(x), 0) || '–'}</td>
              </Fragment>
            ))}
          </tr>
        ))}
      </thead>
      {d.students.map((s) => (
        <tbody key={s.enrollmentId} className="gs-student">
          <tr><td colSpan={1 + (cols.length + 1) * 2} className="gs-l pt-2 font-bold">{[s.examNo, s.grNo, s.name].filter(Boolean).join(' - ')}</td></tr>
          {d.subjects.map((x) => {
            const r = s.rows.find((y) => y.classSubjectId === x.classSubjectId)!;
            return (
              <tr key={x.classSubjectId}>
                <td className="gs-l pl-2">{x.name}</td>
                {[0, 1].map((si) => {
                  const p = x.patterns[si];
                  const hasFe = !!p?.some((y) => partStage(y.key) === 'FE');
                  return (
                    <Fragment key={si}>
                      {cols.map((k) => <td key={k} className="gs-c">{val(r.sem[si], p, k)}</td>)}
                      <td className="gs-c font-bold">{hasFe ? v(r.sem[si]?.fe, r.sem[si]?.absent) : '–'}</td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

function CoverTable({ d, result }: { d: GsData; result: boolean }) {
  const s = d.summary;
  const rows: [string, Count | { boys: number | null; girls: number | null; total: number | null }, boolean?][] = [
    ['No. of Students', s.students], ['Left', s.left], ['Absent', s.absent], ['Appeared', s.appeared],
    ...(result ? [['Passed', s.passed], ['Re-Exam/Detained', s.reExam], ['Passing Percentage', s.passPercent, true]] as typeof rows : []),
  ];
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    <table className="gs-cover">
      <thead><tr><th>Particulars</th><th>Boys</th><th>Girls</th><th>Total</th></tr></thead>
      <tbody>
        {rows.map(([l, c, pct]) => (
          <tr key={l}><td className="text-left font-semibold">{l}</td>{(['boys', 'girls', 'total'] as const).map((k) => <td key={k}>{c[k] == null ? '' : pct ? `${(c[k] as number).toFixed(2)}%` : two(c[k] as number)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function Signatures({ d }: { d: GsData }) {
  return (
    <div className="gs-sign">
      <p>Class Teacher{d.classTeacher ? <span>({d.classTeacher})</span> : null}</p>
      <p>Checked by</p>
      <p>{d.school.principalTitle}<span>{d.school.name}</span></p>
    </div>
  );
}

function SheetHeader({ d, title, logo }: { d: GsData; title: string; logo?: string }) {
  return (
    <div className="gs-head">
      <div className="flex items-center gap-3 border-b-2 border-black pb-1">
        {logo ? <img src={logo} alt="" className="h-14 w-16 object-contain" /> : <div className="w-16" />}
        <div className="flex-1 text-center">
          <p className="text-lg font-bold">{d.school.name}</p>
          <p className="text-[11px]">{d.school.address}</p>
        </div>
        <div className="w-16" />
      </div>
      <div className="mt-1 flex items-end justify-between">
        <p className="text-base font-bold">Class : {d.section.label}</p>
        <p className="font-bold">{title} - {d.year.name}</p>
        <p className="w-32 text-right text-[10px]">{d.status === 'APPROVED' ? '' : 'DRAFT: not approved'}</p>
      </div>
    </div>
  );
}

const PRINT_CSS = `
@page { size: A4 portrait; margin: 10mm; }
.gs-page { background: white; color: black; font-family: Arial, Helvetica, sans-serif; font-size: 10px; }
.gs-sheet { break-after: page; }
.gs-sheet:last-child { break-after: auto; }
.gs-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.gs-table th { font-weight: 600; font-size: 9px; padding: 1px 2px; border-bottom: 1px solid #000; text-align: center; vertical-align: bottom; }
.gs-table td { padding: 1px 2px; }
.gs-table .gs-l { text-align: left; white-space: nowrap; }
.gs-table .gs-c { text-align: center; font-variant-numeric: tabular-nums; }
.gs-table .gs-max td { border-bottom: 1px solid #000; font-weight: 600; }
.gs-student { break-inside: avoid; }
.gs-student .gs-total td { border-top: 1px solid #000; font-weight: 700; }
.gs-student .gs-foot td { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 2px 4px; }
.gs-cover { width: 92%; margin: 18px auto; border-collapse: collapse; font-size: 13px; }
.gs-cover th, .gs-cover td { border: 1px solid #000; padding: 12px 10px; text-align: center; }
.gs-sign { display: flex; justify-content: space-between; margin-top: 42px; font-weight: 700; font-size: 12px; break-inside: avoid; }
.gs-sign p { min-width: 150px; text-align: center; border-top: 1px solid #000; padding-top: 2px; }
.gs-sign span { display: block; font-weight: 400; font-size: 10px; }
`;

export function GreensheetPrintPage() {
  const { sectionId } = useParams();
  const [params] = useSearchParams();
  const part = params.get('part') ?? 'all';
  const logo = useSchoolLogo();
  const q = useQuery({ queryKey: ['greensheet', sectionId], queryFn: () => api.get<GsData>(`/greensheet/${sectionId}`) });
  const show = (p: string) => part === 'all' || part === p;
  const ready = useMemo(() => !!q.data, [q.data]);
  return (
    <>
      <div className="mb-4 flex items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" asChild><Link to={`/greensheet/${sectionId}`}><ArrowLeft /> Back</Link></Button>
        <Button size="sm" className="ml-auto" disabled={!ready} onClick={() => window.print()}><Printer /> Print</Button>
      </div>
      <QueryView query={q}>
        {(d) => (
          <div className="gs-page mx-auto max-w-[210mm] p-[8mm] shadow-card print:max-w-none print:p-0 print:shadow-none">
            <style>{PRINT_CSS}</style>
            {show('fe-cover') && (
              <section className="gs-sheet">
                <SheetHeader d={d} title="Greensheet - Formative Evaluation" logo={logo.data} />
                <CoverTable d={d} result={false} />
                <Signatures d={d} />
              </section>
            )}
            {show('yearwork') && (
              <section className="gs-sheet">
                <SheetHeader d={d} title="Greensheet for Year Work" logo={logo.data} />
                <YearWorkTable d={d} />
                <Signatures d={d} />
              </section>
            )}
            {show('result-cover') && (
              <section className="gs-sheet">
                <SheetHeader d={d} title="Greensheet - Result" logo={logo.data} />
                <CoverTable d={d} result />
                <Signatures d={d} />
              </section>
            )}
            {show('result') && (
              <section className="gs-sheet">
                <SheetHeader d={d} title="Greensheet for Result" logo={logo.data} />
                <ResultTable d={d} students={d.students.filter((s) => !s.left)} />
                <Signatures d={d} />
              </section>
            )}
          </div>
        )}
      </QueryView>
    </>
  );
}
