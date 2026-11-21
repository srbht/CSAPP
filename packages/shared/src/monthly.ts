import { z } from 'zod';
import { CCE_9_POINT } from './grading';

/** Monthly performance: the skills a subject teacher scores every month (same for every subject for now), each out of 5. */
export const MONTHLY_SKILLS = [
  { key: 'READING', label: 'Reading' },
  { key: 'WRITING', label: 'Writing' },
  { key: 'VOCABULARY', label: 'Vocabulary' },
  { key: 'RECITATION', label: 'Recitation' },
  { key: 'HOMEWORK', label: 'Home Work' },
  { key: 'CLASSWORK', label: 'Class Work' },
  { key: 'UNDERSTANDING', label: 'Understanding' },
  { key: 'APPLICATION', label: 'Application' },
  { key: 'COMPLETION', label: 'Completion' },
] as const;
export type MonthlySkill = (typeof MONTHLY_SKILLS)[number]['key'];
export const MONTHLY_MAX = 5;
export const MONTHLY_STATUS_LABELS: Record<string, string> = { NOT_STARTED: 'Not started', DRAFT: 'Being filled', SUBMITTED: 'Submitted', RETURNED: 'Sent back' };

/** A score typed by the teacher: 0–5, or AB (absent; shown as AB and counted as 0, like marks). */
export type MonthlyScore = number | 'AB' | null;

/** One student's month: total of the skills scored, out of 5 × skills scored, % and grade (A1–E2, the school's scale). */
export function monthlyResult(scores: Partial<Record<string, MonthlyScore>> | null | undefined) {
  let total = 0;
  let max = 0;
  for (const s of MONTHLY_SKILLS) {
    const v = scores?.[s.key];
    if (v == null) continue;
    total += typeof v === 'number' ? v : 0;
    max += MONTHLY_MAX;
  }
  if (!max) return { total: null, max: null, percent: null, grade: null };
  const percent = Math.round((total / max) * 10000) / 100;
  const grade = CCE_9_POINT.find((b) => percent >= b.minPercent)?.grade ?? 'E2';
  return { total, max, percent, grade };
}

const score = z.union([z.literal(''), z.null(), z.string().regex(/^\s*ab\s*$/i).transform(() => 'AB' as const), z.coerce.number().int('Whole numbers only').min(0).max(MONTHLY_MAX, `Maximum is ${MONTHLY_MAX}`)])
  .optional().transform((v) => (v === '' || v == null ? null : v));
export const monthlyKeySchema = z.object({
  sectionId: z.coerce.number().int().positive(),
  classSubjectId: z.coerce.number().int().positive(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
});
export const monthlySaveSchema = monthlyKeySchema.extend({
  rows: z.array(z.object({ enrollmentId: z.coerce.number().int().positive(), scores: z.record(z.string().max(20), score) })).max(200),
});
export type MonthlySaveInput = z.infer<typeof monthlySaveSchema>;
