import { useQuery } from '@tanstack/react-query';
import {
  BLOOD_GROUPS, DEPARTMENTS, DESIGNATIONS, EMPLOYEE_TYPE_LABELS, EMPLOYEE_TYPES, EMPLOYMENT_TYPE_LABELS, EMPLOYMENT_TYPES, GENDER_LABELS, PERMISSIONS,
  rupees, SALARY_MODE_LABELS, SALARY_MODES, STAFF_STATUS_LABELS, STAFF_STATUSES, type StaffStatus,
} from '@cps/shared';
import { ArrowLeft, Ban, Camera, CheckCircle2, Eye, History, Landmark, Lock, Paperclip, Pencil, Plus, Search, UserCog, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, Pagination, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, ApiError, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced, useWorkingContext } from '@/lib/hooks';
import type { Assignment, ClassSubject } from '@/lib/types';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { fileSize, openBlob } from './admission-form';
import { divisionLabel, useStudentsOverview } from './dashboard';

const P = PERMISSIONS;

interface StaffRow {
  id: number; employeeCode: string; name: string; nameHi: string | null; gender: string | null; dob: string | null; fatherOrSpouseName: string | null;
  mobile: string | null; altMobile: string | null; email: string | null; addressLine: string | null; bloodGroup: string | null; photoFileId: number | null;
  employeeType: string | null; designation: string | null; department: string | null; qualification: string | null; joiningDate: string | null;
  employmentType: string | null; reportingManagerId: number | null; leavingDate: string | null; remarks: string | null;
  monthlySalary: number | null; salaryMode: string | null; bankAccountHolder: string | null; bankName: string | null; bankAccountNo: string | null; bankIfsc: string | null;
  status: StaffStatus; canSeeSalary: boolean; user: { id: number; username: string; status: string } | null; createdAt: string;
}
interface StaffProfile extends StaffRow {
  currentYear: { id: number; name: string } | null; assignments: Assignment[];
  reportingManager: { id: number; name: string; designation: string | null } | null;
  documents: { id: number; title: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }[];
  history: { id: number; at: string; action: string; reason: string | null; by: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[] | null;
  access: { manage: boolean; register: boolean; salary: boolean; assign: boolean };
}

const STATUS_STYLE: Record<StaffStatus, string> = {
  PENDING_ASSIGNMENT: 'bg-amber-50 text-amber-900 border-amber-200', ACTIVE: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  INACTIVE: 'bg-muted text-muted-foreground border-border', RESIGNED: 'bg-muted text-muted-foreground border-border',
};
export function StaffStatusChip({ status }: { status: StaffStatus }) {
  return <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_STYLE[status])}>{STAFF_STATUS_LABELS[status] ?? status}</span>;
}
const typeLabel = (t: string | null) => (t ? EMPLOYEE_TYPE_LABELS[t as 'TEACHING'] ?? t : null);
const dash = (v: unknown) => (v === null || v === undefined || v === '' ? <span className="text-muted-foreground">—</span> : String(v));

function StaffPhoto({ s, size = 'md' }: { s: { id: number; name: string; photoFileId: number | null }; size?: 'sm' | 'md' | 'lg' }) {
  const photo = useQuery({ queryKey: ['staff-photo', s.id, s.photoFileId], queryFn: async () => URL.createObjectURL(await api.get<Blob>(`/staff/${s.id}/photo`)), enabled: !!s.photoFileId, staleTime: Infinity });
  const cls = size === 'lg' ? 'size-24 rounded-2xl text-2xl' : size === 'md' ? 'size-9 rounded-full text-xs' : 'size-7 rounded-full text-[10px]';
  if (photo.data) return <img src={photo.data} alt="" className={cn(cls, 'object-cover')} />;
  const initials = s.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return <div className={cn(cls, 'grid shrink-0 place-items-center bg-primary/10 font-semibold text-primary')} aria-hidden>{initials}</div>;
}

// ======================================================================= list

