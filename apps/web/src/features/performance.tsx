import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Printer, TrendingUp } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { EmptyState, PageHeader, QueryView } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form-controls';
import { useSchoolLogo } from '@/components/layout';
import { Card } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';

type Cell = number | 'AB' | 'C' | null;
interface Subject { classSubjectId: number; name: string; short: string; max: number; inTotal: boolean; approved: boolean; teacher: string | null }
interface Student { enrollmentId: number; serialNo: number; rollNo: number | null; examNo: string | null; studentCode: string; fullName: string; gender: string; marks: Record<string, Cell>; total: number | null; percent: number | null; rank: number | null; history: { key: string; percent: number | null }[] }
interface Summary { classSubjectId: number; onRoll: number; absentLeft: number; appeared: number | null; passed: number | null; failed: number | null; passPercent: number | null; highest: number | null; average: number | null }
interface Report {
  school: { name: string; address: string };
  year: string;
  report: { key: string; title: string; short: string; part: 'OBT' | 'WRITTEN'; examName: string; heading: string };
  /** Earlier reports of the year (for the progress columns), in order. */
  earlier: { key: string; title: string; short: string; available: boolean }[];
  division: { id: number; label: string; medium: string; name: string; classTeacher: string | null };
  passPercent: number;
  subjects: Subject[];
  pending: string[];
  complete: boolean;
  maxTotal: number;
  students: Student[];
  summary: Summary[];
  classAverage: number | null;
}

const CSS = `
.pr-page { background: white; color: black; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pr-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.pr-table th, .pr-table td { border: 1px solid #444; padding: 3px 4px; text-align: center; }
.pr-table td.pr-name { text-align: left; }
.pr-table thead th { background: #f1f5f9 !important; }
.pr-foot td { background: #f8fafc !important; font-weight: 600; }
.pr-card { break-inside: avoid; }
.pr-card + .pr-card { border-top: 1px dashed #999; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
`;
const cellText = (c: Cell | undefined) => (c == null ? '' : String(c));
const fmt = (n: number | null | undefined) => (n == null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(2));
const REPORTS = [
  { key: 'UT1', title: '1st Unit Test' }, { key: 'SEM1', title: 'Semester I' }, { key: 'UT2', title: '2nd Unit Test' }, { key: 'SEM2', title: 'Semester II' },
];
/** A student's % in every report so far, oldest first (the current one last), with ▲ / ▼ against the one before. */
function progress(d: Report, s: Student) {
  const list = [...d.earlier.map((e, i) => ({ key: e.key, title: e.title, short: e.short, percent: s.history[i]?.percent ?? null })), { key: d.report.key, title: d.report.title, short: d.report.short, percent: s.percent }];
  let prev: number | null = null;
  return list.map((x) => {
    const trend = x.percent != null && prev != null ? (x.percent > prev ? 'up' : x.percent < prev ? 'down' : 'same') : null;
    if (x.percent != null) prev = x.percent;
    return { ...x, trend };
  });
}
function Pct({ p, trend, suffix = '' }: { p: number | null; trend: string | null; suffix?: string }) {
  if (p == null) return null;
  return (
    <span className="whitespace-nowrap">
      {fmt(p)}{suffix}
      {trend === 'up' && <span className="ml-0.5 text-emerald-700" title="Better than the exam before">▲</span>}
      {trend === 'down' && <span className="ml-0.5 text-red-700" title="Lower than the exam before">▼</span>}
    </span>
  );
}

