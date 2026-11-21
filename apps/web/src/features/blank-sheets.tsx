import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Eye, FileSpreadsheet, PenLine, Pencil, Plus, Printer, Sheet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';
import { BucketChip, sheetHref, useExams } from './workflow-ui';
import type { ProgressBucket } from '@cps/shared';

interface Column { key: string; label: string; max: number; kind: 'PART' | 'TOTAL_A' | 'TOTAL_B' | 'TOTAL'; countAs?: number | null; stage?: 'FE' | 'SE' }
interface SheetsSubject { classSubjectId: number; subject: string; columns: Column[]; generated?: { id: number; sheetNo: string } | null }
interface SheetsData {
  school: { name: string; address: string };
  year: string;
  exam: { id: number; name: string };
  division: { id: number; label: string; medium: string; std: string; name: string };
  withNames: boolean;
  students: { serialNo: number; rollNo: number | null; examNo: string | null; fullName: string }[];
  sheets: SheetsSubject[];
}
interface Generated extends SheetsData {
  id: number; sheetNo: string; generatedAt: string; updatedAt: string | null; generatedBy: string | null;
  unit: { recordType: 'MARKS'; examId: number; sectionId: number; classSubjectId: number };
  marks: { bucket: ProgressBucket; step: string; returned: boolean };
  can: { editMaxima: boolean; enterMarks: boolean };
}
interface RegisterRow {
  id: number; sheetNo: string; generatedAt: string; generatedBy: string | null; updatedAt: string | null; examId: number; exam: string; year: string;
  sectionId: number; classSubjectId: number; division: string; subject: string; bucket: ProgressBucket; step: string;
}

const PRINT_CSS = `
@page { size: A4 portrait; margin: 10mm; }
.bs-page { background: white; color: black; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.bs-sheet { break-after: page; }
.bs-sheet:last-child { break-after: auto; }
.bs-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.bs-table th, .bs-table td { border: 1px solid #555; padding: 3px 4px; text-align: center; }
.bs-table td.bs-name { text-align: left; white-space: nowrap; }
.bs-table tbody td { height: 22px; }
.bs-subject { background: #fff2a8 !important; font-weight: 700; font-size: 13px; letter-spacing: .02em; }
.bs-max td { background: #bfdbfe !important; font-weight: 700; }
.bs-total { background: #f3f4f6 !important; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
`;

export const download = async (url: string, name: string) => {
  try {
    const blob = await api.get<Blob>(url);
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  } catch (e) {
    toast.error(errorMessage(e));
  }
};

// ======================================================================= register + generate (Headmaster)

/** Blank mark sheets: one per division, subject and semester. The Headmaster generates them and corrects them in place. */
export function BlankSheetsPage() {
  const [params, setParams] = useSearchParams();
  const generating = params.get('new') === '1';
  const register = useQuery({ queryKey: ['blank-sheets', 'register'], queryFn: () => api.get<RegisterRow[]>('/blank-sheets') });
  const setNew = (on: boolean) => { const n = new URLSearchParams(params); if (on) n.set('new', '1'); else { n.delete('new'); n.delete('exam'); n.delete('section'); n.delete('subject'); n.delete('names'); } setParams(n, { replace: true }); };
  return (
    <>
      <PageHeader icon={Sheet} title="Blank mark sheets"
        description="One sheet per class, subject and semester, with the maximum marks of each part. The division's operator sees it at once, prints it and enters the marks on it. To change the maximum marks, open the sheet and correct it."
        actions={!generating && <Button onClick={() => setNew(true)}><Plus /> Generate new sheet</Button>} />
      {(generating || (register.data && register.data.length === 0)) && <Generator onCancel={register.data?.length ? () => setNew(false) : undefined} />}
      {!generating && <QueryView query={register}>{(rows) => (rows.length ? <SheetList rows={rows} headmaster /> : null)}</QueryView>}
    </>
  );
}

/** Operator: the generated sheets of their divisions, to print and to enter marks on. */
export function MarkSheetsPage() {
  const register = useQuery({ queryKey: ['blank-sheets', 'register'], queryFn: () => api.get<RegisterRow[]>('/blank-sheets') });
  return (
    <>
      <PageHeader icon={Sheet} title="Mark sheets" description="The mark sheets the Headmaster generated for your classes. Print the blank sheet for the teacher, then enter the marks and send them to the subject teacher." />
      <QueryView query={register} empty={(r) => (r.length ? null : <Card><EmptyState icon={Sheet} title="No mark sheets yet" description="They appear here as soon as the Headmaster generates them for your classes." /></Card>)}>
        {(rows) => <SheetList rows={rows} />}
      </QueryView>
    </>
  );
}

