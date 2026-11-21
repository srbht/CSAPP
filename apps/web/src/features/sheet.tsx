import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTENDANCE_STAGE_ACTOR, countedMax, evaluationNo, MARK_PARTS, PART_CODES, type MarkPart, monthLabel, partCode, partStage, partSummary, type PartValue, STAGE_ACTOR, type ProgressBucket } from '@cps/shared';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, CircleDot, FileSpreadsheet, FileUp, Lock, RotateCcw, Save, Send, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { errorMessage, QueryView } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form-controls';
import { Badge, Card } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { download } from './blank-sheets';
import { BucketChip, type Unit } from './workflow-ui';

interface SheetRow {
  enrollmentId: number; rollNo: number | null; examNo: string | null; enrollmentStatus: string;
  student: { id: number; fullName: string; fullNameHi: string | null; gender: string };
  id: number | null; version: number | null; rowStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | null; passedStage: string | null;
  rejectReason: string | null; rejectedStage: string | null; marks1: number | null; marks2: number | null; parts: Record<string, PartValue> | null; absent: boolean; presentDays: number | null; needsReview: boolean;
}
interface SheetData {
  unit: { key: string; recordType: 'MARKS' | 'ATTENDANCE'; section: { id: number; name: string; schoolClass: { displayName: string; medium: { nameEn: string } } }; exam: { id: number; nameEn: string; kind: string; reportTerm: string | null } | null; classSubject: { id: number; subject: { nameEn: string } } | null; max1: number | null; max2: number | null; pattern: MarkPart[] | null; period: string | null };
  people: { operators: string[]; firstReviewer: string | null; classTeacher: string | null };
  submission: { id: number; stage: string; status: string; revision: number; workingDays: number | null; submittedAt: string | null; approvedAt: string | null; returnedFrom: string | null } | null;
  blankSheet: { id: number; sheetNo: string } | null;
  /** Sheets with a Unit Test (OBT) column: UNIT_TEST = step 1 (OBT only), FINAL = step 2 (the rest). */
  step: 'UNIT_TEST' | 'FINAL' | null;
  lockedParts: string[];
  bucket: ProgressBucket;
  rows: SheetRow[];
  can: { edit: boolean; editRowsLimited: boolean; submit: boolean; review: boolean; reopen: boolean; ownWorkBlocked: boolean; sendDown?: boolean; returnUp?: boolean; lowerStep?: string | null; upperStep?: string | null; editParts?: string[]; absentTick?: boolean; reopenUnitTest?: boolean };
  history: { id: number; stage: string; action: string; actorName: string | null; comment: string | null; rowCount: number | null; createdAt: string; revision: number }[];
}
type Values = { parts: Record<string, string>; absent: boolean; presentDays: string };
interface FilePreview {
  fileName: string; sheetName: string | null; matchedBy: string;
  columns: { key: string; label: string; found: boolean }[];
  rows: { enrollmentId: number; rollNo: number | null; examNo: string | null; fullName: string; fileRow: number; parts: Record<string, string>; absent: boolean }[];
  issues: string[];
  missing: { rollNo: number | null; examNo: string | null; fullName: string }[];
}

const STEPS = ['OPERATOR', 'SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE', 'DONE'] as const;
const ACTION_WORDS: Record<string, string> = { SUBMIT: 'Submitted', RESUBMIT: 'Corrected and resubmitted', VERIFY: 'Verified', APPROVE: 'Approved', REJECT: 'Sent back', REOPEN: 'Reopened', SEND_BACK: 'Sent back one step', RETURN_UP: 'Returned up' };
/** Who holds a mark sheet at each step. */
const STEP_WHO: Record<string, string> = { OPERATOR: 'operator', SUBJECT_VERIFY: 'subject teacher', CLASS_APPROVE: 'class teacher', HEADMASTER_APPROVE: 'Headmaster' };

function useUnit(): Unit | null {
  const [p] = useSearchParams();
  const t = p.get('recordType');
  if (t === 'MARKS') return { recordType: 'MARKS', examId: Number(p.get('examId')), sectionId: Number(p.get('sectionId')), classSubjectId: Number(p.get('classSubjectId')) };
  if (t === 'ATTENDANCE') return { recordType: 'ATTENDANCE', sectionId: Number(p.get('sectionId')), period: p.get('period') ?? '' };
  return null;
}

export function SheetPage() {
  const unit = useUnit();
  const q = useQuery({
    queryKey: ['sheet', unit],
    queryFn: () => api.get<SheetData>(`/sheets?${new URLSearchParams(Object.entries(unit ?? {}).map(([k, v]) => [k, String(v)])).toString()}`),
    enabled: !!unit,
  });
  if (!unit) return <p className="text-sm text-muted-foreground">Open a sheet from Exams & Marks, Attendance or Approvals.</p>;
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2 print:hidden" asChild>
        <Link to={unit.recordType === 'MARKS' ? `/marks?examId=${unit.examId}` : `/attendance?period=${unit.period}`}><ArrowLeft /> {unit.recordType === 'MARKS' ? 'Exams & Marks' : 'Attendance'}</Link>
      </Button>
      <QueryView query={q}>{(d) => <Sheet key={`${d.submission?.id}:${d.submission?.revision}:${d.submission?.stage}`} d={d} unit={unit} />}</QueryView>
    </>
  );
}

