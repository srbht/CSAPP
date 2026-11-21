import { PERMISSIONS, type PermissionCode } from '@cps/shared';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, useLocation } from 'react-router';
import { EmptyState } from './components/common';
import { AppLayout } from './components/layout';
import { Button } from './components/ui/button';
import { AcademicYearsPage, MediumsPage, PoliciesPage, SchoolProfilePage, SequencesPage } from './features/settings';
import { ClassesPage, ClassSubjectsPage, GradingPage, SubjectsPage } from './features/academics';
import { AssignmentsPage } from './features/assignments';
import { BlankSheetsPage, BlankSheetViewPage } from './features/blank-sheets';
import { PerformancePage } from './features/performance';
import { MonthlyPage, MonthlySheetPage } from './features/monthly';
import { ChangePasswordPage, LoginPage } from './features/auth';
import { DashboardPage } from './features/dashboard';
import { ClassesOverviewPage, DivisionPage, ClassListsPage } from './features/classes';
import { SetupPage } from './features/setup';
import { ApprovalsPage, AttendancePage, ExamsSetupPage, MarksPage } from './features/academic-work';
import { GreensheetListPage, GreensheetPage, GreensheetPrintPage, MarkPatternPage } from './features/greensheet';
import { MarksheetPage, PrintAllPage, ReportCardPage, ReportCardsPage } from './features/reportcards';
import { SheetPage } from './features/sheet';
import { CollectFeePage, FeesPage, ReceiptPage, StudentFeesPage } from './features/fees';
import { PromotionPage, PromotionSelectPage, StudentImportPage } from './features/student-import';
import { StudentFormPage, StudentProfilePage, StudentsPage } from './features/students';
import { AdmissionFormPrintPage, BlankAdmissionFormPage } from './features/admission-form';
import { ReportPage, ReportsHomePage } from './features/reports';
import { FeeCertificatePage } from './features/fee-certificate';
import { AuditLogsPage, RolesPage, UsersPage } from './features/people';
import { StaffFormPage, StaffListPage, StaffProfilePage } from './features/staff';
import { ExpenseCategoriesPage, ExpenseDetailPage, ExpenseFormPage, ExpenseListPage } from './features/expenses';
import { useAuth } from './lib/auth';

const P = PERMISSIONS;

function FullPageSpinner() {
  return <div className="grid min-h-dvh place-items-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>;
}

/** Signed-in gate; forces the first-login password change. */
function RequireAuth() {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signedOut') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // First sign-in: nothing else is reachable until the temporary password is changed (API enforces this too).
  if (me?.mustChangePassword) return <ChangePasswordPage />;
  return <Outlet />;
}

