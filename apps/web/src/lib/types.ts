// Shapes returned by the API (BigInt ids serialised as numbers, dates as ISO strings).

export interface Me {
  id: number;
  username: string;
  mobile: string | null;
  email: string | null;
  mustChangePassword: boolean;
  staff: { id: number; name: string; employeeCode: string } | null;
  school: { id: number; name: string; nameHi: string | null; logoFileId: number | null };
  roles: { code: string; name: string; scopeType: string; scopeId: number | null }[];
  permissions: string[];
  preferences: { language: 'en' | 'hi'; academicYearId: number | null; mediumId: number | null };
  scope: { all: boolean; sectionIds: number[]; byRole: Record<'OPERATOR' | 'SUBJECT_TEACHER' | 'CLASS_TEACHER' | 'ATTENDANCE_VERIFIER', number[]> } | null;
}

export interface School {
  id: number;
  code: string;
  name: string;
  nameHi: string | null;
  motto: string | null;
  addressLine: string;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  udiseCode: string | null;
  registrationNo: string | null;
  board: string | null;
  principalName: string | null;
  principalTitle: string | null;
  logoFileId: number | null;
  stampFileId: number | null;
  principalSignFileId: number | null;
}

export interface Term {
  id: number;
  code: string;
  nameEn: string;
  nameHi: string | null;
  startDate: string;
  endDate: string;
  sequence: number;
}

export interface AcademicYear {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  weeklyOffDays: number[];
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
  isCurrent: boolean;
  terms: Term[];
  _count?: { classes: number };
}

export interface Medium {
  id: number;
  code: string;
  nameEn: string;
  nameHi: string | null;
  examNoPrefix: string | null;
  sortOrder: number;
  status: string;
}

export interface Standard {
  id: number;
  code: string;
  nameEn: string;
  nameHi: string | null;
  levelOrder: number;
  status: string;
}

export interface StaffRef {
  id: number;
  name: string;
  employeeCode?: string;
}

export interface Section {
  id: number;
  classId: number;
  name: string;
  capacity: number | null;
  room: string | null;
  status: string;
  classTeacher?: StaffRef | null;
}

export interface SchoolClass {
  id: number;
  academicYearId: number;
  mediumId: number;
  standardId: number;
  code: string;
  displayName: string;
  gradingSystemId: number | null;
  status: string;
  medium: Medium;
  standard: Standard;
  gradingSystem: { id: number; name: string } | null;
  sections: Section[];
  subjectCount: number;
}

export interface Subject {
  id: number;
  mediumId: number;
  code: string;
  nameEn: string;
  nameHi: string | null;
  shortName: string | null;
  subjectType: string;
  area: string;
  parentSubjectId: number | null;
  status: string;
  medium: { id: number; code: string; nameEn: string };
  parent: { id: number; nameEn: string; code: string } | null;
  _count: { papers: number };
}

export interface ClassSubject {
  id: number;
  classId: number;
  subjectId: number;
  isOptional: boolean;
  optionalGroup: string | null;
  includeInTotal: boolean;
  defaultMaxMarks: number | null;
  defaultPassMarks: number | null;
  gradingSystemId: number | null;
  reportRollup: string;
  displayOrder: number;
  status: string;
  subject: Subject & { parent: { id: number; nameEn: string; code: string } | null };
}

export interface GradeBand {
  id?: number;
  grade: string;
  minPercent: number;
  maxPercent: number;
  gradePoint: number | null;
  labelEn: string | null;
  labelHi: string | null;
  isPass: boolean;
}

export interface GradingSystem {
  id: number;
  name: string;
  status: string;
  bands: GradeBand[];
}

export interface EffectivePolicy {
  key: string;
  value: unknown;
  source: 'DEFAULT' | 'STORED';
  scope: { academicYearId: number | null; mediumId: number | null; standardId: number | null; classId: number | null } | null;
  label: string;
  description: string;
  group: string;
  input: 'number' | 'percent' | 'select' | 'boolean' | 'stages';
  options: { value: string; label: string }[] | null;
  default: unknown;
}

export interface PolicyOverride {
  id: number;
  policyKey: string;
  value: unknown;
  scopeKey: string;
  academicYear: { name: string } | null;
  medium: { nameEn: string } | null;
  standard: { nameEn: string } | null;
  schoolClass: { displayName: string } | null;
  updatedAt: string;
}

export interface NumberSequence {
  id: number;
  seqKey: string;
  label: string;
  pattern: string;
  nextValue: number;
  preview: string;
}

export interface Staff {
  id: number;
  employeeCode: string;
  name: string;
  nameHi: string | null;
  mobile: string | null;
  email: string | null;
  addressLine: string | null;
  joiningDate: string | null;
  designation: string | null;
  employmentType: string | null;
  status: string;
  user: { id: number; username: string; status: string } | null;
}

export interface Assignment {
  id: number;
  academicYearId: number;
  staffId: number;
  role: 'OPERATOR' | 'SUBJECT_TEACHER' | 'CLASS_TEACHER' | 'ATTENDANCE_VERIFIER';
  sectionId: number;
  classSubjectId: number | null;
  validFrom: string;
  validTo: string | null;
  status: string;
  staff: { id: number; name: string; employeeCode: string };
  section: { id: number; name: string; schoolClass: { id: number; displayName: string; medium: { id: number; code: string } } };
  classSubject: { id: number; subject: { id: number; nameEn: string; shortName: string | null; code: string } } | null;
}

export interface StaffDetail extends Staff {
  currentYear: { id: number; name: string } | null;
  assignments: Assignment[];
  workload: { classTeacherOf: number; subjectPeriods: number; attendanceDivisions: number; operatorDivisions: number };
}

