import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@cps/shared';
import {
  AlertTriangle, ArrowRight, BookCheck, CalendarCheck, CheckCircle2, CircleAlert, ClipboardList, GraduationCap, IndianRupee, KeyRound, Receipt, Wallet,
  Search, Settings, UserPlus, Users, UsersRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { rupees } from '@cps/shared';
import { roleSummary, useSchoolLogo } from '@/components/layout';
import { Card } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useWorkingContext } from '@/lib/hooks';
import type { Assignment, DivisionOverview, SetupSummary, StudentsOverview } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MyTasks } from './academic-work';
import { useTasks } from './workflow-ui';
import { useFeeSummary } from './fees';
import { HeadmasterDashboard } from './head-dashboard';

const P = PERMISSIONS;

/** Divisions of the year chosen in the top bar, or of another year (e.g. admissions for next year). */
export const useStudentsOverview = (forYearId?: number | null) => {
  const { can } = useAuth();
  const { yearId: working } = useWorkingContext();
  const yearId = forYearId ?? working;
  return useQuery({
    queryKey: ['students', 'overview', yearId],
    queryFn: () => api.get<StudentsOverview>(`/students/overview${qs({ academicYearId: yearId })}`),
    enabled: can(P.STUDENTS_READ) && !!yearId,
  });
};

export const divisionLabel = (d: { name: string; schoolClass: { displayName: string } }) => `${d.schoolClass.displayName} ${d.name}`;

/** Headmaster / Super Admin: the approvals-first dashboard. Everyone else: their own work. */
export function DashboardPage() {
  const { can } = useAuth();
  const head = can(P.STUDENTS_ADMISSION_APPROVE) || can(P.EXPENSES_APPROVE) || can(P.MARKS_APPROVE);
  return head ? <HeadmasterDashboard /> : <GeneralDashboard />;
}

function GeneralDashboard() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const { year } = useWorkingContext();
  const overview = useStudentsOverview();
  const isAdmin = can(P.SETTINGS_MANAGE) || can(P.ASSIGNMENTS_MANAGE);
  const setup = useQuery({ queryKey: ['dashboard', 'setup'], queryFn: () => api.get<SetupSummary>('/dashboard/setup'), enabled: isAdmin || can(P.STAFF_READ) });
  const mine = useQuery({ queryKey: ['me', 'assignments'], queryFn: () => api.get<Assignment[]>('/me/assignments'), enabled: !!me?.staff });
  const logo = useSchoolLogo();
  const tasks = useTasks();
  const fees = useFeeSummary(can(P.FEES_READ));
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

  return (
    <div className="grid gap-7">
      {/* Welcome banner */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary to-indigo-800 p-6 text-primary-foreground shadow-lg shadow-primary/20 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -right-10 size-64 rounded-full bg-white/10" aria-hidden />
        <div className="pointer-events-none absolute -bottom-20 right-40 size-48 rounded-full bg-brand-accent/30" aria-hidden />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-center gap-4">
            {logo.data && <img src={logo.data} alt="" className="hidden size-16 rounded-2xl bg-white object-contain p-1 shadow-md sm:block" />}
            <div>
              <p className="text-sm text-white/80">{today}</p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('dashboard.welcome', { name: me?.staff?.name ?? me?.username })}</h1>
              <p className="mt-1 text-sm text-white/80">{roleSummary(me?.roles)}{year && <> · Academic year {year.name}</>}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {overview.data && <HeroStat label={overview.data.scopeAll ? 'Students' : 'My students'} value={overview.data.totals.students.toLocaleString('en-IN')} to="/students" />}
            {tasks.data && (can(P.MARKS_READ) || can(P.ATTENDANCE_VERIFY)) && <HeroStat label="Waiting for me" value={String(tasks.data.review + tasks.data.corrections)} to="/approvals" highlight={tasks.data.review + tasks.data.corrections > 0} />}
            {fees.data && <HeroStat label="Fees collected today" value={rupees(fees.data.today.amount)} to="/fees?tab=receipts" />}
          </div>
        </div>
      </section>

      <WaitingForYou />

      {fees.data && fees.data.totals.students > 0 && (
        <section aria-labelledby="fees">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="fees" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Fees · {fees.data.year.name}</h2>
            <Link to="/fees" className="text-sm text-primary hover:underline">Fee overview</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat to="/fees" icon={IndianRupee} value={rupees(fees.data.totals.paid)} label="Collected" sub={`${fees.data.totals.collectedPercent}% of ${rupees(fees.data.totals.totalPayable)}`} />
            <Stat to="/fees?tab=register" icon={Wallet} value={rupees(fees.data.totals.balance)} label="Balance to collect" sub={`${fees.data.totals.studentsWithBalance} students`} />
            <Stat to="/fees?tab=register&status=PREVIOUS" icon={AlertTriangle} value={rupees(fees.data.totals.previousStillDue)} label="Previous year unpaid" sub={`${fees.data.totals.studentsWithPrevious} students`} tone="bad" />
            <Stat to="/fees?tab=receipts" icon={Receipt} value={rupees(fees.data.today.amount)} label="Today" sub={`${fees.data.today.receipts} receipts`} />
          </div>
        </section>
      )}

      <QuickActions />

      {/* Class teacher / operator / subject teacher view */}
      {me?.staff && <MyWork assignments={mine.data ?? []} overview={overview.data} loading={mine.isPending} />}

      {/* Whole-school view (Headmaster, admin, office) */}
      {overview.data?.scopeAll && <SchoolAtAGlance overview={overview.data} staffCount={setup.data?.counts.staff} />}

      <HomeApprovals />

      {isAdmin && setup.data && <SetupStatus d={setup.data} />}
    </div>
  );
}

