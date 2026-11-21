import { z } from 'zod';

/**
 * Greensheet mark pattern (Maharashtra CCE, as on the school's printed Greensheet).
 *
 * Each semester exam of a class subject has a list of "parts":
 *  - Formative Evaluation (FE): OBS, Oral, Activity, Project, OBT, Home Work, Class Work, Practical, MCQ
 *  - Summative Evaluation (SE): Written, Oral, Practical/Project
 * The operator types each part; the FE total (A / C) and SE total (B / D) are always calculated.
 * An MCQ test can be entered out of 40 and counted out of 10 ("MCQ Avg."), as in classes IX–X.
 * FE_TOTAL / SE_TOTAL are used only for marks entered as totals before the Greensheet format.
 */
export const MARK_PARTS = {
  OBS: { stage: 'FE', label: 'OBS', long: 'Observation' },
  ORAL: { stage: 'FE', label: 'Oral', long: 'Oral' },
  ACTIVITY: { stage: 'FE', label: 'Activity', long: 'Activity' },
  PROJECT: { stage: 'FE', label: 'Project', long: 'Project' },
  OBT: { stage: 'FE', label: 'OBT', long: 'Open book test' },
  HOMEWORK: { stage: 'FE', label: 'Home Work', long: 'Home work' },
  CLASSWORK: { stage: 'FE', label: 'Class Work', long: 'Class work' },
  PRACTICAL: { stage: 'FE', label: 'Practical', long: 'Practical' },
  MCQ: { stage: 'FE', label: 'MCQ', long: 'MCQ test' },
  FE_TOTAL: { stage: 'FE', label: 'Formative', long: 'Formative total (entered before the Greensheet format)' },
  WRITTEN: { stage: 'SE', label: 'Written', long: 'Written' },
  SE_ORAL: { stage: 'SE', label: 'Oral', long: 'Oral' },
  SE_PRACT: { stage: 'SE', label: 'Pract./Proj.', long: 'Practical / Project' },
  SE_TOTAL: { stage: 'SE', label: 'Summative', long: 'Summative total (entered before the Greensheet format)' },
} as const;
export type MarkPartKey = keyof typeof MARK_PARTS;
export const MARK_PART_KEYS = Object.keys(MARK_PARTS) as MarkPartKey[];
/** Parts offered in the pattern editor (the two legacy totals are not). */
export const PATTERN_PART_KEYS = MARK_PART_KEYS.filter((k) => k !== 'FE_TOTAL' && k !== 'SE_TOTAL');
export const partStage = (k: string) => MARK_PARTS[k as MarkPartKey]?.stage ?? 'FE';

export interface MarkPart { key: MarkPartKey; max: number; countAs?: number | null }
export type MarkPattern = MarkPart[];

export const roundHalfUp = (n: number) => Math.floor(n + 0.5 + 1e-9);
/** Value of a part as it counts in the total (MCQ 29/40 counted out of 10 → 7). */
export const countedValue = (p: MarkPart, v: number) => (p.countAs ? roundHalfUp((v * p.countAs) / p.max) : v);
export const countedMax = (p: MarkPart) => p.countAs ?? p.max;

/** Sort parts in the Greensheet's column order. */
export const sortPattern = (p: MarkPattern) => [...p].sort((a, b) => MARK_PART_KEYS.indexOf(a.key) - MARK_PART_KEYS.indexOf(b.key));

/** Maximum Formative (max1) and Summative (max2, null when there is no summative part). */
export function patternMax(p: MarkPattern) {
  const fe = p.filter((x) => partStage(x.key) === 'FE');
  const se = p.filter((x) => partStage(x.key) === 'SE');
  return { max1: fe.reduce((t, x) => t + countedMax(x), 0), max2: se.length ? se.reduce((t, x) => t + countedMax(x), 0) : null };
}

/**
 * Codes the operator can type in a part's box instead of a number. Both are shown on the sheets and COUNT AS 0:
 * AB = absent for that part only (e.g. the unit test), C = caught copying. Different from the whole-subject Absent tick.
 */
export const PART_CODES = { AB: 'Absent', C: 'Copying' } as const;
export type PartCode = keyof typeof PART_CODES;
/** A part's mark: a number, a code (AB / C, counted as 0), or empty. */
export type PartValue = number | PartCode | null;
/** "ab", " C " → "AB" / "C"; anything else → null. */
export const partCode = (v: unknown): PartCode | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  return t in PART_CODES ? (t as PartCode) : null;
};

