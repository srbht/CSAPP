import { useQuery } from '@tanstack/react-query';
import {
  LEDGER_STATE_LABELS, type LedgerFigures, type LedgerState, MODES_NEEDING_REFERENCE, PAYMENT_MODE_LABELS, PAYMENT_MODES, PERMISSIONS, round2, rupees, todayIn, type PaymentMode,
} from '@cps/shared';
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, ChevronRight, Copy, History, IndianRupee, Pencil, Printer, Receipt, Search, Settings2, Users, Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, errorMessage, PageHeader, Pagination, QueryView, useSave } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { api, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced, useWorkingContext, useYears } from '@/lib/hooks';
import type { StudentDetail, StudentRow } from '@/lib/types';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { divisionLabel, useStudentsOverview } from './dashboard';
import { StudentAvatar } from './students';
import { InstalmentPlanTab, InstalmentsCard, type StudentInstalments } from './fee-instalments';

const P = PERMISSIONS;
/** Today in the school's timezone (a payment dated before this is a backdated entry). */
const todayIso = () => todayIn('Asia/Kolkata');

// ======================================================================= shared

type Sums = Omit<LedgerFigures, never>;
const STATE_STYLE: Record<LedgerState, string> = {
  PAID: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  PART_PAID: 'bg-sky-50 text-sky-800 border-sky-200',
  DUE: 'bg-amber-50 text-amber-900 border-amber-200',
  NO_FEES: 'bg-muted text-muted-foreground border-border',
};
export function FeeState({ state }: { state: LedgerState }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATE_STYLE[state])}>{LEDGER_STATE_LABELS[state]}</span>;
}
function Money({ value, className, strong }: { value: number; className?: string; strong?: boolean }) {
  return <span className={cn('tabular-nums', strong && 'font-semibold', className)}>{rupees(value)}</span>;
}
function PaidBar({ paid, net, className }: { paid: number; net: number; className?: string }) {
  const pct = net ? Math.min(100, Math.round((paid / net) * 100)) : 0;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}
function Kpi({ label, value, sub, tone, icon: Icon }: { label: string; value: string; sub?: React.ReactNode; tone?: 'ok' | 'bad' | 'brand'; icon: React.ElementType }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className={cn('grid size-8 place-items-center rounded-lg', tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : tone === 'bad' ? 'bg-red-50 text-red-700' : 'bg-primary/10 text-primary')}><Icon className="size-4" /></span>
        {label}
      </div>
      <p className={cn('mt-3 text-[28px] leading-none font-semibold tabular-nums', tone === 'bad' && 'text-red-700', tone === 'ok' && 'text-emerald-700')}>{value}</p>
      {sub && <div className="mt-2 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

/** The student fee ledger, line by line — the same lines the receipt prints. */
export function LedgerTable({ l, actions }: { l: LedgerFigures & { concessionReason?: string | null; openingReason?: string | null; previousYear?: string | null }; actions?: { opening?: () => void; concession?: () => void } }) {
  return (
    <dl className="divide-y text-sm">
      <LedgerLine label="Previous year outstanding" hint={l.previousYear ? `Unpaid balance carried forward from ${l.previousYear}` : l.openingReason ?? 'Balance from before this year'} value={l.previousOutstanding}
        extra={l.previousOutstanding > 0 && (l.previousStillDue > 0 ? <span className="text-xs text-amber-700">{rupees(l.previousStillDue)} still unpaid</span> : <span className="text-xs text-emerald-700">cleared</span>)}
        action={actions?.opening && <Button size="sm" variant="ghost" onClick={actions.opening}><Pencil /> Opening balance</Button>} />
      <LedgerLine label="Current year fees" hint="Annual fee of the class" value={l.currentYearFee} />
      {(l.concession > 0 || actions?.concession) && (
        <LedgerLine label="Discount (by Headmaster)" hint={l.concessionReason ?? undefined} value={-l.concession} tone="violet"
          action={actions?.concession && <Button size="sm" variant="ghost" onClick={actions.concession}><Pencil /> {l.concession > 0 ? 'Change' : 'Give discount'}</Button>} />
      )}
      {l.penalty > 0 && <LedgerLine label="Late fee" hint="For not paying the amount due by a due date" value={l.penalty} />}
      <LedgerLine label="Total payable" value={l.totalPayable} strong />
      <LedgerLine label="Total fees paid" value={-l.paid} tone="green" />
      <div className={cn('flex items-center justify-between gap-4 px-4 py-3', l.balance > 0 ? 'bg-primary/[0.05]' : 'bg-emerald-50')}>
        <dt className="font-semibold">Remaining outstanding balance</dt>
        <dd className={cn('text-xl font-bold tabular-nums', l.balance > 0 ? '' : 'text-emerald-700')}>{l.balance > 0 ? rupees(l.balance) : 'Fully paid'}</dd>
      </div>
    </dl>
  );
}
function LedgerLine({ label, hint, value, strong, tone, extra, action }: { label: string; hint?: string; value: number; strong?: boolean; tone?: 'green' | 'violet'; extra?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-4 py-2.5', strong && 'bg-muted/40')}>
      <dt className="min-w-0"><span className={cn(strong && 'font-semibold')}>{label}</span>{hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}</dt>
      <div className="flex items-center gap-2">
        {action}
        <dd className="text-right">
          <span className={cn('tabular-nums', strong && 'font-semibold', tone === 'green' && 'text-emerald-700', tone === 'violet' && 'text-violet-700')}>{value < 0 ? `− ${rupees(-value)}` : rupees(value)}</span>
          {extra && <span className="block">{extra}</span>}
        </dd>
      </div>
    </div>
  );
}

// ======================================================================= Fees page (overview, register, receipts, setup)

interface Summary {
  year: { id: number; name: string };
  totals: Sums & { students: number; studentsWithBalance: number; studentsWithPrevious: number; studentsNoFee: number; collectedPercent: number };
  today: { amount: number; receipts: number };
  last30: { date: string; amount: number; receipts: number }[];
  byMode: { mode: PaymentMode; amount: number; receipts: number }[];
  byClass: (Sums & { classId: number; name: string; students: number; studentsWithBalance: number; collectedPercent: number })[];
}

export function FeesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  return (
    <>
      <PageHeader icon={IndianRupee} title="Fees" description="One annual fee per class. Every student has a ledger for each year: previous year outstanding, this year's fee, what is paid, and the balance."
        actions={can(P.FEES_COLLECT) && <Button asChild><Link to="/fees/collect"><Wallet /> Collect fee</Link></Button>} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })} className="mb-5">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="register">Fee register</TabsTrigger>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="setup">Class fees</TabsTrigger>
          <TabsTrigger value="instalments">Due dates</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'overview' && <Overview />}
      {tab === 'register' && <Register />}
      {tab === 'receipts' && <Receipts />}
      {tab === 'setup' && <ClassFees />}
      {tab === 'instalments' && <InstalmentPlanTab />}
    </>
  );
}

export const useFeeSummary = (enabled = true) => {
  const { yearId } = useWorkingContext();
  return useQuery({ queryKey: ['fees', 'summary', yearId], queryFn: () => api.get<Summary>(`/fees/summary${qs({ academicYearId: yearId })}`), enabled: enabled && !!yearId });
};

