import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, rupees } from '@cps/shared';
import {
  ArrowRight, BarChart3, BookCheck, CalendarClock, Check, CheckCircle2, ClipboardList, FileText, GraduationCap, History, IndianRupee, Receipt, ShieldAlert,
  UserCog, UserPlus, Users, UsersRound, Wallet, ListChecks, CalendarCheck } from 'lucide-react';
import { Link } from 'react-router';
import { useSave } from '@/components/common';
import { roleSummary, useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { TODO_TONE, type TodoItem, useStudentsOverview, useTodo } from './dashboard';
import { useFeeSummary } from './fees';
import { useTasks } from './workflow-ui';

const P = PERMISSIONS;

interface Item { id: number; title: string; detail: string; by: string | null; at: string; amount?: number; isRte?: boolean }
interface Overview {
  today: string;
  approvals: {
    admissions?: { count: number; oldest: string | null; items: Item[] };
    promotions?: { count: number; oldest: string | null; items: (Item & { sectionId: number })[] };
    vouchers?: { count: number; amount: number; oldest: string | null; salaries: { count: number; amount: number }; items: Item[] };
    staff?: { count: number; oldest: string | null; items: Item[] };
    reportCards?: { count: number };
  };
  fees?: { today: number; todayReceipts: number; todayByMode: { mode: string; label: string; amount: number }[]; month: number; monthReceipts: number; backdatedLastDay: number; cancelledLastDay: number };
  expenses?: { month: number; monthVouchers: number; today: number };
  admissions?: { thisMonth: number; thisYear: number };
  activity?: { id: number; at: string; action: string; entityType: string; entityId: number | null; by: string | null; reason: string | null; after: Record<string, unknown> | null }[];
}

/** "3 days", "5 hours", "just now" — how long something has been waiting. */
function ago(iso: string | null | undefined) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''}`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? 's' : ''}`;
}