/** UX guard only; the API enforces the same permission. */
function Guard({ perm, children }: { perm: PermissionCode; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(perm)) return <EmptyState title="You don't have access to this page" description="Ask the school admin if you need it." action={<Button asChild variant="outline"><Link to="/">Go to home</Link></Button>} />;
  return <>{children}</>;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'change-password', element: <ChangePasswordPage /> },
          { path: 'students', element: <Guard perm={P.STUDENTS_READ}><StudentsPage /></Guard> },
          { path: 'students/import', element: <Guard perm={P.STUDENTS_WRITE}><StudentImportPage /></Guard> },
          { path: 'classes/:sectionId/promote', element: <Guard perm={P.STUDENTS_READ}><PromotionPage /></Guard> },
          { path: 'promotion', element: <Guard perm={P.STUDENTS_READ}><PromotionSelectPage /></Guard> },
          { path: 'class-lists', element: <Guard perm={P.STUDENTS_READ}><ClassListsPage /></Guard> },
          { path: 'monthly-performance', element: <Guard perm={P.MARKS_READ}><MonthlyPage /></Guard> },
          { path: 'monthly-performance/sheet', element: <Guard perm={P.MARKS_READ}><MonthlySheetPage /></Guard> },
          { path: 'performance', element: <Guard perm={P.MARKS_READ}><PerformancePage /></Guard> },
          { path: 'blank-mark-sheets', element: <Guard perm={P.EXAMS_MANAGE}><BlankSheetsPage /></Guard> },
          { path: 'blank-mark-sheets/:id', element: <Guard perm={P.MARKS_READ}><BlankSheetViewPage /></Guard> },
          { path: 'marks', element: <Guard perm={P.MARKS_READ}><MarksPage /></Guard> },
          { path: 'attendance', element: <AttendancePage /> },
          { path: 'approvals', element: <ApprovalsPage /> },
          { path: 'sheet', element: <SheetPage /> },
          { path: 'exams', element: <Guard perm={P.ACADEMICS_READ}><ExamsSetupPage /></Guard> },
          { path: 'exams/pattern', element: <Guard perm={P.ACADEMICS_READ}><MarkPatternPage /></Guard> },
          { path: 'greensheet', element: <Guard perm={P.MARKS_READ}><GreensheetListPage /></Guard> },
          { path: 'greensheet/:sectionId', element: <Guard perm={P.MARKS_READ}><GreensheetPage /></Guard> },
          { path: 'greensheet/:sectionId/print', element: <Guard perm={P.MARKS_READ}><GreensheetPrintPage /></Guard> },
          { path: 'marksheet', element: <Guard perm={P.MARKS_READ}><MarksheetPage /></Guard> },
          { path: 'report-cards', element: <ReportCardsPage /> },
          { path: 'report-cards/print', element: <PrintAllPage /> },
          { path: 'report-cards/preview', element: <ReportCardPage /> },
          { path: 'report-cards/:id', element: <ReportCardPage /> },
          { path: 'fees', element: <Guard perm={P.FEES_READ}><FeesPage /></Guard> },
          { path: 'fees/collect', element: <Guard perm={P.FEES_COLLECT}><CollectFeePage /></Guard> },
          { path: 'fees/student/:studentId', element: <Guard perm={P.FEES_READ}><StudentFeesPage /></Guard> },
          { path: 'fees/receipts/:id', element: <Guard perm={P.FEES_READ}><ReceiptPage /></Guard> },
          { path: 'fees/certificates/:id', element: <Guard perm={P.CERTIFICATES_ISSUE}><FeeCertificatePage /></Guard> },
          { path: 'reports', element: <ReportsHomePage /> },
          { path: 'reports/:key', element: <ReportPage /> },
          { path: 'students/new', element: <Guard perm={P.STUDENTS_WRITE}><StudentFormPage /></Guard> },
          { path: 'students/:id', element: <Guard perm={P.STUDENTS_READ}><StudentProfilePage /></Guard> },
          { path: 'students/:id/edit', element: <Guard perm={P.STUDENTS_WRITE}><StudentFormPage /></Guard> },
          { path: 'students/:id/admission-form', element: <Guard perm={P.STUDENTS_READ}><AdmissionFormPrintPage /></Guard> },
          { path: 'students/admission-form/blank', element: <Guard perm={P.STUDENTS_READ}><BlankAdmissionFormPage /></Guard> },
          { path: 'classes', element: <Guard perm={P.STUDENTS_READ}><ClassesOverviewPage /></Guard> },
          { path: 'classes/:sectionId', element: <Guard perm={P.STUDENTS_READ}><DivisionPage /></Guard> },
          { path: 'setup', element: <SetupPage /> },
          { path: 'academics/classes', element: <Guard perm={P.ACADEMICS_READ}><ClassesPage /></Guard> },
          { path: 'academics/classes/:id/subjects', element: <Guard perm={P.ACADEMICS_READ}><ClassSubjectsPage /></Guard> },
          { path: 'academics/subjects', element: <Guard perm={P.ACADEMICS_READ}><SubjectsPage /></Guard> },
          { path: 'academics/assignments', element: <Guard perm={P.STAFF_READ}><AssignmentsPage /></Guard> },
          { path: 'academics/grading', element: <Guard perm={P.ACADEMICS_READ}><GradingPage /></Guard> },
          { path: 'staff', element: <StaffListPage /> },
          { path: 'staff/new', element: <StaffFormPage /> },
          { path: 'staff/:id', element: <StaffProfilePage /> },
          { path: 'staff/:id/edit', element: <StaffFormPage /> },
          { path: 'expenses', element: <ExpenseListPage /> },
          { path: 'expenses/new', element: <Guard perm={P.EXPENSES_CREATE}><ExpenseFormPage /></Guard> },
          { path: 'expenses/categories', element: <ExpenseCategoriesPage /> },
          { path: 'expenses/:id', element: <ExpenseDetailPage /> },
          { path: 'expenses/:id/edit', element: <ExpenseFormPage /> },
          { path: 'vouchers', element: <ExpenseListPage vouchers /> },
          { path: 'users', element: <Guard perm={P.USERS_MANAGE}><UsersPage /></Guard> },
          { path: 'roles', element: <Guard perm={P.USERS_MANAGE}><RolesPage /></Guard> },
          { path: 'settings/profile', element: <Guard perm={P.SETTINGS_READ}><SchoolProfilePage /></Guard> },
          { path: 'settings/years', element: <Guard perm={P.SETTINGS_READ}><AcademicYearsPage /></Guard> },
          { path: 'settings/mediums', element: <Guard perm={P.SETTINGS_READ}><MediumsPage /></Guard> },
          { path: 'settings/policies', element: <Guard perm={P.SETTINGS_READ}><PoliciesPage /></Guard> },
          { path: 'settings/sequences', element: <Guard perm={P.SETTINGS_READ}><SequencesPage /></Guard> },
          { path: 'audit', element: <Guard perm={P.AUDIT_READ}><AuditLogsPage /></Guard> },
          { path: '*', element: <EmptyState title="Page not found" action={<Button asChild variant="outline"><Link to="/">Go to home</Link></Button>} /> },
        ],
      },
    ],
  },
]);
