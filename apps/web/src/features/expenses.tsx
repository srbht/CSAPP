import { useQuery } from '@tanstack/react-query';
import {
  amountInWords, EXPENSE_MODES, EXPENSE_STATUS_LABELS, EXPENSE_STATUSES, MONTH_NAMES, PAYMENT_MODE_LABELS, PERMISSIONS, rupees, type ExpenseStatus, type PaymentMode,
} from '@cps/shared';
import { ArrowLeft, Ban, Check, Download, Eye, FileText, History, Paperclip, Pencil, Plus, Printer, Receipt, Search, Tags, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, Pagination, QueryView, useSave } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, ApiError, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced } from '@/lib/hooks';
import type { School } from '@/lib/types';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { fileSize, openBlob } from './admission-form';

const P = PERMISSIONS;
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

interface Category { id: number; code: string; name: string; isSalary: boolean; isSystem: boolean; status: string; used: number; usable: boolean }
interface Voucher {
  id: number; voucherNo: string; expenseDate: string; category: { id: number; name: string; code: string; isSalary: boolean }; title: string; description: string; paidTo: string;
  amount: number; mode: PaymentMode; reference: string | null; billNo: string | null; remarks: string | null; status: ExpenseStatus;
  staff: { id: number; name: string; employeeCode: string; designation: string | null } | null; salaryMonth: number | null; salaryYear: number | null; monthlySalary: number | null;
  createdBy: string | null; createdById: number; createdAt: string; approvedBy: string | null; approvedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; rejectReason: string | null;
  cancelledBy: string | null; cancelledAt: string | null; cancelReason: string | null; attachmentCount: number;
}
interface SalaryStatus { staff: { id: number; name: string; employeeCode: string; designation: string | null }; period: string; monthlySalary: number | null; paid: number; remaining: number; payments: { id: number; voucherNo: string; expenseDate: string; amount: number; status: string }[] }
interface VoucherDetail extends Voucher {
  attachments: { id: number; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }[];
  history: { id: number; at: string; action: string; by: string | null; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
  salary: SalaryStatus | null;
  can: { edit: boolean; approve: boolean; cancel: boolean; attach: boolean; history: boolean };
}

const STATUS_STYLE: Record<ExpenseStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-900 border-amber-200', APPROVED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  REJECTED: 'bg-red-50 text-red-800 border-red-200', CANCELLED: 'bg-muted text-muted-foreground border-border',
};
export function VoucherStatus({ status }: { status: ExpenseStatus }) {
  return <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_STYLE[status])}>{EXPENSE_STATUS_LABELS[status]}</span>;
}
const useCategories = () => useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<Category[]>('/expense-categories'), staleTime: 60_000 });

// ======================================================================= list (Expense List and Voucher Management)