// ---------------------------------------------------------------- quick actions

function QuickActions() {
  const { can } = useAuth();
  const overview = useStudentsOverview();
  const whole = overview.data?.scopeAll ?? true;
  const actions = [
    can(P.STUDENTS_READ) && { to: '/students', icon: Search, title: whole ? 'Find a student' : 'My students', text: whole ? 'Search by name, GR No or exam number and open the profile.' : 'Students of your divisions. Open a profile to see details.' },
    can(P.STUDENTS_WRITE) && { to: '/students/new', icon: UserPlus, title: 'Admit a new student', text: 'Fill the admission form; GR No and exam no are given automatically.' },
    can(P.MARKS_ENTER) && { to: '/marks', icon: BookCheck, title: 'Enter marks', text: 'Choose the exam, division and subject, type the marks and submit them for verification.' },
    can(P.ATTENDANCE_MARK) && { to: '/attendance', icon: CalendarCheck, title: 'Enter attendance', text: 'Working days and days present for each student, month by month.' },
    (can(P.MARKS_VERIFY_SUBJECT) || can(P.MARKS_VERIFY_CLASS) || can(P.MARKS_APPROVE)) && { to: '/approvals', icon: ClipboardList, title: 'Check and approve', text: 'Marks and attendance waiting for your verification or approval.' },
    can(P.STUDENTS_READ) && (whole
      ? { to: '/classes', icon: GraduationCap, title: 'See all classes', text: 'Every division with its students, class teacher and operator.' }
      : { to: '/classes', icon: GraduationCap, title: 'My classes', text: 'The divisions you are assigned to, with their student lists.' }),
    can(P.ASSIGNMENTS_MANAGE) && { to: '/academics/assignments', icon: ClipboardList, title: 'Who teaches what', text: 'Choose class teachers, subject teachers and operators.' },
    can(P.STAFF_MANAGE) && { to: '/staff', icon: Users, title: 'Teachers & staff', text: 'Add or update teachers and office staff.' },
    can(P.USERS_MANAGE) && { to: '/users', icon: KeyRound, title: 'Logins', text: 'Create a login for a teacher and choose their role.' },
    can(P.SETTINGS_MANAGE) && { to: '/setup', icon: Settings, title: 'School setup', text: 'Logo, academic year, classes, subjects, grading and rules.' },
  ].filter(Boolean) as { to: string; icon: React.ElementType; title: string; text: string }[];
  if (!actions.length) return null;
  return (
    <section aria-labelledby="qa">
      <h2 id="qa" className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">What you can do</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {actions.slice(0, 8).map((a) => (
          <Link key={a.to} to={a.to} className="group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Card className="flex h-full items-start gap-3 p-4 transition-colors group-hover:border-primary/50 group-hover:bg-accent/30">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><a.icon className="size-5" /></div>
              <div className="min-w-0">
                <p className="font-medium">{a.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{a.text}</p>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- my work (teachers, operators)

function MyWork({ assignments, overview, loading }: { assignments: Assignment[]; overview?: StudentsOverview; loading: boolean }) {
  if (loading) return null;
  if (!assignments.length) return null;
  const sections = new Map((overview?.sections ?? []).map((s) => [s.sectionId, s]));
  const classTeacherOf = assignments.filter((a) => a.role === 'CLASS_TEACHER');
  const subjects = assignments.filter((a) => a.role === 'SUBJECT_TEACHER');
  const operatorOf = assignments.filter((a) => a.role === 'OPERATOR');
  const verifierOf = assignments.filter((a) => a.role === 'ATTENDANCE_VERIFIER');
  const bySection = (list: Assignment[]) => Object.values(list.reduce<Record<number, { section: Assignment['section']; items: Assignment[] }>>((acc, a) => {
    (acc[a.sectionId] ??= { section: a.section, items: [] }).items.push(a);
    return acc;
  }, {}));

  return (
    <section aria-labelledby="mywork" className="grid gap-4">
      <h2 id="mywork" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">My work this year</h2>

      {classTeacherOf.map((a) => {
        const d = sections.get(a.sectionId);
        return (
          <Card key={a.id} className="overflow-hidden">
            <div className="flex flex-col gap-4 bg-gradient-to-r from-primary to-primary/80 p-5 text-primary-foreground sm:flex-row sm:items-center">
              <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-white/15"><GraduationCap className="size-6" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-sm opacity-90">You are the class teacher of</p>
                <p className="text-2xl font-semibold">{a.section.schoolClass.displayName} {a.section.name}</p>
                {d && <p className="mt-0.5 text-sm opacity-90">{d.students} students · {d.boys} male, {d.girls} female{d.operators.length ? ` · Operator: ${d.operators.map((o) => o.name).join(', ')}` : ''}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to={`/classes/${a.sectionId}`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3 text-sm font-medium text-primary hover:bg-white/90">
                  Open my class <ArrowRight className="size-4" />
                </Link>
              </div>
            </div>
            <p className="px-5 py-3 text-sm text-muted-foreground">
              You can see full student profiles of this class, including parents' phone numbers. Later you will approve its marks and attendance here.
            </p>
          </Card>
        );
      })}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {bySection(subjects).map(({ section, items }) => (
          <WorkCard key={`s${section.id}`} to={`/classes/${section.id}`} icon={BookCheck} title={`${section.schoolClass.displayName} ${section.name}`}
            role="Subject teacher" detail={items.map((i) => i.classSubject?.subject.nameEn).join(', ')} count={sections.get(section.id)?.students} />
        ))}
        {operatorOf.map((a) => (
          <WorkCard key={`o${a.id}`} to={`/classes/${a.sectionId}`} icon={ClipboardList} title={`${a.section.schoolClass.displayName} ${a.section.name}`}
            role="Operator (data entry)" detail="You will enter attendance and marks for this division." count={sections.get(a.sectionId)?.students} />
        ))}
        {verifierOf.map((a) => (
          <WorkCard key={`v${a.id}`} to={`/classes/${a.sectionId}`} icon={CalendarCheck} title={`${a.section.schoolClass.displayName} ${a.section.name}`}
            role="Attendance verifier" detail="You will check attendance entered by the operator." count={sections.get(a.sectionId)?.students} />
        ))}
      </div>
    </section>
  );
}

function WorkCard({ to, icon: Icon, title, role, detail, count }: { to: string; icon: React.ElementType; title: string; role: string; detail?: string; count?: number }) {
  return (
    <Link to={to} className="group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <Card className="flex h-full items-start gap-3 p-4 transition-colors group-hover:border-primary/50">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><Icon className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-medium">{title}</p>
            {count !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{count} students</span>}
          </div>
          <p className="text-xs font-medium text-primary">{role}</p>
          {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
        </div>
      </Card>
    </Link>
  );
}

// ---------------------------------------------------------------- whole school

function SchoolAtAGlance({ overview, staffCount }: { overview: StudentsOverview; staffCount?: number }) {
  const t = overview.totals;
  const mediums = overview.byMedium;
  return (
    <section aria-labelledby="glance" className="grid gap-4">
      <h2 id="glance" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">School at a glance · {overview.year.name}</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat to="/students" icon={UsersRound} value={t.students} label="Students studying" sub={`${t.boys} male · ${t.girls} female`} />
        {mediums.map((m) => (
          <Stat key={m.code} to={`/students?medium=${m.code}`} icon={GraduationCap} value={m.students} label={m.name} sub={`${m.divisions} divisions`} />
        ))}
        {staffCount !== undefined && <Stat to="/staff" icon={Users} value={staffCount} label="Teachers & staff" sub="active" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {mediums.map((m) => (
          <Card key={m.code} className="overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="font-semibold">{m.name}</h3>
              <Link to="/classes" className="text-sm text-primary hover:underline">All classes</Link>
            </div>
            <ul className="divide-y">
              {overview.sections.filter((s) => s.schoolClass.medium.code === m.code).map((s) => <DivisionRow key={s.sectionId} d={s} />)}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function DivisionRow({ d }: { d: DivisionOverview }) {
  return (
    <li>
      <Link to={`/classes/${d.sectionId}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40">
        <span className="w-24 shrink-0 font-medium">Std {d.schoolClass.standard.code} {d.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.classTeacher?.name ?? <span className="text-warning">No class teacher</span>}</span>
        <span className="shrink-0 tabular-nums">{d.students} <span className="text-muted-foreground">students</span></span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function HeroStat({ label, value, to, highlight }: { label: string; value: string; to: string; highlight?: boolean }) {
  return (
    <Link to={to} className={cn('min-w-36 rounded-2xl px-4 py-3 backdrop-blur transition-colors', highlight ? 'bg-brand-accent text-black hover:bg-brand-accent/90' : 'bg-white/12 hover:bg-white/20')}>
      <p className={cn('text-xs', highlight ? 'text-black/70' : 'text-white/75')}>{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </Link>
  );
}

function Stat({ icon: Icon, label, value, sub, to, tone }: { icon: React.ElementType; label: string; value: number | string; sub?: string; to?: string; tone?: 'bad' }) {
  const inner = (
    <Card className={cn('h-full p-5', to && 'transition-colors hover:border-primary/50')}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><span className={cn('grid size-8 place-items-center rounded-lg', tone === 'bad' ? 'bg-red-50 text-red-700' : 'bg-primary/10 text-primary')}><Icon className="size-4" /></span> {label}</div>
      <p className={cn('mt-3 text-[28px] leading-none font-semibold tabular-nums', tone === 'bad' && 'text-red-700')}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
  return to ? <Link to={to} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{inner}</Link> : inner;
}

// ---------------------------------------------------------------- approvals waiting for me

function HomeApprovals() {
  const { can } = useAuth();
  const tasks = useTasks();
  if (!can(P.MARKS_READ) && !can(P.ATTENDANCE_VERIFY)) return null;
  return (
    <section aria-labelledby="appr">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="appr" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Marks & attendance waiting for you</h2>
        <Link to="/approvals" className="text-sm text-primary hover:underline">Approval status by standard</Link>
      </div>
      {tasks.data && !tasks.data.items.length
        ? <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-600" /> Nothing is waiting for you right now.</Card>
        : <MyTasks tasks={tasks.data} compact />}
    </section>
  );
}

// ---------------------------------------------------------------- setup status (admins)

function SetupStatus({ d }: { d: SetupSummary }) {
  const steps = [
    { done: !d.gaps.profileIncomplete, to: '/settings/profile', label: 'School profile, logo and principal name' },
    { done: !!d.currentYear && d.counts.classes > 0, to: '/academics/classes', label: 'Classes and divisions for both mediums' },
    { done: d.counts.classes > 0 && d.gaps.classesWithoutSubjects === 0, to: '/academics/classes', label: 'Subjects for every class', detail: d.gaps.classesWithoutSubjects ? `${d.gaps.classesWithoutSubjects} classes have no subjects` : undefined },
    { done: d.counts.staff > 0, to: '/staff', label: 'Teachers and staff' },
    { done: d.counts.sections > 0 && d.gaps.sectionsWithoutClassTeacher === 0, to: '/academics/assignments', label: 'A class teacher for every division', detail: d.gaps.sectionsWithoutClassTeacher ? `${d.gaps.sectionsWithoutClassTeacher} divisions without a class teacher` : undefined },
    { done: d.counts.sections > 0 && d.gaps.subjectSlotsWithoutTeacher === 0, to: '/academics/assignments', label: 'Subject teachers', detail: d.gaps.subjectSlotsWithoutTeacher ? `${d.gaps.subjectSlotsWithoutTeacher} division-subjects without a teacher` : undefined },
    { done: d.counts.sections > 0 && d.gaps.sectionsWithoutOperator === 0, to: '/academics/assignments', label: 'Operators for data entry', detail: d.gaps.sectionsWithoutOperator ? `${d.gaps.sectionsWithoutOperator} divisions without an operator` : undefined },
    { done: d.counts.users > 1, to: '/users', label: 'Logins for staff' },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) {
    return (
      <Link to="/setup" className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm hover:border-primary/50">
        <CheckCircle2 className="size-4 text-success" /> School setup is complete ({done}/{steps.length}). <span className="text-primary">Open setup</span>
      </Link>
    );
  }
  return (
    <section aria-labelledby="setup">
      <h2 id="setup" className="mb-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">Finish school setup · {done}/{steps.length}</h2>
      <p className="mb-3 text-sm text-muted-foreground">Complete these steps so teachers can start using the system.</p>
      <div className="grid gap-2">
        {steps.filter((s) => !s.done).map((s) => (
          <Link key={s.label} to={s.to} className="group flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:border-primary/50">
            <CircleAlert className="size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{s.label}</p>
              {s.detail && <p className="text-xs text-muted-foreground">{s.detail}</p>}
            </div>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- waiting for you

export interface TodoItem { key: string; group: string; title: string; detail: string; to: string; at?: string | null }
export const useTodo = () => {
  const { me } = useAuth();
  return useQuery({ queryKey: ['dashboard', 'todo'], queryFn: () => api.get<{ items: TodoItem[] }>('/dashboard/todo'), enabled: !!me, refetchInterval: 60_000 });
};
export const TODO_TONE: Record<string, string> = {
  'Class list': 'bg-teal-100 text-teal-900', 'Exam Nos': 'bg-indigo-100 text-indigo-900', Admission: 'bg-sky-100 text-sky-900',
  Promotion: 'bg-emerald-100 text-emerald-900', 'GR No': 'bg-orange-100 text-orange-900', 'Marks & attendance': 'bg-amber-100 text-amber-900',
};

/** Everything that needs this person now, in one list (class lists, Exam Nos, admissions, promotions, GR Nos, marks). */
function WaitingForYou() {
  const { can } = useAuth();
  const todo = useTodo();
  const tasks = useTasks();
  if (!todo.data) return null;
  const items: TodoItem[] = [...todo.data.items];
  if (tasks.data && (can(P.MARKS_READ) || can(P.ATTENDANCE_VERIFY))) {
    if (tasks.data.review) items.unshift({ key: 'marks-review', group: 'Marks & attendance', title: `${tasks.data.review} mark / attendance sheet${tasks.data.review > 1 ? 's' : ''} to check`, detail: 'Waiting for your verification or approval', to: '/approvals' });
    if (tasks.data.corrections) items.unshift({ key: 'marks-fix', group: 'Marks & attendance', title: `${tasks.data.corrections} sheet${tasks.data.corrections > 1 ? 's' : ''} sent back for correction`, detail: 'Correct the marked rows and submit again', to: '/approvals' });
  }
  return (
    <section aria-labelledby="todo">
      <Card className={cn('overflow-hidden', items.length ? 'border-amber-300' : 'border-emerald-200')}>
        <div className={cn('flex items-center gap-3 px-5 py-3', items.length ? 'bg-amber-50' : 'bg-emerald-50')}>
          <span className={cn('grid size-9 place-items-center rounded-full text-lg font-bold tabular-nums', items.length ? 'bg-amber-200 text-amber-950' : 'bg-emerald-200 text-emerald-900')}>{items.length || '✓'}</span>
          <h2 id="todo" className="font-semibold">{items.length ? 'Waiting for you' : 'Nothing is waiting for you'}</h2>
        </div>
        {items.length > 0 && (
          <ul className="divide-y">
            {items.map((i) => (
              <li key={i.key}>
                <Link to={i.to} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                  <span className={cn('w-36 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium', TODO_TONE[i.group] ?? 'bg-muted')}>{i.group}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{i.detail}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-primary">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
