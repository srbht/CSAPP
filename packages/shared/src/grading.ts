export interface GradeBandInput {
  grade: string;
  minPercent: number;
  maxPercent: number;
  isPass: boolean;
}

/** Maharashtra CCE 9-point scale. A1-B2 verified against the school's report card; C1-E2 assumed (docs/04 §4.6). */
export const CCE_9_POINT: (GradeBandInput & { gradePoint: number })[] = [
  { grade: 'A1', minPercent: 91, maxPercent: 100, isPass: true, gradePoint: 10 },
  { grade: 'A2', minPercent: 81, maxPercent: 90.99, isPass: true, gradePoint: 9 },
  { grade: 'B1', minPercent: 71, maxPercent: 80.99, isPass: true, gradePoint: 8 },
  { grade: 'B2', minPercent: 61, maxPercent: 70.99, isPass: true, gradePoint: 7 },
  { grade: 'C1', minPercent: 51, maxPercent: 60.99, isPass: true, gradePoint: 6 },
  { grade: 'C2', minPercent: 41, maxPercent: 50.99, isPass: true, gradePoint: 5 },
  { grade: 'D', minPercent: 33, maxPercent: 40.99, isPass: true, gradePoint: 4 },
  { grade: 'E1', minPercent: 21, maxPercent: 32.99, isPass: false, gradePoint: 0 },
  { grade: 'E2', minPercent: 0, maxPercent: 20.99, isPass: false, gradePoint: 0 },
];

/**
 * Bands must cover 0–100 with no overlaps or gaps larger than 0.01 (two-decimal percentages).
 * Returns a list of human-readable problems; empty list = valid.
 */
export function validateGradeBands(bands: GradeBandInput[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ['At least one grade band is required.'];
  const names = new Set<string>();
  for (const b of bands) {
    const g = b.grade.trim();
    if (!g) problems.push('Grade name is required.');
    if (names.has(g.toUpperCase())) problems.push(`Grade "${g}" appears more than once.`);
    names.add(g.toUpperCase());
    if (b.minPercent > b.maxPercent) problems.push(`Grade ${g}: minimum is greater than maximum.`);
    if (b.minPercent < 0 || b.maxPercent > 100) problems.push(`Grade ${g}: range must be within 0–100.`);
  }
  const sorted = [...bands].sort((a, b) => a.minPercent - b.minPercent);
  if (sorted[0].minPercent !== 0) problems.push('The lowest band must start at 0.');
  if (sorted[sorted.length - 1].maxPercent !== 100) problems.push('The highest band must end at 100.');
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.minPercent <= prev.maxPercent) problems.push(`Grades ${prev.grade} and ${cur.grade} overlap.`);
    else if (Math.round((cur.minPercent - prev.maxPercent) * 100) > 1) problems.push(`Gap between ${prev.grade} and ${cur.grade}.`);
  }
  return problems;
}

/** Look up a grade for an unrounded percentage using lower bounds (90.4 → A2). */
export function gradeFor(percent: number, bands: GradeBandInput[]): GradeBandInput | undefined {
  return [...bands].sort((a, b) => b.minPercent - a.minPercent).find((b) => percent >= b.minPercent);
}
