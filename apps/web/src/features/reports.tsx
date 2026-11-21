import { useQuery } from '@tanstack/react-query';
import {
  DEPARTMENTS, DESIGNATIONS, EMPLOYEE_TYPE_LABELS, EMPLOYEE_TYPES, EXPENSE_MODES, EXPENSE_STATUS_LABELS, EXPENSE_STATUSES, PAYMENT_MODE_LABELS, PAYMENT_MODES, PERMISSIONS,
  STAFF_STATUS_LABELS, STAFF_STATUSES, type PermissionCode,
} from '@cps/shared';
import {
  ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, BarChart3, BriefcaseBusiness, CalendarClock, CalendarDays, ChevronDown, FileSpreadsheet, FileText, IndianRupee, LayoutDashboard,
  ListOrdered, PieChart, Printer, Receipt, Scale, Search, UserCheck, UserX, Users, Wallet, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, Pagination, QueryView } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced, useWorkingContext, useYears } from '@/lib/hooks';
import type { StudentsOverview } from '@/lib/types';
import { cn } from '@/lib/utils';

const P = PERMISSIONS;

// ======================================================================= report catalogue

type FilterKind = 'dates' | 'mode' | 'classes' | 'section' | 'gender' | 'status' | 'amount' | 'includePrevious'
  | 'expenseMode' | 'category' | 'voucherStatus' | 'createdBy' | 'enteredBy' | 'employeeType' | 'designation' | 'department' | 'staffStatus' | 'joining';