/** Performance reports after each unit test: the class sheet (as on the school's register) and a report per student. */
export function PerformancePage() {
  const overview = useStudentsOverview();
  const [params, setParams] = useSearchParams();
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k !== 'student' && k !== 'view') n.delete('student'); setParams(n, { replace: true }); };
  const reportKey = params.get('report') ?? 'UT1';
  const sectionId = params.get('section') ?? '';
  const view = params.get('view') === 'students' ? 'students' : 'class';
  const student = params.get('student') ?? '';
  const report = useQuery({
    queryKey: ['performance', reportKey, sectionId],
    queryFn: () => api.get<Report>(`/performance/report${qs({ report: reportKey, sectionId })}`),
    enabled: !!sectionId,
  });

  return (
    <>
      <div className="print:hidden">
        <PageHeader icon={TrendingUp} title="Performance reports"
          description="After each exam: the class marks sheet and a report for every student, with the % of every earlier exam to follow the progress. Unit tests use the OBT marks, semesters the Written marks, once the Headmaster has approved them. AB and C count as 0. Activity subjects (Art, PT, Work Experience, Art & Craft) are not included." />
        <Card className="mb-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_auto]">
            <Field label="Report" htmlFor="pr-e">
              <Select id="pr-e" value={reportKey} onChange={(e) => set('report', e.target.value)}>
                {REPORTS.map((x) => <option key={x.key} value={x.key}>{x.title}</option>)}
              </Select>
            </Field>
            <Field label="Class" htmlFor="pr-c">
              <Select id="pr-c" value={sectionId} onChange={(e) => set('section', e.target.value)}>
                <option value="">— Choose the class —</option>
                {overview.data?.sections.map((d) => <option key={d.sectionId} value={d.sectionId}>{divisionLabel(d)} ({d.students} students)</option>)}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <div className="inline-flex rounded-lg border p-0.5 text-sm" role="tablist">
                {(['class', 'students'] as const).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => set('view', v === 'class' ? '' : v)}
                    className={cn('rounded-md px-3 py-1.5', view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    {v === 'class' ? 'Class sheet' : 'Student reports'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {!sectionId ? (
        <Card className="print:hidden"><EmptyState icon={TrendingUp} title="Choose the report and the class" description="Unit tests show the OBT marks, semesters the Written marks, once the Headmaster has approved them." /></Card>
      ) : (
        <QueryView query={report}>
          {(d) => (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
                {d.pending.length > 0 && (
                  <div className="flex flex-1 items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <p><b>Not approved yet:</b> {d.pending.join(', ')}. These columns stay empty and the rank is shown once every subject is approved{d.report.part === 'WRITTEN' ? ' (the Headmaster\'s final approval of the semester sheet)' : ' (the Headmaster\'s approval of the unit test)'}.</p>
                  </div>
                )}
                {view === 'students' && (
                  <Select aria-label="Student" className="h-9 w-72" value={student} onChange={(e) => set('student', e.target.value)}>
                    <option value="">All students ({d.students.length})</option>
                    {d.students.map((s) => <option key={s.enrollmentId} value={s.enrollmentId}>{s.rollNo ?? s.serialNo}. {s.fullName}</option>)}
                  </Select>
                )}
                <Button className="ml-auto" onClick={() => window.print()} disabled={!d.subjects.length}><Printer /> Print</Button>
              </div>
              {!d.subjects.length ? (
                <Card><EmptyState icon={TrendingUp} title={`No ${d.report.part === 'OBT' ? 'Unit Test (OBT)' : 'Written'} column in this class`} description={`None of this class's subjects has a ${d.report.part === 'OBT' ? 'Unit Test (OBT)' : 'Written'} column in its mark pattern for ${d.report.examName}.`} /></Card>
              ) : (
                <div className="pr-page mx-auto max-w-[297mm] overflow-x-auto bg-white p-[8mm] shadow-card print:max-w-none print:overflow-visible print:p-0 print:shadow-none">
                  <style>{CSS + (view === 'class' ? '@page { size: A4 landscape; margin: 8mm; }' : '@page { size: A4 portrait; margin: 10mm; }')}</style>
                  {view === 'class' ? <ClassSheet d={d} /> : d.students.filter((s) => !student || String(s.enrollmentId) === student).map((s) => <StudentReport key={s.enrollmentId} d={d} s={s} />)}
                </div>
              )}
            </>
          )}
        </QueryView>
      )}
    </>
  );
}

function Head({ d, title }: { d: Report; title: string }) {
  const logo = useSchoolLogo();
  return (
    <header className="mb-2">
      <div className="flex items-center gap-3 border-b-2 border-black pb-1">
        {logo.data ? <img src={logo.data} alt="" className="h-14 w-16 object-contain" /> : <div className="w-16" />}
        <div className="flex-1 text-center">
          <h1 className="text-lg font-bold" style={{ fontFamily: 'Georgia, serif' }}>{d.school.name}</h1>
          {d.school.address && <p className="text-[11px]">{d.school.address}</p>}
        </div>
        <div className="w-16" />
      </div>
      <p className="mt-1 text-center text-[13px] font-semibold">{title}</p>
    </header>
  );
}

/** The school's "Unit Test Marks" register: one row per student, one column per subject. */
function ClassSheet({ d }: { d: Report }) {
  const rows: [string, (s: Summary) => string][] = [
    ['Total Students on Roll', (s) => String(s.onRoll)],
    ['Total No. of Students Absent / Left', (s) => String(s.absentLeft)],
    ['Total No. of Students Appeared', (s) => fmt(s.appeared)],
    [`Total No. of Students Passed (${d.passPercent}% and above)`, (s) => fmt(s.passed)],
    [`Total No. of Students Failed (below ${d.passPercent}%)`, (s) => fmt(s.failed)],
    ['Result %', (s) => fmt(s.passPercent)],
    ['Highest Marks', (s) => fmt(s.highest)],
    ['Average Marks', (s) => fmt(s.average)],
  ];
  const sum = new Map(d.summary.map((s) => [s.classSubjectId, s]));
  return (
    <section>
      <Head d={d} title={d.report.heading} />
      <p className="mb-1 text-[12px] font-semibold">Class- {d.division.label}</p>
      <table className="pr-table">
        <thead>
          <tr>
            <th rowSpan={2} style={{ width: 28 }}>Sr. No</th>
            <th rowSpan={2} style={{ width: 62 }}>Exam No</th>
            <th rowSpan={2}>Name of Student</th>
            {d.subjects.map((s) => <th key={s.classSubjectId} title={s.name}>{s.short}{!s.inTotal ? '*' : ''}</th>)}
            <th>Total</th>
            {d.earlier.map((e) => <th key={e.key} rowSpan={2} style={{ width: 52 }} className="bg-slate-100">{e.short} %</th>)}
            <th rowSpan={2} style={{ width: 52 }}>{d.earlier.length ? `${d.report.short} %` : '%'}</th>
            <th rowSpan={2} style={{ width: 70 }}>Sign</th>
          </tr>
          <tr>{d.subjects.map((s) => <th key={s.classSubjectId}>{s.max}</th>)}<th>{d.maxTotal}</th></tr>
        </thead>
        <tbody>
          {d.students.map((s) => { const pg = progress(d, s); return (
            <tr key={s.enrollmentId}>
              <td>{s.rollNo ?? s.serialNo}</td>
              <td className="font-mono">{s.examNo ?? ''}</td>
              <td className="pr-name">{s.fullName}</td>
              {d.subjects.map((x) => { const c = s.marks[String(x.classSubjectId)]; return <td key={x.classSubjectId} className={cn(typeof c === 'string' && 'font-semibold')}>{x.approved ? cellText(c) : ''}</td>; })}
              <td className="font-semibold">{fmt(s.total)}</td>
              {pg.slice(0, -1).map((x) => <td key={x.key}><Pct p={x.percent} trend={x.trend} /></td>)}
              <td className="font-semibold"><Pct p={s.percent} trend={pg[pg.length - 1].trend} /></td>
              <td />
            </tr>
          ); })}
          {rows.map(([label, f]) => (
            <tr key={label} className="pr-foot">
              <td colSpan={3} className="pr-name">{label}</td>
              {d.subjects.map((x) => <td key={x.classSubjectId}>{sum.get(x.classSubjectId) ? f(sum.get(x.classSubjectId)!) : ''}</td>)}
              <td colSpan={3 + d.earlier.length} />
            </tr>
          ))}
          <tr className="pr-foot">
            <td colSpan={3} className="pr-name">Subject Teacher's Sign</td>
            {d.subjects.map((x) => <td key={x.classSubjectId} style={{ height: 46, verticalAlign: 'bottom' }}><span className="block text-[8px] leading-tight font-normal">{x.teacher ?? ''}</span></td>)}
            <td colSpan={3 + d.earlier.length} />
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-[10px]">AB = absent, C = copying (both counted as 0).{d.earlier.length ? ' ▲ / ▼ = higher / lower than the exam before.' : ''}{d.subjects.some((s) => !s.inTotal) ? ' * Not counted in the total.' : ''}{d.classAverage != null ? ` Class average: ${fmt(d.classAverage)}%.` : ''}</p>
      <div className="mt-10 grid grid-cols-2 gap-24 text-center text-[11px]">
        <p className="border-t border-black pt-1">Class teacher{d.division.classTeacher ? ` (${d.division.classTeacher})` : ''}</p>
        <p className="border-t border-black pt-1">Headmaster</p>
      </div>
    </section>
  );
}

/** One student's unit test report, with the class average and highest for comparison. Two fit on an A4 page. */
function StudentReport({ d, s }: { d: Report; s: Student }) {
  const sum = new Map(d.summary.map((x) => [x.classSubjectId, x]));
  return (
    <section className="pr-card py-5">
      <Head d={d} title={`${d.report.title}${d.report.part === 'WRITTEN' ? ' (Written)' : ''} · Performance Report · ${d.year}`} />
      <div className="mb-2 grid grid-cols-2 gap-x-6 gap-y-0.5 text-[12px] sm:grid-cols-4">
        <p className="col-span-2"><b>Name:</b> {s.fullName}</p>
        <p><b>Class:</b> {d.division.label}</p>
        <p><b>Roll No:</b> {s.rollNo ?? '—'}</p>
        <p><b>Exam No:</b> {s.examNo ?? '—'}</p>
        <p><b>Student ID:</b> {s.studentCode}</p>
      </div>
      <table className="pr-table">
        <thead>
          <tr><th className="pr-name">Subject</th><th>Max. Marks</th><th>Marks Obtained</th><th>Class Average</th><th>Class Highest</th></tr>
        </thead>
        <tbody>
          {d.subjects.map((x) => {
            const c = s.marks[String(x.classSubjectId)];
            const m = sum.get(x.classSubjectId);
            return (
              <tr key={x.classSubjectId}>
                <td className="pr-name">{x.name}{!x.inTotal ? ' *' : ''}</td>
                <td>{x.max}</td>
                <td className="font-semibold">{x.approved ? cellText(c) || '—' : 'Not approved yet'}</td>
                <td>{fmt(m?.average)}</td>
                <td>{fmt(m?.highest)}</td>
              </tr>
            );
          })}
          <tr className="pr-foot"><td className="pr-name">Total</td><td>{d.maxTotal}</td><td>{fmt(s.total)}</td><td colSpan={2} /></tr>
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-x-8 text-[12px]">
        <p><b>Percentage:</b> {s.percent == null ? '—' : `${fmt(s.percent)}%`}</p>
        <p><b>Rank in class:</b> {s.rank == null ? (d.complete ? '—' : 'after all subjects are approved') : `${s.rank} of ${d.students.length}`}</p>
        {d.classAverage != null && <p><b>Class average:</b> {fmt(d.classAverage)}%</p>}
      </div>
      {d.earlier.length > 0 && (
        <table className="pr-table mt-2" style={{ width: 'auto' }}>
          <tbody>
            <tr><td className="pr-name font-semibold">Progress</td>{progress(d, s).map((x) => <td key={x.key} className="bg-slate-50 font-semibold">{x.title}</td>)}</tr>
            <tr><td className="pr-name">Percentage</td>{progress(d, s).map((x) => <td key={x.key}>{x.percent == null ? '—' : <Pct p={x.percent} trend={x.trend} suffix="%" />}</td>)}</tr>
          </tbody>
        </table>
      )}
      <p className="mt-1 text-[10px]">AB = absent, C = copying (both counted as 0).{d.subjects.some((x) => !x.inTotal) ? ' * Not counted in the total.' : ''}</p>
      <div className="mt-8 grid grid-cols-3 gap-10 text-center text-[11px]">
        <p className="border-t border-black pt-1">Class teacher</p>
        <p className="border-t border-black pt-1">Headmaster</p>
        <p className="border-t border-black pt-1">Parent's signature</p>
      </div>
    </section>
  );
}
