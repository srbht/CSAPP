import { z } from 'zod';
import {
  ACADEMIC_YEAR_STATUS, ASSIGNMENT_ROLES, BLOOD_GROUPS, GENDERS, GUARDIAN_RELATIONS, RECORD_STATUS,
  REPORT_ROLLUP, STUDENT_STATUS, SUBJECT_AREAS, SUBJECT_TYPES, USER_STATUS,
} from './enums';
import { SCOPE_TYPES } from './permissions';
import { isValidPattern } from './sequences';

// ---------- primitives ----------
const trimmed = (max: number) => z.string().trim().max(max);
const required = (max: number, label = 'This field') => trimmed(max).min(1, `${label} is required`);
const optionalText = (max: number) =>
  trimmed(max).optional().nullable().transform((v) => (v === '' || v == null ? null : v));
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use date format YYYY-MM-DD');
export const id = z.coerce.number().int().positive();
export const mobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');
/** Optional field where '' / null / missing all mean "no value" (stored as NULL). Zod 4 needs .optional() outside the union. */
const blankable = <T extends z.ZodType>(schema: T) =>
  z.union([z.literal(''), z.null(), schema]).optional().transform((v) => (v ? (v as z.infer<T>) : null));
const optionalMobile = blankable(mobile);
const optionalEmail = blankable(z.string().trim().email('Enter a valid email').max(150));
const code = (max = 20) =>
  z.string().trim().min(1, 'Code is required').max(max).regex(/^[A-Za-z0-9_.-]+$/, 'Use letters, numbers, - _ . only');

// ---------- list query ----------
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(40).optional(),
  status: z.string().trim().max(20).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

// ---------- auth ----------
export const loginSchema = z.object({
  login: required(150, 'Username or mobile'),
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const passwordPolicy = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use letters and numbers');

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordPolicy,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })
  .refine((d) => d.newPassword !== d.currentPassword, { path: ['newPassword'], message: 'New password must be different' });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const preferencesSchema = z.object({
  language: z.enum(['en', 'hi']).optional(),
  academicYearId: id.nullable().optional(),
  mediumId: id.nullable().optional(),
});

