/**
 * Permission catalog. Codes are stored in the `permissions` table (seeded) and checked
 * server-side by the AuthGuard. Roles are editable; this file defines what exists and the
 * default grants for the built-in roles.
 *
 * Academic workflow (docs/07): Operator enters → Subject Teacher verifies → Class Teacher approves
 * → Headmaster gives final approval → report cards can be generated.
 */
export const PERMISSIONS = {
  // Settings & academics
  SETTINGS_READ: 'settings.read',
  SETTINGS_MANAGE: 'settings.manage',
  ACADEMICS_READ: 'academics.read',
  ACADEMICS_MANAGE: 'academics.manage',
  // Staff & academic assignments
  STAFF_READ: 'staff.read',
  STAFF_MANAGE: 'staff.manage',
  /** Office: register staff, edit personal details, photo and documents, view profiles (no employment or salary). */
  STAFF_REGISTER: 'staff.register',
  STAFF_SALARY: 'staff.salary',
  ASSIGNMENTS_MANAGE: 'assignments.manage',
  // Security
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  AUDIT_READ: 'audit.read',
  // Students
  STUDENTS_READ: 'students.read',
  STUDENTS_WRITE: 'students.write',
  STUDENTS_ACADEMIC_ENTRY: 'students.academic.entry',
  STUDENTS_SENSITIVE_READ: 'students.sensitive.read',
  STUDENTS_STATUS: 'students.status',
  /** Confirm (or reject) a new admission entered by the office. */
  STUDENTS_ADMISSION_APPROVE: 'students.admission.approve',
  STUDENTS_PROMOTE: 'students.promote',
  CERTIFICATES_ISSUE: 'certificates.issue',
  CERTIFICATES_CANCEL: 'certificates.cancel',
  DATAQUALITY_MANAGE: 'dataquality.manage',
  // Attendance
  ATTENDANCE_MARK: 'attendance.mark',
  ATTENDANCE_VERIFY: 'attendance.verify',
  ATTENDANCE_CORRECT_REQUEST: 'attendance.correct.request',
  ATTENDANCE_CORRECT_APPROVE: 'attendance.correct.approve',
  ATTENDANCE_CALENDAR_MANAGE: 'attendance.calendar.manage',
  ATTENDANCE_LEGACY_IMPORT: 'attendance.legacy.import',
  ATTENDANCE_LEGACY_APPROVE: 'attendance.legacy.approve',
  // Exams & marks
  EXAMS_MANAGE: 'exams.manage',
  MARKS_ENTER: 'marks.enter',
  MARKS_READ: 'marks.read',
  MARKS_VERIFY_SUBJECT: 'marks.verify.subject',
  MARKS_VERIFY_CLASS: 'marks.verify.class',
  MARKS_VERIFY_COORDINATOR: 'marks.verify.coordinator',
  MARKS_APPROVE: 'marks.approve',
  MARKS_REOPEN: 'marks.reopen',
  REMARKS_ENTER: 'remarks.enter',
  // Report cards
  REPORTCARDS_GENERATE: 'reportcards.generate',
  REPORTCARDS_PUBLISH: 'reportcards.publish',
  TEMPLATES_MANAGE: 'templates.manage',
  // Reports / import / export
  FEES_READ: 'fees.read',
  FEES_COLLECT: 'fees.collect',
  FEES_MANAGE: 'fees.manage',
  FEES_CONCESSION: 'fees.concession',
  FEES_CANCEL: 'fees.cancel',
  /** Correct a receipt (date, mode, reference, manual no.; amount by cancel and re-issue). */
  FEES_EDIT: 'fees.edit',
  // Expenses and vouchers
  EXPENSES_CREATE: 'expenses.create',
  EXPENSES_READ: 'expenses.read',
  EXPENSES_APPROVE: 'expenses.approve',
  /** Edit or cancel APPROVED vouchers (with reason). */
  EXPENSES_CORRECT: 'expenses.correct',
  EXPENSE_CATEGORIES_MANAGE: 'expenses.categories',
  REPORTS_VIEW: 'reports.view',
  REPORTS_SCHOOLWIDE: 'reports.schoolwide',
  IMPORTS_RUN: 'imports.run',
  EXPORTS_RUN: 'exports.run',
  MIGRATION_HISTORICAL: 'migration.historical',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS: PermissionCode[] = Object.values(PERMISSIONS);

const P = PERMISSIONS;

/**
 * Academic approval authority. Never implied by administrative access: the Super Admin role
 * does NOT get these by default, they must be granted explicitly through an academic role.
 */
export const ACADEMIC_APPROVAL_PERMISSIONS: PermissionCode[] = [
  P.MARKS_VERIFY_SUBJECT, P.MARKS_VERIFY_CLASS, P.MARKS_VERIFY_COORDINATOR, P.MARKS_APPROVE, P.MARKS_REOPEN,
  P.ATTENDANCE_VERIFY, P.ATTENDANCE_CORRECT_APPROVE, P.ATTENDANCE_LEGACY_APPROVE, P.REPORTCARDS_PUBLISH,
];

/**
 * Permissions a user can only hand out (via a role) if they hold them personally.
 * Ordinary data-entry permissions can be granted by anyone with users.manage, because data entry
 * is still limited by assignments and must pass verification.
 */
export const SENSITIVE_PERMISSIONS: PermissionCode[] = [
  ...ACADEMIC_APPROVAL_PERMISSIONS,
  P.USERS_MANAGE, P.ROLES_MANAGE, P.SETTINGS_MANAGE, P.ASSIGNMENTS_MANAGE, P.AUDIT_READ,
  P.STUDENTS_SENSITIVE_READ, P.REPORTS_SCHOOLWIDE, P.MIGRATION_HISTORICAL, P.CERTIFICATES_CANCEL, P.FEES_CONCESSION, P.FEES_CANCEL,
];

export interface PermissionMeta {
  code: PermissionCode;
  module: string;
  description: string;
}

export const PERMISSION_META: PermissionMeta[] = [
  { code: P.SETTINGS_READ, module: 'Settings', description: 'View school settings, years, mediums, policies' },
  { code: P.SETTINGS_MANAGE, module: 'Settings', description: 'Edit school profile, academic years, mediums, standards, policies, number formats' },
  { code: P.ACADEMICS_READ, module: 'Academics', description: 'View classes, divisions, subjects, grading' },
  { code: P.ACADEMICS_MANAGE, module: 'Academics', description: 'Manage classes, divisions, subjects, grading systems' },
  { code: P.STAFF_READ, module: 'Staff', description: 'View staff directory and assignments' },
  { code: P.STUDENTS_ADMISSION_APPROVE, module: 'Students', description: 'Approve or reject new admissions entered by the office (approved admissions get GR No, roll no and fees)' },
  { code: P.STAFF_MANAGE, module: 'Staff', description: 'Assign designation, department, employee type, reporting manager; activate staff and change status' },
  { code: P.STAFF_REGISTER, module: 'Staff', description: 'Register new staff, edit personal details, photo and documents, view staff profiles' },
  { code: P.STAFF_SALARY, module: 'Staff', description: 'View and manage staff salary and bank details, pay salaries' },
  { code: P.ASSIGNMENTS_MANAGE, module: 'Staff', description: 'Assign operators, subject teachers, class teachers and verifiers' },
  { code: P.USERS_MANAGE, module: 'Security', description: 'Create logins, reset passwords, assign roles' },
  { code: P.ROLES_MANAGE, module: 'Security', description: 'Edit roles and their permissions' },
  { code: P.AUDIT_READ, module: 'Security', description: 'View audit logs' },
  { code: P.FEES_READ, module: 'Fees', description: 'View student fee ledgers, receipts and collection reports' },
  { code: P.FEES_COLLECT, module: 'Fees', description: 'Collect fees and issue receipts' },
  { code: P.FEES_MANAGE, module: 'Fees', description: 'Set the annual fee of each class, copy fees to a new year, enter opening balances' },
  { code: P.FEES_CONCESSION, module: 'Fees', description: 'Give a fee concession to a student' },
  { code: P.FEES_CANCEL, module: 'Fees', description: 'Cancel a fee receipt (with reason)' },
  { code: P.FEES_EDIT, module: 'Fees', description: 'Correct a fee receipt (with reason) and audit backdated receipts' },
  { code: P.EXPENSES_CREATE, module: 'Expenses', description: 'Enter expenses and generate payment vouchers' },
  { code: P.EXPENSES_READ, module: 'Expenses', description: 'View all expenses, vouchers, expense and income reports' },
  { code: P.EXPENSES_APPROVE, module: 'Expenses', description: 'Approve or reject expense vouchers' },
  { code: P.EXPENSES_CORRECT, module: 'Expenses', description: 'Edit or cancel approved vouchers (with reason)' },
  { code: P.EXPENSE_CATEGORIES_MANAGE, module: 'Expenses', description: 'Add and manage expense categories' },
  { code: P.STUDENTS_READ, module: 'Students', description: 'View students (within scope)' },
  { code: P.STUDENTS_WRITE, module: 'Students', description: 'Admit students and edit master records' },
  { code: P.STUDENTS_ACADEMIC_ENTRY, module: 'Students', description: 'Enter / update academic records of assigned divisions (operator)' },
  { code: P.STUDENTS_SENSITIVE_READ, module: 'Students', description: 'View Aadhaar, caste and other sensitive fields' },
  { code: P.STUDENTS_STATUS, module: 'Students', description: 'Withdraw, transfer, reactivate students' },
  { code: P.STUDENTS_PROMOTE, module: 'Students', description: 'Promote students to next year' },
  { code: P.CERTIFICATES_ISSUE, module: 'Students', description: 'Issue certificates: fee certificate for parents, leaving / bonafide' },
  { code: P.CERTIFICATES_CANCEL, module: 'Students', description: 'Cancel issued certificates' },
  { code: P.DATAQUALITY_MANAGE, module: 'Students', description: 'Resolve data quality issues' },
  { code: P.ATTENDANCE_MARK, module: 'Attendance', description: 'Enter attendance for assigned divisions' },
  { code: P.ATTENDANCE_VERIFY, module: 'Attendance', description: 'Verify attendance for assigned divisions' },
  { code: P.ATTENDANCE_CORRECT_REQUEST, module: 'Attendance', description: 'Request attendance corrections' },
  { code: P.ATTENDANCE_CORRECT_APPROVE, module: 'Attendance', description: 'Approve attendance corrections' },
  { code: P.ATTENDANCE_CALENDAR_MANAGE, module: 'Attendance', description: 'Manage academic calendar and holidays' },
  { code: P.ATTENDANCE_LEGACY_IMPORT, module: 'Attendance', description: 'Import monthly attendance totals' },
  { code: P.ATTENDANCE_LEGACY_APPROVE, module: 'Attendance', description: 'Approve imported monthly attendance' },
  { code: P.EXAMS_MANAGE, module: 'Examinations', description: 'Configure examinations and result schemes' },
  { code: P.MARKS_ENTER, module: 'Marks', description: 'Enter marks for assigned divisions (operator)' },
  { code: P.MARKS_READ, module: 'Marks', description: 'View marks (within scope)' },
  { code: P.MARKS_VERIFY_SUBJECT, module: 'Marks', description: 'Subject teacher verification of assigned subjects' },
  { code: P.MARKS_VERIFY_CLASS, module: 'Marks', description: 'Class teacher review and approval of assigned division' },
  { code: P.MARKS_VERIFY_COORDINATOR, module: 'Marks', description: 'Exam coordinator check (optional stage)' },
  { code: P.MARKS_APPROVE, module: 'Marks', description: 'Headmaster final approval (locks records)' },
  { code: P.MARKS_REOPEN, module: 'Marks', description: 'Reopen approved records with a reason' },
  { code: P.REMARKS_ENTER, module: 'Marks', description: 'Enter remarks and conduct' },
  { code: P.REPORTCARDS_GENERATE, module: 'Report Cards', description: 'Preview report cards (draft watermark)' },
  { code: P.REPORTCARDS_PUBLISH, module: 'Report Cards', description: 'Generate official report cards and publish / revoke' },
  { code: P.TEMPLATES_MANAGE, module: 'Report Cards', description: 'Design report card templates' },
  { code: P.REPORTS_VIEW, module: 'Reports', description: 'View reports within scope' },
  { code: P.REPORTS_SCHOOLWIDE, module: 'Reports', description: 'View school-wide reports across all classes and mediums' },
  { code: P.IMPORTS_RUN, module: 'Import/Export', description: 'Run imports (within scope)' },
  { code: P.EXPORTS_RUN, module: 'Import/Export', description: 'Run exports (within scope)' },
  { code: P.MIGRATION_HISTORICAL, module: 'Import/Export', description: 'Import historical approved data (migration)' },
];

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  SCHOOL_ADMIN: 'SCHOOL_ADMIN',
  HEADMASTER: 'HEADMASTER',
  EXAM_COORDINATOR: 'EXAM_COORDINATOR',
  OPERATOR: 'OPERATOR',
  SUBJECT_TEACHER: 'SUBJECT_TEACHER',
  CLASS_TEACHER: 'CLASS_TEACHER',
  ATTENDANCE_TEACHER: 'ATTENDANCE_TEACHER',
  OFFICE_STAFF: 'OFFICE_STAFF',
  PARENT: 'PARENT',
} as const;
export type SystemRoleCode = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export const SCOPE_TYPES = ['SCHOOL', 'MEDIUM', 'CLASS', 'SECTION', 'ASSIGNED'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

const R = SYSTEM_ROLES;
/** Default grants (editable later in Users & Permissions → Roles). */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleCode, { name: string; defaultScope: ScopeType; permissions: PermissionCode[] }> = {
  // Technical administration only: no academic approval authority unless also given an academic role.
  [R.SUPER_ADMIN]: {
    name: 'Super Admin',
    defaultScope: 'SCHOOL',
    permissions: ALL_PERMISSIONS.filter((p) => !ACADEMIC_APPROVAL_PERMISSIONS.includes(p)),
  },
  [R.SCHOOL_ADMIN]: {
    name: 'School Admin',
    defaultScope: 'SCHOOL',
    permissions: [
      P.SETTINGS_READ, P.SETTINGS_MANAGE, P.ACADEMICS_READ, P.ACADEMICS_MANAGE, P.STAFF_READ, P.STAFF_MANAGE,
      P.USERS_MANAGE, P.AUDIT_READ, P.STUDENTS_READ, P.STUDENTS_WRITE, P.STUDENTS_SENSITIVE_READ, P.STUDENTS_STATUS,
      P.CERTIFICATES_ISSUE, P.CERTIFICATES_CANCEL, P.DATAQUALITY_MANAGE, P.ATTENDANCE_CALENDAR_MANAGE,
      P.ATTENDANCE_LEGACY_IMPORT, P.EXAMS_MANAGE, P.MARKS_READ, P.REPORTCARDS_GENERATE, P.TEMPLATES_MANAGE,
      P.REPORTS_VIEW, P.REPORTS_SCHOOLWIDE, P.IMPORTS_RUN, P.EXPORTS_RUN,
      P.FEES_READ, P.FEES_COLLECT, P.FEES_MANAGE, P.FEES_CONCESSION, P.FEES_CANCEL, P.FEES_EDIT,
      P.STAFF_REGISTER, P.STAFF_SALARY, P.EXPENSES_CREATE, P.EXPENSES_READ, P.EXPENSES_APPROVE, P.EXPENSE_CATEGORIES_MANAGE,
    ],
  },
  // Highest academic authority: sees everything, controls assignments, final approval.
  [R.HEADMASTER]: {
    name: 'Headmaster',
    defaultScope: 'SCHOOL',
    permissions: [
      P.SETTINGS_READ, P.ACADEMICS_READ, P.ACADEMICS_MANAGE, P.STAFF_READ, P.ASSIGNMENTS_MANAGE, P.AUDIT_READ,
      P.STUDENTS_READ, P.STUDENTS_SENSITIVE_READ, P.STUDENTS_STATUS, P.STUDENTS_PROMOTE, P.CERTIFICATES_ISSUE,
      P.CERTIFICATES_CANCEL, P.ATTENDANCE_CORRECT_APPROVE, P.ATTENDANCE_LEGACY_APPROVE, P.MARKS_READ, P.MARKS_APPROVE,
      P.MARKS_REOPEN, P.REMARKS_ENTER, P.REPORTCARDS_GENERATE, P.REPORTCARDS_PUBLISH, P.REPORTS_VIEW, P.EXAMS_MANAGE,
      P.REPORTS_SCHOOLWIDE, P.EXPORTS_RUN, P.FEES_READ, P.FEES_MANAGE, P.FEES_CONCESSION, P.FEES_CANCEL, P.FEES_EDIT,
      P.STAFF_MANAGE, P.STAFF_REGISTER, P.STAFF_SALARY, P.EXPENSES_CREATE, P.EXPENSES_READ, P.EXPENSES_APPROVE, P.EXPENSE_CATEGORIES_MANAGE,
      P.STUDENTS_ADMISSION_APPROVE, P.STUDENTS_WRITE, // edits confirmed students (the office only until confirmation)
    ],
  },
  [R.EXAM_COORDINATOR]: {
    name: 'Examination Coordinator',
    defaultScope: 'SCHOOL',
    permissions: [
      P.SETTINGS_READ, P.ACADEMICS_READ, P.STAFF_READ, P.STUDENTS_READ, P.EXAMS_MANAGE, P.MARKS_READ,
      P.MARKS_VERIFY_COORDINATOR, P.REPORTCARDS_GENERATE, P.TEMPLATES_MANAGE, P.REPORTS_VIEW, P.EXPORTS_RUN,
    ],
  },
  // Enters data for assigned divisions only; can never verify or approve.
  [R.OPERATOR]: {
    name: 'Operator',
    defaultScope: 'ASSIGNED',
    permissions: [
      P.ACADEMICS_READ, P.STUDENTS_READ, P.STUDENTS_ACADEMIC_ENTRY, P.ATTENDANCE_MARK, P.ATTENDANCE_CORRECT_REQUEST,
      P.MARKS_ENTER, P.MARKS_READ, P.REMARKS_ENTER, P.IMPORTS_RUN, P.EXPORTS_RUN,
      // Generation is blocked by the API until Subject Teacher, Class Teacher and Headmaster have all approved.
      P.REPORTCARDS_GENERATE,
    ],
  },
  [R.SUBJECT_TEACHER]: {
    name: 'Subject Teacher',
    defaultScope: 'ASSIGNED',
    permissions: [P.ACADEMICS_READ, P.STUDENTS_READ, P.MARKS_READ, P.MARKS_VERIFY_SUBJECT, P.REPORTS_VIEW, P.EXPORTS_RUN],
  },
  [R.CLASS_TEACHER]: {
    name: 'Class Teacher',
    defaultScope: 'ASSIGNED',
    permissions: [
      P.ACADEMICS_READ, P.STUDENTS_READ, P.MARKS_READ, P.MARKS_VERIFY_CLASS, P.ATTENDANCE_VERIFY, P.REMARKS_ENTER,
      P.REPORTCARDS_GENERATE, P.REPORTS_VIEW, P.EXPORTS_RUN,
    ],
  },
  // Verifies attendance of divisions where they hold an ATTENDANCE_VERIFIER assignment.
  [R.ATTENDANCE_TEACHER]: {
    name: 'Attendance Verifier',
    defaultScope: 'ASSIGNED',
    permissions: [P.ACADEMICS_READ, P.STUDENTS_READ, P.ATTENDANCE_VERIFY, P.REPORTS_VIEW],
  },
  [R.OFFICE_STAFF]: {
    name: 'Office Staff',
    defaultScope: 'SCHOOL',
    permissions: [
      P.ACADEMICS_READ, P.STUDENTS_READ, P.STUDENTS_WRITE, P.CERTIFICATES_ISSUE, // no staff list, assignments or school setup
      P.DATAQUALITY_MANAGE, P.ATTENDANCE_LEGACY_IMPORT, P.REPORTS_VIEW, P.IMPORTS_RUN, P.EXPORTS_RUN, P.FEES_READ, P.FEES_COLLECT,
      P.STAFF_REGISTER, P.EXPENSES_CREATE, // registers staff (personal details only) and enters expenses; cannot approve
    ],
  },
  [R.PARENT]: { name: 'Parent (future)', defaultScope: 'ASSIGNED', permissions: [] },
};

/**
 * Default permissions added to system roles AFTER the first release. Every seed run adds any that are missing
 * to existing roles, so schools that set up roles earlier get them without losing their other changes.
 */
export const ADDED_DEFAULT_PERMISSIONS: Partial<Record<SystemRoleCode, PermissionCode[]>> = {
  OPERATOR: [P.REPORTCARDS_GENERATE],
  SCHOOL_ADMIN: [
    P.FEES_READ, P.FEES_COLLECT, P.FEES_MANAGE, P.FEES_CONCESSION, P.FEES_CANCEL, P.FEES_EDIT,
    P.STAFF_REGISTER, P.STAFF_SALARY, P.EXPENSES_CREATE, P.EXPENSES_READ, P.EXPENSES_APPROVE, P.EXPENSE_CATEGORIES_MANAGE,
  ],
  HEADMASTER: [
    P.FEES_READ, P.FEES_MANAGE, P.FEES_CONCESSION, P.FEES_CANCEL, P.FEES_EDIT,
    P.STAFF_MANAGE, P.STAFF_REGISTER, P.STAFF_SALARY, P.EXPENSES_CREATE, P.EXPENSES_READ, P.EXPENSES_APPROVE, P.EXPENSE_CATEGORIES_MANAGE,
    P.STUDENTS_ADMISSION_APPROVE, P.EXAMS_MANAGE, P.STUDENTS_WRITE,
  ],
  OFFICE_STAFF: [P.FEES_READ, P.FEES_COLLECT, P.STAFF_REGISTER, P.EXPENSES_CREATE],
};
