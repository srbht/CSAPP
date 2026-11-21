/**
 * Number pattern formatting. A pattern contains exactly one `{000…}` placeholder whose zero
 * count is the minimum padding, e.g. 'SE-{0000}' + 1510 → 'SE-1510', 'STU{000000}' + 1 → 'STU000001'.
 */
const PLACEHOLDER = /\{(0+)\}/;

export function isValidPattern(pattern: string): boolean {
  const matches = pattern.match(/\{0+\}/g);
  return !!matches && matches.length === 1 && pattern.length <= 60;
}

/**
 * Optional tokens: {MEDIUM} → first 3 letters of the medium (English → ENG, Hindi → HIN) and {YEAR} → first year of the
 * academic year (2026-27 → 2026). Used by the Student ID: '{MEDIUM}{YEAR}{00000000}' → ENG202600000001.
 */
export interface SequenceTokens { medium?: string; year?: string }

export function mediumToken(mediumName: string): string {
  return mediumName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}

export function yearToken(academicYearName: string): string {
  return academicYearName.slice(0, 4);
}

export function formatSequence(pattern: string, value: number, tokens: SequenceTokens = {}): string {
  const m = pattern.match(PLACEHOLDER);
  if (!m || !isValidPattern(pattern)) throw new Error(`Invalid sequence pattern: ${pattern}`);
  return pattern.replace(PLACEHOLDER, String(value).padStart(m[1].length, '0'))
    .replace(/\{MEDIUM\}/g, tokens.medium ?? 'ENG').replace(/\{YEAR\}/g, tokens.year ?? String(new Date().getFullYear()));
}

const ROMAN: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

/**
 * Exam No prefix: first letter of the medium, then the standard as a number; pre-primary uses N (Nursery), J (LKG)
 * and S (UKG). English Std 1 → "E-1", Hindi Std 10 → "H-10", English UKG → "E-S". The running number follows: E-1-001.
 */
export function examNoPrefix(mediumName: string, standard: { code: string; levelOrder: number }): string {
  const m = mediumName.replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase();
  const code = standard.code.toUpperCase();
  const s = standard.levelOrder >= 1 ? String(standard.levelOrder) : code === 'UKG' ? 'S' : code === 'LKG' ? 'J' : 'N';
  return `${m}-${s}`;
}

/** GR No as printed: the number, "TEMP" while a new register number is awaited (after Std I / V promotion), or blank. */
export function grNoLabel(s: { grNo: string | null; grNoTemp?: boolean | null }): string {
  return s.grNo ?? (s.grNoTemp ? 'TEMP' : '');
}