/** One student's parts, stage by stage: FE total (marks1) and SE total (marks2); AB and C count as 0. */
export function partSummary(p: MarkPattern, values: Partial<Record<string, PartValue | string | undefined>>) {
  let fe: number | null = null;
  let se: number | null = null;
  const codes: { key: string; code: PartCode }[] = [];
  for (const part of p) {
    const v = values[part.key];
    if (v == null || v === '') continue;
    const code = partCode(v);
    if (code) codes.push({ key: part.key, code });
    const c = code ? 0 : countedValue(part, Number(v));
    if (partStage(part.key) === 'FE') fe = (fe ?? 0) + c;
    else se = (se ?? 0) + c;
  }
  return { marks1: fe, marks2: se, codes };
}

/** Totals of one student's parts: FE total (marks1) and SE total (marks2); null while nothing of that stage is entered. */
export function partTotals(p: MarkPattern, values: Partial<Record<string, PartValue | string | undefined>>) {
  const r = partSummary(p, values);
  return { marks1: r.marks1, marks2: r.marks2 };
}

/** Parts of the pattern that are still empty for a student who is not absent (AB / C count as filled). */
export const missingParts = (p: MarkPattern, values: Partial<Record<string, PartValue | undefined>> | null | undefined) => p.filter((x) => values?.[x.key] == null).map((x) => x.key);

/** Problems with a part's values (above the maximum etc.). */
export function partErrors(p: MarkPattern, values: Partial<Record<string, PartValue | undefined>>) {
  const out: { key: string; message: string }[] = [];
  const allowed = new Set(p.map((x) => x.key));
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    if (partCode(v)) { if (!allowed.has(k as MarkPartKey)) out.push({ key: k, message: `${MARK_PARTS[k as MarkPartKey]?.label ?? k} is not part of this subject` }); continue; }
    if (!allowed.has(k as MarkPartKey)) { out.push({ key: k, message: `${MARK_PARTS[k as MarkPartKey]?.label ?? k} is not part of this subject` }); continue; }
    const part = p.find((x) => x.key === k)!;
    if (Number(v) < 0) out.push({ key: k, message: `${MARK_PARTS[part.key].label}: cannot be negative` });
    if (Number(v) > part.max) out.push({ key: k, message: `${MARK_PARTS[part.key].label}: more than the maximum ${part.max}` });
  }
  return out;
}

// ---------------------------------------------------------------- default patterns (from the school's Greensheet 2025-26)

const fe = (obs: number, oral: number, act: number, proj: number, obt: number, hw: number, cw: number | null): MarkPart[] => [
  { key: 'OBS', max: obs }, { key: 'ORAL', max: oral }, { key: 'ACTIVITY', max: act }, { key: 'PROJECT', max: proj }, { key: 'OBT', max: obt },
  { key: 'HOMEWORK', max: hw }, ...(cw ? [{ key: 'CLASSWORK' as const, max: cw }] : []),
];
const se = (written: number, oral: number): MarkPart[] => [{ key: 'WRITTEN', max: written }, { key: 'SE_ORAL', max: oral }];
/** W.E., Art, P.E. in classes I–VIII: formative only, out of 100, with Practical. */
const ACTIVITY_PATTERN: MarkPattern = [
  { key: 'OBS', max: 15 }, { key: 'ORAL', max: 20 }, { key: 'ACTIVITY', max: 10 }, { key: 'PROJECT', max: 15 }, { key: 'OBT', max: 20 }, { key: 'PRACTICAL', max: 20 },
];
const MATHS_LIKE = ['MATH', 'MATHS', 'ALG', 'GEOM', 'SOC', 'SST', 'HISPS', 'GEOG'];
const SCIENCE_LIKE = ['SCI', 'SCI1', 'SCI2'];

/** Group of standards that share a pattern: I–II, III–IV, V–VI, VII–VIII, IX–X (pre-primary uses I–II until the school decides). */
export function patternGroup(standardCode: string): 'I-II' | 'III-IV' | 'V-VI' | 'VII-VIII' | 'IX-X' {
  const c = standardCode.toUpperCase();
  if (c === 'III' || c === 'IV') return 'III-IV';
  if (c === 'V' || c === 'VI') return 'V-VI';
  if (c === 'VII' || c === 'VIII') return 'VII-VIII';
  if (c === 'IX' || c === 'X') return 'IX-X';
  return 'I-II';
}

/**
 * The school's pattern for one class subject in one semester.
 * IX–X: languages FE Oral 10 + Home Work 10, SE Written 80; Maths & Social Science FE Home Work 10 + MCQ 40 (counted 10),
 * SE Written 80; Science SE Written 80 + Practical/Project 20; activity subjects SE Practical/Project 100.
 */
