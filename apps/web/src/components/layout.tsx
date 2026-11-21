import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, type PermissionCode } from '@cps/shared';
import {
  Ban, BarChart3, BookCheck, CalendarCheck, CalendarClock, CheckCircle2, ClipboardCheck, ClipboardList, FileSpreadsheet, FileText, GraduationCap, Home, Hourglass, IndianRupee, KeyRound, LogOut, Menu, Plus, Receipt, School, UserCheck, Sheet, TrendingUp, ListChecks, ScrollText, Search, Settings, Tags, UserCog, UserPlus, Users, UsersRound, Wallet, X, XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext, useYears } from '@/lib/hooks';
import { useTasks } from '@/features/workflow-ui';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input, Select } from './ui/form-controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/overlay';

interface NavItem { to: string; label: string; icon: React.ElementType; perm?: PermissionCode | PermissionCode[]; soon?: boolean; hint?: string; badge?: boolean }
interface NavGroup { label?: string; items: NavItem[] }

const P = PERMISSIONS;

/** The menu is grouped by what people DO, not by database table. Setup screens live on one Setup page. */
function useNav(): NavGroup[] {
  const { t } = useTranslation();
  return [
    { items: [{ to: '/', label: t('nav.home'), icon: Home }] },
    {
      label: t('nav.daily'),
      items: [
        { to: '/students', label: t('nav.students'), icon: UsersRound, perm: P.STUDENTS_READ },
        { to: '/classes', label: t('nav.classes'), icon: GraduationCap, perm: P.STUDENTS_READ },
        { to: '/students?status=PENDING_APPROVAL', label: t('nav.admissionApprovals'), icon: UserCheck, perm: P.STUDENTS_ADMISSION_APPROVE },
        { to: '/class-lists', label: t('nav.classLists'), icon: ListChecks, perm: P.STUDENTS_READ },
        { to: '/promotion', label: t('nav.promotion'), icon: TrendingUp, perm: [P.STUDENTS_PROMOTE, P.STUDENTS_WRITE] },
        { to: '/academics/assignments', label: t('nav.assignments'), icon: ClipboardList, perm: P.STAFF_READ },
      ],
    },
    {
      label: t('nav.academic'),
      items: [
        { to: '/attendance', label: t('nav.attendance'), icon: CalendarCheck, perm: [P.ATTENDANCE_MARK, P.ATTENDANCE_VERIFY, P.ATTENDANCE_CORRECT_APPROVE] },
        { to: '/marks', label: t('nav.exams'), icon: BookCheck, perm: P.MARKS_READ },
        { to: '/approvals', label: t('nav.approvals'), icon: ClipboardCheck, perm: [P.MARKS_READ, P.ATTENDANCE_VERIFY], badge: true },
        { to: '/report-cards', label: t('nav.reportCards'), icon: FileText, perm: [P.MARKS_READ, P.REPORTCARDS_GENERATE] },
        { to: '/greensheet', label: t('nav.greensheet'), icon: FileSpreadsheet, perm: P.MARKS_READ },
        { to: '/performance', label: t('nav.performance'), icon: TrendingUp, perm: P.MARKS_READ },
        { to: '/monthly-performance', label: t('nav.monthly'), icon: ListChecks, perm: P.MARKS_READ },
        { to: '/blank-mark-sheets', label: t('nav.blankSheets'), icon: Sheet, perm: P.EXAMS_MANAGE },
      ],
    },
    {
      label: t('nav.office'),
      items: [
        { to: '/fees', label: t('nav.fees'), icon: IndianRupee, perm: P.FEES_READ },
        { to: '/fees/collect', label: t('nav.collect'), icon: Wallet, perm: P.FEES_COLLECT },
        { to: '/reports/backdated-fees', label: t('nav.backdated'), icon: CalendarClock, perm: P.FEES_EDIT },
      ],
    },
    {
      label: t('nav.staffGroup'),
      items: [
        { to: '/staff', label: t('nav.staffList'), icon: Users, perm: [P.STAFF_READ, P.STAFF_REGISTER, P.STAFF_MANAGE] },
        { to: '/staff/new', label: t('nav.addStaff'), icon: UserPlus, perm: [P.STAFF_REGISTER, P.STAFF_MANAGE] },
        { to: '/reports#staff', label: t('nav.staffReports'), icon: BarChart3, perm: [P.STAFF_READ, P.STAFF_REGISTER, P.STAFF_MANAGE] },
      ],
    },
    {
      label: t('nav.expenseGroup'),
      items: [
        { to: '/expenses/new', label: t('nav.addExpense'), icon: Plus, perm: P.EXPENSES_CREATE },
        { to: '/expenses', label: t('nav.expenseList'), icon: FileText, perm: [P.EXPENSES_CREATE, P.EXPENSES_READ] },
        { to: '/expenses/categories', label: t('nav.expenseCategories'), icon: Tags, perm: [P.EXPENSE_CATEGORIES_MANAGE, P.EXPENSES_READ] },
        { to: '/reports#expense', label: t('nav.expenseReports'), icon: BarChart3, perm: P.EXPENSES_READ },
      ],
    },
    {
      label: t('nav.voucherGroup'),
      items: [
        { to: '/vouchers', label: t('nav.allVouchers'), icon: Receipt, perm: [P.EXPENSES_CREATE, P.EXPENSES_READ] },
        { to: '/vouchers?status=PENDING', label: t('nav.pendingVouchers'), icon: Hourglass, perm: [P.EXPENSES_CREATE, P.EXPENSES_READ] },
        { to: '/vouchers?status=APPROVED', label: t('nav.approvedVouchers'), icon: CheckCircle2, perm: [P.EXPENSES_CREATE, P.EXPENSES_READ] },
        { to: '/vouchers?status=REJECTED', label: t('nav.rejectedVouchers'), icon: XCircle, perm: [P.EXPENSES_CREATE, P.EXPENSES_READ] },
        { to: '/vouchers?status=CANCELLED', label: t('nav.cancelledVouchers'), icon: Ban, perm: [P.EXPENSES_CREATE, P.EXPENSES_READ] },
      ],
    },
    {
      label: t('nav.reportsGroup'),
      items: [{ to: '/reports', label: t('nav.reports'), icon: BarChart3, perm: [P.REPORTS_VIEW, P.FEES_READ, P.EXPENSES_READ, P.STAFF_READ, P.STAFF_REGISTER] }],
    },
    {
      label: t('nav.admin'),
      items: [
        { to: '/setup', label: t('nav.setup'), icon: Settings, perm: [P.SETTINGS_READ, P.ACADEMICS_MANAGE] },
        { to: '/users', label: t('nav.users'), icon: UserCog, perm: P.USERS_MANAGE },
        { to: '/audit', label: t('nav.audit'), icon: ScrollText, perm: P.AUDIT_READ },
      ],
    },
  ];
}