function SheetList({ rows, headmaster }: { rows: RegisterRow[]; headmaster?: boolean }) {
  const exams = [...new Map(rows.map((r) => [r.examId, `${r.exam} ${r.year}`])).entries()];
  const [exam, setExam] = useState<string>('');
  const [cls, setCls] = useState('');
  const shown = rows.filter((r) => (!exam || String(r.examId) === exam) && (!cls || r.division === cls))
    .sort((a, b) => a.division.localeCompare(b.division, undefined, { numeric: true }) || a.subject.localeCompare(b.subject));
  const divisions = [...new Set(rows.map((r) => r.division))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <Card className="overflow-x-auto">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
        <span className="font-semibold">{headmaster ? 'Generated sheets' : 'Your mark sheets'}</span>
        <Select aria-label="Semester" className="ml-auto h-9 w-48" value={exam} onChange={(e) => setExam(e.target.value)}>
          <option value="">All semesters</option>{exams.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
        <Select aria-label="Class" className="h-9 w-48" value={cls} onChange={(e) => setCls(e.target.value)}>
          <option value="">All classes</option>{divisions.map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
      </div>
      <Table>
        <THead><TR><TH>Class</TH><TH>Subject</TH><TH>Semester</TH><TH>Marks</TH><TH>Sheet</TH><TH /></TR></THead>
        <TBody>
          {shown.map((r) => (
            <TR key={r.id}>
              <TD className="whitespace-nowrap font-medium">{r.division}</TD>
              <TD>{r.subject}</TD>
              <TD className="whitespace-nowrap">{r.exam}</TD>
              <TD><BucketChip bucket={r.bucket} label={r.step} /></TD>
              <TD className="whitespace-nowrap text-xs text-muted-foreground"><span className="font-mono">{r.sheetNo}</span><span className="block">{formatDate(r.generatedAt)}{r.updatedAt ? ' · corrected' : ''}</span></TD>
              <TD className="text-right whitespace-nowrap">
                <Button size="sm" variant="outline" asChild><Link to={`/blank-mark-sheets/${r.id}`}><Eye /> {headmaster ? 'Open' : 'Print'}</Link></Button>{' '}
                {!headmaster && <Button size="sm" asChild><Link to={sheetHref({ recordType: 'MARKS', examId: r.examId, sectionId: r.sectionId, classSubjectId: r.classSubjectId })}><PenLine /> {r.bucket === 'CORRECTION' ? 'Correct marks' : r.bucket === 'NOT_STARTED' || r.bucket === 'OPERATOR' ? 'Enter marks' : 'View marks'}</Link></Button>}
              </TD>
            </TR>
          ))}
          {shown.length === 0 && <TR><TD colSpan={6} className="py-6 text-center text-muted-foreground">No sheets for this choice</TD></TR>}
        </TBody>
      </Table>
    </Card>
  );
}

type PartValues = Record<string, { max: string; countAs: string }>;
const partsFromColumns = (cols: Column[], v?: PartValues) => cols.filter((c) => c.kind === 'PART').map((c) => {
  const x = v?.[c.key];
  return { key: c.key, max: Number(x?.max ?? c.max), ...(x ? (x.countAs ? { countAs: Number(x.countAs) } : {}) : (c.countAs ? { countAs: c.countAs } : {})) };
});
const startValues = (cols: Column[]): PartValues => Object.fromEntries(cols.filter((c) => c.kind === 'PART').map((c) => [c.key, { max: String(c.max), countAs: c.countAs ? String(c.countAs) : '' }]));
const partsInvalid = (parts: { max: number; countAs?: number }[]) => parts.some((p) => !Number.isInteger(p.max) || p.max < 1 || p.max > 200 || (p.countAs !== undefined && (!Number.isInteger(p.countAs) || p.countAs < 1 || p.countAs > p.max)));

/** The maximum marks of one subject's parts, editable. */
function MaximaEditor({ subject, columns, value, onChange }: { subject: string; columns: Column[]; value: PartValues; onChange: (v: PartValues) => void }) {
  const parts = partsFromColumns(columns, value);
  const sum = (stage: 'FE' | 'SE') => parts.filter((_p, i) => columns.filter((c) => c.kind === 'PART')[i].stage === stage).reduce((t, p) => t + (p.countAs ?? p.max), 0);
  const fe = sum('FE');
  const se = sum('SE');
  return (
    <div className="rounded-xl border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-yellow-50 px-3 py-2">
        <b className="min-w-0 flex-1">{subject}</b>
        <span className="text-xs text-muted-foreground">Formative {fe}{se ? ` · Summative ${se} · Total ${fe + se}` : ''}</span>
      </div>
      <div className="flex flex-wrap gap-2 p-3">
        {columns.filter((c) => c.kind === 'PART').map((c) => {
          const v = value[c.key] ?? { max: String(c.max), countAs: c.countAs ? String(c.countAs) : '' };
          const upd = (patch: Partial<typeof v>) => onChange({ ...value, [c.key]: { ...v, ...patch } });
          return (
            <label key={c.key} className={cn('grid w-24 gap-1 rounded-lg border bg-blue-50/60 p-2 text-xs', c.stage === 'SE' && 'bg-indigo-50/60')}>
              <span className="font-medium">{c.label}</span>
              <Input aria-label={`${subject} ${c.label} maximum`} inputMode="numeric" className="h-8 tabular-nums" value={v.max} onChange={(e) => upd({ max: e.target.value.replace(/\D/g, '') })} />
              {c.countAs != null && <span className="text-muted-foreground">counts as <input aria-label="counts as" className="w-8 rounded border px-1" value={v.countAs} onChange={(e) => upd({ countAs: e.target.value.replace(/\D/g, '') })} /></span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Step 1: semester, class, subject. Step 2: maximum marks (from the Mark pattern, editable). Then generate. */
function Generator({ onCancel }: { onCancel?: () => void }) {
  const exams = useExams();
  const overview = useStudentsOverview();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k === 'section' || k === 'exam') n.delete('subject'); setParams(n, { replace: true }); };
  const examId = params.get('exam') ?? (exams.data?.[0] ? String(exams.data[0].id) : '');
  const sectionId = params.get('section') ?? '';
  const subjectId = params.get('subject') ?? '';
  const names = params.get('names') === '1';
  const preview = useQuery({
    queryKey: ['blank-sheets', 'preview', examId, sectionId],
    queryFn: () => api.get<SheetsData>(`/exams/${examId}/blank-sheets${qs({ sectionId })}`),
    enabled: !!examId && !!sectionId,
  });
  const chosen = (preview.data?.sheets ?? []).filter((s) => !subjectId || String(s.classSubjectId) === subjectId);
  const fresh = chosen.filter((s) => !s.generated);
  const done = chosen.filter((s) => s.generated);
  const [maxima, setMaxima] = useState<Record<number, PartValues>>({});
  useEffect(() => { setMaxima(Object.fromEntries((preview.data?.sheets ?? []).map((s) => [s.classSubjectId, startValues(s.columns)]))); }, [preview.data]);
  const bad = fresh.some((s) => partsInvalid(partsFromColumns(s.columns, maxima[s.classSubjectId])));
  const generate = useSave(() => api.post<{ created: { id: number; sheetNo: string; subject: string }[]; skipped: string[] }>('/blank-sheets', {
    examId: Number(examId), sectionId: Number(sectionId), classSubjectId: subjectId ? Number(subjectId) : null, names,
    maxima: fresh.map((s) => ({ classSubjectId: s.classSubjectId, parts: partsFromColumns(s.columns, maxima[s.classSubjectId]) })),
  }), {
    invalidate: [['blank-sheets'], ['exams']],
    onSuccess: (r) => {
      toast.success(r.created.length === 1 ? `Sheet ${r.created[0].sheetNo} generated` : `${r.created.length} sheets generated`);
      navigate(r.created.length === 1 ? `/blank-mark-sheets/${r.created[0].id}` : '/blank-mark-sheets');
    },
  });

  return (
    <div className="mb-6 grid gap-4">
      <Card className="p-4">
        <p className="mb-3 font-semibold">1. Choose the class</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_1.4fr_auto]">
          <Field label="Semester" htmlFor="bse">
            <Select id="bse" value={examId} onChange={(e) => set('exam', e.target.value)}>
              {!exams.data?.length && <option value="">No semester set up</option>}
              {exams.data?.map((x) => <option key={x.id} value={x.id}>{x.nameEn}</option>)}
            </Select>
          </Field>
          <Field label="Class" htmlFor="bsc">
            <Select id="bsc" value={sectionId} onChange={(e) => set('section', e.target.value)}>
              <option value="">— Choose the class —</option>
              {overview.data?.sections.map((d) => <option key={d.sectionId} value={d.sectionId}>{divisionLabel(d)} ({d.students} students)</option>)}
            </Select>
          </Field>
          <Field label="Subject" htmlFor="bss">
            <Select id="bss" value={subjectId} disabled={!preview.data} onChange={(e) => set('subject', e.target.value)}>
              <option value="">All subjects (one sheet each)</option>
              {preview.data?.sheets.map((s) => <option key={s.classSubjectId} value={s.classSubjectId}>{s.subject}{s.generated ? ' (already generated)' : ''}</option>)}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm whitespace-nowrap"><Checkbox checked={names} onChange={(e) => set('names', e.target.checked ? '1' : '')} /> Include student names</label>
        </div>
      </Card>

      {sectionId && (
        <QueryView query={preview}>
          {() => chosen.length === 0 ? (
            <Card><EmptyState icon={Sheet} title="No subjects for this class yet" description="Attach subjects to the class first (School setup → Classes)." /></Card>
          ) : (
            <Card className="p-4">
              {done.length > 0 && (
                <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  <b>Already generated</b> (only one sheet per subject; open it to correct the maximum marks):{' '}
                  {done.map((s, i) => <span key={s.classSubjectId}>{i ? ', ' : ''}<Link className="font-medium underline" to={`/blank-mark-sheets/${s.generated!.id}`}>{s.subject}</Link></span>)}
                </div>
              )}
              {fresh.length > 0 ? (
                <>
                  <p className="font-semibold">2. Maximum marks</p>
                  <p className="mb-3 text-sm text-muted-foreground">Check or change the maximum marks of each part. They are saved as the Mark pattern of this class for {exams.data?.find((x) => String(x.id) === examId)?.nameEn ?? 'this semester'} (all divisions) and printed in the blue row.</p>
                  <div className="grid gap-3">
                    {fresh.map((s) => <MaximaEditor key={s.classSubjectId} subject={s.subject} columns={s.columns} value={maxima[s.classSubjectId] ?? {}} onChange={(v) => setMaxima((m) => ({ ...m, [s.classSubjectId]: v }))} />)}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    <Link to="/exams/pattern" className="mr-auto text-sm text-primary hover:underline">Add or remove parts in Mark pattern</Link>
                    {onCancel && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
                    <Button disabled={bad} loading={generate.isPending} onClick={() => generate.mutate(undefined)}>Save maximum marks &amp; generate {fresh.length > 1 ? `${fresh.length} sheets` : 'sheet'}</Button>
                  </div>
                </>
              ) : (
                <div className="flex justify-end">{onCancel && <Button variant="outline" onClick={onCancel}>Back</Button>}</div>
              )}
            </Card>
          )}
        </QueryView>
      )}
    </div>
  );
}

// ======================================================================= one sheet (Headmaster or operator)

export function BlankSheetViewPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['blank-sheets', 'one', id], queryFn: () => api.get<Generated>(`/blank-sheets/${id}`) });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="print:hidden">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to={q.data?.can.enterMarks ? '/marks' : '/blank-mark-sheets'}><ArrowLeft /> Mark sheets</Link></Button>
      </div>
      <QueryView query={q}>
        {(d) => (
          <>
            <div className="print:hidden">
              <PageHeader title={`${d.division.label} · ${d.sheets[0]?.subject ?? ''}`}
                description={`${d.exam.name} ${d.year} · Sheet ${d.sheetNo} · generated ${formatDate(d.generatedAt)}${d.generatedBy ? ` by ${d.generatedBy}` : ''}${d.updatedAt ? ` · corrected ${formatDate(d.updatedAt)}` : ''}`}
                actions={<div className="flex flex-wrap gap-2">
                  {d.can.enterMarks && <Button asChild><Link to={sheetHref(d.unit)}><PenLine /> {d.marks.bucket === 'CORRECTION' ? 'Correct marks' : 'Enter marks'}</Link></Button>}
                  <Button variant={d.can.enterMarks ? 'outline' : 'default'} onClick={() => window.print()}><Printer /> Print</Button>
                  <Button variant="outline" loading={busy} onClick={async () => { setBusy(true); await download(`/blank-sheets/${d.id}.xlsx`, `${d.sheetNo}.xlsx`); setBusy(false); }}><FileSpreadsheet /> Excel</Button>
                  {d.can.editMaxima && !editing && <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit maximum marks</Button>}
                </div>} />
              <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Marks:</span><BucketChip bucket={d.marks.bucket} label={d.marks.step} />
                {!d.can.editMaxima && d.marks.bucket !== 'NOT_STARTED' && d.marks.bucket !== 'OPERATOR' && d.marks.bucket !== 'CORRECTION' && <span className="text-xs text-muted-foreground">Maximum marks are locked while the marks are being approved.</span>}
              </div>
              {editing && <MaximaEdit d={d} onDone={() => setEditing(false)} />}
            </div>
            <div className="bs-page mx-auto max-w-[210mm] bg-white p-[8mm] shadow-card print:max-w-none print:p-0 print:shadow-none">
              <style>{PRINT_CSS}</style>
              {d.sheets.map((s) => <SheetPage key={s.classSubjectId} d={d} sheet={s} />)}
            </div>
          </>
        )}
      </QueryView>
    </>
  );
}

/** The Headmaster corrects the maximum marks of this sheet (same sheet, no second one). */
function MaximaEdit({ d, onDone }: { d: Generated; onDone: () => void }) {
  const s = d.sheets[0];
  const start = useMemo(() => startValues(s.columns), [s]);
  const [value, setValue] = useState<PartValues>(start);
  const [names, setNames] = useState(d.withNames);
  const parts = partsFromColumns(s.columns, value);
  const save = useSave(() => api.put(`/blank-sheets/${d.id}/maxima`, { parts, names }), { invalidate: [['blank-sheets'], ['exams'], ['sheet']], success: 'Maximum marks corrected', onSuccess: onDone });
  return (
    <Card className="mb-4 p-4">
      <p className="mb-3 font-semibold">Correct the maximum marks</p>
      <MaximaEditor subject={s.subject} columns={s.columns} value={value} onChange={setValue} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <label className="mr-auto flex items-center gap-2 text-sm"><Checkbox checked={names} onChange={(e) => setNames(e.target.checked)} /> Include student names</label>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={partsInvalid(parts)} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
      </div>
    </Card>
  );
}

function SheetPage({ d, sheet }: { d: SheetsData & { sheetNo?: string }; sheet: SheetsData['sheets'][number] }) {
  const lead = d.withNames ? 3 : 2;
  return (
    <section className="bs-sheet mb-10 print:mb-0">
      <header className="mb-2 text-center">
        <h1 className="text-lg font-bold" style={{ fontFamily: 'Georgia, serif' }}>{d.school.name}</h1>
        <p className="text-[12px] font-semibold">Marks for the Academic year {d.year} · {d.exam.name}</p>
        <p className="text-[11px]">{d.division.medium} · {d.division.std} · Division {d.division.name}{d.sheetNo ? ` · Sheet ${d.sheetNo}` : ''}</p>
      </header>
      <table className="bs-table">
        <thead>
          <tr><th colSpan={lead + sheet.columns.length} className="bs-subject">Subject: {sheet.subject.toUpperCase()}</th></tr>
          <tr>
            <th style={{ width: 34 }}>Sr. No</th>
            <th style={{ width: 70 }}>Exam No</th>
            {d.withNames && <th>Student name</th>}
            {sheet.columns.map((c) => <th key={c.key} className={c.kind !== 'PART' ? 'bs-total' : undefined}>{c.label}{c.countAs ? <span className="block text-[9px] font-normal">({c.max}→{c.countAs})</span> : null}</th>)}
          </tr>
          <tr className="bs-max">
            <td>Max.</td>
            <td />
            {d.withNames && <td />}
            {sheet.columns.map((c) => <td key={c.key}>{c.max}</td>)}
          </tr>
        </thead>
        <tbody>
          {d.students.map((st) => (
            <tr key={st.serialNo}>
              <td>{st.rollNo ?? st.serialNo}</td>
              <td className="font-mono">{st.examNo ?? ''}</td>
              {d.withNames && <td className="bs-name">{st.fullName}</td>}
              {sheet.columns.map((c) => <td key={c.key} className={c.kind !== 'PART' ? 'bs-total' : undefined} />)}
            </tr>
          ))}
          {d.students.length === 0 && <tr><td colSpan={lead + sheet.columns.length} className="text-muted-foreground">No students in this division yet</td></tr>}
        </tbody>
      </table>
      <div className="mt-8 grid grid-cols-2 gap-16 text-center text-[11px]">
        <p className="border-t border-black pt-1">Subject teacher</p>
        <p className="border-t border-black pt-1">Class teacher</p>
      </div>
    </section>
  );
}
