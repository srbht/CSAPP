import { useQuery } from '@tanstack/react-query';
import {
  ADMISSION_DOCUMENTS, dateInWords, grNoLabel, MAX_DOCUMENT_BYTES, MOTHER_TONGUES, NATIONALITIES, RELIGIONS, TRANSPORT_MODES,
  BLOOD_GROUPS, CATEGORY_SUGGESTIONS, GENDER_LABELS, GUARDIAN_RELATION_LABELS, PERMISSIONS, STUDENT_STATUS, STUDENT_STATUS_LABELS,
  studentCreateSchema, studentSchema, studentStatusSchema, type StudentStatus,
} from '@cps/shared';
import {
  AlertTriangle, ArrowLeft, BookCheck, Check, CalendarCheck, Camera, Eye, FileText, FileUp, Lock, Paperclip, Pencil, Phone, Plus, Printer, Search,
  Shuffle, UserRound, UsersRound, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { EmptyState, errorMessage, PageHeader, Pagination, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { api, ApiError, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced, useStandards, useWorkingContext, useYears } from '@/lib/hooks';
import type { DivisionOverview, StudentDetail, StudentDuplicate, StudentRow } from '@/lib/types';
import { cn, formatDate, isoDay } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';
import { ACCEPT_DOCUMENTS, ACCEPT_PHOTO, fileSize, UploadedFiles } from './admission-form';
import { FeeCertificateButton, FeeCertificatesList } from './fee-certificate';
import { ConcessionDialog, LedgerTable, useFeeAccount } from './fees';
import { InstalmentsCard } from './fee-instalments';

const P = PERMISSIONS;
const STATUS_LABEL: Record<string, string> = STUDENT_STATUS_LABELS;

// ======================================================================= shared bits

export function StudentAvatar({ name, studentId, photoFileId, size = 'md' }: { name: string; studentId?: number; photoFileId?: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const photo = useQuery({
    queryKey: ['student-photo', studentId, photoFileId],
    queryFn: async () => URL.createObjectURL(await api.get<Blob>(`/students/${studentId}/photo`)),
    enabled: !!photoFileId && !!studentId && size === 'lg',
    staleTime: Infinity,
  });
  const parts = name.split(/\s+/);
  // School style is SURNAME FIRST FATHER MOTHER: initials of first name + surname.
  const initials = ((parts[1]?.[0] ?? '') + (parts[0]?.[0] ?? '')).toUpperCase();
  const cls = size === 'lg' ? 'size-24 text-2xl rounded-2xl' : size === 'md' ? 'size-9 text-xs rounded-full' : 'size-7 text-[10px] rounded-full';
  if (photo.data) return <img src={photo.data} alt="" className={cn(cls, 'object-cover')} />;
  return <div className={cn(cls, 'grid shrink-0 place-items-center bg-primary/10 font-semibold text-primary')} aria-hidden>{initials}</div>;
}

/** Admission state first: Provisional (entered by the office) until the Headmaster confirms it. */
function StudentStatusBadge({ status }: { status: string }) {
  if (status === 'ACTIVE') return <Badge variant="success">Confirmed</Badge>;
  if (status === 'PENDING_APPROVAL') return <Badge variant="warning">Provisional</Badge>;
  return <Badge variant={status === 'REJECTED' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status] ?? status}</Badge>;
}

/** Division picker built from the divisions the user is allowed to see. */
function DivisionSelect({ divisions, value, onChange, allLabel = 'All classes', id }: { divisions: DivisionOverview[]; value: string; onChange: (v: string) => void; allLabel?: string; id?: string }) {
  const byMedium = divisions.reduce<Record<string, DivisionOverview[]>>((acc, d) => ((acc[d.schoolClass.medium.nameEn] ??= []).push(d), acc), {});
  return (
    <Select id={id} aria-label="Class and division" value={value} onChange={(e) => onChange(e.target.value)}>
      {allLabel && <option value="">{allLabel}</option>}
      {Object.entries(byMedium).map(([m, list]) => (
        <optgroup key={m} label={m}>
          {list.map((d) => <option key={d.sectionId} value={d.sectionId}>{divisionLabel(d)} ({d.students})</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

/** Dropdown for a fixed list of choices. */
const OptionSelect = ({ options, empty = '—', ...props }: React.ComponentProps<'select'> & { options: readonly string[]; empty?: string }) => (
  <Select {...props}>
    <option value="">{empty}</option>
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </Select>
);

// ======================================================================= list

export function StudentsTable({ rows, showClass = true, onOpen }: { rows: StudentRow[]; showClass?: boolean; onOpen: (r: StudentRow) => void }) {
  const showContact = rows.some((r) => r.primaryContact);
  return (
    <Table>
      <THead>
        <TR>
          <TH className="w-14">Roll</TH><TH>Student</TH>{showClass && <TH>Class</TH>}<TH>Student ID</TH><TH>Exam No</TH><TH>GR No</TH><TH>Gender</TH>
          {showContact && <TH>Parent's mobile</TH>}<TH />
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.enrollmentId} className="cursor-pointer" onClick={() => onOpen(r)}>
            <TD className="tabular-nums text-muted-foreground">{r.rollNo ?? '—'}</TD>
            <TD>
              <div className="flex items-center gap-3">
                <StudentAvatar name={r.fullName} />
                <div className="min-w-0">
                  <Link to={`/students/${r.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium hover:text-primary hover:underline">{r.fullName}</Link>
                  <StudentStatusBadge status={r.status} />{r.correctionNote && <Badge variant="destructive" className="ml-1">Correction needed</Badge>}
                </div>
              </div>
            </TD>
            {showClass && <TD className="whitespace-nowrap">{divisionLabel(r.section)}</TD>}
            <TD className="font-mono text-xs">{r.studentCode}</TD>
            <TD className="font-mono text-xs">{r.examNo ?? '—'}</TD>
            <TD className="font-mono text-xs">{grNoLabel(r)}</TD>
            <TD>{GENDER_LABELS[r.gender]}</TD>
            {showContact && <TD className="tabular-nums">{r.primaryContact?.mobile ? <a href={`tel:${r.primaryContact.mobile}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">{r.primaryContact.mobile}</a> : '—'}</TD>}
            <TD className="text-right"><Eye className="ml-auto size-4 text-muted-foreground" /></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function StudentsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { yearId: workingYear } = useWorkingContext();
  const years = useYears();
  const [params, setParams] = useSearchParams();
  // Year shown here (defaults to the one in the top bar), e.g. to see the admissions already made for next year.
  const yearId = params.get('year') ? Number(params.get('year')) : workingYear;
  const overview = useStudentsOverview(yearId);
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  const search = useDebounced(q);
  const section = params.get('section') ?? '';
  const mediumCode = params.get('medium') ?? '';
  const gender = params.get('gender') ?? '';
  const status = params.get('status') ?? 'CURRENT';
  const gr = params.get('gr') ?? '';
  const page = Number(params.get('page') ?? 1);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const mediumId = overview.data?.sections.find((s) => s.schoolClass.medium.code === mediumCode)?.schoolClass.medium.id;
  const list = useQuery({
    queryKey: ['students', 'list', { yearId, search, section, mediumId, gender, status, gr, page }],
    queryFn: () => api.get<Page<StudentRow>>(`/students${qs({ academicYearId: yearId, q: search, sectionId: section, mediumId, gender, status, gr: gr || undefined, page, pageSize: 50 })}`),
    placeholderData: (prev) => prev,
    enabled: !!yearId && (!mediumCode || !!overview.data),
  });
  const divisions = (overview.data?.sections ?? []).filter((d) => !mediumCode || d.schoolClass.medium.code === mediumCode);
  const scopeText = overview.data && !overview.data.scopeAll
    ? `You can see the students of your ${overview.data.sections.length === 1 ? 'division' : `${overview.data.sections.length} divisions`}: ${overview.data.sections.map(divisionLabel).join(', ')}.`
    : 'All students of the school. Click a student to open the full profile.';

  return (
    <>
      <PageHeader
        title="Students"
        description={scopeText}
        actions={can(P.STUDENTS_WRITE) && overview.data?.scopeAll && <>
          <Button variant="outline" asChild><Link to="/students/import"><FileUp /> Import from Excel</Link></Button>
          <Button asChild><Link to={`/students/new${qs({ section: section || undefined, year: params.get('year') || undefined })}`}><Plus /> Admit student</Link></Button>
        </>}
      />
      {(years.data?.length ?? 0) > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Academic year</span>
          {years.data!.filter((y) => y.status !== 'CLOSED' || y.id === yearId).map((y) => (
            <button key={y.id} type="button" onClick={() => { const n = new URLSearchParams(); if (y.id !== workingYear) n.set('year', String(y.id)); setParams(n, { replace: true }); }}
              className={cn('rounded-full border px-3 py-1', y.id === yearId ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
              {y.name}{y.isCurrent ? ' (current)' : ''}
            </button>
          ))}
        </div>
      )}
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1.4fr_1fr_1fr]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search students" className="pl-8" placeholder="Name, GR No, exam no" value={q} onChange={(e) => { setQ(e.target.value); set('q', e.target.value); }} />
        </div>
        {overview.data?.scopeAll ? (
          <Select aria-label="Medium" value={mediumCode} onChange={(e) => { const next = new URLSearchParams(params); if (e.target.value) next.set('medium', e.target.value); else next.delete('medium'); next.delete('section'); next.delete('page'); setParams(next, { replace: true }); }}>
            <option value="">Both mediums</option>
            {overview.data.byMedium.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
          </Select>
        ) : <div className="hidden lg:block" />}
        <DivisionSelect divisions={divisions} value={section} onChange={(v) => set('section', v)} />
        <Select aria-label="Gender" value={gender} onChange={(e) => set('gender', e.target.value)}>
          <option value="">All genders</option><option value="MALE">Male</option><option value="FEMALE">Female</option>
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => set('status', e.target.value)}>
          <option value="CURRENT">Confirmed + provisional</option>
          <option value="ACTIVE">Confirmed only</option>
          <option value="PENDING_APPROVAL">Provisional only</option>
          <option value="CORRECTION">Sent back for correction</option>
          {STUDENT_STATUS.filter((s) => s !== 'ACTIVE').map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          <option value="REJECTED">Admission rejected</option>
          <option value="ALL">Everyone</option>
        </Select>
      </Card>
      {gr && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Badge variant="warning">{gr === 'TEMP' ? 'Showing students with GR No "TEMP"' : 'Showing confirmed students without a GR No'}</Badge>
          <button className="text-primary hover:underline" onClick={() => set('gr', '')}>Show all</button>
        </div>
      )}
      <Card>
        <QueryView query={list} empty={(d) => (d.data.length ? null : (
          <EmptyState icon={UsersRound} title={search || section ? 'No matching students' : 'No students yet'}
            description={search ? 'Check the spelling, or search by GR No or exam number.' : can(P.STUDENTS_WRITE) ? 'Admit the first student, or import the school\'s Excel list (coming soon).' : 'Students of your divisions will appear here once the office admits them.'} />
        ))}>
          {(d) => (
            <>
              <StudentsTable rows={d.data} onOpen={(r) => navigate(`/students/${r.id}`)} />
              <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={(p) => set('page', String(p))} />
            </>
          )}
        </QueryView>
      </Card>
    </>
  );
}

// ======================================================================= profile

function age(dob: string | null) {
  if (!dob) return null;
  const [y, m, d] = dob.slice(0, 10).split('-').map(Number);
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
  return a;
}

function Info({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 text-sm break-words">{v === null || v === undefined || v === '' ? <span className="text-muted-foreground">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Panel({ title, children, className, icon: Icon }: { title: string; children: React.ReactNode; className?: string; icon?: React.ElementType }) {
  return (
    <Card className={cn('p-5', className)}>
      <h3 className="mb-4 flex items-center gap-2 font-semibold">{Icon && <Icon className="size-4 text-muted-foreground" />}{title}</h3>
      {children}
    </Card>
  );
}

function Restricted({ text }: { text: string }) {
  return <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"><Lock className="mt-0.5 size-4 shrink-0" />{text}</p>;
}

function FeesTab({ studentId }: { studentId: number }) {
  const { can } = useAuth();
  const q = useFeeAccount(studentId);
  const [discount, setDiscount] = useState(false);
  if (q.isError) return <Card><EmptyState title="No fee account for this year" /></Card>;
  if (!q.data) return null;
  return (
    <div className="grid max-w-2xl gap-4">
      <Card className="overflow-hidden">
        <div className="border-b px-5 py-3 font-semibold">Fee ledger · {q.data.year.name}</div>
        <LedgerTable l={q.data.ledger} actions={{ concession: q.data.ledger.canDiscount ? () => setDiscount(true) : undefined }} />
      </Card>
      {discount && <ConcessionDialog a={q.data} onClose={() => setDiscount(false)} />}
      <InstalmentsCard a={q.data} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild><Link to={`/fees/student/${studentId}`}>Full ledger, year by year and receipts</Link></Button>
        {can(P.FEES_COLLECT) && q.data.ledger.canCollect && q.data.ledger.balance > 0 && <Button asChild><Link to={`/fees/collect?student=${studentId}`}>Collect fee</Link></Button>}
      </div>
      <FeeCertificatesList studentId={studentId} />
    </div>
  );
}

export function StudentProfilePage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['students', 'detail', id], queryFn: () => api.get<StudentDetail>(`/students/${id}`) });
  const [dlg, setDlg] = useState<'division' | 'status' | null>(null);
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2 print:hidden" asChild><Link to="/students"><ArrowLeft /> Students</Link></Button>
      <QueryView query={q}>
        {(s) => (
          <>
            <AdmissionBanner s={s} />
            <ProfileHeader s={s} onDivision={() => setDlg('division')} onStatus={() => setDlg('status')} />
            {!s.access.contact && (
              <div className="mb-4"><Restricted text="You can see this student's basic details because you teach or enter data for their division. Date of birth, address and parents' phone numbers are visible only to the class teacher, Headmaster and office." /></div>
            )}
            <Tabs defaultValue="profile">
              <TabsList className="print:hidden">
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="parents">Parents</TabsTrigger>
                <TabsTrigger value="record">School record</TabsTrigger>
                <TabsTrigger value="attendance">Attendance</TabsTrigger>
                <TabsTrigger value="exams">Exams & results</TabsTrigger>
                {can(P.FEES_READ) && <TabsTrigger value="fees">Fees</TabsTrigger>}
              </TabsList>
              <TabsContent value="profile"><ProfileTab s={s} /></TabsContent>
              <TabsContent value="parents"><ParentsTab s={s} /></TabsContent>
              <TabsContent value="record"><RecordTab s={s} /></TabsContent>
              <TabsContent value="attendance"><ComingTab icon={CalendarCheck} title="Attendance will appear here" text="Once the Attendance module is switched on (next phase), this tab shows the month-by-month working days, days present and attendance %, and warns when it falls below 75 %." /></TabsContent>
              {can(P.FEES_READ) && <TabsContent value="fees"><FeesTab studentId={s.id} /></TabsContent>}
              <TabsContent value="exams"><ComingTab icon={BookCheck} title="Marks and results will appear here" text="After the Exams module is built, this tab shows UT1, UT2, Semester I and II marks for every subject, grades (A1–E2), and the approved report card." /></TabsContent>
            </Tabs>
            {dlg === 'division' && <DivisionDialog s={s} onClose={() => setDlg(null)} />}
            {dlg === 'status' && <StatusDialog s={s} onClose={() => setDlg(null)} />}
          </>
        )}
      </QueryView>
    </>
  );
}

/** A new admission entered by the office waits for the Headmaster: approve (GR No, roll no and fees are given) or reject. */
function AdmissionBanner({ s }: { s: StudentDetail }) {
  const [mode, setMode] = useState<'reject' | 'return' | null>(null);
  const [reason, setReason] = useState('');
  const [grNo, setGrNo] = useState('');
  const inv = { invalidate: [['students'], ['dashboard'], ['fees']] as unknown[][] };
  const approve = useSave(() => api.post(`/students/${s.id}/admission/approve`, { grNo: grNo.trim() || null }), { ...inv, success: 'Admission confirmed' });
  const reject = useSave(() => api.post(`/students/${s.id}/admission/reject`, { reason }), { ...inv, success: 'Admission rejected', onSuccess: () => setMode(null) });
  const sendBack = useSave(() => api.post(`/students/${s.id}/admission/return`, { reason }), { ...inv, success: 'Sent back to the office for correction', onSuccess: () => { setMode(null); setReason(''); } });
  const resubmit = useSave(() => api.post(`/students/${s.id}/admission/resubmit`), { ...inv, success: 'Sent to the Headmaster again' });
  if (s.status === 'REJECTED') {
    const h = s.statusHistory.find((x) => x.toStatus === 'REJECTED');
    return <Card className="mb-4 border-red-200 bg-red-50 p-4 text-sm text-red-900">This admission was <b>rejected</b> on {formatDate(h?.effectiveDate ?? null)}. {h?.reason}</Card>;
  }
  if (s.status !== 'PENDING_APPROVAL') return null;
  const returned = !!s.correctionNote;
  return (
    <Card className={cn('mb-4 p-4', returned ? 'border-red-300 bg-red-50 text-red-950' : 'border-amber-300 bg-amber-50 text-amber-950')}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {returned ? (
            <>
              <p className="font-semibold">Sent back for correction{s.correctionRequestedAt ? ` on ${formatDate(s.correctionRequestedAt)}` : ''}</p>
              <p className="text-sm">Headmaster's note: <b>{s.correctionNote}</b></p>
              <p className="text-sm">{s.access.edit && !s.access.approveAdmission ? 'Correct the form with Edit details, then send it to the Headmaster again.' : 'Waiting for the office to correct the form and send it again.'}</p>
            </>
          ) : (
            <>
              <p className="font-semibold">Provisional admission: waiting for the Headmaster to confirm</p>
              <p className="text-sm">The office can collect fees and edit every section until the admission is confirmed. The roll no is given on confirmation; the GR No can be entered now or added later.</p>
            </>
          )}
        </div>
        {returned && s.access.edit && !s.access.approveAdmission && <Button onClick={() => resubmit.mutate(undefined)} loading={resubmit.isPending}><Check /> Send to Headmaster again</Button>}
        {s.access.approveAdmission && !returned && <>
          <Input className="w-40 bg-white uppercase placeholder:normal-case" placeholder="GR No (optional)" aria-label="GR No (optional)" value={grNo} onChange={(e) => setGrNo(e.target.value)} />
          <Button onClick={() => approve.mutate(undefined)} loading={approve.isPending}><Check /> Confirm admission</Button>
          <Button variant="outline" onClick={() => { setMode('return'); setReason(''); }}>Send back for correction</Button>
        </>}
        {s.access.approveAdmission && <Button variant="outline" onClick={() => { setMode('reject'); setReason(''); }}>Reject</Button>}
      </div>
      {mode && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Input className="min-w-64 flex-1 bg-white" autoFocus
            placeholder={mode === 'return' ? 'What should the office correct? e.g. Date of birth does not match the birth certificate' : 'Reason, e.g. Age below the minimum for this class'}
            value={reason} onChange={(e) => setReason(e.target.value)} aria-label={mode === 'return' ? 'What to correct' : 'Reason for rejecting'} />
          {mode === 'return'
            ? <Button disabled={reason.trim().length < 3} loading={sendBack.isPending} onClick={() => sendBack.mutate(undefined)}>Send back</Button>
            : <Button variant="destructive" disabled={reason.trim().length < 3} loading={reject.isPending} onClick={() => reject.mutate(undefined)}>Reject admission</Button>}
          <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
        </div>
      )}
    </Card>
  );
}

/** Add or correct the GR No after confirmation (office or Headmaster). */
function GrNoButton({ s }: { s: StudentDetail }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(s.grNo ?? '');
  const save = useSave(() => api.patch(`/students/${s.id}/gr-no`, { grNo: value.trim() || null }), {
    invalidate: [['students'], ['fees']], success: 'GR No saved', onSuccess: () => setOpen(false),
  });
  return (
    <>
      <Button variant={s.grNo ? 'outline' : 'default'} size="sm" onClick={() => { setValue(s.grNo ?? ''); setOpen(true); }}><Pencil /> {s.grNo ? 'Change GR No' : 'Add GR No'}</Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent title={s.grNo ? 'Change GR No' : 'Add GR No'} description="The number from the school's General Register. It is printed on the admission form, receipts and report cards.">
            <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
              <Field label="GR No" htmlFor="grno"><Input id="grno" className="uppercase" autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={30} /></Field>
              <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function ProfileHeader({ s, onDivision, onStatus }: { s: StudentDetail; onDivision: () => void; onStatus: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const upload = useSave((f: File) => { const fd = new FormData(); fd.append('file', f); return api.post(`/students/${s.id}/photo`, fd); }, { invalidate: [['students'], ['student-photo']], success: 'Photo updated' });
  const c = s.current;
  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="relative self-start">
          <StudentAvatar name={s.fullName} studentId={s.id} photoFileId={s.photoFileId} size="lg" />
          {s.access.edit && (
            <>
              <button onClick={() => ref.current?.click()} className="absolute -right-1 -bottom-1 grid size-8 place-items-center rounded-full border bg-card shadow-sm hover:bg-muted print:hidden" aria-label="Upload photo" title="Upload photo">
                <Camera className="size-4" />
              </button>
              <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{s.fullName}</h1>
            <StudentStatusBadge status={s.status} />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Fact label="Class" value={divisionLabel(c.section)} />
            <Fact label="Roll No" value={c.rollNo ?? '—'} />
            <Fact label="Exam No" value={c.examNo ?? '—'} mono />
            <Fact label="GR No" value={grNoLabel(s)} mono />
            <Fact label="Gender" value={s.dob && s.access.contact ? `${age(s.dob)} years` : GENDER_LABELS[s.gender]} />
            <Fact label="Class teacher" value={s.classTeacher?.name ?? '—'} />
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:items-end print:hidden">
          {s.access.edit && <Button variant="outline" size="sm" asChild><Link to={`/students/${s.id}/edit`}><Pencil /> Edit details</Link></Button>}
          {s.access.editGrNo && <GrNoButton s={s} />}
          {s.access.editEnrollment && <Button variant="outline" size="sm" onClick={onDivision}><Shuffle /> Division / roll no</Button>}
          {s.access.changeStatus && s.status !== 'PENDING_APPROVAL' && <Button variant="outline" size="sm" onClick={onStatus}>{s.status === 'ACTIVE' ? 'Mark as left / TC' : 'Re-admit'}</Button>}
          <FeeCertificateButton s={s} />
          <Button variant="ghost" size="sm" asChild><Link to={`/students/${s.id}/admission-form`}><Printer /> Print admission form</Link></Button>
        </div>
      </div>
    </Card>
  );
}

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className={cn('font-medium', mono && 'font-mono')}>{value}</p></div>;
}

function ProfileTab({ s }: { s: StudentDetail }) {
  const a = s.access;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Personal details" icon={UserRound}>
        <Info items={[
          ['Surname', s.surname], ['First name', s.firstName], ['Father\'s name', s.fatherName], ['Mother\'s name', s.motherName],
          ['Gender', GENDER_LABELS[s.gender]],
          ['Date of birth', a.contact ? (s.dob ? `${formatDate(s.dob)} (${age(s.dob)} years)` : null) : <Hidden />],
          ['Place of birth', a.contact ? s.birthPlace : <Hidden />], ['Mother tongue', s.motherTongue], ['Blood group', s.bloodGroup],
          ['Nationality', s.nationality], ['Comes to school by', a.contact ? s.transportMode : <Hidden />], ['Admission type', s.isRte ? <Badge variant="secondary">RTE (25 % quota)</Badge> : 'Regular'],
          ['Date of birth in words', a.contact ? dateInWords(s.dob) : <Hidden />],
        ]} />
      </Panel>
      <Panel title="Admission and IDs">
        <Info items={[
          ['Student ID', <span className="font-mono">{s.studentCode}</span>], ['Admission form No.', s.admissionFormNo ? <span className="font-mono">{s.admissionFormNo}</span> : null], ['GR No (General Register)', grNoLabel(s) ? <span className="font-mono">{grNoLabel(s)}</span> : ''],
          ['Admission date', a.contact ? formatDate(s.admissionDate) : <Hidden />], ['Previous school', a.contact ? s.previousSchool : <Hidden />],
          ['Std Passed', a.contact ? s.previousClass : <Hidden />], ['Last Std Passed Year', a.contact ? s.previousSchoolYear : <Hidden />], ['LC / TC no.', a.contact ? [s.previousLcNo, s.previousLcDate && formatDate(s.previousLcDate)].filter(Boolean).join(' · ') : <Hidden />],
          ['PEN (UDISE+)', s.pen], ['APAAR ID', s.apaarId], ['Saral ID', s.saralId], ['School UID (from sheets)', s.schoolUid],
        ]} />
      </Panel>
      <Panel title="Government / reserved details" icon={Lock}>
        {a.sensitive
          ? <Info items={[
            ['Religion', s.religion], ['Category', s.category], ['Caste', s.caste], ['Sub-caste', s.subCaste], ['Aadhaar', s.aadhaarLast4 ? `XXXX XXXX ${s.aadhaarLast4}` : null],
            ['BPL family', s.isBpl ? 'Yes' : 'No'], ['Minority', s.isMinority ? 'Yes' : 'No'],
          ]} />
          : <Restricted text="Religion, category, caste, Aadhaar, BPL / minority status are visible only to the Headmaster and school admin." />}
      </Panel>
      {a.contact && <DocumentsPanel s={s} />}
      {a.contact && s.notes && <Panel title="Notes" className="lg:col-span-2"><p className="text-sm whitespace-pre-wrap">{s.notes}</p></Panel>}
    </div>
  );
}

/** Checklist of admission documents with the uploaded scans; office can attach more straight from the profile. */
function DocumentsPanel({ s }: { s: StudentDetail }) {
  const received = new Set(s.documents ?? []);
  const upload = useSave(async ({ docType, files }: { docType: string; files: File[] }) => {
    for (const f of files) {
      if (f.size > MAX_DOCUMENT_BYTES) throw new Error(`${f.name} is ${fileSize(f.size)}; the limit is 5 MB`);
      const fd = new FormData();
      fd.append('docType', docType);
      fd.append('file', f);
      await api.post(`/students/${s.id}/documents`, fd);
    }
  }, { invalidate: [['students']], success: 'Document uploaded' });
  const shown = ADMISSION_DOCUMENTS.filter((d) => received.has(d) || s.documentFiles.some((f) => f.docType === d) || s.access.edit);
  return (
    <Panel title="Documents" icon={FileText} className="lg:col-span-2">
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">No documents recorded.</p> : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((d) => {
            const files = s.documentFiles.filter((f) => f.docType === d);
            return (
              <div key={d} className={cn('grid content-start gap-1.5 rounded-lg border px-3 py-2 text-sm', received.has(d) ? 'border-emerald-300 bg-emerald-50/60' : 'border-dashed')}>
                <div className="flex items-center gap-2">
                  <span className={cn('flex-1 font-medium', !received.has(d) && 'text-muted-foreground')}>{received.has(d) ? '✓ ' : ''}{d}</span>
                  {s.access.edit && (
                    <label className={cn('inline-flex cursor-pointer items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs font-medium hover:bg-muted', upload.isPending && 'pointer-events-none opacity-50')}>
                      <Paperclip className="size-3.5" /> {files.length ? 'Add' : 'Upload'}
                      <input type="file" multiple accept={ACCEPT_DOCUMENTS} className="sr-only" onChange={(e) => { const list = Array.from(e.target.files ?? []); if (list.length) upload.mutate({ docType: d, files: list }); e.target.value = ''; }} />
                    </label>
                  )}
                </div>
                {files.length ? <UploadedFiles studentId={s.id} files={files} canDelete={s.access.edit} /> : <p className="text-xs text-muted-foreground">{received.has(d) ? 'Paper copy received; no scan uploaded' : 'Not received'}</p>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

const Hidden = () =><span className="inline-flex items-center gap-1 text-muted-foreground"><Lock className="size-3" /> hidden</span>;

function ParentsTab({ s }: { s: StudentDetail }) {
  if (!s.guardians.length) return <Card><EmptyState title="No parent details recorded" /></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {s.guardians.map((g) => (
        <Card key={g.id} className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <Badge variant="secondary">{GUARDIAN_RELATION_LABELS[g.relation]}</Badge>
            {g.isPrimary && <Badge>Main contact</Badge>}
          </div>
          <p className="text-lg font-medium">{g.name}</p>
          {s.access.contact ? (
            <div className="mt-3 grid gap-1.5 text-sm">
              {g.mobile ? <a href={`tel:${g.mobile}`} className="inline-flex items-center gap-2 font-medium text-primary hover:underline"><Phone className="size-4" /> {g.mobile}</a> : <span className="text-muted-foreground">No mobile number</span>}
              {g.altMobile && <a href={`tel:${g.altMobile}`} className="inline-flex items-center gap-2 text-primary hover:underline"><Phone className="size-4" /> {g.altMobile}</a>}
              {g.whatsapp && <a href={`https://wa.me/91${g.whatsapp}`} className="text-emerald-700 hover:underline">WhatsApp {g.whatsapp}</a>}
            </div>
          ) : <div className="mt-3"><Restricted text="Phone numbers are visible to the class teacher, Headmaster and office." /></div>}
        </Card>
      ))}
    </div>
  );
}

function RecordTab({ s }: { s: StudentDetail }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Class each year">
        <Table>
          <THead><TR><TH>Year</TH><TH>Class</TH><TH>Roll</TH><TH>Exam No</TH><TH>Status</TH></TR></THead>
          <TBody>
            {s.enrollments.map((e) => (
              <TR key={e.id}>
                <TD className="font-medium">{e.academicYear.name}</TD><TD>{divisionLabel(e.section)}</TD><TD>{e.rollNo ?? '—'}</TD>
                <TD className="font-mono text-xs">{e.examNo ?? '—'}</TD><TD>{e.status === 'ACTIVE' ? 'Studying' : e.status.replace('_', ' ').toLowerCase()}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">Each new year (after promotion) adds a row here. Marks and attendance are kept with the year they belong to.</p>
      </Panel>
      <Panel title="History">
        <ol className="relative grid gap-4 border-l pl-5">
          {s.statusHistory.map((h) => (
            <li key={h.id} className="relative">
              <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full bg-primary" />
              <p className="text-sm font-medium">{h.fromStatus ? `${STATUS_LABEL[h.fromStatus] ?? h.fromStatus} → ${STATUS_LABEL[h.toStatus] ?? h.toStatus}` : 'Admitted'}</p>
              <p className="text-xs text-muted-foreground">{formatDate(h.effectiveDate)} · {h.reason}</p>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function ComingTab({ icon, title, text }: { icon: React.ElementType; title: string; text: string }) {
  return <Card className="border-dashed"><EmptyState icon={icon} title={title} description={text} /></Card>;
}

// ======================================================================= dialogs

function DivisionDialog({ s, onClose }: { s: StudentDetail; onClose: () => void }) {
  const overview = useStudentsOverview();
  const [sectionId, setSectionId] = useState(String(s.current.sectionId));
  const [rollNo, setRollNo] = useState(s.current.rollNo ? String(s.current.rollNo) : '');
  const [examNo, setExamNo] = useState(s.current.examNo ?? '');
  const moving = sectionId !== String(s.current.sectionId);
  const save = useSave(() => api.patch(`/students/${s.id}/enrollment`, { sectionId: Number(sectionId), rollNo: moving && rollNo === String(s.current.rollNo) ? '' : rollNo, examNo }), {
    invalidate: [['students']], success: 'Saved', onSuccess: onClose,
  });
  const sameYear = (overview.data?.sections ?? []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Division, roll no and exam no" description={`${s.fullName} · ${s.current.academicYear.name}`}>
        <div className="grid gap-4">
          <Field label="Class and division" htmlFor="dv" hint={moving ? 'Moving to another division gives the next free roll no there unless you type one.' : undefined}>
            <DivisionSelect id="dv" divisions={sameYear} value={sectionId} onChange={setSectionId} allLabel="" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Roll No" htmlFor="rn" hint="Leave blank for the next free number"><Input id="rn" inputMode="numeric" value={rollNo} onChange={(e) => setRollNo(e.target.value)} /></Field>
            <Field label="Exam No" htmlFor="en"><Input id="en" value={examNo} onChange={(e) => setExamNo(e.target.value)} /></Field>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({ s, onClose }: { s: StudentDetail; onClose: () => void }) {
  const form = useForm<z.input<typeof studentStatusSchema>>({ defaultValues: { status: s.status === 'ACTIVE' ? 'WITHDRAWN' : 'ACTIVE', effectiveDate: new Date().toISOString().slice(0, 10), reason: '' } });
  const [error, setError] = useState<Record<string, string>>({});
  const save = useSave((v: z.output<typeof studentStatusSchema>) => api.post(`/students/${s.id}/status`, v), { invalidate: [['students']], success: 'Status changed', onSuccess: onClose });
  const submit = form.handleSubmit((v) => {
    const r = studentStatusSchema.safeParse(v);
    if (!r.success) return setError(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message])));
    save.mutate(r.data);
  });
  const options = STUDENT_STATUS.filter((x) => x !== s.status);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={s.status === 'ACTIVE' ? 'Student leaving the school' : 'Change status'} description={`${s.fullName}. The change and the reason are kept in the student's history.`}>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field label="New status" htmlFor="st"><Select id="st" {...form.register('status')}>{options.map((o) => <option key={o} value={o}>{STATUS_LABEL[o as StudentStatus]}</option>)}</Select></Field>
          <Field label="From date" htmlFor="ed" error={error.effectiveDate}><Input id="ed" type="date" {...form.register('effectiveDate')} /></Field>
          <Field label="Reason" htmlFor="rs" required error={error.reason}><Textarea id="rs" rows={2} placeholder="e.g. Family moved to Pune, TC issued" {...form.register('reason')} /></Field>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= admission / edit form

type ParentFields = { name: string; nameHi: string; mobile: string; altMobile: string; occupation: string; education: string; annualIncome: string; whatsapp: string; email: string };
type FormValues = Omit<z.input<typeof studentSchema>, 'guardians'> & {
  father: ParentFields; mother: ParentFields; guardian: ParentFields & { relation: 'GUARDIAN' | 'OTHER' };
  primary: 'FATHER' | 'MOTHER' | 'GUARDIAN';
  sectionId: string; rollNo: string; examNo: string; joinedOn: string;
};
const emptyParent: ParentFields = { name: '', nameHi: '', mobile: '', altMobile: '', occupation: '', education: '', annualIncome: '', whatsapp: '', email: '' };

function toForm(s: StudentDetail | undefined, sectionId: string): FormValues {
  const g = (rel: string) => s?.guardians.find((x) => x.relation === rel);
  const parent = (x?: StudentDetail['guardians'][number]): ParentFields => x ? { name: x.name, nameHi: x.nameHi ?? '', mobile: x.mobile ?? '', altMobile: x.altMobile ?? '', occupation: x.occupation ?? '', education: x.education ?? '', annualIncome: x.annualIncome ?? '', whatsapp: x.whatsapp ?? '', email: x.email ?? '' } : { ...emptyParent };
  const other = s?.guardians.find((x) => x.relation === 'GUARDIAN' || x.relation === 'OTHER');
  return {
    fullName: s?.fullName ?? '', fullNameHi: s?.fullNameHi ?? '', surname: s?.surname ?? '', firstName: s?.firstName ?? '', fatherName: s?.fatherName ?? '', motherName: s?.motherName ?? '',
    gender: (s?.gender ?? '') as 'MALE', dob: isoDay(s?.dob), birthPlace: s?.birthPlace ?? '', motherTongue: s?.motherTongue ?? '', bloodGroup: (s?.bloodGroup ?? '') as 'A+',
    religion: s?.religion ?? '', category: s?.category ?? '', caste: s?.caste ?? '', aadhaarLast4: s?.aadhaarLast4 ?? '',
    addressLine: s?.addressLine ?? '', city: s?.city ?? 'Mumbai', pincode: s?.pincode ?? '', admissionDate: isoDay(s?.admissionDate) || (s ? '' : new Date().toISOString().slice(0, 10)),
    previousSchool: s?.previousSchool ?? '', previousClass: s?.previousClass ?? '', previousSchoolYear: s?.previousSchoolYear ?? '', previousLcNo: s?.previousLcNo ?? '', previousLcDate: isoDay(s?.previousLcDate),
    nationality: s?.nationality ?? 'Indian', subCaste: s?.subCaste ?? '', isRte: s?.isRte ?? false, cwsn: s?.cwsn ?? '', transportMode: s?.transportMode ?? '', documents: s?.documents ?? [],
    grNo: s?.grNo ?? '', schoolUid: s?.schoolUid ?? '', saralId: s?.saralId ?? '', apaarId: s?.apaarId ?? '', notes: s?.notes ?? '',
    pen: s?.pen ?? '', identificationMarks: s?.identificationMarks ?? '', heightCm: s?.heightCm ?? '', weightKg: s?.weightKg ?? '',
    medicalNotes: s?.medicalNotes ?? '', emergencyName: s?.emergencyName ?? '', emergencyRelation: s?.emergencyRelation ?? '', emergencyMobile: s?.emergencyMobile ?? '',
    siblingsInSchool: s?.siblingsInSchool ?? '', isBpl: s?.isBpl ?? false, isMinority: s?.isMinority ?? false,
    bankAccountNo: s?.bankAccountNo ?? '', bankIfsc: s?.bankIfsc ?? '', bankName: s?.bankName ?? '',
    father: parent(g('FATHER')), mother: parent(g('MOTHER')), guardian: { ...parent(other), relation: (other?.relation as 'GUARDIAN') ?? 'GUARDIAN' },
    primary: (s?.guardians.find((x) => x.isPrimary)?.relation as 'FATHER') ?? 'FATHER',
    sectionId, rollNo: '', examNo: '', joinedOn: '',
  };
}

function toPayload(v: FormValues) {
  const guardians: { key: string; data: Record<string, unknown> }[] = [];
  const add = (key: 'father' | 'mother' | 'guardian', relation: string) => {
    const p = v[key];
    if (p.name.trim()) guardians.push({ key, data: { relation, name: p.name, nameHi: p.nameHi, mobile: p.mobile, altMobile: p.altMobile, occupation: p.occupation, education: p.education, annualIncome: p.annualIncome, whatsapp: p.whatsapp, email: p.email, isPrimary: v.primary === relation || (key === 'guardian' && v.primary === 'GUARDIAN') } });
  };
  add('father', 'FATHER');
  add('mother', 'MOTHER');
  add('guardian', v.guardian.relation);
  const { father: _f, mother: _m, guardian: _g, primary: _p, sectionId, rollNo, examNo, joinedOn, ...student } = v;
  return { student: { ...student, guardians: guardians.map((g) => g.data) }, enrollment: { sectionId, rollNo, examNo, joinedOn }, guardianKeys: guardians.map((g) => g.key) };
}

export function StudentFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const existing = useQuery({ queryKey: ['students', 'detail', id], queryFn: () => api.get<StudentDetail>(`/students/${id}`), enabled: editing });
  if (editing && existing.isPending) return <QueryView query={existing}>{() => null}</QueryView>;
  if (editing && existing.isError) return <QueryView query={existing}>{() => null}</QueryView>;
  return <StudentForm existing={existing.data} />;
}

function StudentForm({ existing }: { existing?: StudentDetail }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const { yearId: workingYear } = useWorkingContext();
  const years = useYears();
  // Admission can be for the current year or a later one (admissions for the next year start any month).
  const current = years.data?.find((y) => y.isCurrent);
  const admissionYears = (years.data ?? []).filter((y) => y.status !== 'CLOSED' && (!current || y.isCurrent || y.startDate > current.startDate))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const [admYear, setAdmYear] = useState<number | null>(params.get('year') ? Number(params.get('year')) : null);
  const admYearId = admYear ?? workingYear;
  const chosenYear = years.data?.find((y) => y.id === admYearId);
  const overview = useStudentsOverview(admYearId);
  const copyClasses = useSave(() => api.post<{ copiedClasses: number }>(`/academic-years/${admYearId}/copy-structure`), { invalidate: [['students'], ['classes']], success: 'Classes copied to the new year' });
  const standards = useStandards();
  const defaults = useMemo(() => toForm(existing, params.get('section') ?? ''), [existing, params]);
  const form = useForm<FormValues>({ defaultValues: defaults });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Photo and scans are chosen here and uploaded right after the student is saved.
  const [photo, setPhoto] = useState<File | null>(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  const [pending, setPending] = useState<{ docType: string; file: File }[]>([]);
  const [dupOk, setDupOk] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const canSensitive = !existing || existing.access.sensitive;
  /** Only the Headmaster enters or changes the GR No; the office's admissions get it when confirmed. */
  const canGr = can(P.STUDENTS_ADMISSION_APPROVE);

  const save = useSave(
    async (body: { student: unknown; enrollment: unknown }) => {
      const r = existing ? await api.patch<{ id: number }>(`/students/${existing.id}`, body.student as object) : await api.post<{ id: number }>('/students', body);
      const sid = existing?.id ?? r.id;
      const failed: string[] = [];
      if (photo) {
        const fd = new FormData();
        fd.append('file', photo);
        await api.post(`/students/${sid}/photo`, fd).catch((e) => failed.push(`photo (${errorMessage(e)})`));
      }
      for (const p of pending) {
        const fd = new FormData();
        fd.append('docType', p.docType);
        fd.append('file', p.file);
        await api.post(`/students/${sid}/documents`, fd).catch((e) => failed.push(`${p.docType} (${errorMessage(e)})`));
      }
      return { id: sid, failed };
    },
    {
      invalidate: [['students'], ['student-photo'], ['dashboard']], success: existing ? 'Student details saved' : can(P.STUDENTS_ADMISSION_APPROVE) ? 'Student admitted' : 'Admission saved and sent to the Headmaster for approval',
      onSuccess: (r) => {
        if (r.failed.length) toast.error(`Saved, but these files did not upload: ${r.failed.join('; ')}. Open "Edit details" to try again.`);
        navigate(`/students/${r.id}`);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.errors.length) {
          setErrors(Object.fromEntries(e.errors.map((x) => [x.path.replace(/^student\./, '').replace(/^enrollment\./, ''), x.message])));
        }
      },
    },
  );

  // Live check: is this child already in the school (same name, or same date of birth + mother's name)?
  const [wName, wDob, wMother] = form.watch(['fullName', 'dob', 'motherName']);
  const dupQuery = useDebounced(JSON.stringify({ fullName: (wName ?? '').trim(), dob: wDob ?? '', motherName: (wMother ?? '').trim() }), 500);
  const dupParams = JSON.parse(dupQuery) as { fullName: string; dob: string; motherName: string };
  const duplicates = useQuery({
    queryKey: ['students', 'duplicates', dupQuery, existing?.id],
    queryFn: () => api.get<StudentDuplicate[]>(`/students/duplicates${qs({ ...dupParams, excludeId: existing?.id })}`),
    enabled: dupParams.fullName.length >= 3 || (!!dupParams.dob && dupParams.motherName.length >= 2),
    placeholderData: (prev) => prev,
  });
  const dups = duplicates.data ?? [];
  useEffect(() => setDupOk(false), [dupQuery]);

  const submit = form.handleSubmit((v) => {
    const { guardianKeys, ...payload } = toPayload(v);
    const parsed = existing ? studentSchema.safeParse(payload.student) : studentCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const path = i.path.map(String);
        if (path[0] === 'student') path.shift();
        if (path[0] === 'enrollment') path.shift();
        if (path[0] === 'guardians' && path[1] !== undefined) map[`${guardianKeys[Number(path[1])]}.${path[2] ?? 'name'}`] = i.message;
        else map[path.join('.')] = i.message;
      }
      setErrors(map);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (dups.length && !dupOk) {
      setErrors({});
      document.getElementById('duplicates')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast.error('This child may already be in the school. Check the list and tick the box if it is a different child.');
      return;
    }
    setErrors({});
    save.mutate(payload);
  });
  const reg = form.register;
  const E = (k: string) => errors[k];
  const nErrors = Object.keys(errors).length;

  // Suggest the full name in the school's style: SURNAME FIRST FATHER MOTHER.
  const [sur, first, fat, mot] = form.watch(['surname', 'firstName', 'fatherName', 'motherName']);
  const suggested = [sur, first, fat, mot].map((x) => (x ?? '').trim()).filter(Boolean).join(' ').toUpperCase();
  const dobWords = dateInWords(form.watch('dob') || null);
  const n = (k: string) => (existing ? '' : `${k}. `);

  const pickPhoto = (f: File | undefined) => {
    if (!f) return;
    if (!ACCEPT_PHOTO.split(',').includes(f.type)) return toast.error('Choose a JPG, PNG or WebP photo');
    if (f.size > 2 * 1024 * 1024) return toast.error('Photo must be 2 MB or smaller. Take it again at a lower resolution.');
    setPhoto(f);
  };
  const addDoc = (docType: string, files: FileList | null) => {
    const ok: { docType: string; file: File }[] = [];
    for (const f of Array.from(files ?? [])) {
      if (!ACCEPT_DOCUMENTS.split(',').includes(f.type)) { toast.error(`${f.name}: only PDF, JPG, PNG or WebP`); continue; }
      if (f.size > MAX_DOCUMENT_BYTES) { toast.error(`${f.name} is ${fileSize(f.size)}; the limit is 5 MB`); continue; }
      ok.push({ docType, file: f });
    }
    if (!ok.length) return;
    setPending((p) => [...p, ...ok]);
    const docs = form.getValues('documents') ?? [];
    if (!docs.includes(docType)) form.setValue('documents', [...docs, docType]);
  };

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2" asChild><Link to={existing ? `/students/${existing.id}` : '/students'}><ArrowLeft /> {existing ? 'Back to profile' : 'Students'}</Link></Button>
        <Button variant="outline" size="sm" className="ml-auto" asChild><Link to="/students/admission-form/blank"><Printer /> Print blank form</Link></Button>
        {existing && <Button variant="outline" size="sm" asChild><Link to={`/students/${existing.id}/admission-form`}><Printer /> Print filled form</Link></Button>}
      </div>
      <PageHeader title={existing ? `Edit ${existing.fullName}` : 'Admit a new student'} description={existing ? 'Changes are saved in the audit log with your name.' : canGr ? 'Fields marked * are required. Exam no and roll no are given automatically if left blank; the GR No can be added later.' : 'Fields marked * are required. The student is saved as Provisional until the Headmaster confirms; you can edit every section until then. The GR No is added after confirmation.'} />
      {nErrors > 0 && <Card className="mb-4 border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">Please correct {nErrors} {nErrors === 1 ? 'field' : 'fields'} marked below.</Card>}
      <form onSubmit={submit} noValidate className="grid gap-4">
        {!existing && (
          <Panel title="1. Class and admission">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {admissionYears.length > 1 && (
                <Field label="Admission for academic year" htmlFor="ay" required hint={chosenYear && !chosenYear.isCurrent ? `The student joins on ${formatDate(chosenYear.startDate)}; the ${chosenYear.name} class fee applies.` : undefined}>
                  <Select id="ay" value={String(admYearId ?? '')} onChange={(e) => { setAdmYear(Number(e.target.value)); form.setValue('sectionId', ''); }}>
                    {admissionYears.map((y) => <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ' (current year)' : ' (next year)'}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Class and division" htmlFor="sec" required error={E('sectionId')} className={admissionYears.length > 1 ? undefined : 'lg:col-span-2'}
                hint={overview.data && !overview.data.sections.length ? `No classes are set up for ${chosenYear?.name ?? 'this year'} yet.${can(P.ACADEMICS_MANAGE) ? '' : ' Ask the Headmaster or admin to copy the classes to the new year.'}` : undefined}>
                <DivisionSelect id="sec" divisions={overview.data?.sections ?? []} value={form.watch('sectionId')} onChange={(v) => form.setValue('sectionId', v)} allLabel="— Choose —" />
                {overview.data && !overview.data.sections.length && chosenYear && !chosenYear.isCurrent && can(P.ACADEMICS_MANAGE) && (
                  <Button type="button" size="sm" variant="outline" className="mt-2" loading={copyClasses.isPending} onClick={() => copyClasses.mutate(undefined)}>Copy this year's classes to {chosenYear.name}</Button>
                )}
              </Field>
              <Field label="Admission date" htmlFor="ad" error={E('admissionDate')}><Input id="ad" type="date" {...reg('admissionDate')} /></Field>
              {canGr && <Field label="GR No" htmlFor="gr" hint="Leave blank if not known yet; it can be added later" error={E('grNo')}><Input id="gr" className="uppercase" {...reg('grNo')} /></Field>}
              <Field label="Roll No" htmlFor="roll" hint="Blank = next number" error={E('rollNo')}><Input id="roll" inputMode="numeric" {...reg('rollNo')} /></Field>
              <Field label="Exam No" htmlFor="exam" hint="Blank = next E#### / H####" error={E('examNo')}><Input id="exam" {...reg('examNo')} /></Field>
              <Field label="Comes to school by" htmlFor="tr"><OptionSelect id="tr" options={TRANSPORT_MODES} {...reg('transportMode')} /></Field>
              <label className="flex items-start gap-2 rounded-xl border bg-muted/30 p-3 text-sm">
                <Checkbox className="mt-0.5" {...reg('isRte')} />
                <span><b>RTE admission</b> (25 % quota)<span className="block text-xs text-muted-foreground">Fees marked "waived for RTE" are not charged</span></span>
              </label>
            </div>
          </Panel>
        )}

        <Panel title={`${n('2')}Student`}>
          <div className="flex flex-col gap-5 lg:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-2">
              <button type="button" onClick={() => photoInput.current?.click()} aria-label="Choose student photo"
                className="grid h-40 w-32 place-items-center overflow-hidden rounded-xl border-2 border-dashed bg-muted/30 text-center text-xs text-muted-foreground hover:border-primary hover:text-primary">
                {photoUrl ? <img src={photoUrl} alt="New photo" className="size-full object-cover" />
                  : existing?.photoFileId ? <StudentAvatar name={existing.fullName} studentId={existing.id} photoFileId={existing.photoFileId} size="lg" />
                    : <span className="grid place-items-center gap-1 p-2"><Camera className="size-6" />Student photo<br />(passport size)</span>}
              </button>
              <input ref={photoInput} type="file" accept={ACCEPT_PHOTO} capture="user" className="hidden" onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
              <div className="flex gap-1">
                <Button type="button" size="sm" variant="outline" onClick={() => photoInput.current?.click()}><Camera /> {photo || existing?.photoFileId ? 'Change' : 'Add photo'}</Button>
                {photo && <Button type="button" size="sm" variant="ghost" onClick={() => setPhoto(null)} aria-label="Remove chosen photo"><X /></Button>}
              </div>
              <p className="w-32 text-center text-[11px] text-muted-foreground">JPG / PNG, up to 2 MB. On a phone this opens the camera.</p>
            </div>
            <div className="grid flex-1 content-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Surname" htmlFor="sn" error={E('surname')}><Input id="sn" {...reg('surname')} /></Field>
              <Field label="First name" htmlFor="fn" error={E('firstName')}><Input id="fn" {...reg('firstName')} /></Field>
              <Field label="Father's name" htmlFor="ftn" error={E('fatherName')}><Input id="ftn" {...reg('fatherName')} /></Field>
              <Field label="Mother's name" htmlFor="mtn" error={E('motherName')}><Input id="mtn" {...reg('motherName')} /></Field>
              <Field label="Full name (as in school register)" htmlFor="full" required error={E('fullName')} className="sm:col-span-2"
                hint={suggested && suggested !== (form.watch('fullName') ?? '').toUpperCase() ? undefined : 'Order used by the school: SURNAME FIRST FATHER MOTHER'}>
                <div className="flex gap-2">
                  <Input id="full" className="uppercase" {...reg('fullName')} />
                  {suggested && suggested !== (form.watch('fullName') ?? '').toUpperCase() && (
                    <Button type="button" variant="outline" onClick={() => form.setValue('fullName', suggested)} title={suggested}>Use {suggested.length > 22 ? 'parts' : suggested}</Button>
                  )}
                </div>
              </Field>
              <Field label="Gender" htmlFor="gd" required error={E('gender')}>
                <Select id="gd" {...reg('gender')}><option value="">— Choose —</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other (transgender)</option></Select>
              </Field>
              <Field label="Date of birth" htmlFor="dob" error={E('dob')} hint={age(form.watch('dob') || null) != null ? `${age(form.watch('dob') || null)} years old` : undefined}><Input id="dob" type="date" {...reg('dob')} /></Field>
              <Field label="Date of birth in words" htmlFor="dobw" className="sm:col-span-2" hint="Filled in automatically; printed in the GR and on the LC">
                <Input id="dobw" readOnly tabIndex={-1} value={dobWords} placeholder="Enter the date of birth" className="bg-muted/40" />
              </Field>
              <Field label="Place of birth" htmlFor="bp" error={E('birthPlace')}><Input id="bp" {...reg('birthPlace')} /></Field>
              <Field label="Nationality" htmlFor="nat"><OptionSelect id="nat" options={NATIONALITIES} {...reg('nationality')} /></Field>
              <Field label="Mother tongue" htmlFor="mt" error={E('motherTongue')}><OptionSelect id="mt" options={MOTHER_TONGUES} {...reg('motherTongue')} /></Field>
              <Field label="Blood group" htmlFor="bg" error={E('bloodGroup')}>
                <Select id="bg" {...reg('bloodGroup')}><option value="">Not known</option>{BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}</Select>
              </Field>
              {existing && canGr && existing.status !== 'PENDING_APPROVAL' && <Field label="GR No" htmlFor="gr2" error={E('grNo')}><Input id="gr2" className="uppercase" {...reg('grNo')} /></Field>}
              {existing && <Field label="Admission date" htmlFor="ad2" error={E('admissionDate')}><Input id="ad2" type="date" {...reg('admissionDate')} /></Field>}
              {existing && <Field label="Comes to school by" htmlFor="tr2"><OptionSelect id="tr2" options={TRANSPORT_MODES} {...reg('transportMode')} /></Field>}
              {existing && <label className="flex items-center gap-2 self-end pb-2 text-sm"><Checkbox {...reg('isRte')} /> RTE admission (25 % quota)</label>}
            </div>
          </div>
          {dups.length > 0 && (
            <div id="duplicates" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alert">
              <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" /> This child may already be in the school</p>
              <ul className="mt-2 grid gap-1.5">
                {dups.map((d) => (
                  <li key={d.id}>
                    <Link to={`/students/${d.id}`} target="_blank" className="font-medium underline">{d.fullName}</Link>
                    {' '}· GR {d.grNo}{d.section ? ` · ${divisionLabel(d.section)}` : ''}{d.year ? ` (${d.year})` : ''}{d.dob ? ` · born ${formatDate(d.dob)}` : ''}
                    {d.status !== 'ACTIVE' ? ` · ${STATUS_LABEL[d.status] ?? d.status}` : ''}
                    <span className="text-amber-800"> — {d.reasons.join(', ') || 'similar details'}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">If the child left and is coming back, open the old record and use <b>Re-admit</b> instead of a new admission.</p>
              <label className="mt-3 flex items-center gap-2 font-medium">
                <Checkbox checked={dupOk} onChange={(e) => setDupOk(e.target.checked)} /> I have checked: this is a different child
              </label>
            </div>
          )}
        </Panel>

        <Panel title={`${n('3')}Previous school`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Previous school" htmlFor="ps" className="sm:col-span-2" error={E('previousSchool')} hint="Leave empty for a first admission (Nursery / Std I)"><Input id="ps" {...reg('previousSchool')} /></Field>
            <Field label="Std Passed" htmlFor="pc"><Select id="pc" {...reg('previousClass')}><option value="">—</option>{standards.data?.map((st) => <option key={st.id} value={st.code}>{st.nameEn}</option>)}</Select></Field>
            <Field label="Last Std Passed Year" htmlFor="psy" hint="e.g. 2025-26" error={E('previousSchoolYear')}><Input id="psy" placeholder="2025-26" maxLength={7} {...reg('previousSchoolYear')} /></Field>
            <Field label="Leaving certificate (LC/TC) no." htmlFor="lc"><Input id="lc" {...reg('previousLcNo')} /></Field>
            <Field label="LC date" htmlFor="lcd" error={E('previousLcDate')}><Input id="lcd" type="date" {...reg('previousLcDate')} /></Field>
          </div>
        </Panel>

        <Panel title={`${n('4')}Parents`}>
          <div className="grid gap-5 lg:grid-cols-3">
            {(['father', 'mother', 'guardian'] as const).map((k) => (
              <div key={k} className="grid content-start gap-3 rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  {k === 'guardian'
                    ? <Select aria-label="Relation" className="h-8 w-44" {...reg('guardian.relation')}><option value="GUARDIAN">Guardian (optional)</option><option value="OTHER">Other relative</option></Select>
                    : <p className="font-semibold">{k === 'father' ? 'Father' : 'Mother'}</p>}
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="radio" value={k === 'father' ? 'FATHER' : k === 'mother' ? 'MOTHER' : 'GUARDIAN'} {...reg('primary')} /> Main contact
                  </label>
                </div>
                <Field label="Name" htmlFor={`${k}n`} error={E(`${k}.name`)}><Input id={`${k}n`} {...reg(`${k}.name`)} /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Mobile" htmlFor={`${k}m`} error={E(`${k}.mobile`)}><Input id={`${k}m`} inputMode="tel" {...reg(`${k}.mobile`)} /></Field>
                  <Field label="WhatsApp" htmlFor={`${k}w`} error={E(`${k}.whatsapp`)}><Input id={`${k}w`} inputMode="tel" placeholder="if different" {...reg(`${k}.whatsapp`)} /></Field>
                </div>
              </div>
            ))}
          </div>
          {E('guardians') && <p className="mt-2 text-sm text-destructive">{E('guardians')}</p>}
        </Panel>

        <Panel title={`${n('5')}Documents`}>
          <p className="mb-3 text-sm text-muted-foreground">Tick what the parents handed in. Attach a scan or phone photo of each (PDF / JPG / PNG, up to 5 MB) so the office does not need the paper copy later.</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ADMISSION_DOCUMENTS.map((d) => {
              const docs = form.watch('documents') ?? [];
              const uploaded = existing?.documentFiles.filter((f) => f.docType === d) ?? [];
              const queued = pending.filter((p) => p.docType === d);
              const has = docs.includes(d);
              return (
                <div key={d} className={cn('grid gap-2 rounded-lg border px-3 py-2 text-sm', has && 'border-emerald-300 bg-emerald-50/60')}>
                  <div className="flex items-center gap-2">
                    <label className="flex flex-1 items-center gap-2">
                      <Checkbox checked={has} onChange={(e) => form.setValue('documents', e.target.checked ? [...docs, d] : docs.filter((x) => x !== d))} /> {d}
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs font-medium hover:bg-muted" title={`Attach a scan of ${d}`}>
                      <Paperclip className="size-3.5" /> Attach
                      <input type="file" multiple accept={ACCEPT_DOCUMENTS} className="sr-only" onChange={(e) => { addDoc(d, e.target.files); e.target.value = ''; }} />
                    </label>
                  </div>
                  {existing && <UploadedFiles studentId={existing.id} files={uploaded} canDelete={existing.access.edit} />}
                  {queued.map((q) => (
                    <p key={`${q.file.name}-${q.file.size}-${q.file.lastModified}`} className="flex items-center gap-1.5 text-xs text-amber-800">
                      <Paperclip className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{q.file.name}</span><span className="shrink-0">· {fileSize(q.file.size)} · uploads on save</span>
                      <button type="button" className="ml-auto rounded p-0.5 hover:bg-amber-100" aria-label={`Remove ${q.file.name}`} onClick={() => setPending((p) => p.filter((x) => x !== q))}><X className="size-3.5" /></button>
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title={`${n('6')}Government IDs`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="PEN (Permanent Education No.)" htmlFor="pen" hint="From UDISE+" error={E('pen')}><Input id="pen" inputMode="numeric" {...reg('pen')} /></Field>
            <Field label="APAAR ID" htmlFor="apa"><Input id="apa" {...reg('apaarId')} /></Field>
            <Field label="Saral ID" htmlFor="sar"><Input id="sar" {...reg('saralId')} /></Field>
            <Field label="School UID (from sheets)" htmlFor="uid"><Input id="uid" {...reg('schoolUid')} /></Field>
          </div>
          <Field label="Notes" htmlFor="notes" className="mt-4"><Textarea id="notes" rows={2} {...reg('notes')} /></Field>
        </Panel>

        <Panel title={`${n('7')}Reserved details (category, Aadhaar)`} icon={Lock}>
          {canSensitive ? (
            <>
              <p className="mb-4 text-sm text-muted-foreground">Only the Headmaster and school admin can see these fields. Enter only the last 4 digits of Aadhaar.</p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Religion" htmlFor="rel"><OptionSelect id="rel" options={RELIGIONS} {...reg('religion')} /></Field>
                <Field label="Category" htmlFor="cat"><OptionSelect id="cat" options={CATEGORY_SUGGESTIONS} {...reg('category')} /></Field>
                <Field label="Caste" htmlFor="cas"><Input id="cas" {...reg('caste')} /></Field>
                <Field label="Sub-caste" htmlFor="scs"><Input id="scs" {...reg('subCaste')} /></Field>
                <Field label="Aadhaar (last 4 digits)" htmlFor="aad" error={E('aadhaarLast4')}><Input id="aad" inputMode="numeric" maxLength={4} {...reg('aadhaarLast4')} /></Field>
                <label className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm"><Checkbox {...reg('isBpl')} /> BPL family (below poverty line)</label>
                <label className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm"><Checkbox {...reg('isMinority')} /> Belongs to a minority community</label>
              </div>
            </>
          ) : <Restricted text="Religion, category, caste, Aadhaar and BPL / minority status are visible only to the Headmaster and school admin. They stay unchanged when you save." />}
        </Panel>

        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
          {(photo || pending.length > 0) && <p className="mr-auto text-xs text-muted-foreground">{[photo && 'photo', pending.length && `${pending.length} document${pending.length > 1 ? 's' : ''}`].filter(Boolean).join(' and ')} will upload after saving</p>}
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{existing ? 'Save changes' : 'Admit student'}</Button>
        </div>
      </form>
      {save.isError && !(save.error instanceof ApiError && save.error.errors.length) && <p className="mt-2 text-sm text-destructive">{errorMessage(save.error)}</p>}
    </>
  );
}
