import { z } from 'zod';

export const WORKFLOW_STAGES = ['SUBJECT_VERIFY', 'CLASS_APPROVE', 'COORDINATOR_VERIFY', 'HEADMASTER_APPROVE'] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
export const MANDATORY_STAGES: WorkflowStage[] = ['SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE'];

/**
 * Policy catalog: every configurable business rule. Values are stored in `policies` per scope
 * (school → year → medium → standard → class); the most specific scope wins.
 * Defaults reflect what the school's own files show (see docs/00 and docs/04).
 */
export interface PolicyDef<T = unknown> {
  key: string;
  group: 'Attendance' | 'Marks' | 'Result' | 'Workflow' | 'Report Card';
  label: string;
  description: string;
  schema: z.ZodType<T>;
  default: T;
  /** UI hint */
  input: 'number' | 'percent' | 'select' | 'boolean' | 'stages';
  options?: { value: string; label: string }[];
}

const def = <T>(d: PolicyDef<T>) => d;

export const POLICY_DEFS = [
  def({
    key: 'attendance.half_day_weight', group: 'Attendance', label: 'Half day counts as',
    description: 'Present-day value of a Half Day mark.', schema: z.number().min(0).max(1), default: 0.5, input: 'number',
  }),
  def({
    key: 'attendance.leave_mode', group: 'Attendance', label: 'Leave is treated as',
    description: 'How Leave affects the attendance percentage. Leave is always shown separately.',
    schema: z.enum(['COUNT_AS_ABSENT', 'EXCLUDE_FROM_WORKING_DAYS', 'COUNT_AS_PRESENT']), default: 'COUNT_AS_ABSENT' as const,
    input: 'select',
    options: [
      { value: 'COUNT_AS_ABSENT', label: 'Absent' },
      { value: 'EXCLUDE_FROM_WORKING_DAYS', label: 'Not a working day for the student' },
      { value: 'COUNT_AS_PRESENT', label: 'Present' },
    ],
  }),
  def({
    key: 'attendance.low_threshold_percent', group: 'Attendance', label: 'Low attendance below (%)',
    description: 'Students below this cumulative percentage are flagged (the school highlights below 75%).',
    schema: z.number().min(0).max(100), default: 75, input: 'percent',
  }),
  def({
    key: 'attendance.count_from_join_date', group: 'Attendance', label: 'Count working days from admission date',
    description: 'A student admitted mid-month is not counted absent for days before admission.',
    schema: z.boolean(), default: true, input: 'boolean',
  }),
  def({
    key: 'attendance.edit_window_hours', group: 'Attendance', label: 'Teacher edit window (hours)',
    description: 'After this, changes need a correction request.', schema: z.number().int().min(0).max(720), default: 24, input: 'number',
  }),
  def({
    key: 'marks.decimals', group: 'Marks', label: 'Decimal places in marks',
    description: '0 = whole marks only, 1 = allow half marks such as 12.5', schema: z.number().int().min(0).max(2), default: 0, input: 'number',
  }),
  def({
    key: 'marks.absent_policy', group: 'Marks', label: 'Absent in exam',
    description: 'How an absent (AB) student is treated in totals.',
    schema: z.enum(['SHOW_AB_INCOMPLETE', 'ZERO', 'EXCLUDE']), default: 'SHOW_AB_INCOMPLETE' as const, input: 'select',
    options: [
      { value: 'SHOW_AB_INCOMPLETE', label: 'Show AB, result incomplete' },
      { value: 'ZERO', label: 'Count as zero' },
      { value: 'EXCLUDE', label: 'Exclude subject from total' },
    ],
  }),
  def({
    key: 'result.pass_percent_subject', group: 'Result', label: 'Subject pass mark (%)',
    description: 'Used when an exam subject has no explicit pass marks (school sheet: 7/20 = 35%).',
    schema: z.number().min(0).max(100), default: 35, input: 'percent',
  }),
  def({
    key: 'result.pass_percent_overall', group: 'Result', label: 'Overall pass percentage',
    description: 'Minimum overall percentage to pass.', schema: z.number().min(0).max(100), default: 35, input: 'percent',
  }),
  def({
    key: 'result.aggregate_rounding', group: 'Result', label: 'Rounding of average columns',
    description: 'School report card rounds 77.5 to 78.',
    schema: z.enum(['HALF_UP_INT', 'TWO_DECIMALS', 'NONE']), default: 'HALF_UP_INT' as const, input: 'select',
    options: [
      { value: 'HALF_UP_INT', label: 'Whole number (half up)' },
      { value: 'TWO_DECIMALS', label: 'Two decimals' },
      { value: 'NONE', label: 'No rounding' },
    ],
  }),
  def({
    key: 'result.rank_mode', group: 'Result', label: 'Rank',
    description: 'Whether rank is calculated and printed.',
    schema: z.enum(['OFF', 'COMPETITION', 'DENSE']), default: 'OFF' as const, input: 'select',
    options: [
      { value: 'OFF', label: 'Do not rank' },
      { value: 'COMPETITION', label: 'Competition (1,2,2,4)' },
      { value: 'DENSE', label: 'Dense (1,2,2,3)' },
    ],
  }),
  def({
    key: 'workflow.stages', group: 'Workflow', label: 'Approval stages after operator entry',
    description: 'Operator entry → Subject teacher → Class teacher → Headmaster is mandatory. The exam coordinator check can be added before the Headmaster.',
    schema: z
      .array(z.enum(WORKFLOW_STAGES))
      .refine((a) => MANDATORY_STAGES.every((m) => a.includes(m)), 'Subject teacher, class teacher and headmaster stages are mandatory'),
    default: [...MANDATORY_STAGES] as WorkflowStage[],
    input: 'stages',
  }),
  def({
    key: 'reportcard.attendance_mode', group: 'Report Card', label: 'Attendance on report card',
    description: 'Confirmed by school: monthly table.',
    schema: z.enum(['MONTHLY', 'BY_TERM', 'BOTH']), default: 'MONTHLY' as const, input: 'select',
    options: [
      { value: 'MONTHLY', label: 'Month-wise' },
      { value: 'BY_TERM', label: 'Semester-wise' },
      { value: 'BOTH', label: 'Both' },
    ],
  }),
] as const;