export function ExpenseListPage({ vouchers }: { vouchers?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const cats = useCategories();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setParams(n, { replace: true }); };
  const [q, setQ] = useState(get('q'));
  const search = useDebounced(q);
  useEffect(() => { if (search !== get('q')) set('q', search); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = { from: get('from'), to: get('to'), categoryId: get('categoryId'), mode: get('mode'), status: get('status'), createdBy: get('createdBy'), staffId: get('staffId'), q: get('q'), sort: get('sort') || '-date', page: get('page') || '1' };
  const list = useQuery({
    queryKey: ['expenses', 'list', f],
    queryFn: () => api.get<Page<Voucher> & { byStatus: Record<ExpenseStatus, { count: number; amount: number }>; creators: { id: number; name: string }[]; access: { readAll: boolean; approve: boolean } }>(`/expenses${qs({ ...f, pageSize: 50 })}`),
    placeholderData: (p) => p,
  });
  const tabs: [string, string][] = [['', 'All vouchers'], ...EXPENSE_STATUSES.map((s) => [s, EXPENSE_STATUS_LABELS[s]] as [string, string])];
  return (
    <>
      <PageHeader icon={vouchers ? Receipt : FileText} title={vouchers ? 'Vouchers' : 'Expenses'}
        description={list.data?.access.readAll ? 'Every expense voucher of the school. Only approved vouchers count as expenses in the reports.' : 'The expense vouchers you entered and their status. The Headmaster approves or rejects them.'}
        actions={can(P.EXPENSES_CREATE) && <Button asChild><Link to="/expenses/new"><Plus /> Add expense</Link></Button>} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tabs.map(([k, l]) => {
          const c = k ? list.data?.byStatus[k as ExpenseStatus] : null;
          return <button key={k} onClick={() => set('status', k)} className={cn('rounded-full border px-3 py-1 text-sm', f.status === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>{l}{c ? ` (${c.count})` : ''}</button>;
        })}
      </div>
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="relative sm:col-span-2"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search" className="pl-9" placeholder="Voucher no., title, paid to, bill no." value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Input aria-label="From date" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} title="From date" />
        <Input aria-label="To date" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} title="To date" />
        <Select aria-label="Category" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}><option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Payment mode" value={f.mode} onChange={(e) => set('mode', e.target.value)}><option value="">All modes</option>{EXPENSE_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select>
        {list.data?.access.readAll && <Select aria-label="Created by" value={f.createdBy} onChange={(e) => set('createdBy', e.target.value)}><option value="">Created by anyone</option>{list.data.creators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
      </Card>
      <Card className="overflow-hidden">
        <QueryView query={list} empty={(d) => (d.data.length ? null : <EmptyState icon={Receipt} title="No vouchers match these filters" />)}>
          {(d) => (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 border-b bg-muted/30 px-5 py-3 text-sm">
                {EXPENSE_STATUSES.map((s) => <span key={s}>{EXPENSE_STATUS_LABELS[s]}: <b className="tabular-nums">{rupees(d.byStatus[s].amount)}</b> ({d.byStatus[s].count})</span>)}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <THead><TR><TH>Voucher No.</TH><TH><button onClick={() => set('sort', f.sort === '-date' ? 'date' : '-date')}>Date {f.sort === 'date' ? '↑' : '↓'}</button></TH><TH>Category</TH><TH>Title</TH><TH>Paid to</TH><TH className="text-right"><button onClick={() => set('sort', f.sort === '-amount' ? 'amount' : '-amount')}>Amount</button></TH><TH>Mode</TH><TH>Status</TH><TH>Created by</TH><TH>Approved by</TH><TH /></TR></THead>
                  <TBody>
                    {d.data.map((v) => (
                      <TR key={v.id} className="cursor-pointer" onClick={() => navigate(`/expenses/${v.id}`)}>
                        <TD className="font-mono text-xs font-medium">{v.voucherNo}</TD>
                        <TD className="whitespace-nowrap">{formatDate(v.expenseDate)}</TD>
                        <TD>{v.category.name}</TD>
                        <TD className="max-w-56 truncate">{v.title}{v.staff && <span className="block text-xs text-muted-foreground">{v.staff.name} · {MONTH_NAMES[(v.salaryMonth ?? 1) - 1]} {v.salaryYear}</span>}</TD>
                        <TD className="max-w-44 truncate">{v.paidTo}</TD>
                        <TD className="text-right font-semibold tabular-nums">{rupees(v.amount)}</TD>
                        <TD className="text-sm">{PAYMENT_MODE_LABELS[v.mode]}</TD>
                        <TD><VoucherStatus status={v.status} /></TD>
                        <TD className="text-sm">{v.createdBy}</TD>
                        <TD className="text-sm">{v.approvedBy ?? '—'}</TD>
                        <TD className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" asChild><Link to={`/expenses/${v.id}`} aria-label="View voucher"><Eye /></Link></Button>
                          <Button size="sm" variant="ghost" aria-label="Download PDF" onClick={() => void openBlob(`/expenses/${v.id}/voucher.pdf`, `voucher-${v.voucherNo}.pdf`)}><Download /></Button>
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

// ======================================================================= add / edit

export function ExpenseFormPage() {
  const { id } = useParams();
  const existing = useQuery({ queryKey: ['expenses', 'detail', id], queryFn: () => api.get<VoucherDetail>(`/expenses/${id}`), enabled: !!id });
  if (id && !existing.data) return <QueryView query={existing}>{() => null}</QueryView>;
  return <ExpenseForm existing={existing.data} />;
}

function ExpenseForm({ existing }: { existing?: VoucherDetail }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const cats = useCategories();
  const now = new Date();
  const [v, setV] = useState({
    expenseDate: existing?.expenseDate.slice(0, 10) ?? todayIso(), categoryId: existing ? String(existing.category.id) : '', title: existing?.title ?? '', description: existing?.description ?? '',
    paidTo: existing?.paidTo ?? '', amount: existing ? String(existing.amount) : '', mode: (existing?.mode ?? 'CASH') as string, reference: existing?.reference ?? '', billNo: existing?.billNo ?? '',
    remarks: existing?.remarks ?? '', staffId: existing?.staff ? String(existing.staff.id) : '', salaryMonth: String(existing?.salaryMonth ?? (now.getMonth() === 0 ? 12 : now.getMonth())),
    salaryYear: String(existing?.salaryYear ?? (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear())), reason: '',
  });
  const [confirmAdditional, setConfirm] = useState(false);
  const [bills, setBills] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const up = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const cat = cats.data?.find((c) => String(c.id) === v.categoryId);
  const isSalary = !!cat?.isSalary;
  const staff = useQuery({ queryKey: ['staff', 'salaried'], queryFn: () => api.get<Page<{ id: number; name: string; employeeCode: string; designation: string | null; monthlySalary: number | null }>>('/staff?status=ACTIVE&pageSize=100'), enabled: isSalary });
  const salary = useQuery({
    queryKey: ['salary-status', v.staffId, v.salaryMonth, v.salaryYear, existing?.id],
    queryFn: () => api.get<SalaryStatus>(`/expenses/salary-status${qs({ staffId: v.staffId, month: v.salaryMonth, year: v.salaryYear, excludeId: existing?.id })}`),
    enabled: isSalary && !!v.staffId, retry: false,
  });
  useEffect(() => {
    if (!isSalary || !salary.data) return;
    setV((x) => ({ ...x, paidTo: x.paidTo || salary.data.staff.name, title: x.title || `Salary ${MONTH_NAMES[Number(x.salaryMonth) - 1]} ${x.salaryYear}`, amount: x.amount || (salary.data.remaining ? String(salary.data.remaining) : ''), description: x.description || `Salary of ${salary.data.staff.name} for ${salary.data.period}` }));
  }, [isSalary, salary.data]);
  const needsRef = v.mode !== 'CASH';
  const approvedEdit = existing?.status === 'APPROVED';

  const save = useSave(async () => {
    const body = {
      ...v, amount: Number(v.amount), categoryId: Number(v.categoryId), confirmAdditional,
      ...(isSalary ? {} : { staffId: null, salaryMonth: null, salaryYear: null }), reason: v.reason || null,
    };
    const r = existing ? await api.patch<Voucher>(`/expenses/${existing.id}`, body) : await api.post<Voucher>('/expenses', body);
    for (const b of bills) {
      const fd = new FormData();
      fd.append('file', b);
      await api.post(`/expenses/${r.id}/attachments`, fd).catch((e) => toast.error(`${b.name}: ${errorMessage(e)}`));
    }
    return r;
  }, {
    invalidate: [['expenses'], ['salary-status']], success: existing ? 'Voucher updated' : 'Voucher created: waiting for approval',
    onSuccess: (r) => navigate(`/expenses/${r.id}`),
    onError: (e) => { if (e instanceof ApiError && e.errors.length) setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.message]))); },
  });
  const E = (k: string) => errors[k];
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to={existing ? `/expenses/${existing.id}` : '/expenses'}><ArrowLeft /> {existing ? 'Back to voucher' : 'Expenses'}</Link></Button>
      <PageHeader icon={Receipt} title={existing ? `Edit voucher ${existing.voucherNo}` : 'Add expense'} description={existing ? 'Changes are kept in the voucher history.' : 'A payment voucher is generated with the next voucher number. It counts as an expense after the Headmaster approves it.'} />
      <form className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(undefined); }}>
        <Card className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Voucher number" htmlFor="vn" hint={existing ? undefined : 'Given automatically (EXP-000001 …)'}><Input id="vn" value={existing?.voucherNo ?? 'Auto'} disabled /></Field>
          <Field label="Expense date" htmlFor="xd" required error={E('expenseDate')}><Input id="xd" type="date" max={todayIso()} value={v.expenseDate} onChange={up('expenseDate')} /></Field>
          <Field label="Expense category" htmlFor="xc" required error={E('categoryId')}>
            <Select id="xc" value={v.categoryId} onChange={up('categoryId')}>
              <option value="">— Choose —</option>
              {cats.data?.filter((c) => c.usable || String(c.id) === v.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          {isSalary && (
            <Card className="grid gap-3 border-primary/30 bg-primary/[0.03] p-4 sm:col-span-2 lg:col-span-3 lg:grid-cols-4">
              <Field label="Staff member" htmlFor="xs" required error={E('staffId')} className="lg:col-span-2">
                <Select id="xs" value={v.staffId} onChange={(e) => setV((x) => ({ ...x, staffId: e.target.value, paidTo: '', amount: '', title: '', description: '' }))}>
                  <option value="">— Choose —</option>
                  {staff.data?.data.map((s) => <option key={s.id} value={s.id}>{s.employeeCode} · {s.name}{s.designation ? ` (${s.designation})` : ''}</option>)}
                </Select>
              </Field>
              <Field label="Salary month" htmlFor="xm" required error={E('salaryMonth')}><Select id="xm" value={v.salaryMonth} onChange={up('salaryMonth')}>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
              <Field label="Salary year" htmlFor="xy" required error={E('salaryYear')}><Input id="xy" inputMode="numeric" value={v.salaryYear} onChange={up('salaryYear')} /></Field>
              {salary.data && (
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:col-span-4">
                  <div><p className="text-xs text-muted-foreground">Designation</p><p className="font-medium">{salary.data.staff.designation ?? '—'}</p></div>
                  <div><p className="text-xs text-muted-foreground">Monthly salary</p><p className="font-medium">{salary.data.monthlySalary != null ? rupees(salary.data.monthlySalary) : <span className="text-destructive">Not set</span>}</p></div>
                  <div><p className="text-xs text-muted-foreground">Already paid for {salary.data.period}</p><p className="font-medium">{rupees(salary.data.paid)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Remaining</p><p className="font-semibold">{rupees(salary.data.remaining)}</p></div>
                  {salary.data.payments.length > 0 && (
                    <label className="col-span-full flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950">
                      <Checkbox className="mt-0.5" checked={confirmAdditional} onChange={(e) => setConfirm(e.target.checked)} />
                      <span>This month already has {salary.data.payments.map((p) => `${p.voucherNo} (${rupees(p.amount)})`).join(', ')}. Tick to record another part payment.</span>
                    </label>
                  )}
                </div>
              )}
              {salary.isError && <p className="text-sm text-destructive lg:col-span-4">{errorMessage(salary.error)}</p>}
            </Card>
          )}
          <Field label="Expense title" htmlFor="xt" required error={E('title')} className="lg:col-span-2"><Input id="xt" value={v.title} onChange={up('title')} /></Field>
          <Field label="Paid to" htmlFor="xp" required error={E('paidTo')}><Input id="xp" value={v.paidTo} onChange={up('paidTo')} /></Field>
          <Field label="Description" htmlFor="xde" required error={E('description')} className="sm:col-span-2 lg:col-span-3"><Textarea id="xde" rows={2} value={v.description} onChange={up('description')} /></Field>
          <Field label="Amount (₹)" htmlFor="xa" required error={E('amount')}><Input id="xa" inputMode="decimal" className="text-lg font-semibold tabular-nums" value={v.amount} onChange={up('amount')} /></Field>
          <Field label="Payment mode" htmlFor="xmo" required><Select id="xmo" value={v.mode} onChange={up('mode')}>{EXPENSE_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select></Field>
          <Field label={v.mode === 'CHEQUE' ? 'Cheque number / bank' : 'Transaction reference'} htmlFor="xr" required={needsRef} error={E('reference')}><Input id="xr" value={v.reference} onChange={up('reference')} placeholder={v.mode === 'UPI' ? 'UTR number' : v.mode === 'BANK_TRANSFER' ? 'NEFT / IMPS reference' : v.mode === 'CHEQUE' ? 'e.g. 000231, SBI' : 'optional'} /></Field>
          <Field label="Bill / invoice number" htmlFor="xb"><Input id="xb" value={v.billNo} onChange={up('billNo')} /></Field>
          <Field label="Bill attachment" htmlFor="xf" hint="PDF / JPG / PNG, up to 5 MB each">
            <Input id="xf" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setBills(Array.from(e.target.files ?? []))} />
          </Field>
          <Field label="Remarks" htmlFor="xre" className="lg:col-span-1"><Input id="xre" value={v.remarks} onChange={up('remarks')} /></Field>
          {v.amount && Number(v.amount) > 0 && <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">In words: <b className="text-foreground">{amountInWords(Number(v.amount))}</b></p>}
          {approvedEdit && <Field label="Reason for changing an approved voucher" htmlFor="xrs" required error={E('reason')} className="sm:col-span-2 lg:col-span-3"><Input id="xrs" value={v.reason} onChange={up('reason')} /></Field>}
          {isSalary && !can(P.STAFF_SALARY) && <p className="text-sm text-destructive">Only authorised users can record salary payments.</p>}
        </Card>
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{existing ? 'Save changes' : 'Save and generate voucher'}</Button>
        </div>
      </form>
    </>
  );
}

// ======================================================================= one voucher

export function ExpenseDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['expenses', 'detail', id], queryFn: () => api.get<VoucherDetail>(`/expenses/${id}`) });
  const [dlg, setDlg] = useState<'reject' | 'cancel' | null>(null);
  const approve = useSave(() => api.post(`/expenses/${id}/approve`), { invalidate: [['expenses']], success: 'Voucher approved' });
  const attach = useSave(async (files: File[]) => { for (const f of files) { const fd = new FormData(); fd.append('file', f); await api.post(`/expenses/${id}/attachments`, fd); } }, { invalidate: [['expenses']], success: 'Bill attached' });
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
      </div>
      <QueryView query={q}>
        {(v) => (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <h1 className="mr-auto text-xl font-semibold">Voucher {v.voucherNo} <VoucherStatus status={v.status} /></h1>
              {v.can.approve && <Button onClick={() => approve.mutate(undefined)} loading={approve.isPending}><Check /> Approve</Button>}
              {v.can.approve && <Button variant="outline" onClick={() => setDlg('reject')}><X /> Reject</Button>}
              {v.can.edit && <Button variant="outline" asChild><Link to={`/expenses/${v.id}/edit`}><Pencil /> Edit</Link></Button>}
              {v.can.cancel && <Button variant="outline" onClick={() => setDlg('cancel')}><Ban /> Cancel voucher</Button>}
              <Button variant="outline" onClick={() => window.print()}><Printer /> Print</Button>
              <Button variant="outline" onClick={() => void openBlob(`/expenses/${v.id}/voucher.pdf`, `voucher-${v.voucherNo}.pdf`)}><Download /> PDF</Button>
            </div>
            {v.status === 'REJECTED' && <Card className="border-red-200 bg-red-50 p-3 text-sm text-red-900 print:hidden">Rejected by {v.rejectedBy} on {formatDateTime(v.rejectedAt)}: {v.rejectReason}</Card>}
            {v.status === 'CANCELLED' && <Card className="bg-muted p-3 text-sm print:hidden">Cancelled by {v.cancelledBy} on {formatDateTime(v.cancelledAt)}: {v.cancelReason}</Card>}
            <VoucherPrint v={v} />
            <div className="grid gap-4 lg:grid-cols-2 print:hidden">
              <Card className="p-5">
                <h3 className="mb-3 flex items-center gap-2 font-semibold"><Paperclip className="size-4 text-muted-foreground" /> Supporting bills</h3>
                {v.attachments.length ? (
                  <ul className="mb-3 divide-y rounded-lg border text-sm">
                    {v.attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 px-3 py-2">
                        <button className="min-w-0 flex-1 truncate text-left text-primary hover:underline" onClick={() => void openBlob(`/expenses/${v.id}/attachments/${a.id}`)}>{a.fileName}</button>
                        <span className="text-xs text-muted-foreground">{fileSize(a.sizeBytes)}</span>
                        <Button size="sm" variant="ghost" aria-label="Download" onClick={() => void openBlob(`/expenses/${v.id}/attachments/${a.id}`, a.fileName)}><Download /></Button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mb-3 text-sm text-muted-foreground">No bills attached.</p>}
                {v.can.attach && <Input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="Attach bills" onChange={(e) => { const list = Array.from(e.target.files ?? []); if (list.length) attach.mutate(list); e.target.value = ''; }} />}
              </Card>
              {v.salary && (
                <Card className="p-5">
                  <h3 className="mb-3 font-semibold">Salary of {v.salary.staff.name} · {v.salary.period}</h3>
                  <p className="text-sm">Monthly salary <b>{rupees(v.salary.monthlySalary ?? 0)}</b> · paid (pending + approved) <b>{rupees(v.salary.paid)}</b> · remaining <b>{rupees(v.salary.remaining)}</b></p>
                  <ul className="mt-2 text-sm">{v.salary.payments.map((p) => <li key={p.id}><Link className="text-primary hover:underline" to={`/expenses/${p.id}`}>{p.voucherNo}</Link> · {formatDate(p.expenseDate)} · {rupees(p.amount)} · {EXPENSE_STATUS_LABELS[p.status as ExpenseStatus]}</li>)}</ul>
                </Card>
              )}
              {v.can.history && (
                <Card className="p-5 lg:col-span-2">
                  <h3 className="mb-3 flex items-center gap-2 font-semibold"><History className="size-4 text-muted-foreground" /> Voucher history</h3>
                  <ol className="grid gap-2 text-sm">
                    {v.history.map((h) => (
                      <li key={h.id} className="border-l-2 pl-3">
                        <span className="text-muted-foreground">{formatDateTime(h.at)}</span> · <b>{h.by ?? 'system'}</b> · {({ CREATE: 'Created', UPDATE: 'Changed', APPROVE: 'Approved', REJECT: 'Rejected', CANCEL: 'Cancelled' } as Record<string, string>)[h.action] ?? h.action}
                        {h.reason && <span className="text-muted-foreground"> · {h.reason}</span>}
                        {h.action === 'UPDATE' && h.before && h.after && <span className="block text-xs text-muted-foreground">{Object.keys(h.after).filter((k) => JSON.stringify(h.after![k]) !== JSON.stringify(h.before![k])).map((k) => `${k}: ${String(h.before![k] ?? '—')} → ${String(h.after![k] ?? '—')}`).join(' · ')}</span>}
                      </li>
                    ))}
                  </ol>
                </Card>
              )}
            </div>
            {dlg && <DecisionDialog v={v} kind={dlg} onClose={() => setDlg(null)} />}
          </div>
        )}
      </QueryView>
    </>
  );
}

/** The payment voucher as printed (screen and paper). */
function VoucherPrint({ v }: { v: VoucherDetail }) {
  const school = useQuery({ queryKey: ['school'], queryFn: () => api.get<School>('/school') });
  const logo = useSchoolLogo();
  const sc = school.data;
  const rows: [string, React.ReactNode][] = [
    ['Voucher No.', <span className="font-mono font-semibold">{v.voucherNo}</span>], ['Expense date', formatDate(v.expenseDate)], ['Expense category', v.category.name], ['Expense title', v.title],
    ['Paid to', v.paidTo], ['Description', v.description],
    ...(v.staff ? [['Salary of', `${v.staff.name} (${v.staff.employeeCode})${v.staff.designation ? `, ${v.staff.designation}` : ''} · ${MONTH_NAMES[(v.salaryMonth ?? 1) - 1]} ${v.salaryYear}`] as [string, React.ReactNode]] : []),
    ['Bill / invoice No.', v.billNo ?? '—'], ['Amount', <b className="text-base">{rupees(v.amount)}</b>], ['Amount in words', amountInWords(v.amount)],
    ['Payment mode', PAYMENT_MODE_LABELS[v.mode]], ['Transaction reference', v.reference ?? '—'], ['Prepared by', `${v.createdBy ?? '—'} · ${formatDateTime(v.createdAt)}`],
    ['Approved by', v.approvedBy ?? '—'], ['Approval date', v.approvedAt ? formatDate(v.approvedAt) : '—'], ['Remarks', v.remarks ?? '—'],
  ];
  return (
    <div className="relative mx-auto w-full max-w-[210mm] overflow-hidden rounded-2xl border bg-white p-7 text-black shadow-card print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <style>{'@page { size: A5 landscape; margin: 8mm; }'}</style>
      {v.status !== 'APPROVED' && <div className="pointer-events-none absolute inset-0 grid place-items-center"><span className="-rotate-20 text-6xl font-black tracking-widest text-red-600/15 uppercase">{EXPENSE_STATUS_LABELS[v.status]}</span></div>}
      <header className="flex items-center gap-4 border-b-2 border-black pb-3">
        {logo.data && <img src={logo.data} alt="" className="h-14 w-16 object-contain" />}
        <div className="flex-1 text-center">
          <h2 className="text-xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>{sc?.name}</h2>
          <p className="text-xs">{[sc?.addressLine, sc?.city, sc?.pincode].filter(Boolean).join(', ')}{sc?.phone ? ` · ☎ ${sc.phone}` : ''}{sc?.email ? ` · ${sc.email}` : ''}</p>
          <p className="mt-1 text-sm font-semibold tracking-wider uppercase">Payment voucher</p>
        </div>
      </header>
      <table className="mt-3 w-full border-collapse text-sm">
        <tbody>{rows.map(([k, val]) => <tr key={k}><td className="w-44 border border-black px-2 py-1 align-top font-semibold">{k}</td><td className="border border-black px-2 py-1">{val}</td></tr>)}</tbody>
      </table>
      <footer className="mt-12 grid grid-cols-3 gap-6 text-center text-xs">
        <p className="border-t border-black pt-1">Prepared by</p><p className="border-t border-black pt-1">Approved by</p><p className="border-t border-black pt-1">Receiver's signature</p>
      </footer>
    </div>
  );
}

function DecisionDialog({ v, kind, onClose }: { v: VoucherDetail; kind: 'reject' | 'cancel'; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useSave(() => api.post(`/expenses/${v.id}/${kind}`, { reason }), { invalidate: [['expenses']], success: kind === 'reject' ? 'Voucher rejected' : 'Voucher cancelled', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${kind === 'reject' ? 'Reject' : 'Cancel'} voucher ${v.voucherNo}?`} description={kind === 'cancel' && v.status === 'APPROVED' ? `${rupees(v.amount)} will no longer count as an approved expense (reversal). The voucher stays on record.` : 'The voucher stays on record with this reason.'}>
        <Field label="Reason" htmlFor="dr" required><Textarea id="dr" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Keep</Button><Button variant="destructive" loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>{kind === 'reject' ? 'Reject' : 'Cancel voucher'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= categories

export function ExpenseCategoriesPage() {
  const { can } = useAuth();
  const cats = useCategories();
  const manage = can(P.EXPENSE_CATEGORIES_MANAGE);
  const [name, setName] = useState('');
  const add = useSave(() => api.post('/expense-categories', { name, status: 'ACTIVE' }), { invalidate: [['expense-categories']], success: 'Category added', onSuccess: () => setName('') });
  const update = useSave((c: { id: number; name: string; status: string }) => api.patch(`/expense-categories/${c.id}`, { name: c.name, status: c.status }), { invalidate: [['expense-categories']], success: 'Category saved' });
  const sorted = useMemo(() => cats.data ?? [], [cats.data]);
  return (
    <>
      <PageHeader icon={Tags} title="Expense categories" description="Categories used on vouchers. A category that has been used cannot be deleted; make it inactive instead." />
      {manage && (
        <Card className="mb-4 flex flex-wrap items-end gap-2 p-4">
          <Field label="New category" htmlFor="nc" className="min-w-64 flex-1"><Input id="nc" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Security services" /></Field>
          <Button disabled={name.trim().length < 2} loading={add.isPending} onClick={() => add.mutate(undefined)}><Plus /> Add</Button>
        </Card>
      )}
      <Card className="overflow-hidden">
        <QueryView query={cats}>
          {() => (
            <Table>
              <THead><TR><TH>Category</TH><TH className="text-right">Vouchers</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {sorted.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium">{c.name}{c.isSalary && <Badge variant="secondary" className="ml-2">Salary</Badge>}{c.isSystem && <span className="ml-2 text-xs text-muted-foreground">default</span>}</TD>
                    <TD className="text-right tabular-nums">{c.used}</TD>
                    <TD>{c.status === 'ACTIVE' ? 'Active' : <span className="text-muted-foreground">Inactive</span>}</TD>
                    <TD className="text-right">
                      {manage && <Button size="sm" variant="ghost" onClick={() => { const n = prompt('Category name', c.name); if (n && n.trim().length >= 2 && n !== c.name) update.mutate({ id: c.id, name: n.trim(), status: c.status }); }}><Pencil /> Rename</Button>}
                      {manage && !c.isSalary && <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: c.id, name: c.name, status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })}>{c.status === 'ACTIVE' ? 'Make inactive' : 'Make active'}</Button>}
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