export function StaffListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setParams(n, { replace: true }); };
  const [q, setQ] = useState(get('q'));
  const search = useDebounced(q);
  useEffect(() => { if (search !== get('q')) set('q', search); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const filters = { q: get('q'), employeeType: get('employeeType'), designation: get('designation'), department: get('department'), status: get('status'), joinFrom: get('joinFrom'), joinTo: get('joinTo'), sort: get('sort') || 'name', page: get('page') || '1' };
  const list = useQuery({ queryKey: ['staff', 'list', filters], queryFn: () => api.get<Page<StaffRow> & { pendingAssignment: number }>(`/staff${qs({ ...filters, pageSize: 50 })}`), placeholderData: (p) => p });
  const canAdd = can(P.STAFF_REGISTER) || can(P.STAFF_MANAGE);
  return (
    <>
      <PageHeader icon={Users} title="Staff" description="Every teacher and staff member. The office registers new staff; the Headmaster assigns designation, department, classes and salary, and activates them."
        actions={canAdd && <Button asChild><Link to="/staff/new"><UserPlus /> Add staff</Link></Button>} />
      {!!list.data?.pendingAssignment && filters.status !== 'PENDING_ASSIGNMENT' && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <span className="flex-1"><b>{list.data.pendingAssignment}</b> newly registered staff {list.data.pendingAssignment === 1 ? 'is' : 'are'} waiting for the Headmaster to assign designation, department and classes.</span>
          <Button size="sm" variant="outline" onClick={() => set('status', 'PENDING_ASSIGNMENT')}>Show them</Button>
        </Card>
      )}
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <div className="relative sm:col-span-2 xl:col-span-2"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search staff" className="pl-9" placeholder="Name, Staff ID or mobile" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select aria-label="Employee type" value={filters.employeeType} onChange={(e) => set('employeeType', e.target.value)}><option value="">Teaching and non-teaching</option>{EMPLOYEE_TYPES.map((t) => <option key={t} value={t}>{EMPLOYEE_TYPE_LABELS[t]}</option>)}</Select>
        <Select aria-label="Designation" value={filters.designation} onChange={(e) => set('designation', e.target.value)}><option value="">All designations</option>{DESIGNATIONS.map((d) => <option key={d}>{d}</option>)}</Select>
        <Select aria-label="Department" value={filters.department} onChange={(e) => set('department', e.target.value)}><option value="">All departments</option>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</Select>
        <Select aria-label="Status" value={filters.status} onChange={(e) => set('status', e.target.value)}><option value="">Any status</option>{STAFF_STATUSES.map((s) => <option key={s} value={s}>{STAFF_STATUS_LABELS[s]}</option>)}</Select>
        <div className="flex gap-2"><Input aria-label="Joined from" type="date" value={filters.joinFrom} onChange={(e) => set('joinFrom', e.target.value)} title="Joined from" /><Input aria-label="Joined up to" type="date" value={filters.joinTo} onChange={(e) => set('joinTo', e.target.value)} title="Joined up to" /></div>
      </Card>
      <Card className="overflow-hidden">
        <QueryView query={list} empty={(d) => (d.data.length ? null : <EmptyState icon={Users} title="No staff match these filters" />)}>
          {(d) => (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH><SortHead label="Staff ID" k="employeeCode" sort={filters.sort} onSort={(v) => set('sort', v)} /></TH><TH><SortHead label="Name" k="name" sort={filters.sort} onSort={(v) => set('sort', v)} /></TH>
                      <TH>Gender</TH><TH>Employee type</TH><TH>Designation</TH><TH>Department</TH><TH>Mobile</TH>
                      <TH><SortHead label="Joining date" k="joiningDate" sort={filters.sort} onSort={(v) => set('sort', v)} /></TH><TH>Status</TH><TH />
                    </TR>
                  </THead>
                  <TBody>
                    {d.data.map((s) => (
                      <TR key={s.id} className="cursor-pointer" onClick={() => navigate(`/staff/${s.id}`)}>
                        <TD className="font-mono text-xs">{s.employeeCode}</TD>
                        <TD><div className="flex items-center gap-2"><StaffPhoto s={s} size="sm" /><Link to={`/staff/${s.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-primary hover:underline">{s.name}</Link></div></TD>
                        <TD>{s.gender ? GENDER_LABELS[s.gender as 'MALE'] : dash(null)}</TD>
                        <TD>{dash(typeLabel(s.employeeType))}</TD><TD>{dash(s.designation)}</TD><TD>{dash(s.department)}</TD>
                        <TD className="tabular-nums">{s.mobile ? <a href={`tel:${s.mobile}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">{s.mobile}</a> : dash(null)}</TD>
                        <TD>{s.joiningDate ? formatDate(s.joiningDate) : dash(null)}</TD>
                        <TD><StaffStatusChip status={s.status} /></TD>
                        <TD className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" asChild><Link to={`/staff/${s.id}`} aria-label="View profile"><Eye /></Link></Button>
                          {canAdd && <Button size="sm" variant="ghost" asChild><Link to={`/staff/${s.id}/edit`} aria-label="Edit profile"><Pencil /></Link></Button>}
                          {can(P.STAFF_MANAGE) && s.status === 'PENDING_ASSIGNMENT' && <Button size="sm" variant="outline" asChild><Link to={`/staff/${s.id}/edit#employment`}><UserCog /> Assign</Link></Button>}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={(p) => set('page', String(p))} />
            </>
          )}
        </QueryView>
      </Card>
    </>
  );
}

function SortHead({ label, k, sort, onSort }: { label: string; k: string; sort: string; onSort: (v: string) => void }) {
  const on = sort === k || sort === `-${k}`;
  return <button className={cn('inline-flex items-center gap-1 hover:text-foreground', on && 'text-foreground')} onClick={() => onSort(sort === k ? `-${k}` : k)}>{label}{on ? (sort.startsWith('-') ? ' ↓' : ' ↑') : ''}</button>;
}

// ======================================================================= add / edit

type Form = Record<string, string>;
const PERSONAL = ['name', 'nameHi', 'gender', 'dob', 'fatherOrSpouseName', 'mobile', 'altMobile', 'email', 'addressLine', 'bloodGroup'] as const;
const EMPLOYMENT = ['employeeType', 'designation', 'department', 'qualification', 'joiningDate', 'employmentType', 'reportingManagerId', 'leavingDate', 'remarks'] as const;
const SALARY = ['monthlySalary', 'salaryMode', 'bankAccountHolder', 'bankName', 'bankAccountNo', 'bankIfsc'] as const;

export function StaffFormPage() {
  const { id } = useParams();
  const existing = useQuery({ queryKey: ['staff', 'detail', id], queryFn: () => api.get<StaffProfile>(`/staff/${id}`), enabled: !!id });
  if (id && !existing.data) return <QueryView query={existing}>{() => null}</QueryView>;
  return <StaffForm existing={existing.data} />;
}

function StaffForm({ existing }: { existing?: StaffProfile }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const manage = can(P.STAFF_MANAGE);
  const salary = can(P.STAFF_SALARY);
  const initial = useMemo(() => {
    const f: Form = {};
    for (const k of [...PERSONAL, ...EMPLOYMENT, ...SALARY]) {
      const v = existing?.[k as keyof StaffProfile];
      f[k] = v === null || v === undefined ? '' : typeof v === 'string' && /Date$|^dob$/.test(k) ? v.slice(0, 10) : String(v);
    }
    return f;
  }, [existing]);
  const [v, setV] = useState<Form>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState<File | null>(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  const photoInput = useRef<HTMLInputElement>(null);
  const managers = useQuery({ queryKey: ['staff', 'managers'], queryFn: () => api.get<Page<StaffRow>>('/staff?status=ACTIVE&pageSize=100'), enabled: manage });
  useEffect(() => { if (location.hash === '#employment') document.getElementById('employment')?.scrollIntoView({ behavior: 'smooth' }); }, []);
  const up = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const E = (k: string) => errors[k];

  const save = useSave(async () => {
    // Only the field groups this user may change are sent; the server checks the same rules.
    const body: Record<string, unknown> = {};
    for (const k of PERSONAL) body[k] = v[k] || null;
    if (manage) for (const k of EMPLOYMENT) body[k] = v[k] || null;
    if (salary) for (const k of SALARY) body[k] = v[k] || null;
    const r = existing ? await api.patch<StaffRow>(`/staff/${existing.id}`, body) : await api.post<StaffRow>('/staff', body);
    if (photo) {
      const fd = new FormData();
      fd.append('file', photo);
      await api.post(`/staff/${r.id}/photo`, fd).catch((e) => toast.error(`Saved, but the photo did not upload: ${errorMessage(e)}`));
    }
    return r;
  }, {
    invalidate: [['staff'], ['staff-photo']], success: existing ? 'Staff details saved' : 'Staff member registered',
    onSuccess: (r) => navigate(`/staff/${r.id}`),
    onError: (e) => { if (e instanceof ApiError && e.errors.length) { setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.message]))); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
  });

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to={existing ? `/staff/${existing.id}` : '/staff'}><ArrowLeft /> {existing ? 'Back to profile' : 'Staff'}</Link></Button>
      <PageHeader icon={UserPlus} title={existing ? `Edit ${existing.name}` : 'Register new staff'}
        description={manage ? 'Fields marked * are required. You can fill personal, employment and salary details.' : 'Enter the personal details. The Headmaster then assigns designation, department, classes and salary, and activates the staff member.'} />
      {Object.keys(errors).length > 0 && <Card className="mb-4 border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">Please correct the fields marked below.</Card>}
      <form className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(undefined); }}>
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">A. Personal information</h2>
          <div className="flex flex-col gap-5 lg:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-2">
              <button type="button" onClick={() => photoInput.current?.click()} className="grid h-36 w-28 place-items-center overflow-hidden rounded-xl border-2 border-dashed bg-muted/30 text-center text-xs text-muted-foreground hover:border-primary" aria-label="Choose profile photo">
                {photoUrl ? <img src={photoUrl} alt="" className="size-full object-cover" /> : existing?.photoFileId ? <StaffPhoto s={existing} size="lg" /> : <span className="grid place-items-center gap-1 p-2"><Camera className="size-6" />Profile photo</span>}
              </button>
              <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && f.size > 2 * 1024 * 1024) toast.error('Photo must be 2 MB or smaller'); else if (f) setPhoto(f); e.target.value = ''; }} />
              {photo && <Button type="button" size="sm" variant="ghost" onClick={() => setPhoto(null)}><X /> Remove</Button>}
            </div>
            <div className="grid flex-1 content-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Staff ID" htmlFor="sid" hint={existing ? undefined : 'Given automatically when you save'}><Input id="sid" value={existing?.employeeCode ?? 'Auto'} disabled /></Field>
              <Field label="Full name" htmlFor="sn" required error={E('name')} className="lg:col-span-2"><Input id="sn" value={v.name} onChange={up('name')} /></Field>
              <Field label="Gender" htmlFor="sg" required error={E('gender')}><Select id="sg" value={v.gender} onChange={up('gender')}><option value="">— Choose —</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option></Select></Field>
              <Field label="Date of birth" htmlFor="sd" required error={E('dob')}><Input id="sd" type="date" value={v.dob} onChange={up('dob')} /></Field>
              <Field label="Father's / spouse name" htmlFor="sf"><Input id="sf" value={v.fatherOrSpouseName} onChange={up('fatherOrSpouseName')} /></Field>
              <Field label="Mobile number" htmlFor="sm" required error={E('mobile')}><Input id="sm" inputMode="tel" value={v.mobile} onChange={up('mobile')} /></Field>
              <Field label="Alternate mobile" htmlFor="sa" error={E('altMobile')}><Input id="sa" inputMode="tel" value={v.altMobile} onChange={up('altMobile')} /></Field>
              <Field label="Email" htmlFor="se" error={E('email')}><Input id="se" type="email" value={v.email} onChange={up('email')} /></Field>
              <Field label="Blood group" htmlFor="sb"><Select id="sb" value={v.bloodGroup} onChange={up('bloodGroup')}><option value="">Not known</option>{BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}</Select></Field>
              <Field label="Address" htmlFor="sad" required error={E('addressLine')} className="sm:col-span-2 lg:col-span-3"><Textarea id="sad" rows={2} value={v.addressLine} onChange={up('addressLine')} /></Field>
            </div>
          </div>
          {!existing && <p className="mt-3 text-xs text-muted-foreground">Supporting documents (certificates, ID proof) can be uploaded on the staff profile after saving.</p>}
        </Card>

        <Card className="p-5" id="employment">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">B. Employment information {!manage && <Lock className="size-4 text-muted-foreground" />}</h2>
          {manage ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Employee type" htmlFor="et" error={E('employeeType')}><Select id="et" value={v.employeeType} onChange={up('employeeType')}><option value="">— Choose —</option>{EMPLOYEE_TYPES.map((t) => <option key={t} value={t}>{EMPLOYEE_TYPE_LABELS[t]}</option>)}</Select></Field>
              <Field label="Designation" htmlFor="ed" error={E('designation')}><Select id="ed" value={v.designation} onChange={up('designation')}><option value="">— Choose —</option>{[...new Set([...DESIGNATIONS, ...(v.designation ? [v.designation] : [])])].map((d) => <option key={d}>{d}</option>)}</Select></Field>
              <Field label="Department" htmlFor="edp" error={E('department')}><Select id="edp" value={v.department} onChange={up('department')}><option value="">— Choose —</option>{[...new Set([...DEPARTMENTS, ...(v.department ? [v.department] : [])])].map((d) => <option key={d}>{d}</option>)}</Select></Field>
              <Field label="Qualification" htmlFor="eq"><Input id="eq" value={v.qualification} onChange={up('qualification')} placeholder="e.g. B.A., B.Ed." /></Field>
              <Field label="Joining date" htmlFor="ej" error={E('joiningDate')}><Input id="ej" type="date" value={v.joiningDate} onChange={up('joiningDate')} /></Field>
              <Field label="Employment type" htmlFor="eem" error={E('employmentType')}><Select id="eem" value={v.employmentType} onChange={up('employmentType')}><option value="">— Choose —</option>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>)}</Select></Field>
              <Field label="Reporting manager" htmlFor="erm" error={E('reportingManagerId')}><Select id="erm" value={v.reportingManagerId} onChange={up('reportingManagerId')}><option value="">None</option>{managers.data?.data.filter((m) => m.id !== existing?.id).map((m) => <option key={m.id} value={m.id}>{m.name}{m.designation ? ` (${m.designation})` : ''}</option>)}</Select></Field>
              <Field label="Leaving date" htmlFor="el"><Input id="el" type="date" value={v.leavingDate} onChange={up('leavingDate')} /></Field>
              <Field label="Remarks" htmlFor="er" className="sm:col-span-2 lg:col-span-3"><Textarea id="er" rows={2} value={v.remarks} onChange={up('remarks')} /></Field>
              <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">Classes and subjects are assigned on the staff profile after saving (teaching staff only). Activate the staff member from the profile once these details are complete.</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Employee type, designation, department, classes, subjects, reporting manager and status are assigned by the Headmaster.{existing ? '' : ' The new record is saved as "Pending assignment".'}</p>
          )}
        </Card>

        {salary && (
          <Card className="p-5">
            <h2 className="mb-1 flex items-center gap-2 font-semibold"><Landmark className="size-4 text-muted-foreground" /> C. Salary information</h2>
            <p className="mb-3 text-xs text-muted-foreground">Visible only to the Headmaster and authorised users.</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Monthly salary (₹)" htmlFor="ms" error={E('monthlySalary')}><Input id="ms" inputMode="decimal" value={v.monthlySalary} onChange={up('monthlySalary')} /></Field>
              <Field label="Salary payment mode" htmlFor="smo"><Select id="smo" value={v.salaryMode} onChange={up('salaryMode')}><option value="">— Choose —</option>{SALARY_MODES.map((m) => <option key={m} value={m}>{SALARY_MODE_LABELS[m]}</option>)}</Select></Field>
              <Field label="Bank account holder" htmlFor="bh"><Input id="bh" value={v.bankAccountHolder} onChange={up('bankAccountHolder')} /></Field>
              <Field label="Bank name" htmlFor="bn"><Input id="bn" value={v.bankName} onChange={up('bankName')} /></Field>
              <Field label="Account number" htmlFor="ba" error={E('bankAccountNo')}><Input id="ba" inputMode="numeric" value={v.bankAccountNo} onChange={up('bankAccountNo')} /></Field>
              <Field label="IFSC code" htmlFor="bi" error={E('bankIfsc')}><Input id="bi" className="uppercase" maxLength={11} value={v.bankIfsc} onChange={up('bankIfsc')} /></Field>
            </div>
          </Card>
        )}

        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{existing ? 'Save changes' : 'Register staff'}</Button>
        </div>
      </form>
    </>
  );
}