function Overview() {
  const q = useFeeSummary();
  return (
    <QueryView query={q} empty={(s) => (s.totals.students && s.totals.studentsNoFee < s.totals.students ? null : <Card><EmptyState icon={IndianRupee} title="No class fees set yet" description="Open Class fees and enter the annual fee of each class (or copy last year's). Every student's ledger is updated at once." action={<Button asChild><Link to="/fees?tab=setup"><Settings2 /> Class fees</Link></Button>} /></Card>)}>
      {(s) => {
        const max = Math.max(1, ...s.last30.map((d) => d.amount));
        return (
          <div className="grid gap-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi icon={IndianRupee} label="Total payable this year" value={rupees(s.totals.totalPayable)} sub={`${rupees(s.totals.currentYearNet)} this year's fees + ${rupees(s.totals.previousOutstanding)} previous years`} />
              <Kpi icon={CheckCircle2} tone="ok" label="Collected" value={rupees(s.totals.paid)} sub={<PaidBar paid={s.totals.paid} net={s.totals.totalPayable} />} />
              <Kpi icon={Wallet} tone="brand" label="Balance to collect" value={rupees(s.totals.balance)} sub={`${s.totals.studentsWithBalance} students have a balance`} />
              <Kpi icon={AlertTriangle} tone="bad" label="Previous year still unpaid" value={rupees(s.totals.previousStillDue)} sub={<Link to="/fees?tab=register&status=PREVIOUS" className="text-primary hover:underline">{s.totals.studentsWithPrevious} students →</Link>} />
            </div>
            <div className="grid gap-5 lg:grid-cols-3">
              <Card className="p-5 lg:col-span-2">
                <div className="mb-4 flex items-baseline justify-between">
                  <h2 className="font-semibold">Collection, last 30 days</h2>
                  <p className="text-sm text-muted-foreground">Today: <b className="text-foreground">{rupees(s.today.amount)}</b> · {s.today.receipts} receipts</p>
                </div>
                <div className="flex h-40 items-end gap-1" role="img" aria-label="Daily collection for the last 30 days">
                  {s.last30.map((d) => (
                    <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
                      <div className={cn('rounded-t-sm', d.date === todayIso() ? 'bg-brand-accent' : 'bg-primary/70 group-hover:bg-primary')} style={{ height: `${Math.max(d.amount ? 4 : 0, (d.amount / max) * 100)}%` }} />
                      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md bg-foreground px-2 py-1 text-[11px] whitespace-nowrap text-background group-hover:block">{formatDate(d.date)}: {rupees(d.amount)} ({d.receipts})</span>
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{formatDate(s.last30[0]?.date)}</span><span>Today</span></div>
              </Card>
              <Card className="p-5">
                <h2 className="mb-3 font-semibold">How parents paid</h2>
                {s.byMode.length ? (
                  <ul className="grid gap-3">
                    {s.byMode.sort((a, b) => b.amount - a.amount).map((m) => (
                      <li key={m.mode}>
                        <div className="flex justify-between text-sm"><span>{PAYMENT_MODE_LABELS[m.mode]}</span><Money value={m.amount} strong /></div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/70" style={{ width: `${(m.amount / Math.max(1, s.totals.paid)) * 100}%` }} /></div>
                        <p className="text-xs text-muted-foreground">{m.receipts} receipts</p>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No payments yet.</p>}
              </Card>
            </div>
            <Card className="overflow-hidden">
              <div className="border-b px-5 py-4"><h2 className="font-semibold">Class-wise</h2><p className="text-sm text-muted-foreground">Click a class to see who still has a balance.</p></div>
              <Table>
                <THead><TR><TH>Class</TH><TH className="text-right">Students</TH><TH className="text-right">Previous years</TH><TH className="text-right">This year's fees</TH><TH className="text-right">Total payable</TH><TH className="text-right">Collected</TH><TH className="text-right">Balance</TH><TH className="w-40">Collected %</TH></TR></THead>
                <TBody>
                  {s.byClass.map((c) => (
                    <TR key={c.classId}>
                      <TD><Link to={`/fees?tab=register&classId=${c.classId}`} className="font-medium text-primary hover:underline">{c.name}</Link></TD>
                      <TD className="text-right tabular-nums">{c.students}<span className="block text-xs text-muted-foreground">{c.studentsWithBalance} with balance</span></TD>
                      <TD className="text-right"><Money value={c.previousOutstanding} className={c.previousOutstanding ? '' : 'text-muted-foreground'} /></TD>
                      <TD className="text-right"><Money value={c.currentYearNet} /></TD>
                      <TD className="text-right"><Money value={c.totalPayable} /></TD>
                      <TD className="text-right"><Money value={c.paid} className="text-emerald-700" /></TD>
                      <TD className="text-right"><Money value={c.balance} strong /></TD>
                      <TD><PaidBar paid={c.paid} net={c.totalPayable} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}

interface RegisterRow { nextInstalment: { label: string; dueOn: string; balance: number; status: string } | null; studentId: number; enrollmentId: number; enrollmentStatus: string; fullName: string; grNo: string; rollNo: number | null; isRte: boolean; section: { id: number; name: string; schoolClass: { id: number; displayName: string } }; contact: { name: string; mobile: string | null } | null; ledger: LedgerFigures; state: LedgerState; lastPayment: { paidOn: string; amount: number } | null }
function Register() {
  const { can } = useAuth();
  const { yearId } = useWorkingContext();
  const overview = useStudentsOverview();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const search = useDebounced(q);
  const status = params.get('status') ?? 'BALANCE';
  const sectionId = params.get('sectionId') ?? '';
  const classId = params.get('classId') ?? '';
  const page = Number(params.get('page') ?? 1);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setParams(n, { replace: true }); };
  const list = useQuery({
    queryKey: ['fees', 'register', { yearId, search, status, sectionId, classId, page }],
    queryFn: () => api.get<Page<RegisterRow> & { totals: Sums & { students: number; withBalance: number } }>(`/fees/register${qs({ academicYearId: yearId, q: search, status: status === 'ALL' ? undefined : status, sectionId, classId, page, pageSize: 50, sort: status === 'BALANCE' || status === 'PREVIOUS' ? 'balance' : 'roll' })}`),
    placeholderData: (p) => p,
  });
  const chips: [string, string][] = [['BALANCE', 'Balance due'], ['PREVIOUS', 'Previous year unpaid'], ['DUE', 'Nothing paid'], ['PART_PAID', 'Part paid'], ['PAID', 'Fully paid'], ['ALL', 'Everyone']];
  return (
    <div className="grid gap-4">
      <Card className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center">
        <div className="relative lg:w-72"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" placeholder="Name, GR No or exam no" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
        <Select aria-label="Division" className="lg:w-64" value={sectionId} onChange={(e) => { const n = new URLSearchParams(params); n.delete('classId'); if (e.target.value) n.set('sectionId', e.target.value); else n.delete('sectionId'); setParams(n, { replace: true }); }}>
          <option value="">{classId ? 'Selected class' : 'All classes'}</option>
          {overview.data?.sections.map((d) => <option key={d.sectionId} value={d.sectionId}>{divisionLabel(d)}</option>)}
        </Select>
        <div className="flex flex-wrap gap-1.5">
          {chips.map(([k, l]) => <button key={k} onClick={() => set('status', k)} className={cn('rounded-full border px-3 py-1 text-sm', status === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>{l}</button>)}
        </div>
      </Card>
      <QueryView query={list} empty={(d) => (d.data.length ? null : <Card><EmptyState icon={Users} title={status === 'BALANCE' || status === 'PREVIOUS' ? 'Nobody here has a balance' : 'No students'} /></Card>)}>
        {(d) => (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-b bg-muted/30 px-5 py-3 text-sm">
              <span>{d.totals.students} students</span>
              <span>Previous years <b><Money value={d.totals.previousOutstanding} /></b></span>
              <span>This year <b><Money value={d.totals.currentYearNet} /></b></span>
              <span>Total payable <b><Money value={d.totals.totalPayable} /></b></span>
              <span>Paid <b className="text-emerald-700"><Money value={d.totals.paid} /></b></span>
              <span>Balance <b><Money value={d.totals.balance} /></b></span>
            </div>
            <Table>
              <THead><TR><TH>Student</TH><TH>Class</TH><TH className="text-right">Previous year</TH><TH className="text-right">Current year</TH><TH className="text-right">Total payable</TH><TH className="text-right">Paid</TH><TH className="text-right">Balance</TH><TH>Status</TH><TH>Last paid</TH><TH>Parent</TH><TH /></TR></THead>
              <TBody>
                {d.data.map((r) => (
                  <TR key={r.enrollmentId}>
                    <TD><Link to={`/fees/student/${r.studentId}`} className="font-medium hover:text-primary hover:underline">{r.fullName}</Link><span className="block text-xs text-muted-foreground">{r.grNo ? `GR ${r.grNo}` : ''}{r.isRte && <Badge variant="secondary" className="ml-1.5">RTE</Badge>}{r.enrollmentStatus === 'PENDING_APPROVAL' ? <Badge variant="warning" className="ml-1.5">Provisional</Badge> : r.enrollmentStatus !== 'ACTIVE' && <Badge variant="secondary" className="ml-1.5">{r.enrollmentStatus.toLowerCase().replace('_', ' ')}</Badge>}</span></TD>
                    <TD className="whitespace-nowrap">{r.section.schoolClass.displayName} {r.section.name}<span className="block text-xs text-muted-foreground">Roll {r.rollNo ?? '—'}</span></TD>
                    <TD className="text-right">{r.ledger.previousOutstanding ? <><Money value={r.ledger.previousOutstanding} />{r.ledger.previousStillDue > 0 && <span className="block text-xs text-amber-700">{rupees(r.ledger.previousStillDue)} unpaid</span>}</> : <span className="text-muted-foreground">—</span>}</TD>
                    <TD className="text-right"><Money value={r.ledger.currentYearNet} /></TD>
                    <TD className="text-right"><Money value={r.ledger.totalPayable} /></TD>
                    <TD className="text-right"><Money value={r.ledger.paid} className="text-emerald-700" /></TD>
                    <TD className="text-right"><Money value={r.ledger.balance} strong /></TD>
                    <TD><FeeState state={r.state} />{r.nextInstalment && <span className={cn('mt-0.5 block text-xs whitespace-nowrap', r.nextInstalment.status === 'OVERDUE' ? 'font-medium text-red-700' : 'text-muted-foreground')}>{r.nextInstalment.status === 'OVERDUE' ? `Late: ${rupees(r.nextInstalment.balance)} short (${r.nextInstalment.label})` : `Next: ${rupees(r.nextInstalment.balance)} by ${formatDate(r.nextInstalment.dueOn)}`}</span>}</TD>
                    <TD className="text-xs text-muted-foreground">{r.lastPayment ? <>{formatDate(r.lastPayment.paidOn)}<span className="block">{rupees(r.lastPayment.amount)}</span></> : '—'}</TD>
                    <TD className="text-xs">{r.contact?.mobile ? <a href={`tel:${r.contact.mobile}`} className="tabular-nums hover:text-primary">{r.contact.mobile}</a> : '—'}</TD>
                    <TD className="text-right">{can(P.FEES_COLLECT) && r.ledger.balance > 0 && r.enrollmentStatus === 'ACTIVE' && <Button size="sm" variant="outline" asChild><Link to={`/fees/collect?student=${r.studentId}`}>Collect</Link></Button>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={(p) => set('page', String(p))} />
          </Card>
        )}
      </QueryView>
    </div>
  );
}

interface PaymentRow { id: number; receiptNo: string; manualReceiptNo: string | null; paidOn: string; amount: number; mode: PaymentMode; reference: string | null; status: string; balanceAfter: number; student: { id: number; fullName: string; grNo: string }; section: { name: string; schoolClass: { displayName: string } } }
function Receipts() {
  const { yearId } = useWorkingContext();
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [mode, setMode] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['fees', 'payments', { yearId, from, to, mode, page }],
    queryFn: () => api.get<Page<PaymentRow> & { totals: { amount: number; receipts: number; cancelled: number; byMode: { mode: PaymentMode; amount: number; receipts: number }[] } }>(`/fees/payments${qs({ academicYearId: yearId, from, to, mode, page, pageSize: 50 })}`),
    placeholderData: (p) => p,
  });
  const quick = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); setFrom(d.toISOString().slice(0, 10)); setTo(todayIso()); setPage(1); };
  return (
    <div className="grid gap-4">
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <Field label="From" htmlFor="fr"><Input id="fr" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></Field>
        <Field label="To" htmlFor="to"><Input id="to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></Field>
        <Field label="Mode" htmlFor="md"><Select id="md" className="w-48" value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }}><option value="">All modes</option>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select></Field>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => quick(0)}>Today</Button>
          <Button size="sm" variant="outline" onClick={() => quick(6)}>7 days</Button>
          <Button size="sm" variant="outline" onClick={() => quick(29)}>30 days</Button>
        </div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => window.print()}><Printer /> Print</Button>
      </Card>
      <QueryView query={list}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Kpi icon={Wallet} label="Collected" value={rupees(d.totals.amount)} sub={`${d.totals.receipts} receipts${d.totals.cancelled ? ` · ${d.totals.cancelled} cancelled` : ''}`} tone="ok" />
              {d.totals.byMode.slice(0, 3).map((m) => <Kpi key={m.mode} icon={Receipt} label={PAYMENT_MODE_LABELS[m.mode]} value={rupees(m.amount)} sub={`${m.receipts} receipts`} />)}
            </div>
            <Card className="overflow-hidden">
              {d.data.length ? (
                <>
                  <Table>
                    <THead><TR><TH>Receipt</TH><TH>Date</TH><TH>Student</TH><TH>Mode</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance after</TH><TH /></TR></THead>
                    <TBody>
                      {d.data.map((p) => (
                        <TR key={p.id} className={cn(p.status === 'CANCELLED' && 'opacity-60')}>
                          <TD><Link to={`/fees/receipts/${p.id}`} className="font-mono text-xs font-medium text-primary hover:underline">{p.receiptNo}</Link>{p.status === 'CANCELLED' && <Badge variant="destructive" className="ml-2">Cancelled</Badge>}{p.manualReceiptNo && <span className="block font-mono text-[11px] text-muted-foreground">Manual {p.manualReceiptNo}</span>}</TD>
                          <TD>{formatDate(p.paidOn)}</TD>
                          <TD><Link to={`/fees/student/${p.student.id}`} className="hover:text-primary hover:underline">{p.student.fullName}</Link><span className="block text-xs text-muted-foreground">{p.section.schoolClass.displayName} {p.section.name}</span></TD>
                          <TD className="text-sm">{PAYMENT_MODE_LABELS[p.mode]}{p.reference && <span className="block font-mono text-xs text-muted-foreground">{p.reference}</span>}</TD>
                          <TD className="text-right"><Money value={p.amount} strong /></TD>
                          <TD className="text-right"><Money value={p.balanceAfter} className="text-muted-foreground" /></TD>
                          <TD className="text-right"><Button size="sm" variant="ghost" asChild><Link to={`/fees/receipts/${p.id}`}><Printer /> Receipt</Link></Button></TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={setPage} />
                </>
              ) : <EmptyState icon={Receipt} title="No receipts in these dates" />}
            </Card>
          </>
        )}
      </QueryView>
    </div>
  );
}

// ======================================================================= class fees (one annual amount per class and year)

interface ClassFeeList {
  year: { id: number; name: string; status: string; editable: boolean };
  previousYear: { id: number; name: string; classesWithFees: number } | null;
  classes: { classId: number; displayName: string; medium: string; mediumCode: string; students: number; amount: number | null; updatedAt: string | null; previousYearAmount: number | null }[];
}
function ClassFees() {
  const { can } = useAuth();
  const { yearId: workingYear } = useWorkingContext();
  const years = useYears();
  const [params, setParams] = useSearchParams();
  // Fees can be set for the year in the top bar or for a later year (e.g. next year's admissions).
  const yearId = params.get('year') ? Number(params.get('year')) : workingYear;
  const current = years.data?.find((y) => y.isCurrent);
  const choices = (years.data ?? []).filter((y) => y.id === yearId || (y.status !== 'CLOSED' && (!current || y.isCurrent || y.startDate > current.startDate)))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const q = useQuery({ queryKey: ['fees', 'class-fees', yearId], queryFn: () => api.get<ClassFeeList>(`/fees/class-fees${qs({ academicYearId: yearId })}`), enabled: !!yearId });
  const copyClasses = useSave(() => api.post<{ copiedClasses: number }>(`/academic-years/${yearId}/copy-structure`), { invalidate: [['fees'], ['students'], ['classes']], success: 'Classes copied to the new year' });
  const [copyOpen, setCopyOpen] = useState(false);
  const manage = can(P.FEES_MANAGE);
  const pickYear = (id: number) => { const n = new URLSearchParams({ tab: 'setup' }); if (id !== workingYear) n.set('year', String(id)); setParams(n, { replace: true }); };
  return (
    <QueryView query={q}>
      {(d) => {
        const editable = manage && d.year.editable;
        const set = d.classes.filter((c) => c.amount != null).length;
        return (
          <div className="grid gap-4">
            {choices.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Academic year</span>
                {choices.map((y) => (
                  <button key={y.id} type="button" onClick={() => pickYear(y.id)}
                    className={cn('rounded-full border px-3 py-1', y.id === yearId ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                    {y.name}{y.isCurrent ? ' (current)' : current && y.startDate > current.startDate ? ' (next year)' : ''}
                  </button>
                ))}
              </div>
            )}
            {!d.classes.length && (
              <Card className="flex flex-wrap items-center gap-3 border-amber-300 bg-amber-50 p-4 dark:bg-amber-950/30">
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">No classes are set up for {d.year.name} yet</h2>
                  <p className="text-sm text-muted-foreground">Copy this year's classes and divisions to {d.year.name} first; then the fee of each class can be set here.</p>
                </div>
                {can(P.ACADEMICS_MANAGE) && d.year.editable
                  ? <Button loading={copyClasses.isPending} onClick={() => copyClasses.mutate(undefined)}><Copy /> Copy this year's classes to {d.year.name}</Button>
                  : <span className="text-sm text-muted-foreground">Ask the admin to copy the classes.</span>}
              </Card>
            )}
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">Annual fee of each class · {d.year.name}</h2>
                <p className="text-sm text-muted-foreground">
                  One amount per class for the whole year — no separate tuition, admission or other heads. {set} of {d.classes.length} classes set.
                  {!d.year.editable && ' This year is closed: its fees are kept as history.'}
                </p>
              </div>
              {editable && d.previousYear && d.previousYear.classesWithFees > 0 && <Button variant="outline" onClick={() => setCopyOpen(true)}><Copy /> Copy fees from {d.previousYear.name}</Button>}
            </Card>
            <Card className="overflow-hidden">
              <Table>
                <THead><TR><TH>Class</TH><TH>Medium</TH><TH className="text-right">Students</TH>{d.previousYear && <TH className="text-right">{d.previousYear.name}</TH>}<TH className="w-64 text-right">Annual fee {d.year.name}</TH></TR></THead>
                <TBody>
                  {d.classes.map((c) => (
                    <TR key={c.classId}>
                      <TD className="font-medium">{c.displayName}</TD>
                      <TD className="text-sm text-muted-foreground">{c.medium}</TD>
                      <TD className="text-right tabular-nums">{c.students}</TD>
                      {d.previousYear && <TD className="text-right text-sm text-muted-foreground">{c.previousYearAmount != null ? rupees(c.previousYearAmount) : '—'}</TD>}
                      <TD className="text-right">{editable ? <ClassFeeInput c={c} /> : c.amount != null ? <Money value={c.amount} strong /> : <span className="text-amber-700">Not set</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
            <p className="text-xs text-muted-foreground">Saving a fee updates the ledger of every student in that class for {d.year.name} only. Earlier years keep their own fees. RTE students are not charged.</p>
            {copyOpen && d.previousYear && <CopyFeesDialog from={d.previousYear} to={d.year} onClose={() => setCopyOpen(false)} />}
          </div>
        );
      }}
    </QueryView>
  );
}

function ClassFeeInput({ c }: { c: ClassFeeList['classes'][number] }) {
  const [v, setV] = useState(c.amount != null ? String(c.amount) : '');
  useEffect(() => setV(c.amount != null ? String(c.amount) : ''), [c.amount]);
  const save = useSave(() => api.put<{ students: number }>(`/fees/class-fees/${c.classId}`, { amount: Number(v) }), { invalidate: [['fees']], success: `${c.displayName}: fee saved` });
  const dirty = v !== (c.amount != null ? String(c.amount) : '') && v.trim() !== '' && !Number.isNaN(Number(v));
  return (
    <form className="flex items-center justify-end gap-2" onSubmit={(e) => { e.preventDefault(); if (dirty) save.mutate(undefined); }}>
      <div className="relative w-36">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
        <Input aria-label={`Annual fee for ${c.displayName}`} inputMode="decimal" className={cn('h-9 pl-6 text-right tabular-nums', c.amount == null && !v && 'border-amber-300')} placeholder="Not set" value={v} onChange={(e) => setV(e.target.value)} />
      </div>
      <Button type="submit" size="sm" variant={dirty ? 'default' : 'ghost'} disabled={!dirty} loading={save.isPending}>Save</Button>
    </form>
  );
}

function CopyFeesDialog({ from, to, onClose }: { from: { id: number; name: string }; to: { id: number; name: string }; onClose: () => void }) {
  const [overwrite, setOverwrite] = useState(false);
  const save = useSave(() => api.post<{ copied: number; skipped: number; unmatched: number }>('/fees/class-fees/copy', { fromAcademicYearId: from.id, toAcademicYearId: to.id, overwrite }), {
    invalidate: [['fees']], onSuccess: (r) => { toast.success(`${r.copied} class fees copied${r.skipped ? `, ${r.skipped} kept as they were` : ''}`); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Copy class fees from ${from.name} to ${to.name}?`} description={`Each class of ${to.name} gets the fee of the same class (medium and standard) in ${from.name}. ${from.name} itself is not changed. You can edit any amount afterwards.`}>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Also replace fees already set for {to.name}</label>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}><Copy /> Copy fees</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= one student's fee ledger

type Ledger = LedgerFigures & { state: LedgerState; concessionReason: string | null; openingReason: string | null; isFirstYear: boolean; previousYear: string | null; canCollect: boolean; carriedTo: string | null; canDiscount?: boolean; canWaive?: boolean };
export interface Account extends Omit<StudentInstalments, 'ledger'> {
  year: { id: number; name: string }; enrollmentId: number; ledgerId: number;
  student: { id: number; fullName: string; fullNameHi: string | null; grNo: string; provisional: boolean; isRte: boolean; rollNo: number | null; examNo: string | null; contact: { name: string; mobile: string | null } | null };
  section: { id: number; name: string; schoolClass: { displayName: string } };
  ledger: Ledger;
  history: (LedgerFigures & { year: { id: number; name: string; status: string }; className: string; status: string; state: LedgerState })[];
  payments: { id: number; receiptNo: string; manualReceiptNo: string | null; isBackdated: boolean; paidOn: string; amount: number; mode: PaymentMode; reference: string | null; payerName: string | null; remarks: string | null; balanceAfter: number; status: string; cancelReason: string | null; createdAt: string }[];
}
const useAccount = (studentId?: string | null, yearOverride?: number | null) => {
  const { yearId } = useWorkingContext();
  const y = yearOverride ?? yearId;
  return useQuery({ queryKey: ['fees', 'account', studentId, y], queryFn: () => api.get<Account>(`/fees/students/${studentId}${qs({ academicYearId: y })}`), enabled: !!studentId, retry: false });
};

export function StudentFeesPage() {
  const { studentId } = useParams();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const yearParam = params.get('year');
  const q = useAccount(studentId, yearParam ? Number(yearParam) : null);
  const [dlg, setDlg] = useState<'concession' | 'opening' | null>(null);
  const [cancel, setCancel] = useState<Account['payments'][number] | null>(null);
  const [fix, setFix] = useState<{ p: Account['payments'][number]; kind: 'details' | 'amount' } | null>(null);
  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/fees?tab=register"><ArrowLeft /> Fee register</Link></Button>
      <QueryView query={q}>
        {(a) => (
          <div className="grid gap-5">
            <PageHeader icon={IndianRupee} title={a.student.fullName} description={`${a.section.schoolClass.displayName} ${a.section.name} · ${a.student.provisional ? 'Provisional admission' : `Roll ${a.student.rollNo ?? '—'}${a.student.grNo ? ` · GR ${a.student.grNo}` : ''}`} · Fee ledger ${a.year.name}${a.student.isRte ? ' · RTE admission' : ''}`}
              actions={<>
                <Button variant="outline" asChild><Link to={`/students/${a.student.id}`}>Student profile</Link></Button>
                {can(P.FEES_COLLECT) && a.ledger.canCollect && a.ledger.balance > 0 && <Button asChild><Link to={`/fees/collect?student=${a.student.id}`}><Wallet /> Collect fee</Link></Button>}
              </>} />
            {a.ledger.carriedTo && (
              <Card className="border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                This year is closed for payments. Its balance of <b>{rupees(a.ledger.balance)}</b> was carried forward to {a.ledger.carriedTo} as previous year outstanding.
              </Card>
            )}
            <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b px-5 py-4"><h2 className="font-semibold">Fee ledger · {a.year.name}</h2><FeeState state={a.ledger.state} /></div>
                <LedgerTable l={a.ledger} actions={{
                  opening: can(P.FEES_MANAGE) && a.ledger.isFirstYear ? () => setDlg('opening') : undefined,
                  concession: a.ledger.canDiscount ? () => setDlg('concession') : undefined,
                }} />
              </Card>
              <Card className="overflow-hidden">
                <div className="border-b px-5 py-4"><h2 className="flex items-center gap-2 font-semibold"><History className="size-4 text-muted-foreground" /> Year by year</h2><p className="text-sm text-muted-foreground">Each year is kept separately. A year's unpaid balance moves to the next year as previous year outstanding.</p></div>
                <Table>
                  <THead><TR><TH>Year</TH><TH className="text-right">Previous</TH><TH className="text-right">Year fee</TH><TH className="text-right">Paid</TH><TH className="text-right">Balance</TH></TR></THead>
                  <TBody>
                    {a.history.map((h) => (
                      <TR key={h.year.id} className={cn(h.year.id === a.year.id && 'bg-primary/[0.05]')}>
                        <TD><button className="font-medium text-primary hover:underline" onClick={() => setParams({ year: String(h.year.id) })}>{h.year.name}</button><span className="block text-xs text-muted-foreground">{h.className}</span></TD>
                        <TD className="text-right"><Money value={h.previousOutstanding} className={h.previousOutstanding ? '' : 'text-muted-foreground'} /></TD>
                        <TD className="text-right"><Money value={h.currentYearNet} /></TD>
                        <TD className="text-right"><Money value={h.paid} className="text-emerald-700" /></TD>
                        <TD className="text-right"><Money value={h.balance} strong /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
            </div>
            <InstalmentsCard a={a} />
            <Card className="overflow-hidden">
              <div className="border-b px-5 py-4"><h2 className="font-semibold">Receipts · {a.year.name}</h2></div>
              {a.payments.length ? (
                <ul className="divide-y">
                  {a.payments.map((p) => (
                    <li key={p.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3', p.status === 'CANCELLED' && 'opacity-60')}>
                      <div className="min-w-0 flex-1">
                        <Link to={`/fees/receipts/${p.id}`} className="font-mono text-sm font-medium text-primary hover:underline">{p.receiptNo}</Link>
                        {p.manualReceiptNo && <span className="ml-2 font-mono text-xs text-muted-foreground">Manual {p.manualReceiptNo}</span>}
                        {p.isBackdated && <Badge variant="secondary" className="ml-2">Backdated</Badge>}
                        <p className="text-xs text-muted-foreground">{formatDate(p.paidOn)} · {PAYMENT_MODE_LABELS[p.mode]}{p.reference ? ` · ${p.reference}` : ''}{p.payerName ? ` · ${p.payerName}` : ''} · entered {formatDateTime(p.createdAt)}</p>
                        {p.status === 'CANCELLED' && <p className="text-xs text-red-700">Cancelled: {p.cancelReason}</p>}
                      </div>
                      <div className="text-right"><p className={cn('font-semibold tabular-nums', p.status === 'CANCELLED' && 'line-through')}>{rupees(p.amount)}</p><p className="text-xs text-muted-foreground">balance after: {rupees(p.balanceAfter)}</p></div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" asChild><Link to={`/fees/receipts/${p.id}`} aria-label="Print receipt"><Printer /></Link></Button>
                        {can(P.FEES_EDIT) && p.status === 'VALID' && <Button size="sm" variant="ghost" title="Correct date, mode, reference or manual receipt no." onClick={() => setFix({ p, kind: 'details' })}><Pencil /> Correct</Button>}
                        {can(P.FEES_EDIT) && p.status === 'VALID' && a.ledger.canCollect && <Button size="sm" variant="ghost" title="Wrong amount: cancel and re-issue" onClick={() => setFix({ p, kind: 'amount' })}>Amount</Button>}
                        {can(P.FEES_CANCEL) && p.status === 'VALID' && <Button size="sm" variant="ghost" aria-label="Cancel receipt" onClick={() => setCancel(p)}><Ban /></Button>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState icon={Receipt} title="No payments this year" />}
            </Card>
            {dlg === 'concession' && <ConcessionDialog a={a} onClose={() => setDlg(null)} />}
            {dlg === 'opening' && <OpeningDialog a={a} onClose={() => setDlg(null)} />}
            {cancel && <CancelDialog p={cancel} onClose={() => setCancel(null)} />}
            {fix?.kind === 'details' && <CorrectDialog p={fix.p} onClose={() => setFix(null)} />}
            {fix?.kind === 'amount' && <ReissueDialog p={fix.p} onClose={() => setFix(null)} />}
          </div>
        )}
      </QueryView>
    </>
  );
}

export function ConcessionDialog({ a, onClose }: { a: Account; onClose: () => void }) {
  const l = a.ledger;
  const [amount, setAmount] = useState(String(l.concession || ''));
  const [reason, setReason] = useState(l.concessionReason ?? '');
  const save = useSave(() => api.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: Number(amount) || 0, reason }), { invalidate: [['fees'], ['students']], success: 'Discount saved', onSuccess: onClose });
  const value = Number(amount) || 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Fee discount · ${a.student.fullName} · ${a.year.name}`} description={`This year's fee is ${rupees(l.currentYearFee)}. The discount lowers it; it cannot be more than the fee. Set 0 to remove it.`}>
        <div className="grid gap-4">
          <Field label="Discount amount (₹)" htmlFor="ca" hint={value > 0 && value <= l.currentYearFee ? `This year's fee becomes ${rupees(round2(l.currentYearFee - value))}` : undefined}><Input id="ca" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <div className="flex gap-2">{[10, 25, 50].map((p) => <Button key={p} size="sm" variant="outline" onClick={() => setAmount(String(round2((l.currentYearFee * p) / 100)))}>{p}%</Button>)}</div>
          <Field label="Reason" htmlFor="cr" required><Input id="cr" placeholder="e.g. Sibling discount, staff ward, financial hardship" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 3 || value > l.currentYearFee} onClick={() => save.mutate(undefined)}>Save discount</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpeningDialog({ a, onClose }: { a: Account; onClose: () => void }) {
  const [amount, setAmount] = useState(String(a.ledger.previousOutstanding || ''));
  const [reason, setReason] = useState(a.ledger.openingReason ?? '');
  const save = useSave(() => api.patch(`/fees/ledgers/${a.ledgerId}/opening`, { amount: Number(amount) || 0, reason }), { invalidate: [['fees']], success: 'Previous year outstanding saved', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Previous year outstanding (opening balance)" description="What this student still owed before the school started using this system, e.g. from last year's fee register. It is shown separately from this year's fee. Later years carry the balance forward automatically.">
        <div className="grid gap-4">
          <Field label="Amount still owed (₹)" htmlFor="ob"><Input id="ob" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Where this comes from" htmlFor="or" required><Input id="or" placeholder="e.g. Unpaid balance in the 2025-26 fee register" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Headmaster / Super Admin: correct a receipt's details. Every change needs a reason and is kept in the audit log. */
function CorrectDialog({ p, onClose }: { p: Account['payments'][number]; onClose: () => void }) {
  const [v, setV] = useState({ paidOn: p.paidOn.slice(0, 10), mode: p.mode as string, reference: p.reference ?? '', payerName: p.payerName ?? '', remarks: p.remarks ?? '', manualReceiptNo: p.manualReceiptNo ?? '', reason: '' });
  const up = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = useSave(() => api.patch(`/fees/payments/${p.id}`, v), { invalidate: [['fees']], success: 'Receipt corrected', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Correct receipt ${p.receiptNo}`} description="The system receipt number and the amount stay the same. The old and new values and your reason are kept in the audit history.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment date" htmlFor="cpd"><Input id="cpd" type="date" max={todayIso()} value={v.paidOn} onChange={up('paidOn')} /></Field>
          <Field label="Payment mode" htmlFor="cpm"><Select id="cpm" value={v.mode} onChange={up('mode')}>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select></Field>
          <Field label="Transaction reference" htmlFor="cpr"><Input id="cpr" value={v.reference} onChange={up('reference')} /></Field>
          <Field label="Manual receipt number" htmlFor="cpn"><Input id="cpn" value={v.manualReceiptNo} onChange={up('manualReceiptNo')} /></Field>
          <Field label="Paid by (name)" htmlFor="cpp"><Input id="cpp" value={v.payerName} onChange={up('payerName')} /></Field>
          <Field label="Remarks" htmlFor="cpk"><Input id="cpk" value={v.remarks} onChange={up('remarks')} /></Field>
          <Field label="Reason for the correction" htmlFor="cpz" required className="sm:col-span-2"><Input id="cpz" value={v.reason} onChange={up('reason')} placeholder="e.g. Parent paid by UPI, not cash" /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={v.reason.trim().length < 3} onClick={() => save.mutate(undefined)}>Save correction</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Wrong amount: the receipt is cancelled (kept on record) and a corrected receipt is issued for the same payment. */
function ReissueDialog({ p, onClose }: { p: Account['payments'][number]; onClose: () => void }) {
  const navigate = useNavigate();
  const [amount, setAmount] = useState(String(p.amount));
  const [reason, setReason] = useState('');
  const save = useSave(() => api.post<{ id: number }>(`/fees/payments/${p.id}/reissue`, { amount: Number(amount), reason }), { invalidate: [['fees']], success: 'Corrected receipt issued', onSuccess: (r) => navigate(`/fees/receipts/${r.id}`) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Correct the amount of ${p.receiptNo}`} description={`Receipt ${p.receiptNo} (${rupees(p.amount)}) will be cancelled and a new receipt issued for the correct amount, with the same payment date${p.manualReceiptNo ? ` and manual receipt no. ${p.manualReceiptNo}` : ''}.`}>
        <div className="grid gap-3">
          <Field label="Correct amount (₹)" htmlFor="rsa"><Input id="rsa" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Reason" htmlFor="rsr" required><Input id="rsr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Parent paid ₹900, entered as ₹1,000" /></Field>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 3 || !Number(amount)} onClick={() => save.mutate(undefined)}>Cancel and re-issue</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ p, onClose }: { p: { id: number; receiptNo: string; amount: number }; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useSave(() => api.post(`/fees/payments/${p.id}/cancel`, { reason }), { invalidate: [['fees']], success: 'Receipt cancelled; the balance is back', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Cancel receipt ${p.receiptNo}?`} description={`${rupees(p.amount)} will no longer count as paid and the balance goes up again (also in later years' carried-forward amount). The receipt stays on record as cancelled.`}>
        <Field label="Reason" htmlFor="cx" required><Textarea id="cx" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cheque bounced, entered for the wrong student" /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Keep receipt</Button><Button variant="destructive" loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>Cancel receipt</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= collect fee

export function CollectFeePage() {
  const [params, setParams] = useSearchParams();
  const studentId = params.get('student');
  const medium = params.get('medium') ?? '';
  const section = params.get('section') ?? '';
  const go = (next: { medium?: string; section?: string; student?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    setParams(p);
  };
  return (
    <>
      <PageHeader icon={Wallet} title="Collect fee" description="Choose the medium, the class and then the student. Check the student's details, enter the amount received and print the receipt." />
      {studentId
        ? <CollectForm studentId={studentId} onChange={() => go({ medium, section })} />
        : <StudentPicker medium={medium} section={section} onMedium={(m) => go({ medium: m })} onSection={(s) => go({ medium, section: s })} onPick={(id, m, s) => go({ medium: m, section: s, student: String(id) })} />}
    </>
  );
}

/** Three steps: medium → class and division → student. A search box is kept for when the office already knows the name or GR No. */
function StudentPicker({ medium, section, onMedium, onSection, onPick }: {
  medium: string; section: string; onMedium: (m: string) => void; onSection: (s: string) => void; onPick: (id: number, medium: string, section: string) => void;
}) {
  const { yearId } = useWorkingContext();
  const overview = useStudentsOverview();
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const found = useQuery({ queryKey: ['students', 'pick', search, yearId], queryFn: () => api.get<Page<StudentRow>>(`/students${qs({ academicYearId: yearId, q: search, pageSize: 12 })}`), enabled: search.length >= 2 });
  const sections = overview.data?.sections ?? [];
  const mediums = overview.data?.byMedium ?? [];
  const div = sections.find((s) => String(s.sectionId) === section);
  const mediumName = mediums.find((m) => m.code === medium)?.name;
  const step = !medium ? 1 : !div ? 2 : 3;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {/* Steps: each one is clickable to go back. */}
      <Card className="flex flex-wrap items-center gap-1 p-2 text-sm">
        <StepChip n={1} active={step === 1} done={step > 1} label={mediumName ?? 'Medium'} onClick={() => onMedium('')} />
        <ChevronRight className="size-4 text-muted-foreground" />
        <StepChip n={2} active={step === 2} done={step > 2} label={div ? divisionLabel(div) : 'Class'} onClick={medium ? () => onMedium(medium) : undefined} />
        <ChevronRight className="size-4 text-muted-foreground" />
        <StepChip n={3} active={step === 3} done={false} label="Student" />
      </Card>

      <QueryView query={overview}>
        {() => (
          <>
            {step === 1 && (
              <Card className="p-5">
                <h2 className="mb-3 font-semibold">1. Choose the medium</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {mediums.map((m) => (
                    <button key={m.code} onClick={() => onMedium(m.code)} className="rounded-xl border p-5 text-left transition hover:border-primary hover:bg-primary/5">
                      <p className="text-lg font-semibold">{m.name}</p>
                      <p className="text-sm text-muted-foreground">{m.divisions} divisions · {m.students} students</p>
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {step === 2 && (
              <Card className="p-5">
                <h2 className="mb-3 font-semibold">2. Choose the class and division · {mediumName}</h2>
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {sections.filter((s) => s.schoolClass.medium.code === medium).map((s) => (
                    <button key={s.sectionId} onClick={() => onSection(String(s.sectionId))} className="rounded-xl border p-3 text-left transition hover:border-primary hover:bg-primary/5">
                      <p className="font-semibold">{s.schoolClass.displayName} – {s.name}</p>
                      <p className="text-xs text-muted-foreground">{s.students} students{s.classTeacher ? ` · ${s.classTeacher.name}` : ''}</p>
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {step === 3 && div && <DivisionStudents sectionId={div.sectionId} title={divisionLabel(div)} onPick={(id) => onPick(id, medium, section)} />}
          </>
        )}
      </QueryView>

      <Card className="p-4">
        <Field label="Or search directly" htmlFor="sp" hint="Type at least 2 letters of the name, or the GR No / exam no">
          <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="sp" className="pl-9" placeholder="e.g. Sharma, SE-1205, E1001" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </Field>
        {found.data && (
          <ul className="mt-3 divide-y rounded-xl border">
            {found.data.data.map((s) => (
              <li key={s.id}>
                <button onClick={() => onPick(s.id, s.section.schoolClass.medium.code, String(s.section.id))} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
                  <div className="min-w-0 flex-1"><p className="font-medium">{s.fullName}</p><p className="text-xs text-muted-foreground">{divisionLabel(s.section)} · Roll {s.rollNo ?? '—'} {s.grNo ? ` · GR ${s.grNo}` : ''}</p></div>
                  <span className="text-sm text-primary">Select →</span>
                </button>
              </li>
            ))}
            {!found.data.data.length && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No student found</li>}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StepChip({ n, label, active, done, onClick }: { n: number; label: string; active: boolean; done: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className={cn('grid size-5 place-items-center rounded-full text-[11px] font-bold', active ? 'bg-primary text-primary-foreground' : done ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground')}>{done ? '✓' : n}</span>
      <span className={cn(active ? 'font-semibold' : 'text-muted-foreground')}>{label}</span>
    </>
  );
  return onClick && (done || active)
    ? <button type="button" onClick={onClick} className="flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-muted">{body}</button>
    : <span className="flex items-center gap-1.5 px-2 py-1">{body}</span>;
}

/** Step 3: every student of the division in roll order, with a filter box. */
function DivisionStudents({ sectionId, title, onPick }: { sectionId: number; title: string; onPick: (id: number) => void }) {
  const { yearId } = useWorkingContext();
  const [filter, setFilter] = useState('');
  const list = useQuery({ queryKey: ['students', 'division', sectionId, yearId], queryFn: () => api.get<Page<StudentRow>>(`/students${qs({ academicYearId: yearId, sectionId, pageSize: 100 })}`) });
  const f = filter.trim().toLowerCase();
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="flex-1 font-semibold">3. Choose the student · {title}</h2>
        <Input aria-label="Filter students" className="w-56" placeholder="Filter by name or roll no" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <QueryView query={list}>
        {(d) => {
          const rows = d.data.filter((s) => !f || s.fullName.toLowerCase().includes(f) || String(s.rollNo ?? '') === f || (s.grNo ?? '').toLowerCase().includes(f));
          return rows.length ? (
            <ul className="grid gap-1 sm:grid-cols-2">
              {rows.map((s) => (
                <li key={s.id}>
                  <button onClick={() => onPick(s.id)} className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:border-primary hover:bg-primary/5">
                    <span className="w-8 text-right text-sm tabular-nums text-muted-foreground">{s.rollNo ?? '—'}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.fullName}</span><span className="text-xs text-muted-foreground">{s.grNo ? `GR ${s.grNo}` : ''}{s.primaryContact?.mobile ? ` · ${s.primaryContact.mobile}` : ''}</span></span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No student matches" />;
        }}
      </QueryView>
    </Card>
  );
}

/** What the office checks before taking money: is this the right child, and who is the parent. */
function StudentDetailsCard({ studentId, onChange }: { studentId: string; onChange: () => void }) {
  const q = useQuery({ queryKey: ['students', 'detail', studentId], queryFn: () => api.get<StudentDetail>(`/students/${studentId}`) });
  const s = q.data;
  if (!s) return <Card className="h-32 animate-pulse p-4" />;
  const parent = s.guardians.find((g) => g.isPrimary) ?? s.guardians[0];
  const father = s.guardians.find((g) => g.relation === 'FATHER');
  const mother = s.guardians.find((g) => g.relation === 'MOTHER');
  const c = s.current;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-4">
        <StudentAvatar name={s.fullName} studentId={s.id} photoFileId={s.photoFileId} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-semibold">{s.fullName}</p>
            {s.isRte && <Badge variant="secondary">RTE</Badge>}
            {s.status === 'PENDING_APPROVAL' ? <Badge variant="warning">Provisional: waiting for the Headmaster</Badge> : s.status !== 'ACTIVE' && <Badge variant="destructive">{s.status.toLowerCase()}</Badge>}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
            <Detail k="Class" v={divisionLabel(c.section)} />
            <Detail k="Roll No" v={c.rollNo ?? '—'} />
            <Detail k="GR No" v={<span className="font-mono">{s.grNo ?? ''}</span>} />
            <Detail k="Father" v={father?.name ?? s.fatherName ?? '—'} />
            <Detail k="Mother" v={mother?.name ?? s.motherName ?? '—'} />
            <Detail k={`Contact${parent ? ` (${parent.relation.toLowerCase()})` : ''}`} v={parent?.mobile ? <a href={`tel:${parent.mobile}`} className="text-primary hover:underline">{parent.mobile}</a> : '—'} />
            {s.siblings.length > 0 && <div className="col-span-full"><Detail k="Brothers / sisters in school" v={s.siblings.map((x) => `${x.fullName}${x.section ? ` (${divisionLabel(x.section)})` : ''}`).join(', ')} /></div>}
          </dl>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" asChild><Link to={`/fees/student/${s.id}`}>Full fee account</Link></Button>
          <Button variant="outline" size="sm" asChild><Link to={`/students/${s.id}`}>Student profile</Link></Button>
          <Button variant="ghost" size="sm" onClick={onChange}><ArrowLeft /> Change student</Button>
        </div>
      </div>
    </Card>
  );
}

function Detail({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="truncate font-medium">{v}</dd></div>;
}

function CollectForm({ studentId, onChange }: { studentId: string; onChange: () => void }) {
  const navigate = useNavigate();
  const q = useAccount(studentId);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [reference, setReference] = useState('');
  const [payerName, setPayerName] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [remarks, setRemarks] = useState('');
  const [manualNo, setManualNo] = useState('');
  const [saving, setSaving] = useState(false);
  const { me } = useAuth();
  const backdated = paidOn < todayIso();
  useEffect(() => { if (q.data?.student.contact?.name && !payerName) setPayerName(q.data.student.contact.name); }, [q.data, payerName]);
  const a = q.data;
  const amt = Number(amount) || 0;
  // Same rule as the server: the previous year's outstanding is cleared first.
  const split = useMemo(() => {
    if (!a) return { previous: 0, current: 0 };
    const previous = round2(Math.min(a.ledger.previousStillDue, amt));
    return { previous, current: round2(amt - previous) };
  }, [a, amt]);
  const balanceAfter = a ? round2(a.ledger.balance - amt) : 0;
  const tooMuch = !!a && amt > a.ledger.balance + 0.001;
  const needRef = MODES_NEEDING_REFERENCE.includes(mode);
  const submit = async () => {
    if (!a) return;
    setSaving(true);
    try {
      const r = await api.post<{ id: number }>('/fees/payments', { enrollmentId: a.enrollmentId, paidOn, amount: amt, mode, reference: reference || null, payerName: payerName || null, remarks: remarks || null, manualReceiptNo: backdated ? manualNo.trim() : manualNo.trim() || null });
      toast.success('Payment saved');
      navigate(`/fees/receipts/${r.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid gap-5">
      <StudentDetailsCard studentId={studentId} onChange={onChange} />
      <QueryView query={q}>
        {(acct) => (
          <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
            <Card className="h-fit overflow-hidden">
              <div className="flex items-center justify-between border-b px-5 py-4"><h2 className="font-semibold">Fee ledger · {acct.year.name}</h2><Button variant="ghost" size="sm" asChild><Link to={`/fees/student/${acct.student.id}`}>Full ledger and receipts</Link></Button></div>
              <LedgerTable l={acct.ledger} />
              {!acct.ledger.canCollect && <p className="border-t bg-amber-50 px-5 py-3 text-sm text-amber-950">This year is closed: its balance was carried forward to {acct.ledger.carriedTo}. Switch the year at the top to {acct.ledger.carriedTo} to collect.</p>}
            </Card>

            <Card className="sticky top-20 h-fit p-5">
              <h2 className="mb-4 font-semibold">Payment</h2>
              {acct.ledger.balance <= 0 ? <EmptyState icon={CheckCircle2} title="Nothing to pay: fully paid" /> : (
                <div className="grid gap-4">
                  <Field label="Amount received today (₹)" htmlFor="am" required error={tooMuch ? `More than the balance (${rupees(acct.ledger.balance)})` : undefined}>
                    <Input id="am" autoFocus inputMode="decimal" className="h-14 text-2xl font-semibold tabular-nums" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
                  </Field>
                  <div className="flex flex-wrap gap-1.5">
                    {acct.ledger.previousStillDue > 0 && <Button size="sm" variant="outline" onClick={() => setAmount(String(acct.ledger.previousStillDue))}>Previous year {rupees(acct.ledger.previousStillDue)}</Button>}
                    <Button size="sm" variant="outline" onClick={() => setAmount(String(acct.ledger.balance))}>Full balance {rupees(acct.ledger.balance)}</Button>
                  </div>
                  <Field label="Payment mode" htmlFor="pm"><Select id="pm" value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}</Select></Field>
                  {needRef && <Field label={mode === 'CHEQUE' ? 'Cheque number' : mode === 'UPI' ? 'UPI transaction ID (UTR)' : 'Reference number'} htmlFor="rf" required><Input id="rf" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Payment date" htmlFor="dt"><Input id="dt" type="date" max={todayIso()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
                    <Field label="Paid by (name)" htmlFor="pn"><Input id="pn" value={payerName} onChange={(e) => setPayerName(e.target.value)} /></Field>
                  </div>
                  {backdated ? (
                    <Field label="Manual receipt number" htmlFor="mrn" required hint="The payment date is before today: enter the number of the paper receipt given to the parent">
                      <Input id="mrn" className="border-amber-400" value={manualNo} onChange={(e) => setManualNo(e.target.value)} placeholder="e.g. MAN-1025" />
                    </Field>
                  ) : (
                    <Field label="Manual receipt number (optional)" htmlFor="mrn"><Input id="mrn" value={manualNo} onChange={(e) => setManualNo(e.target.value)} /></Field>
                  )}
                  <p className="text-xs text-muted-foreground">System receipt number: generated when you save · Entered by {me?.username} · {backdated ? 'backdated entry' : 'today'}</p>
                  <Field label="Remarks" htmlFor="rm"><Input id="rm" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
                  <div className="rounded-xl bg-muted/50 p-4 text-sm">
                    <div className="flex justify-between"><span>Balance now</span><Money value={acct.ledger.balance} /></div>
                    <div className="flex justify-between text-emerald-700"><span>Paid today</span><span className="tabular-nums">− {rupees(amt)}</span></div>
                    {amt > 0 && split.previous > 0 && <p className="mt-1 text-xs text-muted-foreground">{rupees(split.previous)} clears previous year{split.current > 0 ? `, ${rupees(split.current)} goes to ${acct.year.name}` : ''}</p>}
                    <div className="mt-2 flex justify-between border-t pt-2 text-base font-semibold"><span>Remaining balance</span><Money value={Math.max(0, balanceAfter)} className={balanceAfter <= 0 ? 'text-emerald-700' : ''} /></div>
                  </div>
                  <Button size="lg" className="h-12 text-base" loading={saving} disabled={!amt || tooMuch || (needRef && !reference.trim()) || (backdated && !manualNo.trim()) || !acct.ledger.canCollect} onClick={submit}><Receipt /> Save and print receipt</Button>
                </div>
              )}
            </Card>
          </div>
        )}
      </QueryView>
    </div>
  );
}

// ======================================================================= receipt

interface ReceiptData {
  id: number; receiptNo: string; manualReceiptNo: string | null; isBackdated: boolean; paidOn: string; amount: number; amountInWords: string; mode: PaymentMode; reference: string | null; payerName: string | null; remarks: string | null;
  status: string; cancelReason: string | null; createdAt: string; receivedBy: string | null;
  instalments: { label: string; dueOn: string; total: number; paid: number; balance: number }[] | null;
  ledger: { previousOutstanding: number; currentYearFee: number; concession: number; currentYearNet: number; penalty: number; totalPayable: number; paidBefore: number; paidToday: number; totalPaid: number; balanceAfter: number };
  student: { id: number; fullName: string; studentCode: string; grNo: string; provisional: boolean; rollNo: number | null; section: { name: string; schoolClass: { displayName: string } }; year: string };
  school: { name: string; nameHi: string | null; address: string; phone: string | null; logoFileId: number | null };
}

export function ReceiptPage() {
  const { id } = useParams();
  const logo = useSchoolLogo();
  const q = useQuery({ queryKey: ['fees', 'receipt', id], queryFn: () => api.get<ReceiptData>(`/fees/payments/${id}`) });
  return (
    <>
      <div className="mb-4 flex items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
        <Button size="sm" className="ml-auto" onClick={() => window.print()}><Printer /> Print receipt</Button>
      </div>
      <QueryView query={q}>
        {(r) => {
          const L = r.ledger;
          const row = (label: string, value: string, opts: { strong?: boolean; big?: boolean } = {}) => (
            <tr className={cn(opts.strong && 'font-bold', opts.big && 'text-base')}>
              <td className="border border-black px-2 py-1">{label}</td>
              <td className="border border-black px-2 py-1 text-right tabular-nums">{value}</td>
            </tr>
          );
          const inr = (n: number) => `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          return (
            <div className="relative mx-auto max-w-[148mm] overflow-hidden rounded-2xl border bg-white p-7 text-black shadow-card print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
              {r.status === 'CANCELLED' && <div className="pointer-events-none absolute inset-0 grid place-items-center"><span className="-rotate-30 text-7xl font-black tracking-widest text-red-600/20">CANCELLED</span></div>}
              <header className="flex items-center gap-4 border-b-2 border-black pb-3">
                {logo.data && <img src={logo.data} alt="" className="h-16 w-20 object-contain" />}
                <div className="flex-1 text-center">
                  <h1 className="text-2xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>{r.school.name}</h1>
                  <p className="text-xs">{r.school.address}{r.school.phone ? ` · ${r.school.phone}` : ''}</p>
                  <p className="mt-1 text-sm font-semibold tracking-wider uppercase">Fee receipt</p>
                </div>
              </header>
              <div className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                <p>System receipt No.: <b className="font-mono">{r.receiptNo}</b></p>
                <p className="text-right">Payment date: <b>{formatDate(r.paidOn)}</b></p>
                {r.manualReceiptNo && <p>Manual receipt No.: <b className="font-mono">{r.manualReceiptNo}</b></p>}
                {r.manualReceiptNo && <p className="text-right">{r.isBackdated ? 'Backdated entry' : ''}</p>}
                <p className="col-span-2">Student name: <b>{r.student.fullName}</b></p>
                <p>Student ID: <b className="font-mono">{r.student.studentCode}</b></p>
                <p className="text-right">Academic year: <b>{r.student.year}</b></p>
                <p>Admission No. (G.R.): <b>{r.student.grNo ?? ''}</b></p>
                <p />
                <p>Class: <b>{r.student.section.schoolClass.displayName} {r.student.section.name}</b> · Roll <b>{r.student.rollNo ?? '—'}</b></p>
                {r.payerName && <p className="text-right">Received from: <b>{r.payerName}</b></p>}
              </div>
              <table className="mt-4 w-full border-collapse border border-black text-sm">
                <tbody>
                  {row('Previous year outstanding', inr(L.previousOutstanding))}
                  {row('Current year fees', inr(L.currentYearFee))}
                  {L.concession > 0 && row('Less: discount', `− ${inr(L.concession)}`)}
                  {L.penalty > 0 && row('Late fee', inr(L.penalty))}
                  {row('Total payable', inr(L.totalPayable), { strong: true })}
                  {L.paidBefore > 0 && row('Paid earlier this year', `− ${inr(L.paidBefore)}`)}
                  {row('Fees paid today', inr(L.paidToday), { strong: true, big: true })}
                  {row('Remaining balance', L.balanceAfter > 0 ? inr(L.balanceAfter) : 'NIL (fully paid)', { strong: true })}
                </tbody>
              </table>
              {r.instalments && (
                <table className="mt-3 w-full border-collapse border border-black text-xs">
                  <thead><tr><th className="border border-black px-2 py-0.5 text-left">Due date</th><th className="border border-black px-2 py-0.5 text-left">On or before</th><th className="border border-black px-2 py-0.5 text-right">Amount due</th><th className="border border-black px-2 py-0.5 text-right">Still due</th></tr></thead>
                  <tbody>
                    {r.instalments.map((x) => (
                      <tr key={x.label}>
                        <td className="border border-black px-2 py-0.5">{x.label}</td>
                        <td className="border border-black px-2 py-0.5">{formatDate(x.dueOn)}</td>
                        <td className="border border-black px-2 py-0.5 text-right tabular-nums">{inr(x.total)}</td>
                        <td className="border border-black px-2 py-0.5 text-right tabular-nums">{x.balance > 0 ? inr(x.balance) : 'Paid'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-sm">Amount received today in words: <b>{r.amountInWords}</b></p>
              <p className="text-sm">Payment mode: <b>{PAYMENT_MODE_LABELS[r.mode]}</b>{r.reference ? <> · Transaction ref. <b className="font-mono">{r.reference}</b></> : null}</p>
              {r.remarks && <p className="text-sm">Remarks: {r.remarks}</p>}
              {r.status === 'CANCELLED' && <p className="mt-2 text-sm font-semibold text-red-700">This receipt was cancelled: {r.cancelReason}</p>}
              <footer className="mt-10 flex items-end justify-between text-sm">
                <p className="text-xs text-gray-600">Received by {r.receivedBy ?? '—'} · entered in the system {formatDateTime(r.createdAt)}</p>
                <p className="border-t border-black px-6 pt-1">Cashier / Office signature</p>
              </footer>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

export function useFeeAccount(studentId?: number | null, enabled = true) {
  const { yearId } = useWorkingContext();
  return useQuery({ queryKey: ['fees', 'account', String(studentId), yearId], queryFn: () => api.get<Account>(`/fees/students/${studentId}${qs({ academicYearId: yearId })}`), enabled: !!studentId && enabled, retry: false });
}
