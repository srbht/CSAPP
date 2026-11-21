import { z } from 'zod';
import { BLOOD_GROUPS, EMPLOYMENT_TYPES, GENDERS } from './enums';
import { PAYMENT_MODES } from './fees';
import { mobile } from './schemas';

/**
 * Office management: staff registration (office) and assignment (Headmaster), expenses and payment vouchers.
 */

// ---------- staff ----------
export const STAFF_STATUSES = ['PENDING_ASSIGNMENT', 'ACTIVE', 'INACTIVE', 'RESIGNED'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export const STAFF_STATUS_LABELS: Record<StaffStatus, string> = { PENDING_ASSIGNMENT: 'Pending assignment', ACTIVE: 'Active', INACTIVE: 'Inactive', RESIGNED: 'Resigned' };
export const EMPLOYEE_TYPES = ['TEACHING', 'NON_TEACHING'] as const;
export type EmployeeType = (typeof EMPLOYEE_TYPES)[number];
export const EMPLOYEE_TYPE_LABELS: Record<EmployeeType, string> = { TEACHING: 'Teaching', NON_TEACHING: 'Non-teaching' };
export const EMPLOYMENT_TYPE_LABELS: Record<(typeof EMPLOYMENT_TYPES)[number], string> = { PERMANENT: 'Permanent', CONTRACT: 'Contract', TEMPORARY: 'Temporary', PART_TIME: 'Part-time' };
export const DESIGNATIONS = [
  'Headmaster', 'Head Mistress', 'Supervisor', 'Exam Coordinator', 'Teacher', 'Assistant Teacher', 'Pre-primary Teacher', 'PT Teacher', 'Computer Teacher',
  'Art Teacher', 'Music Teacher', 'Librarian', 'Lab Assistant', 'Office Clerk', 'Accountant', 'Data Entry Operator', 'Receptionist', 'Peon',
  'Ayah', 'Driver', 'Security Guard', 'Sweeper', 'Other',
] as const;
export const DEPARTMENTS = ['Pre-primary', 'Primary', 'Secondary', 'Administration', 'Accounts', 'Examination', 'Library', 'Sports', 'Transport', 'Support staff'] as const;
export const SALARY_MODES = ['CASH', 'BANK_TRANSFER', 'UPI'] as const;
export const SALARY_MODE_LABELS: Record<(typeof SALARY_MODES)[number], string> = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', UPI: 'UPI' };

const text = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const blank = <T extends z.ZodType>(s: T) => z.union([z.literal(''), z.null(), s]).optional().transform((v) => (v ? (v as z.infer<T>) : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use date format YYYY-MM-DD');

/** What the office may enter. */
export const STAFF_PERSONAL_FIELDS = ['name', 'nameHi', 'gender', 'dob', 'fatherOrSpouseName', 'mobile', 'altMobile', 'email', 'addressLine', 'bloodGroup'] as const;
/** Headmaster / Super Admin only. */
export const STAFF_EMPLOYMENT_FIELDS = ['employeeType', 'designation', 'department', 'qualification', 'joiningDate', 'employmentType', 'reportingManagerId', 'leavingDate', 'remarks'] as const;
/** Authorised users only (salary permission). */
export const STAFF_SALARY_FIELDS = ['monthlySalary', 'salaryMode', 'bankAccountHolder', 'bankName', 'bankAccountNo', 'bankIfsc'] as const;

/**
 * One schema for every staff save. The API checks WHO may send which group of fields:
 * personal (staff.register), employment + status (staff.manage), salary (staff.salary).
 */
export const staffSchema = z.object({
  employeeCode: blank(z.string().trim().max(20).regex(/^[A-Za-z0-9_.-]+$/, 'Use letters, numbers, - _ . only')),
  name: z.string().trim().min(1, 'Name is required').max(150),
  nameHi: text(150),
  gender: blank(z.enum(GENDERS)),
  dob: blank(isoDate),
  fatherOrSpouseName: text(150),
  mobile: blank(mobile),
  altMobile: blank(mobile),
  email: blank(z.string().trim().email('Enter a valid email').max(150)),
  addressLine: text(300),
  bloodGroup: blank(z.enum(BLOOD_GROUPS)),
  employeeType: blank(z.enum(EMPLOYEE_TYPES)),
  designation: text(60),
  department: text(60),
  qualification: text(150),
  joiningDate: blank(isoDate),
  employmentType: blank(z.enum(EMPLOYMENT_TYPES)),
  reportingManagerId: blank(z.coerce.number().int().positive()),
  leavingDate: blank(isoDate),
  remarks: text(1000),
  monthlySalary: blank(z.coerce.number().min(0).max(10_000_000)),
  salaryMode: blank(z.enum(SALARY_MODES)),
  bankAccountHolder: text(150),
  bankName: text(100),
  bankAccountNo: blank(z.string().trim().regex(/^\d{9,18}$/, 'Account number is 9 to 18 digits')),
  bankIfsc: blank(z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like SBIN0001234')),
  status: z.enum([...STAFF_STATUSES, 'INACTIVE']).optional(),
});
export type StaffInput = z.infer<typeof staffSchema>;

/** Fields the office must fill when registering (the API enforces these for new registrations). */
export const staffRegistrationSchema = staffSchema.superRefine((d, ctx) => {
  if (!d.gender) ctx.addIssue({ code: 'custom', path: ['gender'], message: 'Choose the gender' });
  if (!d.dob) ctx.addIssue({ code: 'custom', path: ['dob'], message: 'Date of birth is required' });
  if (!d.mobile) ctx.addIssue({ code: 'custom', path: ['mobile'], message: 'Mobile number is required' });
  if (!d.addressLine) ctx.addIssue({ code: 'custom', path: ['addressLine'], message: 'Address is required' });
});

export const staffStatusSchema = z.object({
  status: z.enum(STAFF_STATUSES),
  reason: z.string().trim().min(3, 'Give a reason').max(300),
  leavingDate: blank(isoDate),
});

// ---------- expenses ----------
export const EXPENSE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = { PENDING: 'Pending approval', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
export const EXPENSE_MODES = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const satisfies readonly (typeof PAYMENT_MODES)[number][];
export type ExpenseMode = (typeof EXPENSE_MODES)[number];
export const SALARY_CATEGORY_CODE = 'STAFF_SALARY';
/** Created for every school; more can be added by the Headmaster / Super Admin. */
export const DEFAULT_EXPENSE_CATEGORIES: { code: string; name: string; isSalary?: boolean }[] = [
  { code: 'ELECTRICITY', name: 'Electricity Bill' }, { code: 'WATER', name: 'Water Bill' }, { code: 'INTERNET_PHONE', name: 'Internet & Telephone' },
  { code: 'STATIONERY', name: 'Stationery & Printing' }, { code: 'MAINTENANCE', name: 'Maintenance & Repairs' }, { code: 'CLEANING', name: 'Cleaning Expenses' },
  { code: SALARY_CATEGORY_CODE, name: 'Staff Salary', isSalary: true }, { code: 'TRANSPORT', name: 'Transportation' },
  { code: 'EVENTS', name: 'School Events & Functions' }, { code: 'FURNITURE', name: 'Furniture & Equipment' }, { code: 'OFFICE', name: 'Office Expenses' },
  { code: 'MISC', name: 'Miscellaneous Expenses' },
];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

export const expenseCategorySchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const expenseSchema = z.object({
  expenseDate: isoDate,
  categoryId: z.coerce.number().int().positive({ message: 'Choose a category' }),
  title: z.string().trim().min(2, 'Title is required').max(150),
  description: z.string().trim().min(2, 'Description is required').max(2000),
  paidTo: z.string().trim().min(2, '"Paid to" is required').max(150),
  amount: z.coerce.number().positive('Enter an amount more than 0').max(10_000_000),
  mode: z.enum(EXPENSE_MODES),
  reference: text(80),
  billNo: text(60),
  remarks: text(1000),
  // Staff salary only
  staffId: blank(z.coerce.number().int().positive()),
  salaryMonth: blank(z.coerce.number().int().min(1).max(12)),
  salaryYear: blank(z.coerce.number().int().min(2000).max(2100)),
  /** Pay again for a staff member and month that already has a salary voucher (a deliberate second part payment). */
  confirmAdditional: z.boolean().default(false),
  /** Required when an approved voucher is corrected. */
  reason: text(300),
}).refine((e) => e.mode === 'CASH' || !!e.reference, { path: ['reference'], message: 'Enter the UPI / bank / cheque reference' });
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseDecisionSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