// ======================================================================= profile

export function StaffProfilePage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['staff', 'detail', id], queryFn: () => api.get<StaffProfile>(`/staff/${id}`) });
  const [dlg, setDlg] = useState<'status' | null>(null);
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/staff"><ArrowLeft /> Staff</Link></Button>
      <QueryView query={q}>
        {(s) => (
          <div className="grid gap-4">
            <Card className="p-5">
              <div className="flex flex-col gap-5 sm:flex-row">
                <StaffPhoto s={s} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold sm:text-2xl">{s.name}</h1><StaffStatusChip status={s.status} /></div>
                  <p className="mt-1 text-sm text-muted-foreground">{[s.employeeCode, s.designation, s.department, typeLabel(s.employeeType)].filter(Boolean).join(' · ')}</p>
                  {s.user && <p className="text-xs text-muted-foreground">Login: {s.user.username} ({s.user.status.toLowerCase()})</p>}
                </div>
                <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:items-end">
                  {s.access.register && <Button variant="outline" size="sm" asChild><Link to={`/staff/${s.id}/edit`}><Pencil /> Edit profile</Link></Button>}
                  {s.access.manage && <Button variant="outline" size="sm" asChild><Link to={`/staff/${s.id}/edit#employment`}><UserCog /> Assign designation</Link></Button>}
                  {s.access.manage && <Button size="sm" variant={s.status === 'PENDING_ASSIGNMENT' ? 'default' : 'outline'} onClick={() => setDlg('status')}>{s.status === 'PENDING_ASSIGNMENT' ? <><CheckCircle2 /> Activate</> : 'Change status'}</Button>}
                </div>
              </div>
              {s.status === 'PENDING_ASSIGNMENT' && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Registered by the office. {s.access.manage ? 'Assign employee type, designation, department, joining date and employment type, then activate.' : 'Waiting for the Headmaster to assign the employment details and activate.'}</p>}
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Info title="Personal information" items={[
                ['Gender', s.gender ? GENDER_LABELS[s.gender as 'MALE'] : null], ['Date of birth', s.dob ? formatDate(s.dob) : null], ["Father's / spouse name", s.fatherOrSpouseName],
                ['Mobile', s.mobile], ['Alternate mobile', s.altMobile], ['Email', s.email], ['Blood group', s.bloodGroup], ['Address', s.addressLine],
              ]} />
              <Info title="Employment information" items={[
                ['Employee type', typeLabel(s.employeeType)], ['Designation', s.designation], ['Department', s.department], ['Qualification', s.qualification],
                ['Joining date', s.joiningDate ? formatDate(s.joiningDate) : null], ['Employment type', s.employmentType ? EMPLOYMENT_TYPE_LABELS[s.employmentType as 'PERMANENT'] : null],
                ['Reporting manager', s.reportingManager ? <Link to={`/staff/${s.reportingManager.id}`} className="text-primary hover:underline">{s.reportingManager.name}</Link> : null],
                ['Leaving date', s.leavingDate ? formatDate(s.leavingDate) : null], ['Remarks', s.remarks],
              ]} />
              {s.canSeeSalary && <Info title="Salary information" items={[
                ['Monthly salary', s.monthlySalary != null ? rupees(s.monthlySalary) : null], ['Payment mode', s.salaryMode ? SALARY_MODE_LABELS[s.salaryMode as 'CASH'] : null],
                ['Account holder', s.bankAccountHolder], ['Bank', s.bankName], ['Account number', s.bankAccountNo], ['IFSC', s.bankIfsc],
                ['Salary payments', <Link to={`/expenses?staffId=${s.id}`} className="text-primary hover:underline">View salary vouchers</Link>],
              ]} />}
              <ClassesPanel s={s} />
              <DocumentsPanel s={s} />
              {s.history && <HistoryPanel s={s} />}
            </div>
            {dlg === 'status' && <StatusDialog s={s} onClose={() => setDlg(null)} />}
          </div>
        )}
      </QueryView>
    </>
  );
}