export function useSchoolLogo() {
  const { me } = useAuth();
  const fileId = me?.school.logoFileId;
  return useQuery({
    queryKey: ['file', fileId],
    queryFn: async () => URL.createObjectURL(await api.get<Blob>(`/files/${fileId}/content`)),
    enabled: !!fileId,
    staleTime: Infinity,
  });
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can, me } = useAuth();
  const logo = useSchoolLogo();
  const tasks = useTasks();
  const pending = (tasks.data?.review ?? 0) + (tasks.data?.corrections ?? 0);
  const allowed = (i: NavItem) => !i.perm || (Array.isArray(i.perm) ? i.perm.some((p) => can(p)) : can(i.perm));
  const groups = useNav()
    .map((g) => ({ ...g, items: g.items.filter((i) => i.soon || allowed(i)) }))
    .filter((g) => g.items.length);
  // Highlight one item only: links with ?query must match exactly; otherwise the most specific path wins.
  const loc = useLocation();
  const paths = groups.flatMap((g) => g.items.map((i) => i.to)).filter((to) => !/[?#]/.test(to));
  const isOn = (to: string) => {
    if (to.includes('#')) return false;
    if (to.includes('?')) return loc.pathname + loc.search === to;
    if (to === '/' || to === '/fees') return loc.pathname === to;
    if (loc.pathname !== to && !loc.pathname.startsWith(`${to}/`)) return false;
    if (to === '/vouchers' && loc.search.includes('status=')) return false;
    // A more specific link with a query (e.g. Admission approvals) wins over the plain page.
    const exactQuery = groups.flatMap((g) => g.items.map((i) => i.to)).some((x) => x.includes('?') && x.startsWith(`${to}?`) && loc.pathname + loc.search === x);
    if (exactQuery) return false;
    return !paths.some((p) => p !== to && p.startsWith(`${to}/`) && (loc.pathname === p || loc.pathname.startsWith(`${p}/`)));
  };
  return (
    <div className="flex h-full flex-col border-r bg-sidebar text-sidebar-foreground">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-3 border-b px-4 py-4">
        {logo.data ? (
          <img src={logo.data} alt="" className="size-12 shrink-0 rounded-xl border bg-white object-contain p-0.5" />
        ) : (
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><School className="size-5" /></div>
        )}
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[15px] font-semibold text-foreground">{me?.school.name ?? 'School ERP'}</p>
          <p className="truncate text-xs text-sidebar-muted">School ERP</p>
        </div>
      </Link>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pt-4 pb-6" aria-label="Main">
        {groups.map((g, i) => (
          <div key={i}>
            {g.label && <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-sidebar-muted uppercase">{g.label}</p>}
            <ul className="space-y-0.5">
              {g.items.map((item) => (
                <li key={item.to}>
                  {item.soon ? (
                    <div title={item.hint} className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-muted/80">
                      <item.icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                      <span className="ml-auto rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">Soon</span>
                    </div>
                  ) : (
                    <NavLink
                      to={item.to}
                      end={item.to === '/' || item.to === '/fees'}
                      onClick={onNavigate}
                      className={() => cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-muted hover:text-foreground',
                        isOn(item.to) && 'bg-sidebar-accent text-primary hover:bg-sidebar-accent hover:text-primary before:absolute before:inset-y-1.5 before:-left-3 before:w-1 before:rounded-r-full before:bg-primary',
                      )}
                    >
                      <item.icon className="size-[18px] shrink-0 opacity-80" />
                      <span className="truncate">{item.label}</span>
                      {item.badge && pending > 0 && <span className="ml-auto min-w-5 rounded-full bg-brand-accent px-1.5 py-0.5 text-center text-[11px] font-bold text-black" aria-label={`${pending} waiting for you`}>{pending}</span>}
                    </NavLink>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t px-4 py-3 text-xs text-sidebar-muted">
        Signed in as <span className="font-medium text-foreground">{roleSummary(me?.roles)}</span>
      </div>
    </div>
  );
}

export function roleSummary(roles: { name: string }[] | undefined) {
  if (!roles?.length) return '—';
  return roles.map((r) => r.name).join(', ');
}

function YearSwitcher() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const years = useYears();
  const { yearId } = useWorkingContext();
  const update = async (academicYearId: number) => {
    try {
      await api.patch('/me/preferences', { academicYearId });
      await qc.invalidateQueries();
    } catch {
      toast.error('Could not switch the year. Please try again.');
    }
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="hidden sm:inline">Year</span>
      <Select aria-label={t('common.academicYear')} className="h-8 w-24 text-xs" value={yearId ?? ''} onChange={(e) => update(Number(e.target.value))}>
        {years.data?.map((y) => <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ' ✓' : ''}</option>)}
      </Select>
    </label>
  );
}

function StudentSearch() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  if (!can(P.STUDENTS_READ)) return null;
  return (
    <form
      role="search"
      className="relative w-full max-w-sm"
      onSubmit={(e) => { e.preventDefault(); navigate(`/students?q=${encodeURIComponent(q.trim())}`); setQ(''); }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="Find a student" className="h-9 pl-8" placeholder="Find a student: name, GR No or exam no" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { me, logout } = useAuth();
  const initials = (me?.staff?.name ?? me?.username ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-full py-1 pr-1 pl-3 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" aria-label="Account menu">
          <span className="hidden max-w-40 truncate font-medium md:inline">{me?.staff?.name ?? me?.username}</span>
          <span className="grid size-8 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{initials}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-medium text-foreground">{me?.staff?.name ?? me?.username}</span>
          <span className="block">{roleSummary(me?.roles)}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/change-password"><KeyRound /> {t('common.changePassword')}</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}><LogOut /> {t('common.signOut')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppLayout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-[260px] shrink-0 lg:block print:hidden"><Sidebar /></aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">
            <Sidebar onNavigate={() => setOpen(false)} />
            <button className="absolute top-4 right-3 text-sidebar-foreground" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 print:hidden items-center gap-3 border-b bg-card/95 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu /></Button>
          <StudentSearch />
          <div className="ml-auto flex items-center gap-2">
            <YearSwitcher />
            <UserMenu />
          </div>
        </header>
        <main key={location.pathname} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
