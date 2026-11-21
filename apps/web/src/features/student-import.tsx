import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileUp, GraduationCap, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext, useYears } from '@/lib/hooks';
import type { StudentsOverview } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';

interface PreviewRow {
  rowNo: number; fullName: string; grNo: string | null; examNo: string | null; schoolUid: string | null; dob: string | null; gender: 'MALE' | 'FEMALE' | null;
  phone: string | null; rollNo: number | null; address: string | null; grNoTemp?: boolean; noSurname?: boolean; errors: string[]; warnings: string[];
  split: { surname: string | null; firstName: string | null; fatherName: string | null; motherName: string | null };
}
interface Preview {
  fileName: string; headerRow: number; columns: string[]; detected: { medium: string | null; standard: string | null };
  suggestedSections: { id: number; label: string; students: number }[]; selectedSectionId: number | null;
  summary: { total: number; ready: number; withErrors: number; withWarnings: number }; rows: PreviewRow[];
}

export function StudentImportPage() {
  const navigate = useNavigate();
  const overview = useStudentsOverview();
  const ref = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sectionId, setSectionId] = useState('');
  const [loading, setLoading] = useState(false);

  const upload = async (f: File) => {
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const p = await api.post<Preview>('/students/import/preview', fd);
      setPreview(p);
      setSectionId(p.selectedSectionId ? String(p.selectedSectionId) : '');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const commit = useSave(() => api.post<{ created: number; section: string }>('/students/import/commit', {
    sectionId: Number(sectionId),
    rows: preview!.rows.map(({ errors: _e, warnings: _w, split: _s, ...r }) => r),
  }), {
    invalidate: [['students']], onSuccess: (r) => { toast.success(`${r.created} students imported into ${r.section}`); navigate(`/classes/${sectionId}`); },
  });
  const blocked = (preview?.summary.withErrors ?? 0) > 0;

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/students"><ArrowLeft /> Students</Link></Button>
      <PageHeader title="Import students from Excel" description="Upload the school's class-wise student list (as exported from Google Sheets). Nothing is saved until you check the rows and press Import." />

      <Card className="mb-4 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileUp className="size-6" /></div>
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">One class per file, like "HINDI MED 10TH STD STUDENT LIST".</p>
            <p className="text-muted-foreground">Columns used: Sr. No, Exam No, GR No., School UID, Full Name, Birth Date, Gender, Phone. The title rows above the header and the Medium / Standard line are read automatically. In Google Sheets use <i>File → Download → Microsoft Excel (.xlsx)</i>.</p>
          </div>
          <Button loading={loading} onClick={() => ref.current?.click()}><Upload /> Choose Excel file</Button>
          <input ref={ref} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        </div>
      </Card>

      {preview && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Card className="p-4"><p className="text-xs text-muted-foreground">File</p><p className="truncate font-medium">{preview.fileName}</p><p className="text-xs text-muted-foreground">Header found on row {preview.headerRow}</p></Card>
            <Card className="p-4"><p className="text-xs text-muted-foreground">Found in the sheet</p><p className="font-medium">{preview.detected.medium ?? '?'} medium · Std {preview.detected.standard ?? '?'}</p></Card>
            <Card className="p-4"><p className="text-xs text-muted-foreground">Ready</p><p className="text-2xl font-semibold text-emerald-600">{preview.summary.ready}<span className="text-sm font-normal text-muted-foreground"> / {preview.summary.total}</span></p></Card>
            <Card className="p-4"><p className="text-xs text-muted-foreground">Problems</p><p className={cn('text-2xl font-semibold', blocked ? 'text-destructive' : 'text-muted-foreground')}>{preview.summary.withErrors}</p><p className="text-xs text-muted-foreground">{preview.summary.withWarnings} with warnings</p></Card>
          </div>

          <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
            <Field label="Import into division" htmlFor="sec" className="sm:w-80" hint={preview.suggestedSections.length ? 'Suggested from the sheet' : undefined}>
              <Select id="sec" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">— Choose —</option>
                {(preview.suggestedSections.length ? preview.suggestedSections.map((s) => ({ id: s.id, label: `${s.label} (${s.students} now)` })) : (overview.data?.sections ?? []).map((s) => ({ id: s.sectionId, label: divisionLabel(s) }))).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </Field>
            <div className="flex-1 text-sm text-muted-foreground">
              {blocked ? <span className="flex items-center gap-1.5 text-destructive"><XCircle className="size-4" /> Correct the rows marked in red in the Excel file and upload it again. Either all rows are imported, or none.</span>
                : <span className="flex items-center gap-1.5"><CheckCircle2 className="size-4 text-emerald-600" /> All rows can be imported. Check the name split (surname / first / father / mother) below.</span>}
            </div>
            <Button disabled={blocked || !sectionId} loading={commit.isPending} onClick={() => commit.mutate(undefined)}>Import {preview.summary.total} students</Button>
          </Card>

          <Card className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Row</TH><TH>Full name / split</TH><TH>GR No</TH><TH>Exam No</TH><TH>Birth date</TH><TH>Gender</TH><TH>Phone</TH><TH>Check</TH></TR></THead>
              <TBody>
                {preview.rows.map((r) => (
                  <TR key={r.rowNo} className={cn(r.errors.length && 'bg-red-50/70 dark:bg-red-950/30')}>
                    <TD className="text-muted-foreground">{r.rowNo}</TD>
                    <TD>
                      <p className="font-medium">{r.fullName}</p>
                      <p className="text-xs text-muted-foreground">{[r.split.surname, r.split.firstName, r.split.fatherName, r.split.motherName].map((x, i) => <span key={i} className="mr-2">{['Surname', 'First', 'Father', 'Mother'][i]}: <b>{x ?? '—'}</b></span>)}</p>
                    </TD>
                    <TD className="font-mono text-xs">{r.grNo ?? (r.grNoTemp ? 'TEMP' : <span className="text-muted-foreground">—</span>)}</TD>
                    <TD className="font-mono text-xs">{r.examNo ?? <span className="text-muted-foreground">auto</span>}</TD>
                    <TD>{formatDate(r.dob)}</TD>
                    <TD>{r.gender === 'FEMALE' ? 'Female' : r.gender === 'MALE' ? 'Male' : '—'}</TD>
                    <TD className="tabular-nums">{r.phone ?? '—'}</TD>
                    <TD className="text-xs">
                      {r.errors.map((e) => <p key={e} className="flex items-start gap-1 text-destructive"><XCircle className="mt-0.5 size-3 shrink-0" />{e}</p>)}
                      {r.warnings.map((w) => <p key={w} className="flex items-start gap-1 text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{w}</p>)}
                      {!r.errors.length && !r.warnings.length && <CheckCircle2 className="size-4 text-emerald-600" />}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}

// ======================================================================= promotion

type Decision = 'PROMOTE' | 'DETAIN' | 'PASS_OUT' | 'SKIP';
interface PromotionOptions {
  from: { id: number; label: string; year: string; medium: string }; nextYear: { id: number; name: string } | null; isLastStandard: boolean;
  greensheet: { status: string } | null;
  can: { prepare: boolean; verify: boolean };
  pending: { id: number; items: { enrollmentId: number; decision: Decision }[]; toSectionId: number | null; detainSectionId: number | null; requestedBy: string | null; requestedAt: string } | null;
  lastRejected: { note: string | null; decidedBy: string | null; decidedAt: string } | null;
  promoteTo: { id: number; label: string; newRegister: boolean }[]; detainIn: { id: number; label: string }[];
  students: {
    enrollmentId: number; serialNo: number | null; examNo: string | null; status: string; suggested: Decision;
    student: { id: number; fullName: string; studentCode: string; grNo: string };
    result: string | null; resultLabel: string | null; percentage: number | null;
  }[];
}
const DECISIONS: Record<Decision, string> = { PROMOTE: 'Promote to next class', DETAIN: 'Stay in same standard', PASS_OUT: 'Passed out (left school)', SKIP: 'Wait (e.g. re-exam)' };

/** Promotion: Academic year → Medium → Class (division) → students with their results. */
export function PromotionSelectPage() {
  const years = useYears();
  const { yearId: workingYear } = useWorkingContext();
  const [yearId, setYearId] = useState('');
  const y = yearId || (workingYear ? String(workingYear) : '');
  const overview = useQuery({ queryKey: ['students', 'overview', Number(y)], queryFn: () => api.get<StudentsOverview>(`/students/overview?academicYearId=${y}`), enabled: !!y });
  const [medium, setMedium] = useState('');
  const navigate = useNavigate();
  const requests = useQuery({ queryKey: ['promotion', 'requests'], queryFn: () => api.get<{ id: number; sectionId: number; label: string; students: number; requestedBy: string | null; requestedAt: string }[]>('/promotions/requests'), retry: false });
  const sections = (overview.data?.sections ?? []).filter((d) => !medium || d.schoolClass.medium.code === medium);
  return (
    <>
      <PageHeader icon={GraduationCap} title="Promotion" description="Move passed students to the next class for the next academic year. Prepared by the office or the operator; the Headmaster verifies before it is applied." />
      {(requests.data?.length ?? 0) > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50 p-4 text-amber-950">
          <p className="mb-2 font-semibold">Waiting for your verification</p>
          <ul className="grid gap-1 text-sm">
            {requests.data!.map((r) => <li key={r.id}><Link className="font-medium underline" to={`/classes/${r.sectionId}/promote`}>{r.label}</Link> · {r.students} students · by {r.requestedBy ?? '—'} · {formatDate(r.requestedAt)}</li>)}
          </ul>
        </Card>
      )}
      <Card className="grid gap-4 p-4 sm:grid-cols-3">
        <Field label="Academic year" htmlFor="py"><Select id="py" value={y} onChange={(e) => { setYearId(e.target.value); setMedium(''); }}>{years.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Medium" htmlFor="pm">
          <Select id="pm" value={medium} onChange={(e) => setMedium(e.target.value)}>
            <option value="">All mediums</option>
            {overview.data?.byMedium.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Class" htmlFor="pc">
          <Select id="pc" value="" onChange={(e) => e.target.value && navigate(`/classes/${e.target.value}/promote`)}>
            <option value="">— Choose the class —</option>
            {sections.map((d) => <option key={d.sectionId} value={d.sectionId}>{divisionLabel(d)} ({d.students} students)</option>)}
          </Select>
        </Field>
      </Card>
    </>
  );
}

export function PromotionPage() {
  const { sectionId } = useParams();
  const { can } = useAuth();
  const years = useYears();
  const q = useQuery({ queryKey: ['promotion', sectionId], queryFn: () => api.get<PromotionOptions>(`/promotions/${sectionId}`) });
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [toId, setToId] = useState('');
  const [detainId, setDetainId] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const inv = { invalidate: [['promotion'], ['students'], ['dashboard']] as unknown[][] };
  const promote = useSave((body: object) => api.post<{ status: string }>('/promotions', body), { ...inv, onSuccess: (r) => toast.success(r.status === 'PENDING' ? 'Sent to the Headmaster for verification' : 'Promotion applied') });
  const approve = useSave((id: number) => api.post(`/promotions/requests/${id}/approve`), { ...inv, success: 'Promotion verified and applied' });
  const reject = useSave((id: number) => api.post(`/promotions/requests/${id}/reject`, { note }), { ...inv, success: 'Sent back', onSuccess: () => { setRejecting(false); setNote(''); } });
  const copy = useSave((yearId: number) => api.post<{ copiedClasses: number }>(`/academic-years/${yearId}/copy-structure`), { invalidate: [['promotion'], ['classes']], success: 'Classes copied to the new year' });
  const nextYearInList = years.data?.find((y) => q.data && !q.data.nextYear && y.startDate > (years.data?.find((x) => x.isCurrent)?.startDate ?? ''));
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/promotion"><ArrowLeft /> Promotion</Link></Button>
      <QueryView query={q}>
        {(o) => {
          const active = o.students.filter((s) => s.status === 'ACTIVE');
          const pend = o.pending ? new Map(o.pending.items.map((i) => [i.enrollmentId, i.decision])) : null;
          const dec = (s: (typeof active)[number]): Decision => (pend ? pend.get(s.enrollmentId) ?? 'SKIP' : decisions[s.enrollmentId] ?? s.suggested);
          const counts = active.reduce<Record<string, number>>((a, s) => ({ ...a, [dec(s)]: (a[dec(s)] ?? 0) + 1 }), {});
          const promoteTarget = o.pending ? String(o.pending.toSectionId ?? '') : toId || (o.promoteTo.length === 1 ? String(o.promoteTo[0].id) : '');
          const detainTarget = o.pending ? String(o.pending.detainSectionId ?? '') : detainId || (o.detainIn.length === 1 ? String(o.detainIn[0].id) : '');
          const newRegister = o.promoteTo.find((x) => String(x.id) === promoteTarget)?.newRegister;
          const locked = !!o.pending || !o.can.prepare;
          return (
            <>
              <PageHeader title={`Promote ${o.from.label}`} description={`${o.from.medium} · end of ${o.from.year}. Students get a place in ${o.nextYear?.name ?? 'next year'}; this year's record stays as it is.`} />
              {o.pending && (
                <Card className="mb-4 border-amber-300 bg-amber-50 p-4 text-amber-950">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="min-w-0 flex-1 text-sm"><b>Waiting for the Headmaster's verification.</b> Prepared by {o.pending.requestedBy ?? '—'} on {formatDate(o.pending.requestedAt)}. Nothing changes until it is verified.</p>
                    {o.can.verify && <Button onClick={() => approve.mutate(o.pending!.id)} loading={approve.isPending}><CheckCircle2 /> Verify and promote</Button>}
                    <Button variant="outline" onClick={() => setRejecting(true)}>{o.can.verify ? 'Send back' : 'Withdraw'}</Button>
                  </div>
                  {rejecting && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Input className="min-w-64 flex-1 bg-white" placeholder={o.can.verify ? 'What should be changed?' : 'Reason (optional)'} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
                      <Button variant="destructive" loading={reject.isPending} onClick={() => reject.mutate(o.pending!.id)}>{o.can.verify ? 'Send back' : 'Withdraw'}</Button>
                      <Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                    </div>
                  )}
                </Card>
              )}
              {o.lastRejected && <Card className="mb-4 border-red-200 bg-red-50 p-3 text-sm text-red-900">Sent back by {o.lastRejected.decidedBy ?? 'the Headmaster'} on {formatDate(o.lastRejected.decidedAt)}{o.lastRejected.note ? `: ${o.lastRejected.note}` : ''}. Correct and send again.</Card>}
              {o.greensheet?.status !== 'APPROVED' && <Card className="mb-4 border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-950">The Greensheet of this class is not approved yet: results shown are suggestions.</Card>}
              {!o.nextYear || (!o.promoteTo.length && !o.isLastStandard) ? (
                <Card className="p-5">
                  <EmptyState icon={GraduationCap} title={o.nextYear ? `${o.nextYear.name} has no classes yet` : 'Next academic year is not created yet'}
                    description={o.nextYear ? 'Copy this year\'s classes, divisions and subjects into the new year first.' : 'Create the next year in School setup → Academic years, then copy the classes into it.'}
                    action={o.nextYear && can('academics.manage' as never) ? <Button loading={copy.isPending} onClick={() => copy.mutate(o.nextYear!.id)}>Copy classes to {o.nextYear.name}</Button> : nextYearInList ? null : <Button variant="outline" asChild><Link to="/settings/years">Academic years</Link></Button>} />
                </Card>
              ) : (
                <>
                  <Card className="mb-4 grid gap-4 p-4 sm:grid-cols-3">
                    {!o.isLastStandard && (
                      <Field label="Promote into" htmlFor="to" hint={newRegister ? 'New General Register: the GR No is printed as TEMP until the new one is entered' : undefined}>
                        <Select id="to" value={promoteTarget} disabled={locked} onChange={(e) => setToId(e.target.value)}><option value="">— Choose —</option>{o.promoteTo.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
                      </Field>
                    )}
                    <Field label="Failed students stay in" htmlFor="dt"><Select id="dt" value={detainTarget} disabled={locked} onChange={(e) => setDetainId(e.target.value)}><option value="">— Choose —</option>{o.detainIn.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
                    <div className="flex flex-wrap items-end gap-1.5 text-sm">{Object.entries(counts).map(([k, n]) => <Badge key={k} variant={k === 'DETAIN' ? 'warning' : k === 'SKIP' ? 'secondary' : 'success'}>{n} {DECISIONS[k as Decision]}</Badge>)}</div>
                  </Card>
                  <Card className="overflow-x-auto">
                    <Table>
                      <THead><TR><TH>Sr. No</TH><TH>Student name</TH><TH>Exam No</TH><TH>Student ID</TH><TH>GR No</TH><TH>Result</TH><TH className="text-right">Percentage</TH><TH>Decision</TH></TR></THead>
                      <TBody>
                        {o.students.map((s) => (
                          <TR key={s.enrollmentId}>
                            <TD className="tabular-nums text-muted-foreground">{s.serialNo ?? '—'}</TD>
                            <TD className="font-medium">{s.student.fullName}</TD>
                            <TD className="font-mono text-xs">{s.examNo ?? '—'}</TD>
                            <TD className="font-mono text-xs">{s.student.studentCode}</TD>
                            <TD className="font-mono text-xs">{s.student.grNo}</TD>
                            <TD>{s.resultLabel ? <Badge variant={s.result === 'PASS' || s.result === 'PROMOTED' || s.resultLabel === 'PASS' ? 'success' : 'warning'}>{s.resultLabel}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TD>
                            <TD className="text-right tabular-nums">{s.percentage != null ? `${s.percentage.toFixed(2)} %` : '—'}</TD>
                            <TD>
                              {s.status !== 'ACTIVE' ? <Badge variant="secondary">{s.status === 'PROMOTED' ? 'Promoted' : s.status === 'DETAINED' ? 'Staying back' : 'Done'}</Badge> : (
                                <Select aria-label="Decision" className="h-8 w-56" value={dec(s)} disabled={locked} onChange={(e) => setDecisions((d) => ({ ...d, [s.enrollmentId]: e.target.value as Decision }))}>
                                  {(o.isLastStandard ? ['PASS_OUT', 'DETAIN', 'SKIP'] : ['PROMOTE', 'DETAIN', 'SKIP']).map((k) => <option key={k} value={k}>{DECISIONS[k as Decision]}</option>)}
                                </Select>
                              )}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </Card>
                  {!locked && (
                    <div className="mt-4 flex items-center justify-end gap-3">
                      <p className="text-sm text-muted-foreground">Students marked "Wait" stay here and can be promoted later on their own (e.g. after the re-exam).</p>
                      <Button disabled={!active.length} loading={promote.isPending} onClick={() => promote.mutate({
                        fromSectionId: Number(sectionId), toSectionId: promoteTarget ? Number(promoteTarget) : null, detainSectionId: detainTarget ? Number(detainTarget) : null,
                        items: active.map((s) => ({ enrollmentId: s.enrollmentId, decision: dec(s) })),
                      })}>{o.can.verify ? 'Promote now' : 'Send to Headmaster for verification'}</Button>
                    </div>
                  )}
                </>
              )}
            </>
          );
        }}
      </QueryView>
    </>
  );
}