export function HeadmasterDashboard() {
  const { me, can } = useAuth();
  const { year } = useWorkingContext();
  const logo = useSchoolLogo();
  const q = useQuery({ queryKey: ['dashboard', 'overview'], queryFn: () => api.get<Overview>('/dashboard/overview'), refetchInterval: 60_000 });
  const tasks = useTasks();
  const students = useStudentsOverview();
  const fees = useFeeSummary(can(P.FEES_READ));
  const d = q.data;
  const a = d?.approvals ?? {};
  const academic = (tasks.data?.review ?? 0);
  const todo = useTodo();
  const todoItems = todo.data?.items ?? [];
  const listItems = todoItems.filter((i) => i.group === 'Class list' || i.group === 'Exam Nos');
  const waitingTasks = (tasks.data?.items ?? []).filter((t) => t.status === 'SUBMITTED');
  const marksWaiting = waitingTasks.filter((t) => t.recordType === 'MARKS').length;
  const attendanceWaiting = waitingTasks.filter((t) => t.recordType === 'ATTENDANCE').length;
  const total = (a.admissions?.count ?? 0) + (a.promotions?.count ?? 0) + (a.vouchers?.count ?? 0) + (a.staff?.count ?? 0) + (a.reportCards?.count ?? 0) + academic + todoItems.length;
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const todayText = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

  return (
    <div className="grid gap-6">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-4">
        {logo.data && <img src={logo.data} alt="" className="size-14 rounded-2xl border bg-white object-contain p-1" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{todayText}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting}, {me?.staff?.name ?? me?.username}</h1>
          <p className="text-sm text-muted-foreground">{roleSummary(me?.roles)}{year && <> · Academic year {year.name}</>}</p>
        </div>
        <div className={cn('rounded-2xl px-5 py-3 text-center', total ? 'bg-amber-100 text-amber-950' : 'bg-emerald-50 text-emerald-800')}>
          <p className="text-3xl font-bold tabular-nums">{total}</p>
          <p className="text-xs font-medium">{total ? 'waiting for your approval' : 'nothing waiting'}</p>
        </div>
      </header>

      {/* Approvals centre */}
      <section aria-labelledby="appr" className="grid gap-3">
        <h2 id="appr" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Needs your approval</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {a.admissions && <ApprovalTile icon={UserPlus} title="Provisional admissions" count={a.admissions.count} sub={a.admissions.count ? `to confirm · oldest ${ago(a.admissions.oldest)}` : 'all confirmed'} to="/students?status=PENDING_APPROVAL" />}
          {a.promotions && <ApprovalTile icon={GraduationCap} title="Promotions to verify" count={a.promotions.count} sub={a.promotions.count ? `oldest waiting ${ago(a.promotions.oldest)}` : 'none waiting'} to="/promotion" />}
          <ApprovalTile icon={ListChecks} title="Class lists & Exam Nos" count={listItems.length} sub={listItems.length ? listItems.map((i) => i.title.replace(/^(Finalize the class list of|Generate the Exam Nos of|Check and confirm the class list of) /, '')).slice(0, 3).join(', ') + (listItems.length > 3 ? ' …' : '') : 'nothing waiting'} to="/class-lists?show=MINE" />
          {a.vouchers && <ApprovalTile icon={Receipt} title="Expense vouchers" count={a.vouchers.count} sub={a.vouchers.count ? `${rupees(a.vouchers.amount)}${a.vouchers.salaries.count ? ` · ${a.vouchers.salaries.count} salary` : ''}` : 'all decided'} to="/vouchers?status=PENDING" />}
          {can(P.MARKS_APPROVE) && <ApprovalTile icon={BookCheck} title="Marks" count={marksWaiting} sub={marksWaiting ? 'mark sheets ready for final approval' : 'all approved'} to="/approvals?type=MARKS" />}
          {(can(P.MARKS_APPROVE) || can(P.ATTENDANCE_VERIFY)) && <ApprovalTile icon={CalendarCheck} title="Attendance" count={attendanceWaiting} sub={attendanceWaiting ? 'monthly attendance ready for final approval' : 'all approved'} to="/approvals?type=ATTENDANCE" />}
          {a.staff && <ApprovalTile icon={UserCog} title="New staff to assign" count={a.staff.count} sub={a.staff.count ? 'designation, department, activate' : 'none pending'} to="/staff?status=PENDING_ASSIGNMENT" />}
          {a.reportCards && <ApprovalTile icon={FileText} title="Report cards to publish" count={a.reportCards.count} sub={a.reportCards.count ? 'generated, not yet published' : 'none waiting'} to="/report-cards" />}
        </div>
        <WaitingList d={d} tasks={tasks.data?.items ?? []} todo={todoItems} />
      </section>

      {/* Money and students */}
      <div className="grid gap-4 lg:grid-cols-2">
        {(d?.fees || d?.expenses) && (
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Money</h2><Link to="/reports/day-wise-collection" className="text-sm text-primary hover:underline">Day-wise collection</Link></div>
            <div className="grid grid-cols-2 gap-4">
              {d.fees && <Figure icon={IndianRupee} label="Fees collected today" value={rupees(d.fees.today)} sub={`${d.fees.todayReceipts} receipts`} tone="ok" />}
              {d.expenses && <Figure icon={Wallet} label="Expenses approved today" value={rupees(d.expenses.today)} />}
              {d.fees && <Figure icon={IndianRupee} label="Fees this month" value={rupees(d.fees.month)} sub={`${d.fees.monthReceipts} receipts`} />}
              {d.expenses && <Figure icon={Receipt} label="Expenses this month" value={rupees(d.expenses.month)} sub={`${d.expenses.monthVouchers} approved vouchers`} />}
            </div>
            {d.fees && d.fees.todayByMode.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 text-xs">{d.fees.todayByMode.map((m) => <span key={m.mode} className="rounded-full bg-muted px-2.5 py-1">{m.label}: <b className="tabular-nums">{rupees(m.amount)}</b></span>)}</div>
            )}
            {d.fees && d.expenses && <p className="mt-4 border-t pt-3 text-sm">This month: fees − approved expenses = <b className={cn('tabular-nums', d.fees.month - d.expenses.month < 0 && 'text-red-700')}>{rupees(d.fees.month - d.expenses.month)}</b></p>}
            {d.fees && (d.fees.backdatedLastDay > 0 || d.fees.cancelledLastDay > 0) && (
              <div className="mt-3 grid gap-1.5 text-sm">
                {d.fees.backdatedLastDay > 0 && <Link to="/reports/backdated-fees" className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-950 hover:bg-amber-100"><CalendarClock className="size-4" /> {d.fees.backdatedLastDay} backdated receipt{d.fees.backdatedLastDay > 1 ? 's' : ''} entered in the last 24 hours <ArrowRight className="ml-auto size-4" /></Link>}
                {d.fees.cancelledLastDay > 0 && <Link to="/fees?tab=receipts" className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-red-900 hover:bg-red-100"><ShieldAlert className="size-4" /> {d.fees.cancelledLastDay} receipt{d.fees.cancelledLastDay > 1 ? 's' : ''} cancelled in the last 24 hours <ArrowRight className="ml-auto size-4" /></Link>}
              </div>
            )}
          </Card>
        )}
        {students.data && (
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Students · {students.data.year.name}</h2><Link to="/reports/school-at-a-glance" className="text-sm text-primary hover:underline">School at a glance</Link></div>
            <div className="grid grid-cols-2 gap-4">
              <Figure icon={UsersRound} label="Studying" value={students.data.totals.students.toLocaleString('en-IN')} sub={`${students.data.totals.boys} male · ${students.data.totals.girls} female`} />
              {d?.admissions && <Figure icon={UserPlus} label="New admissions" value={String(d.admissions.thisYear)} sub={`${d.admissions.thisMonth} this month`} />}
            </div>
            <div className="mt-4 grid gap-3">
              {students.data.byMedium.map((m) => {
                const pct = students.data.totals.students ? Math.round((m.students / students.data.totals.students) * 100) : 0;
                return (
                  <Link key={m.code} to={`/students?medium=${m.code}`} className="block rounded-lg hover:bg-muted/40">
                    <div className="flex justify-between text-sm"><span className="font-medium">{m.name}</span><span className="tabular-nums text-muted-foreground">{m.students} students · {m.divisions} divisions</span></div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} /></div>
                  </Link>
                );
              })}
            </div>
          </Card>
        )}
      </div>

      {/* Fees for the year */}
      {fees.data && fees.data.totals.totalPayable > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">Fees for {fees.data.year.name}</h2>
            <p className="text-sm text-muted-foreground"><b className="text-foreground">{fees.data.totals.collectedPercent}%</b> collected of {rupees(fees.data.totals.totalPayable)}</p>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, fees.data.totals.collectedPercent)}%` }} /></div>
          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Figure label="Collected" value={rupees(fees.data.totals.paid)} tone="ok" />
            <Figure label="Balance to collect" value={rupees(fees.data.totals.balance)} sub={`${fees.data.totals.studentsWithBalance} students`} to="/reports/pending-fees" />
            <Figure label="Previous year still unpaid" value={rupees(fees.data.totals.previousStillDue)} sub={`${fees.data.totals.studentsWithPrevious} students`} tone={fees.data.totals.previousStillDue ? 'bad' : undefined} to="/fees?tab=register&status=PREVIOUS" />
            <Figure label="Concessions given" value={rupees(fees.data.totals.concession)} />
          </div>
        </Card>
      )}

      {/* Activity and shortcuts */}
      <div className="grid gap-4 lg:grid-cols-3">
        {d?.activity && (
          <Card className="p-5 lg:col-span-2">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><History className="size-4 text-muted-foreground" /> Latest activity</h2>
            <ul className="divide-y">
              {d.activity.map((x) => <ActivityRow key={x.id} x={x} />)}
              {!d.activity.length && <li className="py-3 text-sm text-muted-foreground">Nothing yet.</li>}
            </ul>
            {can(P.AUDIT_READ) && <Link to="/audit" className="mt-2 inline-block text-sm text-primary hover:underline">Full audit log</Link>}
          </Card>
        )}
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Shortcuts</h2>
          <div className="grid gap-1.5">
            {[
              can(P.REPORTS_VIEW) && { to: '/reports', icon: BarChart3, label: 'Reports & analytics' },
              can(P.STUDENTS_READ) && { to: '/classes', icon: GraduationCap, label: 'Classes and divisions' },
              can(P.ASSIGNMENTS_MANAGE) && { to: '/academics/assignments', icon: ClipboardList, label: 'Who teaches what' },
              (can(P.STAFF_READ) || can(P.STAFF_MANAGE)) && { to: '/staff', icon: Users, label: 'Staff' },
              can(P.EXPENSES_READ) && { to: '/vouchers', icon: Receipt, label: 'All vouchers' },
              can(P.FEES_READ) && { to: '/fees', icon: IndianRupee, label: 'Fees overview' },
            ].filter(Boolean).map((s) => {
              const x = s as { to: string; icon: React.ElementType; label: string };
              return <Link key={x.to} to={x.to} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted"><x.icon className="size-4 text-primary" /> {x.label} <ArrowRight className="ml-auto size-4 text-muted-foreground" /></Link>;
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function ApprovalTile({ icon: Icon, title, count, sub, to }: { icon: React.ElementType; title: string; count: number; sub: string; to: string }) {
  return (
    <Link to={to} className="group rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <Card className={cn('h-full p-4 transition-colors', count ? 'border-amber-300 bg-amber-50/70 group-hover:border-amber-400' : 'group-hover:border-primary/40')}>
        <div className="flex items-center justify-between">
          <span className={cn('grid size-9 place-items-center rounded-xl', count ? 'bg-amber-200/70 text-amber-900' : 'bg-emerald-50 text-emerald-700')}>{count ? <Icon className="size-4.5" /> : <CheckCircle2 className="size-4.5" />}</span>
          <span className={cn('text-3xl font-bold tabular-nums', !count && 'text-muted-foreground/60')}>{count}</span>
        </div>
        <p className="mt-3 font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </Card>
    </Link>
  );
}

/** One list of everything waiting, oldest first, with one-click approve for vouchers (admissions are confirmed on the student page with the GR No). */
function WaitingList({ d, tasks, todo }: { d?: Overview; todo: TodoItem[]; tasks: { submissionId: number; recordType: string; stage: string; status: string; since: string; period: string | null; subject: string | null; exam: { nameEn: string } | null; section: { name: string; schoolClass: { displayName: string } } }[] }) {
  const approveVoucher = useSave((id: number) => api.post(`/expenses/${id}/approve`), { invalidate: [['dashboard'], ['expenses']], success: 'Voucher approved' });
  if (!d) return null;
  type Row = { key: string; kind: string; tone: string; title: string; detail: string; by: string | null; at: string; to: string; approve?: () => void; busy?: boolean; amount?: number };
  const rows: Row[] = [
    ...todo.map((i) => ({ key: i.key, kind: i.group, tone: TODO_TONE[i.group] ?? 'bg-muted', title: i.title, detail: i.detail, by: null, at: i.at ?? '', to: i.to })),
    ...(d.approvals.admissions?.items ?? []).map((i) => ({ key: `a${i.id}`, kind: 'Provisional', tone: 'bg-sky-100 text-sky-900', title: i.title, detail: `${i.detail}${i.isRte ? ' · RTE' : ''}`, by: i.by, at: i.at, to: `/students/${i.id}` })), // confirmed on the student's page, where the GR No is entered
    ...(d.approvals.promotions?.items ?? []).map((i) => ({ key: `p${i.id}`, kind: 'Promotion', tone: 'bg-emerald-100 text-emerald-900', title: i.title, detail: i.detail, by: i.by, at: i.at, to: `/classes/${i.sectionId}/promote` })),
    ...(d.approvals.vouchers?.items ?? []).map((i) => ({ key: `v${i.id}`, kind: 'Voucher', tone: 'bg-violet-100 text-violet-900', title: i.title, detail: i.detail, by: i.by, at: i.at, to: `/expenses/${i.id}`, amount: i.amount, approve: () => approveVoucher.mutate(i.id), busy: approveVoucher.isPending })),
    ...(d.approvals.staff?.items ?? []).map((i) => ({ key: `s${i.id}`, kind: 'New staff', tone: 'bg-teal-100 text-teal-900', title: i.title, detail: `${i.detail} · assign and activate`, by: i.by, at: i.at, to: `/staff/${i.id}` })),
    ...tasks.filter((t) => t.status === 'SUBMITTED').slice(0, 6).map((t) => ({
      key: `t${t.submissionId}`, kind: t.recordType === 'MARKS' ? 'Marks' : 'Attendance', tone: 'bg-amber-100 text-amber-900',
      title: `${t.section.schoolClass.displayName} ${t.section.name} · ${t.recordType === 'MARKS' ? `${t.subject ?? ''} ${t.exam ? `(${t.exam.nameEn})` : ''}` : t.period ?? ''}`, detail: 'final approval', by: null, at: t.since, to: '/approvals',
    })),
  ].sort((x, y) => x.at.localeCompare(y.at)).slice(0, 10);
  if (!rows.length) return <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-600" /> Nothing is waiting for you. Everything is approved.</Card>;
  return (
    <Card className="overflow-hidden">
      <div className="border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">Oldest first</div>
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
            <span className={cn('w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium', r.tone)}>{r.kind}</span>
            <Link to={r.to} className="min-w-0 flex-1 hover:text-primary">
              <span className="block truncate font-medium">{r.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{[r.detail, r.by && `by ${r.by}`, r.at && `waiting ${ago(r.at)}`].filter(Boolean).join(' · ')}</span>
            </Link>
            {r.amount !== undefined && <span className="font-semibold tabular-nums">{rupees(r.amount)}</span>}
            <div className="flex gap-1.5">
              {r.approve && <Button size="sm" onClick={r.approve} loading={r.busy}><Check /> Approve</Button>}
              <Button size="sm" variant="outline" asChild><Link to={r.to}>{r.kind === 'Provisional' ? 'Open to confirm' : 'Open'}</Link></Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Figure({ icon: Icon, label, value, sub, tone, to }: { icon?: React.ElementType; label: string; value: string; sub?: string; tone?: 'ok' | 'bad'; to?: string }) {
  const body = (
    <div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{Icon && <Icon className="size-3.5" />}{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'ok' && 'text-emerald-700', tone === 'bad' && 'text-red-700')}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
  return to ? <Link to={to} className="rounded-lg hover:bg-muted/40">{body}</Link> : body;
}

const ACT: Record<string, Record<string, string>> = {
  Student: { CREATE: 'Provisional admission entered', APPROVE: 'Admission confirmed', REJECT: 'Admission rejected', STATUS: 'Student status changed' },
  Expense: { CREATE: 'Voucher created', APPROVE: 'Voucher approved', REJECT: 'Voucher rejected', CANCEL: 'Voucher cancelled' },
  FeePayment: { COLLECT: 'Fee collected', CANCEL: 'Receipt cancelled' },
  Staff: { CREATE: 'Staff registered', STATUS: 'Staff status changed' },
  StudentFeeLedger: { CONCESSION: 'Concession given' },
};
function ActivityRow({ x }: { x: NonNullable<Overview['activity']>[number] }) {
  const label = ACT[x.entityType]?.[x.action] ?? `${x.entityType} ${x.action.toLowerCase()}`;
  const after = x.after ?? {};
  const extra = x.entityType === 'FeePayment' ? [after.receiptNo, typeof after.amount === 'number' ? rupees(after.amount) : null].filter(Boolean).join(' · ')
    : x.entityType === 'Expense' ? [after.voucherNo, typeof after.amount === 'number' ? rupees(after.amount) : null].filter(Boolean).join(' · ')
      : x.entityType === 'Student' ? String(after.fullName ?? after.grNo ?? '') : '';
  const to = x.entityId == null ? null : x.entityType === 'Student' ? `/students/${x.entityId}` : x.entityType === 'Expense' ? `/expenses/${x.entityId}` : x.entityType === 'FeePayment' ? `/fees/receipts/${x.entityId}` : x.entityType === 'Staff' ? `/staff/${x.entityId}` : null;
  const body = (
    <>
      <span className="min-w-0 flex-1"><span className="font-medium">{label}</span>{extra && <span className="text-muted-foreground"> · {extra}</span>}{x.reason && <span className="block truncate text-xs text-muted-foreground">{x.reason}</span>}</span>
      <span className="shrink-0 text-right text-xs text-muted-foreground">{x.by ?? 'system'}<span className="block">{ago(x.at) === 'just now' ? 'just now' : `${ago(x.at)} ago`}</span></span>
    </>
  );
  return <li>{to ? <Link to={to} className="flex items-center gap-3 py-2 text-sm hover:text-primary">{body}</Link> : <div className="flex items-center gap-3 py-2 text-sm">{body}</div>}</li>;
}