export interface Role {
  id: number;
  code: string;
  name: string;
  isSystem: boolean;
  defaultScope: string;
  userCount: number;
  permissions: string[];
}

export interface User {
  id: number;
  username: string;
  mobile: string | null;
  email: string | null;
  status: 'ACTIVE' | 'DISABLED';
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  staffId: number | null;
  staff: { id: number; name: string; employeeCode: string } | null;
  roles: { id: number; roleId: number; scopeType: string; scopeId: number | null; role: { id: number; code: string; name: string } }[];
}

export interface AuditLog {
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  createdAt: string;
}

export interface SetupSummary {
  currentYear: { id: number; name: string; startDate: string; endDate: string } | null;
  counts: { mediums: number; standards: number; classes: number; sections: number; subjects: number; staff: number; users: number; gradingSystems: number };
  gaps: { profileIncomplete: boolean; sectionsWithoutClassTeacher: number; sectionsWithoutOperator: number; classesWithoutSubjects: number; subjectSlotsWithoutTeacher: number };
}

// ---------- students ----------
export interface SectionRef {
  id: number;
  name: string;
  schoolClass: { id: number; displayName: string; code: string; medium: { id: number; code: string; nameEn: string }; standard: { id: number; code: string; levelOrder: number } };
}

export interface StudentRow {
  id: number;
  enrollmentId: number;
  studentCode: string;
  correctionNote?: string | null;
  grNo: string | null;
  grNoTemp?: boolean;
  fullName: string;
  fullNameHi: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  status: string;
  photoFileId: number | null;
  rollNo: number | null;
  examNo: string | null;
  section: SectionRef;
  dob: string | null;
  primaryContact: { name: string; mobile: string | null } | null;
}

export interface StudentGuardianView {
  id: number;
  relation: 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'OTHER';
  isPrimary: boolean;
  name: string;
  nameHi: string | null;
  mobile: string | null;
  altMobile: string | null;
  occupation: string | null;
  education: string | null;
  annualIncome: string | null;
  whatsapp: string | null;
  email: string | null;
}

export interface Enrollment {
  id: number;
  academicYearId: number;
  sectionId: number;
  rollNo: number | null;
  examNo: string | null;
  joinedOn: string;
  leftOn: string | null;
  status: string;
  finalResult: string | null;
  section: SectionRef;
  academicYear: { id: number; name: string; isCurrent: boolean };
}

export interface StudentDetail {
  id: number;
  version: number;
  studentCode: string;
  admissionFormNo: string | null;
  grNo: string | null;
  grNoTemp?: boolean;
  schoolUid: string | null;
  saralId: string | null;
  apaarId: string | null;
  fullName: string;
  fullNameHi: string | null;
  surname: string | null;
  firstName: string | null;
  fatherName: string | null;
  motherName: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  dob: string | null;
  birthPlace: string | null;
  motherTongue: string | null;
  bloodGroup: string | null;
  religion: string | null;
  category: string | null;
  caste: string | null;
  aadhaarLast4: string | null;
  addressLine: string | null;
  city: string | null;
  pincode: string | null;
  admissionDate: string | null;
  previousSchool: string | null;
  previousClass: string | null;
  previousSchoolYear: string | null;
  previousLcNo: string | null;
  previousLcDate: string | null;
  nationality: string | null;
  subCaste: string | null;
  isRte: boolean;
  cwsn: string | null;
  transportMode: string | null;
  documents: string[] | null;
  photoFileId: number | null;
  status: string;
  notes: string | null;
  pen: string | null;
  identificationMarks: string | null;
  heightCm: number | null;
  weightKg: number | null;
  medicalNotes: string | null;
  emergencyName: string | null;
  emergencyRelation: string | null;
  emergencyMobile: string | null;
  siblingsInSchool: string | null;
  isBpl: boolean | null;
  isMinority: boolean | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  documentFiles: StudentDocumentFile[];
  siblings: { id: number; fullName: string; grNo: string; section: SectionRef | null }[];
  guardians: StudentGuardianView[];
  enrollments: Enrollment[];
  statusHistory: { id: number; fromStatus: string | null; toStatus: string; effectiveDate: string; reason: string; createdAt: string }[];
  current: Enrollment;
  classTeacher: { id: number; name: string } | null;
  operators: { id: number; name: string }[];
  access: { contact: boolean; sensitive: boolean; edit: boolean; changeStatus: boolean; approveAdmission: boolean; editGrNo: boolean; editEnrollment: boolean };
  correctionNote: string | null;
  correctionRequestedAt: string | null;
}

export interface StudentDocumentFile { id: number; docType: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }

export interface StudentDuplicate {
  id: number; fullName: string; grNo: string; dob: string | null; motherName: string | null; status: string;
  section: SectionRef | null; year: string | null; reasons: string[];
}

export interface DivisionOverview {
  sectionId: number;
  name: string;
  capacity: number | null;
  schoolClass: SectionRef['schoolClass'];
  students: number;
  girls: number;
  boys: number;
  classTeacher: { id: number; name: string } | null;
  operators: { id: number; name: string }[];
  myRoles: ('OPERATOR' | 'SUBJECT_TEACHER' | 'CLASS_TEACHER' | 'ATTENDANCE_VERIFIER')[];
}

export interface StudentsOverview {
  year: { id: number; name: string; startDate: string; endDate: string };
  scopeAll: boolean;
  totals: { students: number; girls: number; boys: number; divisions: number };
  byMedium: { code: string; name: string; students: number; divisions: number }[];
  sections: DivisionOverview[];
}
