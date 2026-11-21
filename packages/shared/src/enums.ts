export const RECORD_STATUS = ['ACTIVE', 'INACTIVE'] as const;
export type RecordStatus = (typeof RECORD_STATUS)[number];

export const ACADEMIC_YEAR_STATUS = ['PLANNED', 'ACTIVE', 'CLOSED'] as const;
export type AcademicYearStatus = (typeof ACADEMIC_YEAR_STATUS)[number];

export const SUBJECT_TYPES = ['THEORY', 'PRACTICAL', 'ORAL', 'ACTIVITY', 'OTHER'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const SUBJECT_AREAS = ['SCHOLASTIC', 'CO_SCHOLASTIC'] as const;
export type SubjectArea = (typeof SUBJECT_AREAS)[number];

export const REPORT_ROLLUP = ['SELF', 'INTO_PARENT', 'BOTH'] as const;
export type ReportRollup = (typeof REPORT_ROLLUP)[number];

/**
 * Academic assignments made by the Headmaster (per academic year, per division):
 * OPERATOR enters data · SUBJECT_TEACHER verifies one subject · CLASS_TEACHER approves the division ·
 * ATTENDANCE_VERIFIER verifies attendance. Several operators may share a division.
 */
export const ASSIGNMENT_ROLES = ['OPERATOR', 'SUBJECT_TEACHER', 'CLASS_TEACHER', 'ATTENDANCE_VERIFIER'] as const;
export const ASSIGNMENT_ROLE_LABELS: Record<(typeof ASSIGNMENT_ROLES)[number], string> = {
  OPERATOR: 'Operator',
  SUBJECT_TEACHER: 'Subject teacher',
  CLASS_TEACHER: 'Class teacher',
  ATTENDANCE_VERIFIER: 'Attendance verifier',
};
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const EMPLOYMENT_TYPES = ['PERMANENT', 'TEMPORARY', 'CONTRACT', 'PART_TIME'] as const;

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const GENDER_LABELS: Record<(typeof GENDERS)[number], string> = { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other' };

/** Student master status (lifetime). Leaving the school needs a reason and is kept in history. */
export const STUDENT_STATUS = ['ACTIVE', 'WITHDRAWN', 'TRANSFERRED', 'PASSED_OUT', 'INACTIVE'] as const;
export type StudentStatus = (typeof STUDENT_STATUS)[number];
/** Admission workflow statuses: set only by admission / approval, never chosen in "change status". */
export const ADMISSION_STATUSES = ['PENDING_APPROVAL', 'REJECTED'] as const;
export const STUDENT_STATUS_LABELS: Record<StudentStatus | (typeof ADMISSION_STATUSES)[number], string> = {
  ACTIVE: 'Studying', WITHDRAWN: 'Left school', TRANSFERRED: 'Transferred (TC)', PASSED_OUT: 'Passed out', INACTIVE: 'Inactive',
  PENDING_APPROVAL: 'Provisional', REJECTED: 'Admission rejected',
};
export const ENROLLMENT_STATUS = ['ACTIVE', 'PROMOTED', 'DETAINED', 'COMPLETED', 'TRANSFERRED_OUT', 'WITHDRAWN', 'PENDING_APPROVAL', 'REJECTED'] as const;
export const GUARDIAN_RELATIONS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];
export const GUARDIAN_RELATION_LABELS: Record<GuardianRelation, string> = { FATHER: 'Father', MOTHER: 'Mother', GUARDIAN: 'Guardian', OTHER: 'Other' };
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
/** Suggestions only (Maharashtra categories); the field accepts what the school records. */
export const CATEGORY_SUGGESTIONS = ['OPEN', 'OBC', 'SC', 'ST', 'VJ-A', 'NT-B', 'NT-C', 'NT-D', 'SBC', 'EWS'] as const;

export const USER_STATUS = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const WEEKDAYS = [
  { value: 0, en: 'Sunday', hi: 'रविवार' },
  { value: 1, en: 'Monday', hi: 'सोमवार' },
  { value: 2, en: 'Tuesday', hi: 'मंगलवार' },
  { value: 3, en: 'Wednesday', hi: 'बुधवार' },
  { value: 4, en: 'Thursday', hi: 'गुरुवार' },
  { value: 5, en: 'Friday', hi: 'शुक्रवार' },
  { value: 6, en: 'Saturday', hi: 'शनिवार' },
] as const;

/** Stable machine-readable error codes returned in Problem Details `code`. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  FORBIDDEN: 'FORBIDDEN',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE: 'DUPLICATE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IN_USE: 'IN_USE',
  INVALID_STATE: 'INVALID_STATE',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
