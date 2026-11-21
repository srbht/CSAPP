import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MONTHLY_MAX, MONTHLY_SKILLS, MONTHLY_STATUS_LABELS, monthlyResult, type MonthlyScore } from '@cps/shared';
import { AlertTriangle, ArrowLeft, CheckCircle2, ListChecks, PenLine, Printer, Save, Send, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, QueryView } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, qs } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';

interface Months { year: string; months: { value: string; label: string }[]; current: string | null }
interface ListItem { sectionId: number; division: string; classSubjectId: number; subject: string; teacher: string | null; status: string; submittedAt: string | null; mine: boolean }
interface SheetData {
  school: { name: string; address: string };
  year: string; month: string; monthLabel: string;
  division: { id: number; label: string };
  subject: { classSubjectId: number; name: string };
  teacher: string | null; classTeacher: string | null;
  status: string;
  submittedBy: string | null; submittedAt: string | null;
  returnNote: string | null; returnedBy: string | null; returnedAt: string | null;
  students: { enrollmentId: number; serialNo: number; rollNo: number | null; examNo: string | null; fullName: string; scores: Record<string, MonthlyScore> }[];
  can: { edit: boolean; submit: boolean; sendBack: boolean };
}

const useMonths = () => useQuery({ queryKey: ['monthly', 'months'], queryFn: () => api.get<Months>('/monthly-performance/months') });
const STATUS_TONE: Record<string, string> = {
  NOT_STARTED: 'bg-muted text-muted-foreground', DRAFT: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  SUBMITTED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200', RETURNED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};
const sheetLink = (i: { sectionId: number; classSubjectId: number }, month: string) => `/monthly-performance/sheet${qs({ sectionId: i.sectionId, classSubjectId: i.classSubjectId, month })}`;

/** Monthly performance: the month's sheets (subject teachers: their own; class teacher: their class; Headmaster: all). */
export function MonthlyPage() {
  const months = useMonths();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? months.data?.current ?? '';
  const [cls, setCls] = useState('');
  const list = useQuery({ queryKey: ['monthly', 'list', month], queryFn: () => api.get<{ items: ListItem[] }>(`/monthly-performance${qs({ month })}`), enabled: !!month });
  const items = list.data?.items ?? [];
  const divisions = [...new Set(items.map((i) => i.division))];
  const shown = items.filter((i) => !cls || i.division === cls);
  const done = shown.filter((i) => i.status === 'SUBMITTED').length;
  return (
    <>
      <PageHeader icon={ListChecks} title="Monthly performance"
        description={`Every month each subject teacher scores every student on ${MONTHLY_SKILLS.length} skills (0–${MONTHLY_MAX}) and submits. The total, % and grade are worked out for you. The class teacher sees every sheet of their class; the Headmaster sees all and can send one back with a note.`} />
      <Card className="overflow-x-auto">
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
          <Select aria-label="Month" className="h-9 w-48" value={month} onChange={(e) => setParams({ month: e.target.value }, { replace: true })}>
            {months.data?.months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
          <Select aria-label="Class" className="h-9 w-48" value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">All classes</option>{divisions.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
          {shown.length > 0 && <span className="ml-auto text-sm text-muted-foreground">{done} of {shown.length} submitted</span>}
        </div>
        <QueryView query={list} empty={(d) => (d.items.length ? null : <EmptyState icon={ListChecks} title="No sheets for you" description="Sheets appear here for the classes and subjects you teach, or for your class if you are a class teacher." />)}>
          {() => (
            <Table>
              <THead><TR><TH>Class</TH><TH>Subject</TH><TH>Subject teacher</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {shown.map((i) => (
                  <TR key={`${i.sectionId}:${i.classSubjectId}`}>
                    <TD className="whitespace-nowrap font-medium">{i.division}</TD>
                    <TD>{i.subject}{i.mine && <Badge variant="secondary" className="ml-2">yours</Badge>}</TD>
                    <TD className="text-muted-foreground">{i.teacher ?? 'not assigned'}</TD>
                    <TD><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[i.status])}>{MONTHLY_STATUS_LABELS[i.status]}</span>{i.submittedAt && <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(i.submittedAt)}</span>}</TD>
                    <TD className="text-right">
                      <Button size="sm" variant={i.mine && i.status !== 'SUBMITTED' ? 'default' : 'outline'} asChild>
                        <Link to={sheetLink(i, month)}><PenLine /> {i.mine && i.status !== 'SUBMITTED' ? (i.status === 'RETURNED' ? 'Correct' : 'Fill') : 'Open'}</Link>
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Card>
    </>
  );
}

const CSS = `
@page { size: A4 landscape; margin: 8mm; }
.mp-page { background: white; color: black; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.mp-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.mp-table th, .mp-table td { border: 1px solid #444; padding: 2px 3px; text-align: center; }
.mp-table td.mp-name { text-align: left; }
.mp-table thead th { background: #f1f5f9 !important; }
.mp-foot td { background: #f8fafc !important; font-weight: 600; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
`;
const txt = (v: MonthlyScore | string | undefined) => (v == null ? '' : String(v));

/** One month's sheet for a class and subject: the teacher types 0–5 (or AB) per skill. */
export function MonthlySheetPage() {
  const [p] = useSearchParams();
  const key = { sectionId: Number(p.get('sectionId')), classSubjectId: Number(p.get('classSubjectId')), month: p.get('month') ?? '' };
  const q = useQuery({ queryKey: ['monthly', 'sheet', key], queryFn: () => api.get<SheetData>(`/monthly-performance/sheet${qs(key)}`), enabled: !!key.sectionId && !!key.month });
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2 print:hidden" asChild><Link to={`/monthly-performance${qs({ month: key.month })}`}><ArrowLeft /> Monthly performance</Link></Button>
      <QueryView query={q}>{(d) => <Sheet key={`${d.status}:${d.submittedAt}`} d={d} k={key} />}</QueryView>
    </>
  );
}

function Sheet({ d, k }: { d: SheetData; k: { sectionId: number; classSubjectId: number; month: string } }) {
  const qc = useQueryClient();
  const logo = useSchoolLogo();
  const initial = useMemo(() => Object.fromEntries(d.students.map((s) => [s.enrollmentId, Object.fromEntries(MONTHLY_SKILLS.map((x) => [x.key, txt(s.scores[x.key])]))])) as Record<number, Record<string, string>>, [d]);
  const [values, setValues] = useState(initial);
  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [backOpen, setBackOpen] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  useEffect(() => { setValues(initial); setDirty(new Set()); }, [initial]);

  const parse = (v: string): MonthlyScore => { const t = v.trim(); if (!t) return null; if (/^ab$/i.test(t)) return 'AB'; const n = Number(t); return Number.isInteger(n) && n >= 0 && n <= MONTHLY_MAX ? n : null; };
  const bad = (v: string) => v.trim() !== '' && parse(v) == null;
  const set = (id: number, skill: string, v: string) => { setValues((x) => ({ ...x, [id]: { ...x[id], [skill]: v } })); setDirty((s) => new Set(s).add(id)); };
  const refresh = () => qc.invalidateQueries({ queryKey: ['monthly'] });
  const call = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name);
    try { await fn(); toast.success(ok); await refresh(); return true; } catch (e) { toast.error(errorMessage(e)); return false; } finally { setBusy(null); }
  };
  const save = async (quiet = false) => {
    if (!dirty.size) return true;
    if (d.students.some((s) => MONTHLY_SKILLS.some((x) => bad(values[s.enrollmentId][x.key])))) { toast.error(`Use whole numbers 0 to ${MONTHLY_MAX}, or AB`); return false; }
    return call('save', () => api.put('/monthly-performance/sheet', {
      ...k, rows: d.students.filter((s) => dirty.has(s.enrollmentId)).map((s) => ({ enrollmentId: s.enrollmentId, scores: Object.fromEntries(MONTHLY_SKILLS.map((x) => [x.key, values[s.enrollmentId][x.key].trim()])) })),
    }), quiet ? 'Saved' : 'Saved');
  };
  const submit = async () => { setShowEmpty(true); if (await save(true)) await call('submit', () => api.post('/monthly-performance/sheet/submit', k), 'Submitted. The class teacher and the Headmaster can now see it.'); };
  const next = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const col = e.currentTarget.dataset.col;
    const row = Number(e.currentTarget.dataset.row) + (e.key === 'ArrowUp' ? -1 : 1);
    document.querySelector<HTMLInputElement>(`input[data-col="${col}"][data-row="${row}"]`)?.focus();
  };
  const result = (id: number) => monthlyResult(Object.fromEntries(MONTHLY_SKILLS.map((x) => [x.key, parse(values[id][x.key])])));
  const filled = d.students.filter((s) => MONTHLY_SKILLS.every((x) => values[s.enrollmentId][x.key].trim() !== '')).length;
  const avg = (skill: string) => {
    const nums = d.students.map((s) => parse(values[s.enrollmentId][skill])).filter((v): v is number | 'AB' => v != null).map((v) => (v === 'AB' ? 0 : v));
    return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : '';
  };
  const edit = d.can.edit;

  return (
    <div className="grid gap-4">
      <div className="print:hidden">
        {d.status === 'RETURNED' && d.returnNote && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /><p><b>Sent back by {d.returnedBy ?? 'the Headmaster'}</b> ({formatDateTime(d.returnedAt)}): “{d.returnNote}”. Correct the scores and press <b>Submit</b> again.</p>
          </div>
        )}
        {d.status === 'SUBMITTED' && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" /><p>Submitted by <b>{d.submittedBy}</b> on {formatDateTime(d.submittedAt)}. {d.can.sendBack ? 'If something is wrong, send it back to the teacher with a note.' : 'Locked.'}</p>
          </div>
        )}
        {edit && d.status !== 'RETURNED' && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-100">
            <PenLine className="mt-0.5 size-4 shrink-0" /><p>Type a score from <b>0 to {MONTHLY_MAX}</b> for each skill (<b>AB</b> if the student was absent; counts as 0). Enter moves down. The total, % and grade are worked out for you. Press <b>Save</b>, and when every student is done press <b>Submit</b>.</p>
          </div>
        )}
      </div>

      <div className="mp-page mx-auto w-full max-w-[297mm] overflow-x-auto rounded-xl bg-white p-[6mm] shadow-card print:max-w-none print:overflow-visible print:rounded-none print:p-0 print:shadow-none">
        <style>{CSS}</style>
        <header className="mb-2">
          <div className="flex items-center gap-3 border-b-2 border-black pb-1">
            {logo.data ? <img src={logo.data} alt="" className="h-12 w-14 object-contain" /> : <div className="w-14" />}
            <div className="flex-1 text-center">
              <h1 className="text-lg font-bold" style={{ fontFamily: 'Georgia, serif' }}>{d.school.name}</h1>
              {d.school.address && <p className="text-[11px]">{d.school.address}</p>}
              <p className="text-[13px] font-semibold">Monthly Performance {d.year} · Month – {d.monthLabel}</p>
            </div>
            <div className="w-14" />
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-2 text-[12px] font-semibold">
            <span>Class – {d.division.label}</span><span>Subject – {d.subject.name}</span><span>Subject teacher – {d.teacher ?? '—'}</span>
          </div>
        </header>
        <table className="mp-table">
          <thead>
            <tr>
              <th rowSpan={2} style={{ width: 30 }}>Sr. No</th>
              <th rowSpan={2} style={{ width: 64 }}>Exam No</th>
              <th rowSpan={2}>Name of the Student</th>
              <th colSpan={MONTHLY_SKILLS.length}>{d.subject.name}</th>
              <th rowSpan={2} style={{ width: 44 }}>Total<span className="block font-normal">/{MONTHLY_SKILLS.length * MONTHLY_MAX}</span></th>
              <th rowSpan={2} style={{ width: 44 }}>%</th>
              <th rowSpan={2} style={{ width: 40 }}>Grade</th>
            </tr>
            <tr>{MONTHLY_SKILLS.map((x) => <th key={x.key} style={{ width: 54 }}>{x.label}<span className="block font-normal">/{MONTHLY_MAX}</span></th>)}</tr>
          </thead>
          <tbody>
            {d.students.map((s, i) => {
              const r = result(s.enrollmentId);
              return (
                <tr key={s.enrollmentId} className={cn(dirty.has(s.enrollmentId) && 'bg-sky-50/60 print:bg-transparent')}>
                  <td>{s.rollNo ?? s.serialNo}</td>
                  <td className="font-mono">{s.examNo ?? ''}</td>
                  <td className="mp-name">{s.fullName}</td>
                  {MONTHLY_SKILLS.map((x) => {
                    const v = values[s.enrollmentId][x.key];
                    return (
                      <td key={x.key} className="p-0.5">
                        {edit ? (
                          <Input aria-label={`Roll ${s.rollNo} ${x.label}`} data-col={x.key} data-row={i} inputMode="numeric" value={v} onChange={(e) => set(s.enrollmentId, x.key, e.target.value)} onKeyDown={next}
                            className={cn('mx-auto h-7 w-11 px-1 text-center tabular-nums print:border-0', bad(v) && 'border-destructive text-destructive', /^ab$/i.test(v.trim()) && 'border-amber-400 bg-amber-50 uppercase', showEmpty && v.trim() === '' && 'border-2 border-dashed border-red-400 bg-red-50/60')} />
                        ) : <span className="tabular-nums">{v}</span>}
                      </td>
                    );
                  })}
                  <td className="font-semibold tabular-nums">{r.total ?? ''}</td>
                  <td className="tabular-nums">{r.percent == null ? '' : r.percent}</td>
                  <td className="font-semibold">{r.grade ?? ''}</td>
                </tr>
              );
            })}
            {d.students.length > 0 && (
              <tr className="mp-foot"><td colSpan={3} className="mp-name">Class average</td>{MONTHLY_SKILLS.map((x) => <td key={x.key}>{avg(x.key)}</td>)}<td colSpan={3} /></tr>
            )}
            {d.students.length === 0 && <tr><td colSpan={6 + MONTHLY_SKILLS.length} className="py-4 text-muted-foreground">No students in this class</td></tr>}
          </tbody>
        </table>
        <p className="mt-1 text-[10px]">Each skill out of {MONTHLY_MAX}. AB = absent (counted as 0). Grade: A1 91–100, A2 81–90, B1 71–80, B2 61–70, C1 51–60, C2 41–50, D 33–40, E1 21–32, E2 up to 20.</p>
        <div className="mt-8 grid grid-cols-3 gap-12 text-center text-[11px]">
          <p className="border-t border-black pt-1">Subject teacher{d.teacher ? ` (${d.teacher})` : ''}</p>
          <p className="border-t border-black pt-1">Class teacher{d.classTeacher ? ` (${d.classTeacher})` : ''}</p>
          <p className="border-t border-black pt-1">Headmaster</p>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border print:hidden">
        <p className="text-sm text-muted-foreground">{edit ? `${filled} of ${d.students.length} complete${dirty.size ? ` · ${dirty.size} unsaved` : ''}` : `${MONTHLY_STATUS_LABELS[d.status]}`}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => window.print()}><Printer /> Print</Button>
          {edit && <Button variant="outline" loading={busy === 'save'} disabled={!dirty.size} onClick={() => save()}><Save /> Save</Button>}
          {d.can.submit && <Button loading={busy === 'submit'} disabled={!d.students.length} onClick={submit}><Send /> Submit</Button>}
          {d.can.sendBack && <Button variant="outline" className="border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300" onClick={() => setBackOpen(true)}><Undo2 /> Send back to teacher</Button>}
        </div>
      </div>
      {backOpen && <SendBack busy={busy === 'back'} onClose={() => setBackOpen(false)} onConfirm={async (reason) => { if (await call('back', () => api.post('/monthly-performance/sheet/send-back', { ...k, reason }), 'Sent back to the subject teacher')) setBackOpen(false); }} />}
    </div>
  );
}

function SendBack({ onClose, onConfirm, busy }: { onClose: () => void; onConfirm: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Send back to the subject teacher" description="The sheet opens again for the teacher, with your note at the top.">
        <Field label="Note" htmlFor="mp-r" required hint="At least 3 characters"><Textarea id="mp-r" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Roll 7: Reading score missing" /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" loading={busy} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Send back</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