function Sheet({ d, unit }: { d: SheetData; unit: Unit }) {
  const qc = useQueryClient();
  const marks = d.unit.recordType === 'MARKS';
  const pattern = d.unit.pattern ?? [];
  const feParts = pattern.filter((p) => partStage(p.key) === 'FE');
  const seParts = pattern.filter((p) => partStage(p.key) === 'SE');
  const evNo = evaluationNo(d.unit.exam?.reportTerm);
  const stage = d.submission?.stage ?? 'OPERATOR';
  const actors = marks ? STAGE_ACTOR : ATTENDANCE_STAGE_ACTOR;
  const title = marks
    ? `${d.unit.exam?.nameEn} · ${d.unit.classSubject?.subject.nameEn}`
    : `Attendance · ${monthLabel(d.unit.period!)}`;

  const initial = useMemo(() => Object.fromEntries(d.rows.map((r) => [r.enrollmentId, {
    parts: Object.fromEntries(pattern.map((p) => [p.key, r.parts?.[p.key] == null ? '' : String(r.parts[p.key])])), absent: r.absent, presentDays: r.presentDays == null ? '' : String(r.presentDays),
  }])) as Record<number, Values>, [d.rows]);
  const [values, setValues] = useState(initial);
  const [workingDays, setWorkingDays] = useState(d.submission?.workingDays == null ? '' : String(d.submission.workingDays));
  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState<'rows' | 'reopen' | 'reopenUnit' | 'down' | 'up' | null>(null);
  const pick = marks && (d.can.sendDown || d.can.review); // mark sheets: tick students to highlight for correction
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  useEffect(() => { setValues(initial); setDirty(new Set()); }, [initial]);

  const editableRow = (r: SheetRow) => d.can.edit && (!d.can.editRowsLimited || r.rowStatus !== 'VERIFIED');
  const unitStep = d.step === 'UNIT_TEST';
  /** Mark boxes open in this step: OBT only in step 1; after that everything but the locked OBT (unless still empty). */
  const canType = (r: SheetRow, key: string) => editableRow(r) && ((d.can.editParts ?? []).includes(key) || (d.lockedParts.includes(key) && r.parts?.[key] == null));
  const needParts = unitStep ? pattern.filter((p) => p.key === 'OBT') : pattern;
  const set = (id: number, patch: Partial<Values>) => {
    setValues((v) => ({ ...v, [id]: { ...v[id], ...patch } }));
    setDirty((s) => new Set(s).add(id));
  };
  const workingChanged = !marks && workingDays !== (d.submission?.workingDays == null ? '' : String(d.submission.workingDays));
  const refresh = () => qc.invalidateQueries({ queryKey: ['sheet'] }).then(() => qc.invalidateQueries({ queryKey: ['workflow'] }));

  const save = async (quiet = false) => {
    if (!dirty.size && !workingChanged) return true;
    setBusy('save');
    try {
      const rows = d.rows.filter((r) => dirty.has(r.enrollmentId) || workingChanged).map((r) => {
        const v = values[r.enrollmentId];
        return marks
          ? { enrollmentId: r.enrollmentId, parts: v.absent ? {} : Object.fromEntries(Object.entries(v.parts).map(([k, x]) => [k, x.trim() === '' ? null : x.trim()])), absent: v.absent, version: r.version ?? undefined }
          : { enrollmentId: r.enrollmentId, presentDays: v.presentDays, version: r.version ?? undefined };
      });
      await api.put('/sheets', { unit, workingDays: marks ? undefined : workingDays, rows });
      setRowErrors({});
      if (!quiet) toast.success('Saved');
      await refresh();
      return true;
    } catch (e) {
      const errs = (e as { errors?: { path: string; message: string }[] }).errors ?? [];
      setRowErrors(Object.fromEntries(errs.map((x) => [x.path, x.message])));
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const run = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name);
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const [showEmpty, setShowEmpty] = useState(false);
  const submit = async () => { setShowEmpty(true); if (await save(true)) await run('submit', async () => api.post(`/submissions/${d.submission?.id ?? (await reloadId())}/submit`), 'Sent for verification'); };
  const reloadId = async () => (await qc.fetchQuery({ queryKey: ['sheet', unit], queryFn: () => api.get<SheetData>(`/sheets?${new URLSearchParams(Object.entries(unit).map(([k, v]) => [k, String(v)])).toString()}`) })).submission!.id;

  const cols = pattern.map((p) => p.key as string);
  /** Paste cells copied from Excel into one cell: fills that cell, the cells to its right and the rows below it. */
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, index: number, field: string) => {
    const text = e.clipboardData.getData('text');
    if (!/[\r\n\t]/.test(text.trim())) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
    lines.forEach((line, k) => {
      const r = d.rows[index + k];
      if (!r || !editableRow(r)) return;
      const cells = line.split('\t');
      const val = cells[0].trim();
      if (!marks) { set(r.enrollmentId, { presentDays: val }); return; }
      const start = cols.indexOf(field);
      const next = { ...values[r.enrollmentId].parts };
      cells.forEach((c, j) => { if (cols[start + j] && canType(r, cols[start + j])) next[cols[start + j]] = c.trim(); });
      set(r.enrollmentId, { parts: next });
    });
    toast.success(`Pasted ${lines.length} rows`);
  };
  const nextInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const col = e.currentTarget.dataset.col;
    const row = Number(e.currentTarget.dataset.row) + (e.key === 'ArrowUp' ? -1 : 1);
    document.querySelector<HTMLInputElement>(`input[data-col="${col}"][data-row="${row}"]`)?.focus();
  };

  const totals = (v: Values) => partSummary(pattern, Object.fromEntries(Object.entries(v.parts).filter(([, x]) => x.trim() !== '' && (partCode(x) || !Number.isNaN(Number(x)))).map(([k, x]) => [k, partCode(x) ?? Number(x)])));
  const maxTotal = (d.unit.max1 ?? 0) + (d.unit.max2 ?? 0);
  const filled = d.rows.filter((r) => { const v = values[r.enrollmentId]; return marks ? v.absent || needParts.every((p) => (v.parts[p.key] ?? '').trim() !== '') : v.presentDays !== ''; }).length;
  /** Mark sheets: which parts are still empty, and for how many students (e.g. "Written empty for 31"). */
  const emptyParts = marks ? needParts.map((p) => ({ label: MARK_PARTS[p.key].label, n: d.rows.filter((r) => r.enrollmentStatus === 'ACTIVE' && !values[r.enrollmentId].absent && (values[r.enrollmentId].parts[p.key] ?? '').trim() === '').length })).filter((x) => x.n > 0) : [];
  const reviewRows = d.rows.filter((r) => r.needsReview);
  const stepIndex = STEPS.indexOf(stage as (typeof STEPS)[number]);
  const reviewWord = stage === 'SUBJECT_VERIFY' ? (marks ? 'Verify & send to class teacher' : 'Verify') : stage === 'CLASS_APPROVE' ? 'Approve & send to Headmaster' : unitStep ? 'Approve Unit Test & lock OBT' : 'Give final approval';

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{d.unit.section.schoolClass.displayName} {d.unit.section.name} · {d.unit.section.schoolClass.medium.nameEn}</p>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {marks && <p className="text-sm text-muted-foreground">Maximum: {[feParts.length && `Formative Evaluation ${evNo} ${d.unit.max1}`, seParts.length && `Summative Evaluation ${evNo} ${d.unit.max2}`].filter(Boolean).join(' + ')} = {maxTotal}</p>}
        </div>
        <BucketChip bucket={d.bucket} className="self-start text-sm sm:self-auto" />
      </div>

      {/* Where is this sheet in the approval chain? */}
      <Card className="p-4">
        <ol className="grid grid-cols-5 gap-1 text-center text-xs sm:text-sm">
          {STEPS.map((s, i) => {
            const done = d.submission?.status === 'APPROVED' || i < stepIndex;
            const current = i === stepIndex && d.submission?.status !== 'APPROVED';
            const person = s === 'OPERATOR' ? d.people.operators.join(', ') : s === 'SUBJECT_VERIFY' ? d.people.firstReviewer ?? (marks ? 'not assigned' : d.people.classTeacher) : s === 'CLASS_APPROVE' ? d.people.classTeacher : s === 'HEADMASTER_APPROVE' ? 'Headmaster' : '';
            return (
              <li key={s} className="flex flex-col items-center gap-1">
                <span className={cn('grid size-7 place-items-center rounded-full border-2', done ? 'border-emerald-500 bg-emerald-500 text-white' : current ? (d.bucket === 'CORRECTION' ? 'border-red-500 text-red-600' : 'border-primary text-primary') : 'border-border text-muted-foreground')}>
                  {done ? <Check className="size-4" /> : current ? <CircleDot className="size-4" /> : i + 1}
                </span>
                <span className={cn('font-medium', current ? 'text-foreground' : 'text-muted-foreground')}>{s === 'DONE' ? 'Approved' : actors[s]}</span>
                {person && <span className="hidden truncate text-muted-foreground sm:block sm:max-w-full">{person}</span>}
              </li>
            );
          })}
        </ol>
      </Card>

      <Guidance d={d} marks={marks} reviewCount={reviewRows.length} />

      {!marks && (
        <Card className="flex flex-wrap items-end gap-4 p-4">
          <Field label="Working days in the month" htmlFor="wd" error={rowErrors.workingDays}>
            <Input id="wd" className="w-32" inputMode="decimal" value={workingDays} disabled={!d.can.edit} onChange={(e) => setWorkingDays(e.target.value)} />
          </Field>
          {d.can.edit && <Button variant="outline" size="sm" onClick={() => d.rows.forEach((r) => editableRow(r) && set(r.enrollmentId, { presentDays: workingDays }))} disabled={!workingDays}>Mark everyone present all days</Button>}
          <p className="text-xs text-muted-foreground">Then reduce the days for students who were absent.</p>
        </Card>
      )}

      {marks && d.can.edit && (
        <FillFromFile d={d} unit={unit} onFill={(p) => {
          let n = 0;
          for (const r of p.rows) {
            const row = d.rows.find((x) => x.enrollmentId === r.enrollmentId);
            if (!row || !editableRow(row)) continue;
            const cur = values[r.enrollmentId];
            const open = Object.fromEntries(Object.entries(r.parts).filter(([k]) => canType(row, k)));
            set(r.enrollmentId, r.absent && d.can.absentTick ? { absent: true, parts: Object.fromEntries(cols.map((c) => [c, ''])) } : { parts: { ...cur.parts, ...open } });
            n++;
          }
          toast.success(`Filled ${n} student${n === 1 ? '' : 's'}. Check the marks, then press Save.`);
        }} />
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {marks && (
                <tr className="border-b text-center normal-case">
                  <th colSpan={(d.can.review || pick ? 1 : 0) + 3} />
                  {feParts.length > 0 && <th colSpan={feParts.length + 1} className="border-x px-2 py-1.5 text-foreground">Formative Evaluation {evNo}</th>}
                  {seParts.length > 0 && <th colSpan={seParts.length + 1} className="border-x px-2 py-1.5 text-foreground">Summative Evaluation {evNo}</th>}
                  <th colSpan={3} />
                </tr>
              )}
              <tr>
                {(d.can.review || pick) && <th className="w-10 px-3 py-2"><span className="sr-only">{marks ? 'Highlight for correction' : 'Send back'}</span></th>}
                <th className="w-14 px-3 py-2">Roll</th>
                {marks && <th className="w-24 px-3 py-2">Exam No</th>}
                <th className="px-3 py-2">Student</th>
                {marks ? (
                  <>
                    {feParts.map((p) => <PartHead key={p.key} p={p} locked={d.lockedParts.includes(p.key)} focus={unitStep && p.key === 'OBT'} />)}
                    {feParts.length > 0 && <th className="border-r px-2 py-2 text-center normal-case">Total ({evNo === 'I' ? 'A' : 'C'})<span className="block font-normal">/{d.unit.max1}</span></th>}
                    {seParts.map((p) => <PartHead key={p.key} p={p} locked={d.lockedParts.includes(p.key)} focus={unitStep && p.key === 'OBT'} />)}
                    {seParts.length > 0 && <th className="border-r px-2 py-2 text-center normal-case">Total ({evNo === 'I' ? 'B' : 'D'})<span className="block font-normal">/{d.unit.max2}</span></th>}
                    <th className="px-2 py-2 text-center normal-case">Grand total<span className="block font-normal">/{maxTotal}</span></th>
                    <th className="w-16 px-2 py-2">Absent</th>
                  </>
                ) : (
                  <>
                    <th className="w-32 px-3 py-2">Days present</th>
                    <th className="w-20 px-3 py-2">%</th>
                  </>
                )}
                <th className="px-3 py-2">Check</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, i) => {
                const v = values[r.enrollmentId];
                const editable = editableRow(r);
                const pct = !marks && v.presentDays !== '' && Number(workingDays) ? Math.round((Number(v.presentDays) / Number(workingDays)) * 100) : null;
                const err = Object.entries(rowErrors).find(([k]) => k.startsWith(`rows.${i}.`))?.[1];
                const t = marks ? totals(v) : null;
                return (
                  <tr key={r.enrollmentId} className={cn('border-b last:border-0', r.rowStatus === 'REJECTED' && 'bg-red-50/70 dark:bg-red-950/30', r.needsReview && d.can.review && 'bg-amber-50/60 dark:bg-amber-950/20', dirty.has(r.enrollmentId) && 'bg-sky-50/60 dark:bg-sky-950/20')}>
                    {(d.can.review || pick) && (
                      <td className="px-3 py-1.5">
                        {(r.needsReview || pick) && <Checkbox aria-label={`Send back roll ${r.rollNo}`} checked={selected.has(r.enrollmentId)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.enrollmentId); else n.delete(r.enrollmentId); return n; })} />}
                      </td>
                    )}
                    <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{r.rollNo ?? '—'}</td>
                    {marks && <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{r.examNo ?? <span className="text-muted-foreground">—</span>}</td>}
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{r.student.fullName}</span>
                      {r.enrollmentStatus !== 'ACTIVE' && <Badge variant="secondary" className="ml-2">left</Badge>}
                      {r.rejectReason && r.rowStatus === 'REJECTED' && <span className="mt-0.5 flex items-center gap-1 text-xs text-red-700 dark:text-red-300"><AlertTriangle className="size-3" /> Sent back by {actors[r.rejectedStage ?? ''] ?? 'reviewer'}: {r.rejectReason}</span>}
                      {err && <span className="block text-xs text-destructive">{err}</span>}
                    </td>
                    {marks ? (
                      <>
                        {[...feParts, null, ...seParts, null].map((p, j) => {
                          if (!p) {
                            const isFe = j === feParts.length;
                            if (isFe ? !feParts.length : !seParts.length) return null;
                            const val = isFe ? t?.marks1 : t?.marks2;
                            return <td key={`t${j}`} className="border-r px-2 py-1.5 text-center font-medium tabular-nums">{v.absent ? 'AB' : val ?? '—'}</td>;
                          }
                          const raw = v.parts[p.key] ?? '';
                          const code = partCode(raw);
                          const bad = raw !== '' && !code && (Number.isNaN(Number(raw)) || Number(raw) > p.max || Number(raw) < 0);
                          const open = canType(r, p.key);
                          return (
                            <td key={p.key} className={cn('px-1 py-1.5 text-center', unitStep && p.key === 'OBT' && 'bg-sky-50/70 dark:bg-sky-950/20', d.lockedParts.includes(p.key) && 'bg-muted/40')}>
                              {open ? <Input aria-label={`Roll ${r.rollNo} ${MARK_PARTS[p.key].label}`} data-col={p.key} data-row={i} inputMode="decimal" className={cn('mx-auto h-8 w-14 px-1.5 text-center tabular-nums', bad && 'border-destructive text-destructive', showEmpty && !v.absent && raw.trim() === '' && needParts.some((x) => x.key === p.key) && 'border-2 border-dashed border-red-400 bg-red-50/60 dark:bg-red-950/20', code === 'AB' && 'border-amber-400 bg-amber-50 font-medium text-amber-800 uppercase dark:bg-amber-950/30 dark:text-amber-200', code === 'C' && 'border-fuchsia-400 bg-fuchsia-50 font-medium text-fuchsia-800 uppercase dark:bg-fuchsia-950/30 dark:text-fuchsia-200')} title={code ? `${PART_CODES[code]}: counts as 0` : undefined} value={raw} disabled={v.absent}
                                onChange={(e) => set(r.enrollmentId, { parts: { ...v.parts, [p.key]: e.target.value } })} onPaste={(e) => onPaste(e, i, p.key)} onKeyDown={nextInput} />
                                : <span className={cn('tabular-nums', d.lockedParts.includes(p.key) && 'font-medium', !raw && editable && 'text-muted-foreground/50')} title={d.lockedParts.includes(p.key) ? 'Unit Test approved and locked' : editable && unitStep ? 'Opens after the Headmaster approves the Unit Test (OBT)' : undefined}>{v.absent ? 'AB' : raw || '—'}</span>}
                            </td>
                          );
                        })}
                        <td className="px-2 py-1.5 text-center font-semibold tabular-nums">{v.absent ? 'AB' : t && (t.marks1 != null || t.marks2 != null) ? (t.marks1 ?? 0) + (t.marks2 ?? 0) : '—'}</td>
                        <td className="px-2 py-1.5">
                          {editable && d.can.absentTick !== false ? <Checkbox aria-label={`Roll ${r.rollNo} absent`} checked={v.absent} onChange={(e) => set(r.enrollmentId, { absent: e.target.checked, ...(e.target.checked ? { parts: Object.fromEntries(cols.map((c) => [c, ''])) } : {}) })} />
                            : v.absent ? <Badge variant="secondary">AB</Badge> : null}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-1.5">
                          {editable ? <Input aria-label={`Roll ${r.rollNo} days present`} data-col="pd" data-row={i} inputMode="decimal" className={cn('h-8 w-20 tabular-nums', workingDays && Number(v.presentDays) > Number(workingDays) && 'border-destructive text-destructive')} value={v.presentDays}
                            onChange={(e) => set(r.enrollmentId, { presentDays: e.target.value })} onPaste={(e) => onPaste(e, i, 'presentDays')} onKeyDown={nextInput} />
                            : <span className="tabular-nums">{v.presentDays || '—'}</span>}
                        </td>
                        <td className={cn('px-3 py-1.5 tabular-nums', pct != null && pct < 75 && 'font-medium text-destructive')}>{pct == null ? '—' : `${pct}%`}</td>
                      </>
                    )}
                    <td className="px-3 py-1.5 text-xs">
                      {r.rowStatus === 'REJECTED' ? <span className="text-red-700 dark:text-red-300">Sent back</span>
                        : r.needsReview ? <span className="text-amber-700 dark:text-amber-300">To check</span>
                          : r.passedStage && r.passedStage !== 'OPERATOR' ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-3.5" /> {actors[r.passedStage]}</span>
                            : r.id ? <span className="text-muted-foreground">Entered</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Actions */}
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border print:hidden">
        <p className="text-sm text-muted-foreground">
          {d.can.edit ? `${filled} of ${d.rows.length} complete${emptyParts.length ? ` · empty: ${emptyParts.slice(0, 3).map((x) => `${x.label} for ${x.n}`).join(', ')}${emptyParts.length > 3 ? ' …' : ''}` : ''}${dirty.size ? ` · ${dirty.size} unsaved` : ''}` : pick ? `${selected.size} student${selected.size === 1 ? '' : 's'} highlighted for correction` : d.can.review ? `${reviewRows.length} rows to check · ${selected.size} selected to send back` : d.submission?.status === 'APPROVED' ? `Approved ${formatDateTime(d.submission.approvedAt)}. Locked.` : 'View only'}
        </p>
        <div className="flex flex-wrap gap-2">
          {d.can.edit && <Button variant="outline" loading={busy === 'save'} onClick={() => save()} disabled={!dirty.size && !workingChanged}><Save /> Save</Button>}
          {d.can.edit && <Button loading={busy === 'submit'} onClick={submit} disabled={!d.rows.length}><Send /> {unitStep ? (d.submission?.status === 'CORRECTION_REQUIRED' ? 'Send corrected Unit Test (OBT)' : 'Send Unit Test (OBT) for verification') : d.submission?.status === 'CORRECTION_REQUIRED' ? 'Send corrected sheet' : 'Submit for verification'}</Button>}
          {d.can.review && !marks && <Button variant="outline" onClick={() => setRejectOpen('rows')} className="border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"><Undo2 /> {selected.size ? `Send back ${selected.size} row${selected.size > 1 ? 's' : ''}` : 'Send back whole sheet'}</Button>}
          {marks && d.can.sendDown && d.can.lowerStep && <Button variant="outline" onClick={() => setRejectOpen('down')} className="border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"><Undo2 /> Send back to {STEP_WHO[d.can.lowerStep]}</Button>}
          {marks && d.can.returnUp && d.can.upperStep && <Button variant="outline" onClick={() => setRejectOpen('up')}><Send /> Return to {STEP_WHO[d.can.upperStep]}</Button>}
          {d.can.review && <Button loading={busy === 'verify'} onClick={() => run('verify', () => api.post(`/submissions/${d.submission!.id}/verify`, {}), stage === 'HEADMASTER_APPROVE' ? (unitStep ? 'Unit Test approved. OBT is locked; the operator can now enter the other marks.' : 'Approved. Marks are locked.') : 'Verified and forwarded')}><Check /> {reviewWord}</Button>}
          {d.can.reopen && <Button variant="outline" onClick={() => setRejectOpen('reopen')}><RotateCcw /> Reopen for correction</Button>}
          {d.can.reopenUnitTest && <Button variant="outline" onClick={() => setRejectOpen('reopenUnit')}><RotateCcw /> Reopen Unit Test (OBT)</Button>}
        </div>
      </div>

      <History d={d} actors={actors} />

      {rejectOpen && (
        <RejectDialog
          mode={rejectOpen} count={rejectOpen === 'rows' ? selected.size : 0} total={d.rows.length}
          onClose={() => setRejectOpen(null)}
          lower={d.can.lowerStep ? STEP_WHO[d.can.lowerStep] : null} upper={d.can.upperStep ? STEP_WHO[d.can.upperStep] : null}
          onConfirm={(reason) => run(rejectOpen, () => api.post(`/submissions/${d.submission!.id}/${rejectOpen === 'up' ? 'return-up' : rejectOpen === 'reopen' ? 'reopen' : rejectOpen === 'reopenUnit' ? 'reopen-unit-test' : 'reject'}`, { reason, enrollmentIds: (rejectOpen === 'rows' || rejectOpen === 'down') && selected.size ? [...selected] : undefined }),
            rejectOpen === 'up' ? `Returned to the ${d.can.upperStep ? STEP_WHO[d.can.upperStep] : 'step above'}` : rejectOpen === 'down' ? `Sent back to the ${d.can.lowerStep ? STEP_WHO[d.can.lowerStep] : 'step below'}` : rejectOpen === 'reopenUnit' ? 'Unit Test reopened: the operator corrects OBT' : 'Sent back to the operator').then(() => { setRejectOpen(null); setSelected(new Set()); })}
          busy={busy === rejectOpen}
        />
      )}
    </div>
  );
}