export function defaultPattern(standardCode: string, subjectCode: string, subjectType: string): MarkPattern {
  const g = patternGroup(standardCode);
  const code = subjectCode.toUpperCase();
  const activity = subjectType === 'ACTIVITY';
  if (g === 'IX-X') {
    if (activity) return [{ key: 'SE_PRACT', max: 100 }];
    if (SCIENCE_LIKE.includes(code)) return [{ key: 'WRITTEN', max: 80 }, { key: 'SE_PRACT', max: 20 }];
    if (MATHS_LIKE.includes(code)) return [{ key: 'HOMEWORK', max: 10 }, { key: 'MCQ', max: 40, countAs: 10 }, { key: 'WRITTEN', max: 80 }];
    return [{ key: 'ORAL', max: 10 }, { key: 'HOMEWORK', max: 10 }, { key: 'WRITTEN', max: 80 }];
  }
  if (activity) return ACTIVITY_PATTERN.map((p) => ({ ...p }));
  if (g === 'III-IV') return [...fe(10, 10, 5, 5, 20, 5, 5), ...se(30, 10)];
  if (g === 'V-VI') return [...fe(5, 5, 5, 5, 20, 5, 5), ...se(40, 10)];
  if (g === 'VII-VIII') return [...fe(4, 4, 4, 4, 20, 4, null), ...se(50, 10)];
  return [...fe(10, 10, 10, 10, 20, 5, 5), ...se(20, 10)];
}

/** Pattern for marks entered as two totals before the Greensheet format (nothing is invented). */
export const legacyPattern = (max1: number, max2: number | null): MarkPattern => [
  { key: 'FE_TOTAL', max: max1 }, ...(max2 != null ? [{ key: 'SE_TOTAL' as const, max: max2 }] : []),
];
export const isLegacyPattern = (p: MarkPattern) => p.some((x) => x.key === 'FE_TOTAL' || x.key === 'SE_TOTAL');

// ---------------------------------------------------------------- schemas

const partSchema = z.object({
  key: z.enum(MARK_PART_KEYS as [MarkPartKey, ...MarkPartKey[]]),
  max: z.coerce.number().positive('Maximum must be more than 0').max(1000),
  countAs: z.union([z.literal(''), z.null(), z.coerce.number().positive().max(1000)]).optional().transform((v) => (v === '' || v == null ? null : v)),
});
export const patternSchema = z.array(partSchema).max(20).superRefine((parts, c) => {
  const seen = new Set<string>();
  parts.forEach((p, i) => {
    if (seen.has(p.key)) c.addIssue({ code: 'custom', path: [i, 'key'], message: `${MARK_PARTS[p.key].label} is listed twice` });
    seen.add(p.key);
    if (p.countAs && p.countAs > p.max) c.addIssue({ code: 'custom', path: [i, 'countAs'], message: 'Counted maximum cannot be more than the maximum' });
  });
  if (!parts.length) c.addIssue({ code: 'custom', path: [], message: 'Give at least one part with a maximum' });
});
export const savePatternSchema = z.object({
  classId: z.coerce.number().int().positive(),
  /** Exams to apply to (normally both semesters). */
  examIds: z.array(z.coerce.number().int().positive()).min(1).max(4),
  items: z.array(z.object({ classSubjectId: z.coerce.number().int().positive(), parts: patternSchema })).min(1).max(40),
});
export type SavePatternInput = z.infer<typeof savePatternSchema>;
export const copyPatternSchema = z.object({
  fromClassId: z.coerce.number().int().positive(),
  toClassIds: z.array(z.coerce.number().int().positive()).min(1).max(60),
});

// ---------------------------------------------------------------- results

export const GREENSHEET_RESULTS = ['PASS', 'PROMOTED', 'RE_EXAM', 'DETAINED'] as const;
export type GreensheetResult = (typeof GREENSHEET_RESULTS)[number];
export const GREENSHEET_RESULT_LABELS: Record<GreensheetResult, string> = { PASS: 'PASS', PROMOTED: 'PROMOTED', RE_EXAM: 'Re-Exam', DETAINED: 'Detained' };
export const greensheetDecisionSchema = z.object({
  items: z.array(z.object({
    enrollmentId: z.coerce.number().int().positive(),
    result: z.enum(GREENSHEET_RESULTS).nullable(),
    /** Grace marks per class subject, added to the average (shown as 34+1). */
    grace: z.record(z.string().regex(/^\d+$/), z.coerce.number().int().min(0).max(20)).optional().default({}),
    remark: z.string().trim().max(200).optional().nullable(),
  })).max(200),
});
export type GreensheetDecisionInput = z.infer<typeof greensheetDecisionSchema>;
