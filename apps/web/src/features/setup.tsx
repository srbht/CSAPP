import { PERMISSIONS, type PermissionCode } from '@cps/shared';
import {
  BookCheck, BookOpen, Building2, CalendarRange, ClipboardList, GraduationCap, Hash, Languages, ScrollText, Settings2, ShieldCheck,
  SlidersHorizontal, UserCog, Users,
} from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/common';
import { Card } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';

const P = PERMISSIONS;

interface Item { to: string; icon: React.ElementType; title: string; text: string; perm: PermissionCode }

const GROUPS: { title: string; text: string; items: Item[] }[] = [
  {
    title: 'School', text: 'Done once, changed rarely.',
    items: [
      { to: '/settings/profile', icon: Building2, title: 'School profile', text: 'Name, address, logo, stamp and principal\'s signature for report cards.', perm: P.SETTINGS_READ },
      { to: '/settings/years', icon: CalendarRange, title: 'Academic years & terms', text: 'Year dates (June–April), Semester I and II, weekly off days.', perm: P.SETTINGS_READ },
      { to: '/settings/mediums', icon: Languages, title: 'Mediums & standards', text: 'English and Hindi medium, Nursery to Std X.', perm: P.SETTINGS_READ },
    ],
  },
  {
    title: 'Classes and subjects', text: 'Set up at the start of every year.',
    items: [
      { to: '/academics/classes', icon: GraduationCap, title: 'Classes & divisions', text: 'Create ENGLISH-X, HINDI-IX… and their divisions A, B. Choose each class\'s subjects.', perm: P.ACADEMICS_READ },
      { to: '/academics/subjects', icon: BookOpen, title: 'Subjects & papers', text: 'Subjects per medium, with papers such as Algebra and Geometry under Mathematics.', perm: P.ACADEMICS_READ },
      { to: '/exams', icon: BookCheck, title: 'Exams', text: 'Semester I and II as on the Greensheet, with the mark pattern of each class and due dates.', perm: P.ACADEMICS_READ },
      { to: '/academics/grading', icon: SlidersHorizontal, title: 'Grading', text: 'The A1–E2 scale used on report cards.', perm: P.ACADEMICS_READ },
      { to: '/academics/assignments', icon: ClipboardList, title: 'Who teaches what', text: 'Class teacher, subject teachers and operator for every division.', perm: P.STAFF_READ },
    ],
  },
  {
    title: 'People and logins', text: 'Who can sign in and what they can do.',
    items: [
      { to: '/staff', icon: Users, title: 'Teachers & staff', text: 'Staff directory with each person\'s classes and workload.', perm: P.STAFF_READ },
      { to: '/users', icon: UserCog, title: 'Users & logins', text: 'Create a login for a staff member, reset passwords, unlock accounts.', perm: P.USERS_MANAGE },
      { to: '/roles', icon: ShieldCheck, title: 'Roles & permissions', text: 'What a Headmaster, operator, teacher or office staff may do.', perm: P.USERS_MANAGE },
    ],
  },
  {
    title: 'Rules and records', text: 'School rules and the change log.',
    items: [
      { to: '/settings/policies', icon: Settings2, title: 'Rules', text: 'Pass mark (35 %), attendance warning (75 %), approval steps, report-card options.', perm: P.SETTINGS_READ },
      { to: '/settings/sequences', icon: Hash, title: 'Number formats', text: 'How GR No (SE-####) and exam numbers (E####, H####) are generated.', perm: P.SETTINGS_READ },
      { to: '/audit', icon: ScrollText, title: 'Audit log', text: 'Every change: who made it, when, old and new values.', perm: P.AUDIT_READ },
    ],
  },
];

export function SetupPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="School setup" description="Everything the school configures. Daily work (students, classes) is in the menu on the left." />
      <div className="grid gap-8">
        {GROUPS.map((g) => {
          const items = g.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <section key={g.title}>
              <h2 className="font-semibold">{g.title}</h2>
              <p className="mb-3 text-sm text-muted-foreground">{g.text}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((i) => (
                  <Link key={i.to} to={i.to} className="group rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    <Card className="flex h-full items-start gap-3 p-4 transition-colors group-hover:border-primary/50">
                      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><i.icon className="size-4" /></div>
                      <div><p className="font-medium">{i.title}</p><p className="mt-0.5 text-sm text-muted-foreground">{i.text}</p></div>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