interface ReportDef {
  key: string; title: string; group: 'fee' | 'student' | 'staff' | 'expense'; perm: PermissionCode | PermissionCode[]; icon: React.ElementType; purpose: string;
  filters: FilterKind[]; searchable: boolean; defaultStatus?: string;
  /** Server report to run (when one report is shown with preset filters, e.g. teaching staff). */
  apiKey?: string; preset?: Record<string, string>; allPerms?: boolean; datesHint?: string;
}
const STAFF_VIEW: PermissionCode[] = [PERMISSIONS.STAFF_READ, PERMISSIONS.STAFF_REGISTER, PERMISSIONS.STAFF_MANAGE];
const staffFilters: FilterKind[] = ['employeeType', 'designation', 'department', 'staffStatus', 'joining'];
export const REPORTS: ReportDef[] = [
  { key: 'day-wise-collection', title: 'Day-wise Fees Collection', group: 'fee', perm: P.FEES_READ, icon: CalendarDays, purpose: 'Every receipt between two dates, with previous-year and current-year amounts kept apart, and cash vs online totals.', filters: ['dates', 'mode', 'classes'], searchable: true },
  { key: 'class-wise-collection', title: 'Class-wise Fees Collection', group: 'fee', perm: P.FEES_READ, icon: IndianRupee, purpose: 'Compare classes: fees applicable, collected (previous year and current year separately) and still outstanding.', filters: ['classes', 'dates', 'mode'], searchable: false },
  { key: 'pending-fees', title: 'Class-wise Pending Fees', group: 'fee', perm: P.FEES_READ, icon: Wallet, purpose: 'Students who still owe fees, with parent contact numbers, for follow-up.', filters: ['classes', 'gender', 'amount', 'includePrevious'], searchable: true },
  { key: 'gender-wise-students', title: 'Gender-wise Student List', group: 'student', perm: P.REPORTS_VIEW, icon: Users, purpose: 'Students grouped by gender, with totals of male, female and others.', filters: ['gender', 'classes', 'status'], searchable: true, defaultStatus: 'ACTIVE' },
  { key: 'class-wise-students', title: 'Class-wise Student List', group: 'student', perm: P.REPORTS_VIEW, icon: ListOrdered, purpose: 'Numbered list of students for one or more classes or a section.', filters: ['classes', 'section', 'gender', 'status'], searchable: true, defaultStatus: 'ACTIVE' },
  { key: 'school-at-a-glance', title: 'School at a Glance', group: 'student', perm: P.REPORTS_VIEW, icon: LayoutDashboard, purpose: 'Management overview: enrolment by class, gender, section, new admissions, transfers, active vs inactive.', filters: ['classes', 'section', 'gender', 'status'], searchable: false, defaultStatus: 'ALL' },
  { key: 'backdated-fees', title: 'Backdated Fee Collection', group: 'fee', perm: P.FEES_EDIT, icon: CalendarClock, purpose: 'Receipts entered after the payment date, with the system and manual receipt numbers, for audit.', filters: ['dates', 'classes', 'enteredBy'], searchable: true },
  { key: 'income-expense', title: 'Income & Expense Summary', group: 'expense', perm: [P.EXPENSES_READ, P.FEES_READ], allPerms: true, icon: Scale, purpose: 'Fee collection against approved expenses, by category and month, and the net balance.', filters: ['dates'], searchable: false },
  { key: 'staff-list', title: 'Staff List', group: 'staff', perm: STAFF_VIEW, icon: Users, purpose: 'All staff with designation, department, type, joining date and status.', filters: staffFilters, searchable: true },
  { key: 'teaching-staff', apiKey: 'staff-list', preset: { employeeType: 'TEACHING' }, title: 'Teaching Staff', group: 'staff', perm: STAFF_VIEW, icon: BriefcaseBusiness, purpose: 'Teaching staff only.', filters: ['designation', 'department', 'staffStatus', 'joining'], searchable: true },
  { key: 'non-teaching-staff', apiKey: 'staff-list', preset: { employeeType: 'NON_TEACHING' }, title: 'Non-Teaching Staff', group: 'staff', perm: STAFF_VIEW, icon: BriefcaseBusiness, purpose: 'Office, support and other non-teaching staff.', filters: ['designation', 'department', 'staffStatus', 'joining'], searchable: true },
  { key: 'active-staff', apiKey: 'staff-list', preset: { staffStatus: 'ACTIVE' }, title: 'Active Staff', group: 'staff', perm: STAFF_VIEW, icon: UserCheck, purpose: 'Staff currently working.', filters: ['employeeType', 'designation', 'department', 'joining'], searchable: true },
  { key: 'inactive-staff', apiKey: 'staff-list', preset: { staffStatus: 'INACTIVE' }, title: 'Inactive Staff', group: 'staff', perm: STAFF_VIEW, icon: UserX, purpose: 'Staff who are inactive or have resigned.', filters: ['employeeType', 'designation', 'department', 'joining'], searchable: true },
  { key: 'staff-salary', title: 'Staff Salary', group: 'staff', perm: P.STAFF_SALARY, icon: Wallet, purpose: 'Monthly salary, payment mode and bank details, and salary paid in the period.', filters: ['dates', ...staffFilters.filter((f) => f !== 'joining')], searchable: true },
  { key: 'day-wise-expenses', title: 'Day-wise Expenses', group: 'expense', perm: P.EXPENSES_READ, icon: Receipt, purpose: 'Every voucher between two dates with category, amount, status, created and approved by.', filters: ['dates', 'category', 'expenseMode', 'voucherStatus', 'createdBy'], searchable: true },
  { key: 'category-wise-expenses', title: 'Category-wise Expenses', group: 'expense', perm: P.EXPENSES_READ, icon: PieChart, purpose: 'Approved and pending totals for each expense category.', filters: ['dates', 'category', 'expenseMode'], searchable: false },
  { key: 'salary-expenses', title: 'Staff Salary Expenses', group: 'expense', perm: [P.EXPENSES_READ, P.STAFF_SALARY], allPerms: true, icon: Wallet, purpose: 'Salary vouchers: month, amount paid, remaining salary and status.', filters: ['dates', 'expenseMode', 'voucherStatus', 'designation'], searchable: true },
];
const allowed = (r: ReportDef, can: (p: PermissionCode) => boolean) => {
  const list = Array.isArray(r.perm) ? r.perm : [r.perm];
  return r.allPerms ? list.every(can) : list.some(can);
};

