import { z } from 'zod';

/**
 * Approval workflow (docs/07). Every unit of work (one subject's marks in one exam for one division, or one
 * division's attendance for one month) passes Operator → Subject Teacher → Class Teacher → Headmaster.
 * For attendance the first check is done by the division's Attendance Verifier, or the Class Teacher if none.
 */
export const RECORD_TYPES = ['MARKS', 'ATTENDANCE'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Ordered stages. A row's `passedStage` is the last stage it has passed. */
export const STAGES = ['OPERATOR', 'SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE', 'DONE'] as const;
export type Stage = (typeof STAGES)[number];
export const REVIEW_STAGES: Stage[] = ['SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE'];
export const stageIndex = (s: string) => STAGES.indexOf(s as Stage);

/** RETURNED (mark sheets): sent back one step by the step above; the holder sends it further down or back up. */
export const SUBMISSION_STATUS = ['DRAFT', 'SUBMITTED', 'CORRECTION_REQUIRED', 'APPROVED', 'RETURNED'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[number];
export const ROW_STATUS = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

/** Where a unit of work is, in words people use. NOT_STARTED = nothing saved yet. */
export const PROGRESS_BUCKETS = ['NOT_STARTED', 'OPERATOR', 'CORRECTION', 'SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE', 'APPROVED'] as const;
export type ProgressBucket = (typeof PROGRESS_BUCKETS)[number];
export const PROGRESS_LABELS: Record<ProgressBucket, string> = {
  NOT_STARTED: 'Not started',
  OPERATOR: 'Operator entering',
  CORRECTION: 'Sent back for correction',
  SUBJECT_VERIFY: 'Waiting for subject teacher',
  CLASS_APPROVE: 'Waiting for class teacher',
  HEADMASTER_APPROVE: 'Waiting for Headmaster',
  APPROVED: 'Approved',
};
export const STAGE_ACTOR: Record<string, string> = {
  OPERATOR: 'Operator', SUBJECT_VERIFY: 'Subject teacher', CLASS_APPROVE: 'Class teacher', HEADMASTER_APPROVE: 'Headmaster', DONE: 'Approved',
};
export const ATTENDANCE_STAGE_ACTOR: Record<string, string> = {
  ...STAGE_ACTOR, SUBJECT_VERIFY: 'Attendance verifier',
};

export function progressBucket(sub: { stage: string; status: string } | null | undefined): ProgressBucket {
  if (!sub) return 'NOT_STARTED';
  if (sub.status === 'APPROVED') return 'APPROVED';
  if (sub.status === 'CORRECTION_REQUIRED') return 'CORRECTION';
  if (sub.stage === 'OPERATOR') return 'OPERATOR';
  return sub.stage as ProgressBucket;
}

// ---------- exams ----------
/** Exams follow the Greensheet: Semester I (FE-I + SE-I) and Semester II (FE-II + SE-II). Unit tests were removed. */
export const EXAM_KINDS = ['SEMESTER'] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];
export const REPORT_TERMS = ['TERM1', 'FINAL'] as const;
export type ReportTerm = (typeof REPORT_TERMS)[number];
export const REPORT_TERM_LABELS: Record<ReportTerm, string> = { TERM1: 'Semester I report card', FINAL: 'Final (annual) report card' };

/** "I" or "II": which Formative / Summative Evaluation a semester exam holds. */
export const evaluationNo = (reportTerm: string | null | undefined) => (reportTerm === 'TERM2' ? 'II' : 'I');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use date format YYYY-MM-DD');
export const examSchema = z.object({
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only').transform((v) => v.toUpperCase()),
  nameEn: z.string().trim().min(1, 'Name is required').max(80),
  nameHi: z.string().trim().max(80).optional().nullable(),
  kind: z.enum(EXAM_KINDS).default('SEMESTER'),
  reportTerm: z.enum(['TERM1', 'TERM2'], { message: 'Choose Semester I or Semester II' }),
  sequence: z.coerce.number().int().min(1).max(20),
  marksDueDate: z.union([z.literal(''), z.null(), isoDate]).optional().transform((v) => v || null),
});
export type ExamInput = z.infer<typeof examSchema>;


// ---------- entry ----------
const mark = z.union([z.literal(''), z.null(), z.coerce.number().min(0).max(1000)]).optional().transform((v) => (v === '' || v == null ? null : v));
export const unitKeySchema = z.discriminatedUnion('recordType', [
  z.object({ recordType: z.literal('MARKS'), examId: z.coerce.number().int().positive(), sectionId: z.coerce.number().int().positive(), classSubjectId: z.coerce.number().int().positive() }),
  z.object({ recordType: z.literal('ATTENDANCE'), sectionId: z.coerce.number().int().positive(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') }),
]);
export type UnitKey = z.infer<typeof unitKeySchema>;

export const saveRowsSchema = z.object({
  unit: unitKeySchema,
  workingDays: z.union([z.literal(''), z.null(), z.coerce.number().min(0).max(31)]).optional().transform((v) => (v === '' || v == null ? null : v)),
  rows: z.array(z.object({
    enrollmentId: z.coerce.number().int().positive(),
    /** Greensheet parts (OBS, Oral, … Written); the Formative and Summative totals are calculated from them. */
    parts: z.record(z.string().max(20), z.union([z.string().regex(/^\s*(ab|c)\s*$/i).transform((v) => v.trim().toUpperCase() as 'AB' | 'C'), mark])).optional(),
    absent: z.boolean().optional(), presentDays: mark,
    version: z.coerce.number().int().optional(),
  })).max(200),
});
export type SaveRowsInput = z.infer<typeof saveRowsSchema>;

export const decisionSchema = z.object({ comment: z.string().trim().max(500).optional() });
export const rejectSchema = z.object({
  reason: z.string().trim().min(3, 'Write a short note: what should be checked or corrected').max(300),
  enrollmentIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
});
export type RejectInput = z.infer<typeof rejectSchema>;

// ---------- remarks & report cards ----------
export const remarksSchema = z.object({
  term: z.enum(REPORT_TERMS),
  items: z.array(z.object({
    enrollmentId: z.coerce.number().int().positive(),
    progress: z.string().trim().max(60).optional().nullable(),
    conduct: z.string().trim().max(60).optional().nullable(),
    remark: z.string().trim().max(300).optional().nullable(),
  })).max(200),
});
export const PROGRESS_SUGGESTIONS = ['EXCELLENT', 'VERY GOOD', 'GOOD', 'SATISFACTORY', 'NEEDS IMPROVEMENT'] as const;
export const CONDUCT_SUGGESTIONS = ['EXCELLENT', 'VERY GOOD', 'GOOD', 'SATISFACTORY'] as const;

/** YYYY-MM months from start to end (inclusive), e.g. June–October. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.slice(0, 7).split('-').map(Number);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
export const monthLabel = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};
