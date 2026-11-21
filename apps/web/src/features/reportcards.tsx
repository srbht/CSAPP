import { useQueries, useQuery } from '@tanstack/react-query';
import { type ReportTerm } from '@cps/shared';
import { ArrowLeft, CheckCircle2, Eye, FileText, Lock, Printer, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ConfirmDialog, EmptyState, PageHeader, QueryView, useSave } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';
import { BucketChip, sheetHref, type Unit } from './workflow-ui';


interface DivisionCards {
  section: { id: number; name: string; schoolClass: { displayName: string; medium: string } };
  term: ReportTerm;
  gate: { ready: boolean; required: number; approved: number; missing: { kind: string; label: string; status: string; unit?: Unit }[] };
  can: { view: boolean; generate: boolean; publish: boolean; remarks: boolean };
  students: { enrollmentId: number; rollNo: number | null; examNo: string | null; student: { id: number; fullName: string }; card: { id: number; status: string; generatedAt: string; publishedAt: string | null } | null; remarks: { progress: string | null; conduct: string | null; remark: string | null } | null }[];
}

// ======================================================================= list of divisions

export function ReportCardsPage() {
  const overview = useStudentsOverview();
  const [params] = useSearchParams();
  const term: ReportTerm = 'FINAL'; // the report card (mark sheet) is made once a year, after both semesters
  const sectionId = params.get('section');
  if (sectionId) return <DivisionCardsView sectionId={Number(sectionId)} term={term} />;
  return (
    <>
      <PageHeader title="Report Cards" description="The annual report card (mark sheet), made once both semesters are over. Choose a division. The class teacher or the Headmaster generates the cards once every subject's marks of both semesters and every month's attendance are approved; the Headmaster publishes them." />
      <QueryView query={overview}>
        {(o) => (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {o.sections.map((d) => (
              <Link key={d.sectionId} to={`/report-cards?section=${d.sectionId}&term=${term}`} className="group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                <Card className="h-full p-4 transition-colors group-hover:border-primary/50">
                  <p className="font-semibold">{divisionLabel(d)}</p>
                  <p className="text-sm text-muted-foreground">{d.students} students · {d.classTeacher?.name ?? 'no class teacher'}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </QueryView>
    </>
  );
}

function DivisionCardsView({ sectionId, term }: { sectionId: number; term: ReportTerm }) {
  const q = useQuery({ queryKey: ['report-cards', sectionId, term], queryFn: () => api.get<DivisionCards>(`/report-cards/division/${sectionId}?term=${term}`) });
  const [confirm, setConfirm] = useState<'generate' | 'publish' | null>(null);
  const generate = useSave(() => api.post<{ generated: number; skippedPublished: number }>(`/report-cards/division/${sectionId}/generate`, { term }), { invalidate: [['report-cards']], success: 'Report cards generated', onSuccess: () => setConfirm(null) });
  const publish = useSave(() => api.post<{ published: number }>(`/report-cards/division/${sectionId}/publish`, { term }), { invalidate: [['report-cards']], success: 'Report cards published', onSuccess: () => setConfirm(null) });
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to={`/report-cards?term=${term}`}><ArrowLeft /> Report Cards</Link></Button>
      <QueryView query={q}>
        {(d) => {
          const generated = d.students.filter((s) => s.card).length;
          const published = d.students.filter((s) => s.card?.status === 'PUBLISHED').length;
          return (
            <>
              <PageHeader
                title={`${d.section.schoolClass.displayName} ${d.section.name}: report cards`}
                description={`${d.students.length} students · ${generated} generated · ${published} published`}
                actions={<div className="flex flex-wrap gap-2">
                  {generated > 0 && <Button variant="outline" asChild><Link to={`/report-cards/print?section=${sectionId}&term=${term}`}><Printer /> Print all</Link></Button>}
                  {d.can.publish && generated > published && <Button variant="outline" onClick={() => setConfirm('publish')}><Send /> Publish</Button>}
                  <Button onClick={() => setConfirm('generate')} disabled={!d.can.generate} title={d.gate.ready ? undefined : 'Not everything is approved yet'}>{d.gate.ready ? <Sparkles /> : <Lock />} Generate report cards</Button>
                </div>}
              />

              <Gate gate={d.gate} />

              <Card className="mt-4">
                <Table>
                  <THead><TR><TH className="w-14">Roll</TH><TH>Student</TH><TH>Progress</TH><TH>Conduct</TH><TH>Remark</TH><TH>Report card</TH><TH /></TR></THead>
                  <TBody>
                    {d.students.map((s) => (
                      <RemarkRow key={s.enrollmentId} s={s} term={term} sectionId={sectionId} canEdit={d.can.remarks} />
                    ))}
                  </TBody>
                </Table>
              </Card>
              <p className="mt-2 text-xs text-muted-foreground">The class teacher or the Headmaster types the progress, conduct and remarks; they appear on the card the next time it is generated. A published card never changes.</p>

              <ConfirmDialog open={confirm === 'generate'} onOpenChange={(o) => !o && setConfirm(null)} title="Generate report cards?"
                description={`Official cards are made for ${d.students.length} students from the approved marks and attendance. Cards not yet published are replaced; published cards stay as they are.`}
                confirmLabel="Generate" loading={generate.isPending} onConfirm={() => generate.mutate(undefined)} />
              <ConfirmDialog open={confirm === 'publish'} onOpenChange={(o) => !o && setConfirm(null)} title="Publish report cards?"
                description="Published cards are final: they are frozen and can be printed and given to parents." confirmLabel="Publish" loading={publish.isPending} onConfirm={() => publish.mutate(undefined)} />
            </>
          );
        }}
      </QueryView>
    </>
  );
}

function Gate({ gate }: { gate: DivisionCards['gate'] }) {
  if (gate.ready) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> All {gate.required} marksheets and attendance months are approved by the Headmaster. Report cards can be generated.
      </div>
    );
  }
  return (
    <Card className="overflow-hidden border-amber-200 dark:border-amber-900">
      <div className="flex items-start gap-2 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
        <Lock className="mt-0.5 size-4 shrink-0" />
        <p><b>Report cards are locked.</b> {gate.approved} of {gate.required} items are approved. Every item below must be verified by the subject teacher, approved by the class teacher and approved by the Headmaster first.</p>
      </div>
      <ul className="max-h-72 divide-y overflow-y-auto">
        {gate.missing.map((m, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{m.label}</span>
            <span className="text-xs text-muted-foreground">{m.status}</span>
            {m.unit && <Link to={sheetHref(m.unit)} className="text-xs text-primary hover:underline">Open</Link>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RemarkRow({ s, term, sectionId, canEdit }: { s: DivisionCards['students'][number]; term: ReportTerm; sectionId: number; canEdit: boolean }) {
  const [v, setV] = useState({ progress: s.remarks?.progress ?? '', conduct: s.remarks?.conduct ?? '', remark: s.remarks?.remark ?? '' });
  const [dirty, setDirty] = useState(false);
  const save = useSave(() => api.put(`/report-cards/division/${sectionId}/remarks`, { term, items: [{ enrollmentId: s.enrollmentId, ...v }] }), { invalidate: [['report-cards', sectionId]], success: 'Remark saved', onSuccess: () => setDirty(false) });
  const upd = (p: Partial<typeof v>) => { setV((x) => ({ ...x, ...p })); setDirty(true); };
  return (
    <TR>
      <TD className="tabular-nums text-muted-foreground">{s.rollNo}</TD>
      <TD className="font-medium">{s.student.fullName}</TD>
      <TD>{canEdit ? <Input aria-label="Progress" className="h-8 w-36" maxLength={60} value={v.progress} onChange={(e) => upd({ progress: e.target.value })} onBlur={() => dirty && save.mutate(undefined)} placeholder="e.g. Satisfactory" /> : v.progress || '—'}</TD>
      <TD>{canEdit ? <Input aria-label="Conduct" className="h-8 w-32" maxLength={60} value={v.conduct} onChange={(e) => upd({ conduct: e.target.value })} onBlur={() => dirty && save.mutate(undefined)} placeholder="e.g. Good" /> : v.conduct || '—'}</TD>
      <TD>{canEdit ? <Input aria-label="Remark" className="h-8 min-w-48" value={v.remark} onChange={(e) => upd({ remark: e.target.value })} onBlur={() => dirty && save.mutate(undefined)} /> : v.remark || '—'}</TD>
      <TD>
        {s.card ? (
          <span className="flex items-center gap-1.5">
            <Badge variant={s.card.status === 'PUBLISHED' ? 'success' : 'default'}>{s.card.status === 'PUBLISHED' ? 'Published' : 'Generated'}</Badge>
            <span className="text-xs text-muted-foreground">{formatDateTime(s.card.publishedAt ?? s.card.generatedAt)}</span>
          </span>
        ) : <span className="text-xs text-muted-foreground">Not generated</span>}
      </TD>
      <TD className="text-right whitespace-nowrap">
        {canEdit && dirty && <Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>}
        {s.card ? <Button size="sm" variant="ghost" asChild><Link to={`/report-cards/${s.card.id}`}><FileText /> Open</Link></Button>
          : <Button size="sm" variant="ghost" asChild><Link to={`/report-cards/preview?enrollmentId=${s.enrollmentId}&term=${term}`}><Eye /> Draft</Link></Button>}
      </TD>
    </TR>
  );
}

// ======================================================================= the card itself

interface Snapshot {
  term: ReportTerm;
  school: { name: string; nameHi: string | null; motto: string | null; address: string; logoFileId: number | null; principalTitle: string; principalName: string | null };
  student: { fullName: string; fullNameHi: string | null; studentCode?: string; grNo: string; examNo: string | null; rollNo: number | null; dob: string | null };
  class: { medium: string; standard: string; standardCode: string; division: string; year: string };
  exams: { id: number; code: string; name: string; kind: string }[];
  subjects: { classSubjectId: number; name: string; includeInTotal: boolean; cols: ({ m1: number | null; m2: number | null; absent: boolean; total: number | null; max: number; hasM2: boolean; grade: string | null } | null)[]; average: { total: number | null; grade: string | null } | null }[];
  examTotals: { m1: number; m2: number; total: number; max: number; grade: string | null }[];
  average: { total: number | null; max: number; grade: string | null } | null;
  attendance: { period: string; label: string; term: number; working: number | null; present: number | null }[];
  attendanceTerms: { term: number; working: number; present: number }[];
  attendanceTotal: { working: number; present: number; percent: number | null; low: boolean };
  percentage: number; overallGrade: string | null; result: string;
  remarks: { progress: string | null; conduct: string | null; remark: string | null };
  reopeningDate?: string | null;
}
interface CardResponse { id: number | null; status: string; term: ReportTerm; official: boolean; generatedAt?: string; snapshot: Snapshot }

export function ReportCardPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const preview = !id || id === 'preview';
  const q = useQuery({
    queryKey: ['report-card', id, params.toString()],
    queryFn: () => api.get<CardResponse>(preview ? `/report-cards/preview?${params.toString()}` : `/report-cards/${id}`),
  });
  return (
    <>
      <div className="mb-3 flex items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => window.print()}><Printer /> Print</Button>
      </div>
      <QueryView query={q}>{(c) => <ReportCardSheet card={c} />}</QueryView>
    </>
  );
}

export function PrintAllPage() {
  const [params] = useSearchParams();
  const sectionId = params.get('section');
  const term = (params.get('term') ?? 'FINAL') as ReportTerm;
  const list = useQuery({ queryKey: ['report-cards', Number(sectionId), term], queryFn: () => api.get<DivisionCards>(`/report-cards/division/${sectionId}?term=${term}`) });
  const ids = (list.data?.students ?? []).map((s) => s.card?.id).filter(Boolean) as number[];
  const cards = useQueries({ queries: ids.map((cid) => ({ queryKey: ['report-card', String(cid), ''], queryFn: () => api.get<CardResponse>(`/report-cards/${cid}`) })) });
  const ready = cards.length > 0 && cards.every((c) => c.data);
  return (
    <>
      <div className="mb-3 flex items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
        <p className="text-sm text-muted-foreground">{ids.length} report cards{ready ? '' : ' (loading…)'}</p>
        <Button size="sm" className="ml-auto" disabled={!ready} onClick={() => window.print()}><Printer /> Print all</Button>
      </div>
      {!ids.length && list.data && <EmptyState title="No report cards generated yet" />}
      <div className="grid gap-8">
        {cards.map((c, i) => c.data ? <div key={ids[i]} className="break-after-page"><ReportCardSheet card={c.data} /></div> : null)}
      </div>
    </>
  );
}

function ReportCardSheet({ card }: { card: CardResponse }) {
  const logo = useSchoolLogo();
  const s = card.snapshot;
  const final = s.term === 'FINAL';
  const show = (n: number | null | undefined) => (n == null ? '—' : Number.isInteger(n) ? n : n.toFixed(1));
  const hasM2 = s.subjects.some((x) => x.cols.some((c) => c?.hasM2));
  return (
    <div className="relative mx-auto w-full max-w-[210mm] overflow-hidden rounded-lg border bg-white p-6 text-[13px] text-black shadow-sm print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
      {!card.official && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
          <span className="-rotate-30 text-6xl font-black tracking-widest text-red-600/15 select-none">DRAFT · NOT APPROVED</span>
        </div>
      )}
      {!card.official && <p className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-center text-xs font-medium text-red-800 print:hidden">Draft preview from current data. Not approved, not for parents.</p>}
      <header className="flex items-center gap-4 border-b-2 border-black pb-3">
        {logo.data ? <img src={logo.data} alt="" className="h-20 w-24 object-contain" /> : <div className="h-20 w-24" />}
        <div className="flex-1 text-center">
          {s.school.motto && <p className="text-xs">{s.school.motto}</p>}
          <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: 'Georgia, serif' }}>{s.school.name}</h1>
          <p className="text-xs">{s.school.address}</p>
          <p className="mt-2 text-base font-semibold">{/medium$/i.test(s.class.medium) ? s.class.medium : `${s.class.medium.charAt(0)}${s.class.medium.slice(1).toLowerCase()} Medium`}</p>
          <p className="text-base font-semibold">Academic Year {s.class.year}</p>
        </div>
      </header>

      <section className="py-3">
        <p><span>Name of the Student</span> <span className="mx-1">:</span> <b className="text-base uppercase">{s.student.fullName}</b></p>
        <p className="mt-1 flex flex-wrap gap-x-6">
          <span>Std. <b>{s.class.standardCode}</b></span>
          <span>Div. : <b>{s.class.division}</b></span>
          <span>Exam.No. : <b>{s.student.examNo ?? '—'}</b></span>
          <span>G.R.No. : <b>{s.student.grNo || '—'}</b></span>
          <span>D.O.B. : <b>{formatDate(s.student.dob)}</b></span>
        </p>
        {s.student.studentCode && <p className="mt-0.5 text-xs">Student ID : <b className="font-mono">{s.student.studentCode}</b></p>}
      </section>

      <table className="w-full border-collapse border border-black text-center">
        <thead>
          <tr>
            <th rowSpan={2} className="border border-black px-1 py-1 text-left">Subjects</th>
            {s.exams.map((e) => <th key={e.id} colSpan={hasM2 ? 4 : 2} className="border border-black px-1 py-1">{e.name.replace(/^Semester\s+/i, 'Semester-')}</th>)}
            {final && <th colSpan={2} className="border border-black px-1 py-1">Average</th>}
          </tr>
          <tr className="text-[11px]">
            {s.exams.map((e, i) => (
              <FragmentCols key={e.id} hasM2={hasM2} n={i === 0 ? 'I' : 'II'} />
            ))}
            {final && <><th className="border border-black px-1">Total (100)</th><th className="border border-black px-1">Grade</th></>}
          </tr>
        </thead>
        <tbody>
          {s.subjects.map((sub, i) => (
            <tr key={sub.classSubjectId}>
              <td className="border border-black px-1 py-0.5 text-left">{i + 1}. {sub.name}</td>
              {sub.cols.map((c, j) => c ? (
                <FragmentVals key={j} hasM2={hasM2} vals={[c.absent ? 'AB' : show(c.m1), c.absent ? 'AB' : c.hasM2 ? show(c.m2) : '--', c.absent ? 'AB' : show(c.total), c.grade ?? '—']} />
              ) : <FragmentVals key={j} hasM2={hasM2} vals={['', '', '', '']} />)}
              {final && <><td className="border border-black px-1 font-semibold">{show(sub.average?.total)}</td><td className="border border-black px-1">{sub.average?.grade ?? '—'}</td></>}
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border border-black px-1 py-0.5 text-left">Total</td>
            {s.examTotals.map((t, j) => <FragmentVals key={j} hasM2={hasM2} vals={[show(t.m1), hasM2 ? show(t.m2) : '', `${show(t.total)}`, t.grade ?? '—']} />)}
            {final && <><td className="border border-black px-1">{show(s.average?.total)}</td><td className="border border-black px-1">{s.average?.grade ?? '—'}</td></>}
          </tr>
        </tbody>
      </table>

      <section className="mt-3">
        <p className="mb-1 font-semibold">Attendance :</p>
        <table className="mb-2 w-full border-collapse border border-black text-center text-[12px]">
          <thead>
            <tr>{s.attendanceTerms.map((t) => <th key={t.term} colSpan={2} className="border border-black px-1">Semester-{t.term === 1 ? 'I' : 'II'}</th>)}<th colSpan={2} className="border border-black px-1">Total</th></tr>
            <tr className="text-[11px]">{[...s.attendanceTerms, null].map((_t, i) => <FragmentAtt key={i} />)}</tr>
          </thead>
          <tbody>
            <tr>{s.attendanceTerms.map((t) => <AttVals key={t.term} w={t.working} p={t.present} />)}<AttVals w={s.attendanceTotal.working} p={s.attendanceTotal.present} /></tr>
          </tbody>
        </table>
        <p className="mb-1 text-[12px] font-semibold">Month-wise attendance :</p>
        <table className="w-full border-collapse border border-black text-center text-[11px]">
          <thead><tr><th className="border border-black px-1 text-left">Month</th>{s.attendance.map((a) => <th key={a.period} className="border border-black px-1">{a.label.split(' ')[0]}</th>)}<th className="border border-black px-1">Total</th></tr></thead>
          <tbody>
            <tr><td className="border border-black px-1 text-left">Working days</td>{s.attendance.map((a) => <td key={a.period} className="border border-black">{show(a.working)}</td>)}<td className="border border-black font-semibold">{show(s.attendanceTotal.working)}</td></tr>
            <tr><td className="border border-black px-1 text-left">Present days</td>{s.attendance.map((a) => <td key={a.period} className="border border-black">{show(a.present)}</td>)}<td className="border border-black font-semibold">{show(s.attendanceTotal.present)}</td></tr>
          </tbody>
        </table>
        {s.attendanceTotal.percent != null && <p className={cn('mt-1 text-xs', s.attendanceTotal.low && 'font-semibold')}>Attendance: {s.attendanceTotal.percent}%{s.attendanceTotal.low ? ' (below the required level)' : ''}</p>}
      </section>

      <section className="mt-3 grid grid-cols-3 gap-x-6 gap-y-1">
        <p>Result : <b className="uppercase">{s.result}</b></p>
        <p>Percentage : <b>{s.percentage.toFixed(2)} %</b></p>
        <p>Overall Grade : <b>{s.overallGrade ?? '—'}</b></p>
        <p>Progress : <b className="uppercase">{s.remarks.progress ?? '—'}</b></p>
        <p>Conduct : <b className="uppercase">{s.remarks.conduct ?? '—'}</b></p>
        <p>School Re-opening Date : <b>{s.reopeningDate ? formatDate(s.reopeningDate) : '—'}</b></p>
        <p className="col-span-3">Remarks : {s.remarks.remark ?? ''}</p>
      </section>

      <footer className="mt-12 flex items-end justify-between text-sm">
        <p className="border-t border-black px-4 pt-1">Class Teacher's Sign.</p>
        <p className="border-t border-black px-4 pt-1 text-center">{s.school.principalTitle}'s Sign.{s.school.principalName && <span className="block text-xs">{s.school.principalName.replace(/\s*\(sample\)/i, '')}</span>}</p>
      </footer>
      {card.official && card.status === 'GENERATED' && <p className="mt-3 text-center text-[10px] text-gray-500 print:hidden">Generated, not yet published by the Headmaster.</p>}
    </div>
  );
}
function FragmentCols({ hasM2, n }: { hasM2: boolean; n: string }) {
  return hasM2
    ? <><th className="border border-black px-1">Form-{n}</th><th className="border border-black px-1">Sum-{n}</th><th className="border border-black px-1">Total (100)</th><th className="border border-black px-1">Grade</th></>
    : <><th className="border border-black px-1">Total (100)</th><th className="border border-black px-1">Grade</th></>;
}
function FragmentAtt() {
  return <><th className="border border-black px-1 font-normal">Working Days</th><th className="border border-black px-1 font-normal">Present Days</th></>;
}
function AttVals({ w, p }: { w: number; p: number }) {
  return <><td className="border border-black py-0.5">{w}</td><td className="border border-black py-0.5">{p}</td></>;
}
function FragmentVals({ hasM2, vals }: { hasM2: boolean; vals: (string | number)[] }) {
  const v = hasM2 ? vals : [vals[2], vals[3]];
  return <>{v.map((x, i) => <td key={i} className={cn('border border-black px-1', (hasM2 ? i === 2 : i === 0) && 'font-semibold')}>{x}</td>)}</>;
}

// ======================================================================= consolidated marksheet

interface Marksheet {
  exam: { id: number; code: string; nameEn: string; kind: string };
  section: { id: number; name: string; displayName: string };
  subjects: { classSubjectId: number; name: string; max: number; bucket: import('@cps/shared').ProgressBucket }[];
  maxTotal: number;
  rows: { enrollmentId: number; rollNo: number | null; examNo: string | null; name: string; cells: (number | 'AB' | null)[]; total: number; percent: number }[];
}
export function MarksheetPage() {
  const logo = useSchoolLogo();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ['marksheet', params.toString()], queryFn: () => api.get<Marksheet>(`/marksheet?${params.toString()}`) });
  return (
    <>
      <div className="mb-3 flex items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => window.print()}><Printer /> Print</Button>
      </div>
      <QueryView query={q}>
        {(m) => {
          const pass = (c: number | 'AB' | null, max: number) => typeof c === 'number' && c / max < 0.35;
          return (
            <Card className="overflow-x-auto p-4 print:border-0 print:p-0 print:shadow-none">
              <div className="mb-3 flex items-center gap-3">
                {logo.data && <img src={logo.data} alt="" className="h-12 w-14 object-contain" />}
                <div>
                  <h1 className="text-lg font-semibold">{m.exam.nameEn}: marks of {m.section.displayName} {m.section.name}</h1>
                  <p className="text-xs text-muted-foreground print:hidden">Red = below 35 %. A subject's marks are final only after Headmaster approval.</p>
                </div>
              </div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-xs">
                    <th className="px-2 py-1 text-left">Roll</th><th className="px-2 py-1 text-left">Exam No</th><th className="px-2 py-1 text-left">Name of student</th>
                    {m.subjects.map((s) => <th key={s.classSubjectId} className="px-2 py-1 text-center">{s.name}<span className="block font-normal">{s.max}</span><span className="block print:hidden"><BucketChip bucket={s.bucket} className="mt-0.5 text-[10px]" /></span></th>)}
                    <th className="px-2 py-1 text-center">Total<span className="block font-normal">{m.maxTotal}</span></th><th className="px-2 py-1 text-center">%</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rows.map((r) => (
                    <tr key={r.enrollmentId} className="border-b last:border-0">
                      <td className="px-2 py-1 tabular-nums">{r.rollNo}</td><td className="px-2 py-1 font-mono text-xs">{r.examNo}</td><td className="px-2 py-1 whitespace-nowrap">{r.name}</td>
                      {r.cells.map((c, i) => <td key={i} className={cn('px-2 py-1 text-center tabular-nums', pass(c, m.subjects[i].max) && 'bg-red-50 font-medium text-red-700 dark:bg-red-950 dark:text-red-300')}>{c ?? '—'}</td>)}
                      <td className="px-2 py-1 text-center font-semibold tabular-nums">{r.total}</td><td className="px-2 py-1 text-center tabular-nums">{r.percent.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          );
        }}
      </QueryView>
    </>
  );
}