export function ReportsHomePage() {
  const { can } = useAuth();
  const groups = [
    { key: 'fee', title: 'Fee reports', text: 'Previous academic year collection and current academic year collection are always shown separately.', list: REPORTS.filter((r) => r.group === 'fee' && allowed(r, can)) },
    { key: 'student', title: 'Student reports', text: 'Lists and counts of students for the classes you can see.', list: REPORTS.filter((r) => r.group === 'student' && allowed(r, can)) },
    { key: 'staff', title: 'Staff reports', text: 'Staff lists by type and status. Salary details only for authorised users.', list: REPORTS.filter((r) => r.group === 'staff' && allowed(r, can)) },
    { key: 'expense', title: 'Expense reports', text: 'Only approved vouchers count as expenses; pending, rejected and cancelled vouchers are shown separately. Fee collection and expenses are never mixed.', list: REPORTS.filter((r) => r.group === 'expense' && allowed(r, can)) },
  ].filter((g) => g.list.length);
  useEffect(() => { const h = location.hash.slice(1); if (h) document.getElementById(`reports-${h}`)?.scrollIntoView({ behavior: 'smooth' }); }, []);
  return (
    <>
      <PageHeader icon={BarChart3} title="Reports & Analytics" description="Choose a report. Every report can be filtered, searched, sorted, printed and exported to Excel or PDF." />
      {!groups.length && <Card><EmptyState title="No reports for your role" description="Ask the school admin if you need access." /></Card>}
      <div className="grid gap-6">
        {groups.map((g) => (
          <section key={g.key} id={`reports-${g.key}`}>
            <h2 className="font-semibold">{g.title}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{g.text}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.list.map((r) => (
                <Link key={r.key} to={`/reports/${r.key}`} className="group rounded-2xl border bg-card p-5 shadow-card transition hover:border-primary">
                  <span className="mb-3 grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><r.icon className="size-5" /></span>
                  <p className="font-semibold group-hover:text-primary">{r.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{r.purpose}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

// ======================================================================= one report

type ColType = 'text' | 'money' | 'number' | 'date' | 'percent';
interface Column { key: string; label: string; type?: ColType }
type Row = Record<string, string | number | null>;
interface ReportData {
  title: string; school: string; generatedAt: string;
  filters: { label: string; value: string }[];
  summary: { label: string; value: number | string; type?: ColType }[];
  columns: Column[]; rows: Row[]; totals?: Row;
  tables?: { title: string; columns: Column[]; rows: Row[]; totals?: Row; emphasis?: string[] }[];
  tablesFirst?: boolean;
  notes?: string[];
  meta: { page: number; pageSize: number; total: number };
}

const fmt = (v: unknown, type: ColType = 'text') => {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'money') return `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  if (type === 'percent') return `${Number(v).toFixed(1)}%`;
  if (type === 'date') return String(v).slice(0, 10).split('-').reverse().join('/');
  return String(v);
};
const isNum = (t?: ColType) => t === 'money' || t === 'number' || t === 'percent';
const firstOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const today = () => new Date().toISOString().slice(0, 10);

export function ReportPage() {
  const { key } = useParams();
  const def = REPORTS.find((r) => r.key === key);
  const { can } = useAuth();
  if (!def) return <Card><EmptyState title="Report not found" action={<Button asChild variant="outline"><Link to="/reports">All reports</Link></Button>} /></Card>;
  if (!allowed(def, can)) return <Card><EmptyState title="You don't have access to this report" description="Ask the school admin if you need it." /></Card>;
  return <ReportView key={def.key} def={def} />;
}

function ReportView({ def }: { def: ReportDef }) {
  const { yearId: workingYear } = useWorkingContext();
  const years = useYears();
  const [params, setParams] = useSearchParams();
  const get = (k: string, d = '') => params.get(k) ?? d;
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k);
    if (!('page' in patch)) n.delete('page');
    setParams(n, { replace: true });
  };
  const yearId = get('academicYearId', workingYear ? String(workingYear) : '');
  const has = (f: FilterKind) => def.filters.includes(f);
  const [q, setQ] = useState(get('q'));
  const search = useDebounced(q, 350);
  useEffect(() => { if (search !== get('q')) set({ q: search }); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Defaults that matter: day-wise starts at the 1st of this month; lists show active students.
  const query = useMemo(() => ({
    academicYearId: yearId,
    from: has('dates') ? get('from', def.key === 'day-wise-collection' ? firstOfMonth() : '') : '',
    to: has('dates') ? get('to', def.key === 'day-wise-collection' ? today() : '') : '',
    mode: has('mode') ? get('mode') : '', classIds: has('classes') ? get('classIds') : '', sectionId: has('section') ? get('sectionId') : '',
    gender: has('gender') ? get('gender') : '', status: has('status') ? get('status', def.defaultStatus ?? '') : '',
    minAmount: has('amount') ? get('minAmount') : '', maxAmount: has('amount') ? get('maxAmount') : '',
    includePrevious: has('includePrevious') ? get('includePrevious', 'true') : '',
    q: def.searchable ? get('q') : '', sort: get('sort'), dir: get('dir'),
    categoryId: has('category') ? get('categoryId') : '', voucherStatus: has('voucherStatus') ? get('voucherStatus') : '',
    createdBy: has('createdBy') ? get('createdBy') : '', enteredBy: has('enteredBy') ? get('enteredBy') : '',
    employeeType: has('employeeType') ? get('employeeType') : '', designation: has('designation') ? get('designation') : '',
    department: has('department') ? get('department') : '', staffStatus: has('staffStatus') ? get('staffStatus') : '',
    joinFrom: has('joining') ? get('joinFrom') : '', joinTo: has('joining') ? get('joinTo') : '',
    ...(has('expenseMode') ? { mode: get('mode') } : {}),
    ...def.preset,
  }), [params, yearId, def]); // eslint-disable-line react-hooks/exhaustive-deps
  const apiKey = def.apiKey ?? def.key;
  const people = useQuery({ queryKey: ['reports', 'people'], queryFn: () => api.get<{ feeCollectors: { id: number; name: string }[]; expenseCreators: { id: number; name: string }[] }>('/reports/options/people'), enabled: has('createdBy') || has('enteredBy') });
  const cats = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<{ id: number; name: string }[]>('/expense-categories'), enabled: has('category') });
  const page = Number(get('page', '1'));
  const data = useQuery({
    queryKey: ['reports', def.key, query, page],
    queryFn: () => api.get<ReportData>(`/reports/${apiKey}${qs({ ...query, page, pageSize: 50 })}`),
    enabled: !!yearId, placeholderData: (p) => p,
  });

  // Classes and sections of the chosen year, limited to what the user may see.
  const overview = useQuery({ queryKey: ['students', 'overview', Number(yearId)], queryFn: () => api.get<StudentsOverview>(`/students/overview${qs({ academicYearId: yearId })}`), enabled: !!yearId });
  const classes = useMemo(() => {
    const m = new Map<number, { id: number; name: string; medium: string }>();
    for (const s of overview.data?.sections ?? []) m.set(s.schoolClass.id, { id: s.schoolClass.id, name: s.schoolClass.displayName, medium: s.schoolClass.medium.nameEn });
    return [...m.values()];
  }, [overview.data]);
  const chosen = query.classIds ? query.classIds.split(',').map(Number) : [];
  const sections = (overview.data?.sections ?? []).filter((s) => !chosen.length || chosen.includes(s.schoolClass.id));

  // Export and print always use the complete report (all pages).
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | 'print' | null>(null);
  const [printData, setPrintData] = useState<ReportData | null>(null);
  const download = async (format: 'xlsx' | 'pdf') => {
    setBusy(format);
    try {
      const blob = await api.get<Blob>(`/reports/${apiKey}/export${qs({ ...query, format })}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${def.key}-${today()}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const print = async () => {
    setBusy('print');
    try {
      setPrintData(await api.get<ReportData>(`/reports/${apiKey}${qs({ ...query, all: true })}`));
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };
  useEffect(() => {
    if (!printData) return;
    const t = setTimeout(() => { window.print(); setBusy(null); setPrintData(null); }, 150);
    return () => clearTimeout(t);
  }, [printData]);

  const sortBy = (k: string) => {
    if (query.sort !== k) set({ sort: k, dir: 'asc' });
    else if (query.dir !== 'desc') set({ sort: k, dir: 'desc' });
    else set({ sort: null, dir: null });
  };
  const activeFilters = ['from', 'to', 'mode', 'classIds', 'sectionId', 'gender', 'status', 'minAmount', 'maxAmount', 'includePrevious', 'q', 'sort', 'categoryId', 'voucherStatus', 'createdBy', 'enteredBy', 'employeeType', 'designation', 'department', 'staffStatus', 'joinFrom', 'joinTo'].some((k) => params.get(k));

  return (
    <>
      <div className="print:hidden">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/reports"><ArrowLeft /> All reports</Link></Button>
        <PageHeader icon={def.icon} title={def.title} description={def.purpose}
          actions={<>
            <Button variant="outline" onClick={() => void download('xlsx')} loading={busy === 'xlsx'} disabled={!!busy}><FileSpreadsheet /> Excel</Button>
            <Button variant="outline" onClick={() => void download('pdf')} loading={busy === 'pdf'} disabled={!!busy}><FileText /> PDF</Button>
            <Button onClick={() => void print()} loading={busy === 'print'} disabled={!!busy}><Printer /> Print</Button>
          </>} />

        {/* Filters */}
        <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <Field label="Academic year" htmlFor="ry">
            <Select id="ry" value={yearId} onChange={(e) => set({ academicYearId: e.target.value, classIds: null, sectionId: null })}>
              {years.data?.map((y) => <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ' (current)' : ''}</option>)}
            </Select>
          </Field>
          {has('dates') && <>
            <Field label="From date" htmlFor="rf"><Input id="rf" type="date" value={query.from} onChange={(e) => set({ from: e.target.value })} /></Field>
            <Field label="To date" htmlFor="rt"><Input id="rt" type="date" value={query.to} onChange={(e) => set({ to: e.target.value })} /></Field>
          </>}
          {has('mode') && (
            <Field label="Payment mode" htmlFor="rm">
              <Select id="rm" value={query.mode} onChange={(e) => set({ mode: e.target.value })}><option value="">All modes</option>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select>
            </Field>
          )}
          {has('classes') && (
            <Field label={def.key === 'day-wise-collection' ? 'Class (optional)' : 'Class'} htmlFor="rc">
              <ClassPicker id="rc" classes={classes} value={chosen} onChange={(ids) => set({ classIds: ids.join(','), sectionId: null })} />
            </Field>
          )}
          {has('section') && (
            <Field label="Section" htmlFor="rs">
              <Select id="rs" value={query.sectionId} onChange={(e) => set({ sectionId: e.target.value })}>
                <option value="">All sections</option>
                {sections.map((s) => <option key={s.sectionId} value={s.sectionId}>{s.schoolClass.displayName} {s.name}</option>)}
              </Select>
            </Field>
          )}
          {has('gender') && (
            <Field label="Gender" htmlFor="rg">
              <Select id="rg" value={query.gender} onChange={(e) => set({ gender: e.target.value })}><option value="">All</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option></Select>
            </Field>
          )}
          {has('status') && (
            <Field label="Student status" htmlFor="rst">
              <Select id="rst" value={query.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive (left, passed out)</option><option value="TRANSFERRED">Transferred</option><option value="ALL">All</option>
              </Select>
            </Field>
          )}
          {has('amount') && <>
            <Field label="Pending from (₹)" htmlFor="ra"><Input id="ra" inputMode="decimal" placeholder="Any" value={query.minAmount} onChange={(e) => set({ minAmount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
            <Field label="Pending up to (₹)" htmlFor="rb"><Input id="rb" inputMode="decimal" placeholder="Any" value={query.maxAmount} onChange={(e) => set({ maxAmount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
          </>}
          {has('includePrevious') && (
            <Field label="Include previous year outstanding" htmlFor="ri">
              <Select id="ri" value={query.includePrevious} onChange={(e) => set({ includePrevious: e.target.value })}><option value="true">Yes</option><option value="false">No (current year only)</option></Select>
            </Field>
          )}
          {has('expenseMode') && (
            <Field label="Payment mode" htmlFor="rem">
              <Select id="rem" value={get('mode')} onChange={(e) => set({ mode: e.target.value })}><option value="">All modes</option>{EXPENSE_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select>
            </Field>
          )}
          {has('category') && (
            <Field label="Expense category" htmlFor="rca">
              <Select id="rca" value={query.categoryId} onChange={(e) => set({ categoryId: e.target.value })}><option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </Field>
          )}
          {has('voucherStatus') && (
            <Field label="Voucher status" htmlFor="rvs">
              <Select id="rvs" value={query.voucherStatus} onChange={(e) => set({ voucherStatus: e.target.value })}><option value="">All statuses</option>{EXPENSE_STATUSES.map((x) => <option key={x} value={x}>{EXPENSE_STATUS_LABELS[x]}</option>)}</Select>
            </Field>
          )}
          {has('createdBy') && (
            <Field label="Created by" htmlFor="rcb">
              <Select id="rcb" value={query.createdBy} onChange={(e) => set({ createdBy: e.target.value })}><option value="">Anyone</option>{people.data?.expenseCreators.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            </Field>
          )}
          {has('enteredBy') && (
            <Field label="Entered by" htmlFor="reb">
              <Select id="reb" value={query.enteredBy} onChange={(e) => set({ enteredBy: e.target.value })}><option value="">Anyone</option>{people.data?.feeCollectors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            </Field>
          )}
          {has('employeeType') && (
            <Field label="Employee type" htmlFor="ret">
              <Select id="ret" value={query.employeeType} onChange={(e) => set({ employeeType: e.target.value })}><option value="">All</option>{EMPLOYEE_TYPES.map((t) => <option key={t} value={t}>{EMPLOYEE_TYPE_LABELS[t]}</option>)}</Select>
            </Field>
          )}
          {has('designation') && (
            <Field label="Designation" htmlFor="rde">
              <Select id="rde" value={query.designation} onChange={(e) => set({ designation: e.target.value })}><option value="">All designations</option>{DESIGNATIONS.map((d) => <option key={d}>{d}</option>)}</Select>
            </Field>
          )}
          {has('department') && (
            <Field label="Department" htmlFor="rdp">
              <Select id="rdp" value={query.department} onChange={(e) => set({ department: e.target.value })}><option value="">All departments</option>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</Select>
            </Field>
          )}
          {has('staffStatus') && (
            <Field label="Employment status" htmlFor="rss">
              <Select id="rss" value={query.staffStatus} onChange={(e) => set({ staffStatus: e.target.value })}><option value="">{def.key === 'staff-salary' ? 'Active' : 'All'}</option>{STAFF_STATUSES.map((x) => <option key={x} value={x}>{x === 'INACTIVE' ? 'Inactive / resigned' : STAFF_STATUS_LABELS[x]}</option>)}</Select>
            </Field>
          )}
          {has('joining') && <>
            <Field label="Joined from" htmlFor="rjf"><Input id="rjf" type="date" value={query.joinFrom} onChange={(e) => set({ joinFrom: e.target.value })} /></Field>
            <Field label="Joined up to" htmlFor="rjt"><Input id="rjt" type="date" value={query.joinTo} onChange={(e) => set({ joinTo: e.target.value })} /></Field>
          </>}
          {def.searchable && (
            <Field label="Search" htmlFor="rq" className="sm:col-span-2">
              <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="rq" className="pl-9" placeholder={def.group === 'staff' ? 'Staff name, ID or mobile' : def.group === 'expense' ? 'Voucher no., title, paid to, staff' : 'Student name, admission or receipt no.'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            </Field>
          )}
          {activeFilters && <div className="flex items-end"><Button variant="ghost" size="sm" onClick={() => { setQ(''); setParams(yearId ? { academicYearId: yearId } : {}, { replace: true }); }}><X /> Clear filters</Button></div>}
        </Card>

        <QueryView query={data}>
          {(d) => (
            <div className="grid gap-4">
              <p className="text-xs text-muted-foreground">Generated on {d.generatedAt} · {d.filters.map((f) => `${f.label}: ${f.value}`).join(' · ')}</p>
              {d.tablesFirst && d.tables?.map((t) => <SmallTable key={t.title} t={t} />)}
              {d.summary.length > 0 && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {d.summary.map((s) => (
                    <Card key={s.label} className="p-4">
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                      <p className="mt-1 text-xl font-semibold tabular-nums">{fmt(s.value, s.type ?? 'number')}</p>
                    </Card>
                  ))}
                </div>
              )}
              <Card className="overflow-hidden">
                {d.rows.length ? (
                  <>
                    <div className="overflow-x-auto">
                      <Table>
                        <THead>
                          <TR>
                            {d.columns.map((c) => (
                              <TH key={c.key} className={cn('whitespace-nowrap', isNum(c.type) && 'text-right')}>
                                <button className={cn('inline-flex items-center gap-1 hover:text-foreground', query.sort === c.key && 'text-foreground')} onClick={() => sortBy(c.key)} title="Sort">
                                  {c.label}
                                  {query.sort === c.key ? (query.dir === 'desc' ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />) : <ArrowUpDown className="size-3 opacity-40" />}
                                </button>
                              </TH>
                            ))}
                          </TR>
                        </THead>
                        <TBody>
                          {d.rows.map((r, i) => (
                            <TR key={i}>{d.columns.map((c) => <TD key={c.key} className={cn(isNum(c.type) && 'text-right tabular-nums', c.key === 'studentName' && 'font-medium')}>{fmt(r[c.key], c.type)}</TD>)}</TR>
                          ))}
                          {d.totals && (
                            <TR className="bg-muted/50 font-semibold">{d.columns.map((c) => <TD key={c.key} className={cn(isNum(c.type) && 'text-right tabular-nums')}>{d.totals![c.key] === undefined ? '' : fmt(d.totals![c.key], c.type)}</TD>)}</TR>
                          )}
                        </TBody>
                      </Table>
                    </div>
                    {d.totals && d.meta.total > d.meta.pageSize && <p className="border-t px-4 py-2 text-xs text-muted-foreground">The total row covers all {d.meta.total} rows, not only this page.</p>}
                    <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={(p) => set({ page: String(p) })} />
                  </>
                ) : <EmptyState icon={BarChart3} title="No records match these filters" />}
              </Card>
              {!d.tablesFirst && d.tables?.map((t) => <SmallTable key={t.title} t={t} />)}
              {d.notes?.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
            </div>
          )}
        </QueryView>
      </div>
      {printData && <PrintView d={printData} />}
    </>
  );
}

function SmallTable({ t }: { t: NonNullable<ReportData['tables']>[number] }) {
  return (
    <Card className="overflow-hidden">
      <h3 className="border-b px-4 py-3 font-semibold">{t.title}</h3>
      <div className="overflow-x-auto">
        <Table>
          <THead><TR>{t.columns.map((c) => <TH key={c.key} className={cn(isNum(c.type) && 'text-right')}>{c.label}</TH>)}</TR></THead>
          <TBody>
            {t.rows.map((r, i) => <TR key={i} className={cn(t.emphasis?.includes(String(r[t.columns[0].key])) && 'bg-muted/40 font-semibold')}>{t.columns.map((c) => <TD key={c.key} className={cn(isNum(c.type) && 'text-right tabular-nums')}>{fmt(r[c.key], c.type)}</TD>)}</TR>)}
            {t.totals && <TR className="bg-muted/50 font-semibold">{t.columns.map((c) => <TD key={c.key} className={cn(isNum(c.type) && 'text-right tabular-nums')}>{t.totals![c.key] === undefined ? '' : fmt(t.totals![c.key], c.type)}</TD>)}</TR>}
          </TBody>
        </Table>
      </div>
    </Card>
  );
}

/** Multi-select of classes, grouped by medium. */
function ClassPicker({ id, classes, value, onChange }: { id: string; classes: { id: number; name: string; medium: string }[]; value: number[]; onChange: (ids: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const byMedium = classes.reduce<Record<string, typeof classes>>((acc, c) => ((acc[c.medium] ??= []).push(c), acc), {});
  const label = !value.length ? 'All classes' : value.length <= 2 ? classes.filter((c) => value.includes(c.id)).map((c) => c.name).join(', ') : `${value.length} classes`;
  const toggle = (ids: number[], on: boolean) => onChange(on ? [...new Set([...value, ...ids])] : value.filter((x) => !ids.includes(x)));
  return (
    <div ref={ref} className="relative">
      <button id={id} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border bg-card px-3 text-left text-sm">
        <span className="truncate">{label}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border bg-card p-2 shadow-lg">
          <div className="mb-1 flex justify-between px-1 text-xs"><button className="text-primary hover:underline" onClick={() => onChange(classes.map((c) => c.id))}>Select all</button><button className="text-primary hover:underline" onClick={() => onChange([])}>Clear</button></div>
          {Object.entries(byMedium).map(([m, list]) => (
            <div key={m} className="mb-1">
              <label className="flex items-center gap-2 rounded px-1 py-1 text-xs font-semibold text-muted-foreground uppercase">
                <Checkbox checked={list.every((c) => value.includes(c.id))} onChange={(e) => toggle(list.map((c) => c.id), e.target.checked)} /> {m}
              </label>
              {list.map((c) => (
                <label key={c.id} className="flex items-center gap-2 rounded px-1 py-1 pl-6 text-sm hover:bg-muted">
                  <Checkbox checked={value.includes(c.id)} onChange={(e) => toggle([c.id], e.target.checked)} /> {c.name}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The complete report laid out for paper: shown only while printing. */
function PrintView({ d }: { d: ReportData }) {
  return (
    <div className="hidden text-[11px] text-black print:block">
      <style>{'@page { size: A4 landscape; margin: 10mm; }'}</style>
      <div className="text-center">
        <p className="text-base font-bold">{d.school}</p>
        <p className="text-sm font-semibold">{d.title}</p>
        <p className="text-[10px] text-gray-600">Generated on {d.generatedAt}</p>
      </div>
      <p className="mt-2"><b>Filters:</b> {d.filters.map((f) => `${f.label}: ${f.value}`).join(' | ')}</p>
      {d.summary.length > 0 && <p className="mt-1"><b>Summary:</b> {d.summary.map((s) => `${s.label}: ${fmt(s.value, s.type ?? 'number')}`).join(' · ')}</p>}
      <PrintTable columns={d.columns} rows={d.rows} totals={d.totals} />
      {/* On paper the extra tables (e.g. the collection summary) always come after the list. */}
      {d.tables?.map((t) => <div key={t.title} className="mt-3 break-inside-avoid"><p className="font-bold">{t.title}</p><PrintTable columns={t.columns} rows={t.rows} totals={t.totals} emphasis={t.emphasis} /></div>)}
      {d.notes?.map((n) => <p key={n} className="mt-2 text-[10px] text-gray-600">{n}</p>)}
    </div>
  );
}
function PrintTable({ columns, rows, totals, emphasis }: { columns: Column[]; rows: Row[]; totals?: Row; emphasis?: string[] }) {
  return (
    <table className="mt-2 w-full border-collapse">
      <thead><tr>{columns.map((c) => <th key={c.key} className={cn('border border-black bg-gray-100 px-1 py-0.5 text-left', isNum(c.type) && 'text-right')}>{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i} className={cn('break-inside-avoid', emphasis?.includes(String(r[columns[0].key])) && 'font-bold')}>{columns.map((c) => <td key={c.key} className={cn('border border-black px-1 py-0.5', isNum(c.type) && 'text-right')}>{fmt(r[c.key], c.type)}</td>)}</tr>)}
        {totals && <tr className="font-bold">{columns.map((c) => <td key={c.key} className={cn('border border-black px-1 py-0.5', isNum(c.type) && 'text-right')}>{totals[c.key] === undefined ? '' : fmt(totals[c.key], c.type)}</td>)}</tr>}
      </tbody>
    </table>
  );
}
