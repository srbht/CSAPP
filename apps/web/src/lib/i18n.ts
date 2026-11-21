import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

/** UI text (English only). */
const en = {
  nav: {
    home: 'Home', daily: 'Daily work', students: 'Students', classes: 'Classes', staff: 'Teachers & Staff',
    assignments: 'Who teaches what', academic: 'Marks & attendance', attendance: 'Attendance', exams: 'Exams & Marks', approvals: 'Approvals', office: 'Office', fees: 'Fees', collect: 'Collect fee',
    reportCards: 'Report Cards', greensheet: 'Greensheet', reports: 'Reports & Analytics', reportsGroup: 'Reports', backdated: 'Backdated fee report', admissionApprovals: 'Provisional admissions', promotion: 'Promotion', classLists: 'Class lists', blankSheets: 'Blank mark sheets', performance: 'Performance reports', monthly: 'Monthly performance', staffGroup: 'Staff management', staffList: 'Staff list', addStaff: 'Add staff', staffReports: 'Staff reports', expenseGroup: 'Expense management', addExpense: 'Add expense', expenseList: 'Expense list', expenseCategories: 'Expense categories', expenseReports: 'Expense reports', voucherGroup: 'Voucher management', allVouchers: 'All vouchers', pendingVouchers: 'Pending approval', approvedVouchers: 'Approved', rejectedVouchers: 'Rejected', cancelledVouchers: 'Cancelled', admin: 'Administration', setup: 'School setup', users: 'Users & logins', audit: 'Audit log',
  },
  common: {
    save: 'Save', cancel: 'Cancel', add: 'Add', edit: 'Edit', search: 'Search', active: 'Active', inactive: 'Inactive',
    signOut: 'Sign out', changePassword: 'Change password', loading: 'Loading…', noData: 'Nothing here yet',
    academicYear: 'Academic year', medium: 'Medium', allMediums: 'All mediums', language: 'Language', actions: 'Actions',
    status: 'Status', previous: 'Previous', next: 'Next', retry: 'Try again', close: 'Close',
  },
  login: {
    title: 'Sign in', subtitle: 'Use your username or mobile number', username: 'Username or mobile', password: 'Password',
    submit: 'Sign in', forgot: 'Forgot your password? Ask the school admin to reset it.',
  },
  dashboard: {
    welcome: 'Good to see you, {{name}}', setup: 'School setup', setupHint: 'Complete these steps so teachers can start using the system.',
    year: 'Current academic year', noYear: 'No current academic year. Create one in Academic Years.',
  },
};

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;

try {
  localStorage.removeItem('cps.lang');
} catch {
  /* storage blocked */
}