function Info({ title, items }: { title: string; items: [string, React.ReactNode][] }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold">{title}</h3>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {items.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-0.5 text-sm break-words">{v === null || v === undefined || v === '' ? <span className="text-muted-foreground">—</span> : v}</dd></div>)}
      </dl>
    </Card>
  );
}

/** Classes and subjects come from the school's "Who teaches what" assignments — the same records, not a copy. */
function ClassesPanel({ s }: { s: StaffProfile }) {
  const { yearId } = useWorkingContext();
  const overview = useStudentsOverview();
  const [sectionId, setSectionId] = useState('');
  const [role, setRole] = useState<'SUBJECT_TEACHER' | 'CLASS_TEACHER'>('SUBJECT_TEACHER');
  const [csId, setCsId] = useState('');
  const division = overview.data?.sections.find((d) => String(d.sectionId) === sectionId);
  const subjects = useQuery({ queryKey: ['class-subjects', String(division?.schoolClass.id)], queryFn: () => api.get<ClassSubject[]>(`/classes/${division!.schoolClass.id}/subjects`), enabled: !!division && role === 'SUBJECT_TEACHER' });
  const add = useSave(() => api.post('/assignments', { academicYearId: yearId, staffId: s.id, role, sectionId: Number(sectionId), classSubjectId: role === 'SUBJECT_TEACHER' ? Number(csId) : null }), {
    invalidate: [['staff'], ['assignments']], success: 'Assigned', onSuccess: () => { setSectionId(''); setCsId(''); },
  });
  const end = useSave((aid: number) => api.post(`/assignments/${aid}/end`, {}), { invalidate: [['staff'], ['assignments']], success: 'Assignment ended (kept in history)' });
  const teaching = s.employeeType !== 'NON_TEACHING';
  const canAssign = s.access.assign && s.status === 'ACTIVE' && teaching;
  const roleLabel: Record<string, string> = { SUBJECT_TEACHER: 'Subject teacher', CLASS_TEACHER: 'Class teacher', OPERATOR: 'Data entry operator', ATTENDANCE_VERIFIER: 'Attendance verifier' };
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold">Classes and subjects {s.currentYear && <span className="font-normal text-muted-foreground">· {s.currentYear.name}</span>}</h3>
      {!teaching ? <p className="text-sm text-muted-foreground">Non-teaching staff are not given classes or subjects.</p> : (
        <>
          {s.assignments.length ? (
            <ul className="mb-3 divide-y rounded-lg border text-sm">
              {s.assignments.map((a) => (
                <li key={a.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1">{a.section.schoolClass.displayName} {a.section.name} · {a.classSubject ? a.classSubject.subject.nameEn : roleLabel[a.role]}{a.classSubject && <span className="text-muted-foreground"> (subject teacher)</span>}</span>
                  {s.access.assign && <Button size="sm" variant="ghost" aria-label="End assignment" onClick={() => { if (confirm('End this assignment? It stays in the history.')) end.mutate(a.id); }}><X /></Button>}
                </li>
              ))}
            </ul>
          ) : <p className="mb-3 text-sm text-muted-foreground">No classes assigned this year.</p>}
          {canAssign ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <Field label="Role" htmlFor="ar"><Select id="ar" value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="SUBJECT_TEACHER">Subject teacher</option><option value="CLASS_TEACHER">Class teacher</option></Select></Field>
              <Field label="Class and division" htmlFor="as"><Select id="as" value={sectionId} onChange={(e) => { setSectionId(e.target.value); setCsId(''); }}><option value="">— Choose —</option>{overview.data?.sections.map((d) => <option key={d.sectionId} value={d.sectionId}>{divisionLabel(d)}</option>)}</Select></Field>
              {role === 'SUBJECT_TEACHER' ? <Field label="Subject" htmlFor="asu"><Select id="asu" value={csId} onChange={(e) => setCsId(e.target.value)} disabled={!division}><option value="">— Choose —</option>{subjects.data?.map((c) => <option key={c.id} value={c.id}>{c.subject.nameEn}</option>)}</Select></Field> : <div />}
              <Button type="button" loading={add.isPending} disabled={!sectionId || (role === 'SUBJECT_TEACHER' && !csId)} onClick={() => add.mutate(undefined)}><Plus /> Assign</Button>
            </div>
          ) : s.access.assign && s.status !== 'ACTIVE' ? <p className="text-xs text-muted-foreground">Activate the staff member first, then assign classes and subjects.</p> : null}
        </>
      )}
    </Card>
  );
}