function PartHead({ p, locked, focus }: { p: MarkPart; locked?: boolean; focus?: boolean }) {
  return (
    <th className={cn('px-1 py-2 text-center normal-case', focus && 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100', locked && 'bg-muted/60')} title={locked ? 'Unit Test approved and locked' : MARK_PARTS[p.key].long}>
      {locked && <Lock className="mx-auto mb-0.5 size-3" />}
      {MARK_PARTS[p.key].label}
      <span className="block font-normal">/{p.max}{p.countAs ? ` → ${countedMax(p)}` : ''}</span>
    </th>
  );
}

function Guidance({ d, marks, reviewCount }: { d: SheetData; marks: boolean; reviewCount: number }) {
  const sub = d.submission;
  let tone = 'info';
  let text: React.ReactNode = null;
  const lastNote = d.history.find((h) => h.action === 'SEND_BACK' || h.action === 'REJECT' || h.action === 'REOPEN');
  if (marks && !d.blankSheet && !sub) {
    tone = 'warn';
    text = <>The Headmaster has not generated the <b>blank mark sheet</b> for this subject yet. Marks can be entered once it is generated.</>;
  } else if (marks && d.can.edit && sub?.status === 'CORRECTION_REQUIRED') {
    tone = 'warn';
    text = <>The <b>whole sheet</b> was sent back for correction{lastNote?.comment ? <>: “{lastNote.comment}”</> : null}. Students to check are <b>highlighted in red</b>. Correct the marks and press <b>Send corrected sheet</b>: it is checked again by the subject teacher, class teacher and Headmaster.</>;
  } else if (marks && d.can.returnUp) {
    tone = 'warn';
    text = <>The {STEP_WHO[d.can.upperStep ?? '']} <b>sent this sheet back to you</b>{lastNote?.comment ? <>: “{lastNote.comment}”</> : null}. Send it further back to the <b>{STEP_WHO[d.can.lowerStep ?? '']}</b> (tick the students to correct), or <b>return it to the {STEP_WHO[d.can.upperStep ?? '']}</b> with a note if it is right.</>;
  } else if (marks && d.can.review && d.step === 'UNIT_TEST') {
    text = <>This is <b>Step 1: Unit Test (OBT) only</b>. Please check the <b>OBT</b> column. If it is right, press <b>{d.submission?.stage === 'HEADMASTER_APPROVE' ? 'Approve Unit Test & lock OBT' : 'Verify'}</b>{d.submission?.stage === 'HEADMASTER_APPROVE' ? ': OBT is locked and the operator can then enter the rest of the semester marks' : ''}. If something is wrong, tick the students and press <b>Send back to {STEP_WHO[d.can.lowerStep ?? ''] ?? 'the step below'}</b> with a note.</>;
  } else if (marks && d.can.review) {
    text = <>{d.lockedParts.includes('OBT') ? <>Step 2: the Unit Test (OBT) was approved earlier and is locked. </> : null}Please check the marks. If everything is right, press <b>{d.submission?.stage === 'HEADMASTER_APPROVE' ? 'Give final approval' : 'Verify'}</b>. If something is wrong, tick the students to correct and press <b>Send back to {STEP_WHO[d.can.lowerStep ?? ''] ?? 'the step below'}</b> with a note: the whole sheet goes back one step.</>;
  } else if (d.can.edit && sub?.status === 'CORRECTION_REQUIRED') {
    tone = 'warn';
    text = <>Some rows were <b>sent back</b> (shown in red with the reason). Correct them and press <b>Send corrected sheet</b>. Corrected rows are checked again by every step, starting with the {marks ? 'subject teacher' : 'verifier'}.</>;
  } else if (marks && d.can.edit && d.step === 'UNIT_TEST') {
    text = <><b>Step 1 of 2: Unit Test (OBT).</b> Enter the <b>OBT</b> marks for every student (type <b>AB</b> if absent, <b>C</b> for copying; both count as 0), press <b>Save</b>, then <b>Send Unit Test (OBT) for verification</b>. It is checked by the subject teacher, class teacher and Headmaster. Once the Headmaster approves, OBT is locked and the other columns open for the semester marks.</>;
  } else if (marks && d.can.edit && d.step === 'FINAL' && d.lockedParts.includes('OBT')) {
    text = <><b>Step 2 of 2: semester marks.</b> The Unit Test (OBT) is approved and <b>locked</b>. Enter the other marks (AB if absent for a part, C for copying; both count as 0), press <b>Save</b>, and when every student is done press <b>Submit for verification</b>.</>;
  } else if (d.can.edit) {
    text = marks
      ? <>You are the <b>operator</b> for this division. Type each part as on the Greensheet (Tab moves right, Enter moves down; you can paste several columns from Excel). If a student missed only one part (e.g. the unit test), type <b>AB</b> in that box; for copying type <b>C</b>. Both are shown on the sheet and count as 0. Tick <b>Absent</b> only when the student missed the whole subject. The totals are calculated for you. Press <b>Save</b>, and when every student is done press <b>Submit for verification</b>.</>
      : <>You are the <b>operator</b> for this division. Type the days present (Enter moves down; you can paste a column from Excel), press <b>Save</b>, and when every student is done press <b>Submit for verification</b>.</>;
  } else if (d.can.review) {
    text = <>Please check the <b>{reviewCount} highlighted row{reviewCount === 1 ? '' : 's'}</b>. If everything is right, press <b>{d.submission?.stage === 'HEADMASTER_APPROVE' ? 'Give final approval' : 'Verify'}</b>. If something is wrong, tick those rows and press <b>Send back</b> with a reason: only those rows go back to the operator.</>;
  } else if (d.can.ownWorkBlocked) {
    tone = 'warn';
    text = <>You entered this data yourself, so someone else must verify it.</>;
  } else if (sub?.status === 'APPROVED') {
    tone = 'ok';
    text = <>Approved by the Headmaster. These {marks ? 'marks' : 'attendance figures'} are locked and can be used for report cards.{d.can.reopen ? ' You can reopen it with a reason if a correction is needed.' : ''}</>;
  } else if (!sub) {
    text = <>Nothing has been entered yet. The operator{d.people.operators.length ? ` (${d.people.operators.join(', ')})` : ''} enters this sheet.</>;
  } else {
    text = <>This sheet is now with the <b>{(marks ? STAGE_ACTOR : ATTENDANCE_STAGE_ACTOR)[sub.stage]}</b>. You can view it; you will be able to act when it reaches you.</>;
  }
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border p-3 text-sm', tone === 'warn' ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100' : tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100')}>
      {tone === 'ok' ? <Lock className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <p>{text}</p>
    </div>
  );
}

function History({ d, actors }: { d: SheetData; actors: Record<string, string> }) {
  if (!d.history.length) return null;
  return (
    <Card className="p-4">
      <h2 className="mb-3 font-semibold">History</h2>
      <ol className="grid gap-2.5 text-sm">
        {d.history.map((h) => (
          <li key={h.id} className="flex gap-3">
            <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', h.action === 'REJECT' || h.action === 'REOPEN' || h.action === 'SEND_BACK' ? 'bg-red-500' : h.action === 'APPROVE' || h.action === 'VERIFY' ? 'bg-emerald-500' : 'bg-sky-500')} />
            <div>
              <p><b>{ACTION_WORDS[h.action] ?? h.action}</b>{h.rowCount != null && h.action !== 'SUBMIT' && h.action !== 'RESUBMIT' ? ` (${h.rowCount} row${h.rowCount === 1 ? '' : 's'})` : ''} by {h.actorName ?? 'someone'} <span className="text-muted-foreground">as {actors[h.stage] ?? h.stage}</span></p>
              {h.comment && <p className="text-muted-foreground">“{h.comment}”</p>}
              <p className="text-xs text-muted-foreground">{formatDateTime(h.createdAt)}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Operator: fill the sheet from an Excel / CSV file (e.g. the blank sheet's Excel, filled in). Nothing is saved until Save. */
function FillFromFile({ d, unit, onFill }: { d: SheetData; unit: Unit; onFill: (p: FilePreview) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const upload = async (f: File) => {
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      setPreview(await api.post<FilePreview>(`/sheets/import?${new URLSearchParams(Object.entries(unit).map(([k, v]) => [k, String(v)])).toString()}`, fd));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
      if (ref.current) ref.current.value = '';
    }
  };
  const missingCols = preview?.columns.filter((c) => !c.found) ?? [];
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm">
        <p className="font-medium">Have the marks in Excel?</p>
        <p className="text-muted-foreground">Download this sheet as Excel, type the marks in it (or use your own sheet with the same column names), then upload it. The marks fill in below for you to check; nothing is saved until you press <b>Save</b>.</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {d.blankSheet && <Button variant="outline" loading={busy} onClick={async () => { setBusy(true); await download(`/blank-sheets/${d.blankSheet!.id}.xlsx`, `${d.blankSheet!.sheetNo}.xlsx`); setBusy(false); }}><FileSpreadsheet /> Download Excel to fill</Button>}
        <Button loading={loading} onClick={() => ref.current?.click()}><FileUp /> Fill marks from Excel / CSV</Button>
        <input ref={ref} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      </div>
      {preview && (
        <Dialog open onOpenChange={(o) => !o && setPreview(null)}>
          <DialogContent title="Fill marks from the file" description={`${preview.fileName}${preview.sheetName ? ` · worksheet "${preview.sheetName}"` : ''} · students matched by ${preview.matchedBy}`}>
            <div className="grid max-h-[60vh] gap-3 overflow-y-auto text-sm">
              <p><b>{preview.rows.length}</b> student{preview.rows.length === 1 ? '' : 's'} found in the file{preview.rows.some((r) => r.absent) ? <> ({preview.rows.filter((r) => r.absent).length} absent)</> : null}.</p>
              <p>Columns read: {preview.columns.filter((c) => c.found).map((c) => c.label).join(', ')}</p>
              {missingCols.length > 0 && <p className="text-amber-700 dark:text-amber-300">Not in the file (left as they are): {missingCols.map((c) => c.label).join(', ')}</p>}
              {preview.issues.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">
                  <p className="mb-1 flex items-center gap-1 font-medium"><AlertTriangle className="size-4" /> Please check</p>
                  <ul className="list-disc space-y-0.5 pl-5">{preview.issues.slice(0, 30).map((x, i) => <li key={i}>{x}</li>)}</ul>
                  {preview.issues.length > 30 && <p>… and {preview.issues.length - 30} more</p>}
                </div>
              )}
              {preview.missing.length > 0 && <p className="text-muted-foreground">No marks in the file for {preview.missing.length} student{preview.missing.length === 1 ? '' : 's'}: {preview.missing.slice(0, 12).map((m) => m.examNo ?? `Roll ${m.rollNo ?? '?'}`).join(', ')}{preview.missing.length > 12 ? ' …' : ''}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
              <Button disabled={!preview.rows.length} onClick={() => { onFill(preview); setPreview(null); }}><Check /> Fill the sheet</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

function RejectDialog({ mode, count, total, onClose, onConfirm, busy, lower, upper }: { mode: 'rows' | 'reopen' | 'reopenUnit' | 'down' | 'up'; count: number; total: number; onClose: () => void; onConfirm: (reason: string) => void; busy: boolean; lower?: string | null; upper?: string | null }) {
  const [reason, setReason] = useState('');
  const title = mode === 'reopenUnit' ? 'Reopen the Unit Test (OBT)' : mode === 'reopen' ? 'Reopen approved sheet'
    : mode === 'down' ? `Send the sheet back to the ${lower ?? 'step below'}`
    : mode === 'up' ? `Return the sheet to the ${upper ?? 'step above'}`
    : count ? `Send back ${count} row${count > 1 ? 's' : ''} to the operator` : `Send back the whole sheet (${total} rows)`;
  const description = mode === 'reopenUnit' ? 'OBT is unlocked and goes back to the operator. The corrected OBT is checked again by the subject teacher, class teacher and you; the other marks wait until then. The reason is recorded.'
    : mode === 'reopen' ? 'The whole sheet goes back to the operator and must pass every step again. The reason is recorded.'
    : mode === 'down' ? `The whole sheet goes back one step${count ? `, with ${count} student${count > 1 ? 's' : ''} highlighted for correction` : ''}. Your note is shown to the ${lower ?? 'step below'}.`
    : mode === 'up' ? `You checked it and it is right: the sheet goes back to the ${upper ?? 'step above'} with your note.`
    : 'The rows you did not select count as checked by you. The operator sees your reason next to each row sent back.';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={description}>
        <Field label="Note" htmlFor="rr" required hint="At least 3 characters"><Textarea id="rr" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === 'up' ? 'e.g. Checked roll 7 against the answer sheet: the marks are right' : 'e.g. Roll 7: marks do not match the answer sheet'} /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'up' ? 'default' : 'destructive'} loading={busy} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>{mode === 'reopen' || mode === 'reopenUnit' ? 'Reopen' : mode === 'up' ? 'Return' : 'Send back'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