// ---------- school ----------
export const schoolProfileSchema = z.object({
  name: required(200, 'School name'),
  nameHi: optionalText(200),
  motto: optionalText(200),
  addressLine: required(300, 'Address'),
  city: optionalText(80),
  state: optionalText(80),
  pincode: blankable(z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits')),
  phone: optionalText(20),
  email: optionalEmail,
  website: optionalText(200),
  udiseCode: optionalText(20),
  registrationNo: optionalText(80),
  board: optionalText(80),
  principalName: optionalText(150),
  principalTitle: optionalText(80),
});
export type SchoolProfileInput = z.infer<typeof schoolProfileSchema>;

// ---------- academic years ----------
export const academicYearSchema = z
  .object({
    name: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Use format 2026-27'),
    startDate: isoDate,
    endDate: isoDate,
    weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(6).default([0]),
  })
  .refine((d) => d.endDate > d.startDate, { path: ['endDate'], message: 'End date must be after start date' });
export type AcademicYearInput = z.infer<typeof academicYearSchema>;

export const academicTermSchema = z
  .object({
    code: code(20),
    nameEn: required(80, 'Name'),
    nameHi: optionalText(80),
    startDate: isoDate,
    endDate: isoDate,
    sequence: z.coerce.number().int().min(1).max(20),
  })
  .refine((d) => d.endDate >= d.startDate, { path: ['endDate'], message: 'End date must be on/after start date' });
export type AcademicTermInput = z.infer<typeof academicTermSchema>;
export const academicYearStatusSchema = z.enum(ACADEMIC_YEAR_STATUS);

// ---------- mediums & standards ----------
export const mediumSchema = z.object({
  code: code(10),
  nameEn: required(60, 'Name'),
  nameHi: optionalText(60),
  examNoPrefix: optionalText(5),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  status: z.enum(RECORD_STATUS).default('ACTIVE'),
});
export type MediumInput = z.infer<typeof mediumSchema>;

export const standardSchema = z.object({
  code: code(10),
  nameEn: required(40, 'Name'),
  nameHi: optionalText(40),
  levelOrder: z.coerce.number().int().min(-5).max(20),
  status: z.enum(RECORD_STATUS).default('ACTIVE'),
});
export type StandardInput = z.infer<typeof standardSchema>;

// ---------- classes & sections ----------
export const classSchema = z.object({
  academicYearId: id,
  mediumId: id,
  standardId: id,
  displayName: optionalText(60),
  gradingSystemId: id.nullable().optional(),
  status: z.enum(RECORD_STATUS).default('ACTIVE'),
});
export type ClassInput = z.infer<typeof classSchema>;

export const sectionSchema = z.object({
  name: z.string().trim().min(1, 'Division is required').max(10).transform((v) => v.toUpperCase()),
  capacity: z.coerce.number().int().min(1).max(500).nullable().optional(),
  room: optionalText(30),
  status: z.enum(RECORD_STATUS).default('ACTIVE'),
});
export type SectionInput = z.infer<typeof sectionSchema>;

// ---------- subjects ----------
export const subjectSchema = z.object({
  mediumId: id,
  code: code(20),
  nameEn: required(100, 'Name'),
  nameHi: optionalText(100),
  shortName: optionalText(20),
  subjectType: z.enum(SUBJECT_TYPES),
  area: z.enum(SUBJECT_AREAS).default('SCHOLASTIC'),
  parentSubjectId: id.nullable().optional(),
  status: z.enum(RECORD_STATUS).default('ACTIVE'),
});
export type SubjectInput = z.infer<typeof subjectSchema>;

export const classSubjectItemSchema = z
  .object({
    subjectId: id,
    isOptional: z.boolean().default(false),
    optionalGroup: optionalText(30),
    includeInTotal: z.boolean().default(true),
    defaultMaxMarks: z.coerce.number().positive().max(1000).nullable().optional(),
    defaultPassMarks: z.coerce.number().min(0).max(1000).nullable().optional(),
    gradingSystemId: id.nullable().optional(),
    reportRollup: z.enum(REPORT_ROLLUP).default('SELF'),
    displayOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .refine((d) => d.defaultPassMarks == null || d.defaultMaxMarks == null || d.defaultPassMarks <= d.defaultMaxMarks, {
    path: ['defaultPassMarks'],
    message: 'Pass marks cannot exceed maximum marks',
  });
export const classSubjectsSchema = z.object({ items: z.array(classSubjectItemSchema).max(60) });
export type ClassSubjectItemInput = z.infer<typeof classSubjectItemSchema>;

// ---------- grading ----------
export const gradeBandSchema = z.object({
  grade: required(5, 'Grade'),
  minPercent: z.coerce.number().min(0).max(100),
  maxPercent: z.coerce.number().min(0).max(100),
  gradePoint: z.coerce.number().min(0).max(100).nullable().optional(),
  labelEn: optionalText(60),
  labelHi: optionalText(60),
  isPass: z.boolean(),
});
export const gradingSystemSchema = z.object({
  name: required(80, 'Name'),
  status: z.enum(RECORD_STATUS).default('ACTIVE'),
  bands: z.array(gradeBandSchema).min(1).max(20),
});
export type GradingSystemInput = z.infer<typeof gradingSystemSchema>;

// ---------- policies ----------
export const policyScopeSchema = z.object({
  academicYearId: id.nullable().optional(),
  mediumId: id.nullable().optional(),
  standardId: id.nullable().optional(),
  classId: id.nullable().optional(),
});
export const policyUpsertSchema = policyScopeSchema.extend({
  policyKey: z.string().min(1).max(60),
  value: z.unknown(),
});

// ---------- sequences ----------
export const sequenceUpdateSchema = z.object({
  pattern: z.string().trim().refine(isValidPattern, 'Pattern must contain exactly one {000} placeholder'),
  nextValue: z.coerce.number().int().min(1).max(999999999),
});

// ---------- staff ----------
// Staff schemas live in office.ts (registration by the office, assignment by the Headmaster).

export const assignmentSchema = z
  .object({
    academicYearId: id,
    staffId: id,
    role: z.enum(ASSIGNMENT_ROLES),
    sectionId: id,
    classSubjectId: id.nullable().optional(),
    validFrom: isoDate.optional(),
  })
  .refine((d) => d.role !== 'SUBJECT_TEACHER' || d.classSubjectId != null, {
    path: ['classSubjectId'],
    message: 'Subject is required for a subject teacher',
  });
export type AssignmentInput = z.infer<typeof assignmentSchema>;

// ---------- users & roles ----------
export const userRoleGrantSchema = z.object({
  roleId: id,
  scopeType: z.enum(SCOPE_TYPES).default('SCHOOL'),
  scopeId: id.nullable().optional(),
});
export const userCreateSchema = z.object({
  username: z.string().trim().min(3, 'At least 3 characters').max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, . _ - only'),
  mobile: optionalMobile,
  email: optionalEmail,
  staffId: id.nullable().optional(),
  temporaryPassword: passwordPolicy,
  roles: z.array(userRoleGrantSchema).min(1, 'Assign at least one role'),
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export const userUpdateSchema = z.object({
  mobile: optionalMobile,
  email: optionalEmail,
  staffId: id.nullable().optional(),
  status: z.enum(USER_STATUS),
  roles: z.array(userRoleGrantSchema).min(1, 'Assign at least one role'),
});
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
export const resetPasswordSchema = z.object({ temporaryPassword: passwordPolicy });

export const roleSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Use CAPITALS, numbers and _'),
  name: required(80, 'Name'),
  permissions: z.array(z.string().max(80)).max(200),
});
export type RoleInput = z.infer<typeof roleSchema>;
export const roleUpdateSchema = roleSchema.omit({ code: true });

// ---------- students ----------
export const guardianInputSchema = z.object({
  relation: z.enum(GUARDIAN_RELATIONS),
  name: required(150, 'Name'),
  nameHi: optionalText(150),
  mobile: optionalMobile,
  altMobile: optionalMobile,
  occupation: optionalText(100),
  education: optionalText(60),
  annualIncome: optionalText(40),
  whatsapp: optionalMobile,
  email: optionalEmail,
  isPrimary: z.boolean().default(false),
});
export type GuardianInput = z.infer<typeof guardianInputSchema>;

/** Master record. GR No and exam no are generated from Number Formats when left blank. */
export const studentSchema = z
  .object({
    fullName: required(250, 'Full name'),
    fullNameHi: optionalText(250),
    surname: optionalText(80),
    firstName: optionalText(80),
    fatherName: optionalText(120),
    motherName: optionalText(120),
    gender: z.enum(GENDERS, { message: 'Choose boy, girl or other' }),
    dob: blankable(isoDate),
    birthPlace: optionalText(100),
    motherTongue: optionalText(40),
    bloodGroup: blankable(z.enum(BLOOD_GROUPS)),
    religion: optionalText(40),
    category: optionalText(30),
    caste: optionalText(80),
    aadhaarLast4: blankable(z.string().trim().regex(/^\d{4}$/, 'Only the last 4 digits')),
    addressLine: optionalText(300),
    city: optionalText(80),
    pincode: blankable(z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits')),
    admissionDate: blankable(isoDate),
    previousSchool: optionalText(200),
    previousClass: optionalText(20),
    previousSchoolYear: blankable(z.string().trim().regex(/^\d{4}(-\d{2})?$/, 'Year like 2025-26 or 2025')),
    previousLcNo: optionalText(40),
    previousLcDate: blankable(isoDate),
    nationality: optionalText(40),
    subCaste: optionalText(80),
    isRte: z.boolean().default(false),
    cwsn: optionalText(60),
    transportMode: optionalText(30),
    documents: z.array(z.string().max(60)).max(20).default([]),
    grNo: optionalText(30),
    schoolUid: optionalText(40),
    saralId: optionalText(30),
    apaarId: optionalText(20),
    pen: blankable(z.string().trim().regex(/^[0-9A-Za-z]{5,20}$/, 'PEN has only letters and numbers (11 digits on UDISE+)')),
    identificationMarks: optionalText(200),
    heightCm: blankable(z.coerce.number().int('Whole centimetres').min(40, 'Height looks too small').max(220, 'Height looks too large')),
    weightKg: blankable(z.coerce.number().min(5, 'Weight looks too small').max(150, 'Weight looks too large')),
    medicalNotes: optionalText(500),
    emergencyName: optionalText(120),
    emergencyRelation: optionalText(40),
    emergencyMobile: optionalMobile,
    siblingsInSchool: optionalText(300),
    isBpl: z.boolean().default(false),
    isMinority: z.boolean().default(false),
    bankAccountNo: blankable(z.string().trim().regex(/^\d{9,18}$/, 'Account number is 9 to 18 digits')),
    bankIfsc: blankable(z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like SBIN0001234')),
    bankName: optionalText(100),
    notes: optionalText(2000),
    guardians: z.array(guardianInputSchema).max(4).default([]),
  })
  .refine((d) => new Set(d.guardians.filter((g) => g.relation !== 'OTHER' && g.relation !== 'GUARDIAN').map((g) => g.relation)).size === d.guardians.filter((g) => g.relation !== 'OTHER' && g.relation !== 'GUARDIAN').length, {
    path: ['guardians'], message: 'Father and mother can be entered only once each',
  });
export type StudentInput = z.infer<typeof studentSchema>;

/** Place in the current year. Roll no / exam no are allocated when blank. */
export const enrollmentInputSchema = z.object({
  sectionId: id,
  rollNo: z.union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(999)]).optional().transform((v) => (v === '' || v == null ? null : v)),
  examNo: optionalText(20),
  joinedOn: blankable(isoDate),
});
export type EnrollmentInput = z.infer<typeof enrollmentInputSchema>;

export const studentCreateSchema = z.object({ student: studentSchema, enrollment: enrollmentInputSchema });
export type StudentCreateInput = z.infer<typeof studentCreateSchema>;

/** Live "is this child already in the school?" check on the admission form. */
export const studentDuplicateQuerySchema = z.object({
  fullName: z.string().trim().max(250).optional(),
  dob: z.union([z.literal(''), isoDate]).optional(),
  motherName: z.string().trim().max(120).optional(),
  excludeId: z.coerce.number().int().positive().optional(),
});
export type StudentDuplicateQuery = z.infer<typeof studentDuplicateQuerySchema>;

export const studentDocumentUploadSchema = z.object({ docType: z.string().trim().min(1, 'Choose the document type').max(60) });

export const studentStatusSchema = z.object({
  status: z.enum(STUDENT_STATUS),
  effectiveDate: isoDate,
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});
export type StudentStatusInput = z.infer<typeof studentStatusSchema>;

export const studentListQuerySchema = listQuerySchema.extend({
  academicYearId: z.coerce.number().int().positive().optional(),
  mediumId: z.coerce.number().int().positive().optional(),
  classId: z.coerce.number().int().positive().optional(),
  sectionId: z.coerce.number().int().positive().optional(),
  gender: z.enum(GENDERS).optional(),
  /** TEMP: waiting for a new GR No after promotion into Std I / V; MISSING: no GR No yet. */
  gr: z.enum(['TEMP', 'MISSING']).optional(),
});
export type StudentListQuery = z.infer<typeof studentListQuerySchema>;