function DocumentsPanel({ s }: { s: StaffProfile }) {
  const [title, setTitle] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useSave(async (f: File) => { const fd = new FormData(); fd.append('title', title.trim()); fd.append('file', f); return api.post(`/staff/${s.id}/documents`, fd); }, { invalidate: [['staff']], success: 'Document uploaded', onSuccess: () => setTitle('') });
  const remove = useSave((docId: number) => api.delete(`/staff/${s.id}/documents/${docId}`), { invalidate: [['staff']], success: 'Document removed' });
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold">Supporting documents</h3>
      {s.documents.length ? (
        <ul className="mb-3 divide-y rounded-lg border text-sm">
          {s.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-2 px-3 py-2">
              <Paperclip className="size-4 text-muted-foreground" />
              <button className="min-w-0 flex-1 truncate text-left text-primary hover:underline" onClick={() => void openBlob(`/staff/${s.id}/documents/${d.id}`)}>{d.title}</button>
              <span className="text-xs text-muted-foreground">{fileSize(d.sizeBytes)} · {formatDate(d.createdAt)}</span>
              {s.access.manage && <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => { if (confirm(`Remove "${d.title}"?`)) remove.mutate(d.id); }}><X /></Button>}
            </li>
          ))}
        </ul>
      ) : <p className="mb-3 text-sm text-muted-foreground">No documents uploaded.</p>}
      {s.access.register && (
        <div className="flex gap-2">
          <Input aria-label="Document name" placeholder="e.g. B.Ed. certificate, Aadhaar card" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button type="button" variant="outline" disabled={title.trim().length < 2} loading={upload.isPending} onClick={() => fileRef.current?.click()}><Paperclip /> Upload</Button>
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
        </div>
      )}
    </Card>
  );
}