export type PolicyKey = (typeof POLICY_DEFS)[number]['key'];
export const POLICY_KEYS = POLICY_DEFS.map((d) => d.key) as PolicyKey[];
export const getPolicyDef = (key: string): PolicyDef | undefined =>
  (POLICY_DEFS as readonly PolicyDef[]).find((d) => d.key === key);

export interface PolicyScope {
  academicYearId?: number | null;
  mediumId?: number | null;
  standardId?: number | null;
  classId?: number | null;
}

export interface StoredPolicy extends PolicyScope {
  policyKey: string;
  value: unknown;
}

const SCOPE_FIELDS = ['academicYearId', 'mediumId', 'standardId', 'classId'] as const;

/** Stable key identifying a scope; '*' = any. Used as a unique column. */
export function scopeKey(s: PolicyScope): string {
  return SCOPE_FIELDS.map((f) => (s[f] == null ? '*' : String(s[f]))).join(':');
}

/** A stored policy applies to a target when every non-null scope field matches. */
function applies(p: PolicyScope, target: PolicyScope): boolean {
  return SCOPE_FIELDS.every((f) => p[f] == null || p[f] === target[f]);
}

/** Specificity: class > standard > medium > year (bit weights keep ordering total). */
function specificity(p: PolicyScope): number {
  return (p.classId != null ? 8 : 0) + (p.standardId != null ? 4 : 0) + (p.mediumId != null ? 2 : 0) + (p.academicYearId != null ? 1 : 0);
}

export interface ResolvedPolicy {
  key: string;
  value: unknown;
  source: 'DEFAULT' | 'STORED';
  scope: PolicyScope | null;
}

/** Resolve one policy for a target scope: most specific matching stored row, else the catalog default. */
export function resolvePolicy(key: string, stored: StoredPolicy[], target: PolicyScope): ResolvedPolicy {
  const defn = getPolicyDef(key);
  if (!defn) throw new Error(`Unknown policy key: ${key}`);
  const candidates = stored
    .filter((p) => p.policyKey === key && applies(p, target))
    .sort((a, b) => specificity(b) - specificity(a));
  const best = candidates[0];
  if (!best) return { key, value: defn.default, source: 'DEFAULT', scope: null };
  const scope: PolicyScope = {
    academicYearId: best.academicYearId ?? null, mediumId: best.mediumId ?? null,
    standardId: best.standardId ?? null, classId: best.classId ?? null,
  };
  return { key, value: best.value, source: 'STORED', scope };
}

export function resolveAllPolicies(stored: StoredPolicy[], target: PolicyScope): ResolvedPolicy[] {
  return POLICY_KEYS.map((k) => resolvePolicy(k, stored, target));
}