function HistoryPanel({ s }: { s: StaffProfile }) {
  const describe = (h: NonNullable<StaffProfile['history']>[number]) => {
    if (h.action === 'CREATE') return 'Registered';
    if (h.action === 'STATUS') return `Status: ${STAFF_STATUS_LABELS[(h.before?.status as StaffStatus)] ?? h.before?.status} → ${STAFF_STATUS_LABELS[(h.after?.status as StaffStatus)] ?? h.after?.status}`;
    const keys = Object.keys(h.after ?? {}).filter((k) => !['updatedAt', 'updatedBy', 'version'].includes(k));
    return keys.length ? `Changed ${keys.join(', ')}` : 'Updated';
  };
  return (
    <Card className="p-5 lg:col-span-2">
      <h3 className="mb-3 flex items-center gap-2 font-semibold"><History className="size-4 text-muted-foreground" /> Modification history</h3>
      <ol className="grid gap-2 text-sm">
        {s.history!.map((h) => (
          <li key={h.id} className="flex flex-wrap gap-x-3 border-l-2 pl-3">
            <span className="text-muted-foreground">{formatDateTime(h.at)}</span><span className="font-medium">{h.by ?? 'system'}</span><span>{describe(h)}</span>
            {h.reason && <span className="text-muted-foreground">· {h.reason}</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function StatusDialog({ s, onClose }: { s: StaffProfile; onClose: () => void }) {
  const [status, setStatus] = useState<StaffStatus>(s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');
  const [reason, setReason] = useState('');
  const [leaving, setLeaving] = useState('');
  const save = useSave(() => api.post(`/staff/${s.id}/status`, { status, reason, leavingDate: leaving || null }), { invalidate: [['staff']], success: 'Status changed', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Status of ${s.name}`} description="The change and the reason are kept in the modification history. Leaving staff lose their class and subject assignments (kept as history).">
        <div className="grid gap-4">
          <Field label="New status" htmlFor="ns"><Select id="ns" value={status} onChange={(e) => setStatus(e.target.value as StaffStatus)}>{STAFF_STATUSES.filter((x) => x !== s.status && x !== 'PENDING_ASSIGNMENT').map((x) => <option key={x} value={x}>{STAFF_STATUS_LABELS[x]}</option>)}</Select></Field>
          {(status === 'INACTIVE' || status === 'RESIGNED') && <Field label="Leaving date" htmlFor="ld"><Input id="ld" type="date" value={leaving} onChange={(e) => setLeaving(e.target.value)} /></Field>}
          <Field label="Reason" htmlFor="rs" required><Textarea id="rs" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={status === 'ACTIVE' ? 'e.g. Joined on 1 November; assignments complete' : 'e.g. Resigned, last working day 30 November'} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>{status === 'ACTIVE' ? <><CheckCircle2 /> Activate</> : <><Ban /> Save</>}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
