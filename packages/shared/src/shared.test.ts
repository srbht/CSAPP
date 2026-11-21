import { describe, expect, it } from 'vitest';
import {
  CCE_9_POINT, DEFAULT_ROLE_PERMISSIONS, PERMISSION_META, ALL_PERMISSIONS, examNoPrefix, formatSequence, gradeFor, grNoLabel, isValidPattern, mediumToken, yearToken,
  mobile, resolvePolicy, scopeKey, validateGradeBands, academicYearSchema, assignmentSchema, staffSchema,
  ACADEMIC_APPROVAL_PERMISSIONS, instalmentSchedule, workingDueDate, getPolicyDef, dateInWords, studentSchema, ledgerFigures, ledgerState, classFeeSchema,
} from './index';

describe('grading', () => {
  it('CCE seed is a valid, contiguous 0-100 scale', () => {
    expect(validateGradeBands(CCE_9_POINT)).toEqual([]);
  });

  // Every grade on the school's reference report card (Std VIII, 2025-26)
  it.each([
    [90, 'A2'], [80, 'B1'], [85, 'A2'], [94, 'A1'], [92, 'A1'], [97, 'A1'], [96, 'A1'],
    [63, 'B2'], [78, 'B1'], [98, 'A1'], [79, 'B1'], [84, 'A2'], [86, 'A2'], [83, 'A2'],
    [(814 / 900) * 100, 'A2'], [(755 / 900) * 100, 'A2'], [87.33, 'A2'],
  ])('%s%% → %s', (pct, grade) => {
    expect(gradeFor(pct, CCE_9_POINT)?.grade).toBe(grade);
  });

  it('detects overlaps, gaps and bad bounds', () => {
    expect(validateGradeBands([
      { grade: 'A', minPercent: 50, maxPercent: 100, isPass: true },
      { grade: 'B', minPercent: 0, maxPercent: 60, isPass: false },
    ])).toContain('Grades B and A overlap.');
    expect(validateGradeBands([
      { grade: 'A', minPercent: 60, maxPercent: 100, isPass: true },
      { grade: 'B', minPercent: 0, maxPercent: 50, isPass: false },
    ])).toContain('Gap between B and A.');
    expect(validateGradeBands([{ grade: 'A', minPercent: 10, maxPercent: 100, isPass: true }]))
      .toContain('The lowest band must start at 0.');
    expect(validateGradeBands([
      { grade: 'A', minPercent: 0, maxPercent: 100, isPass: true },
      { grade: 'a', minPercent: 0, maxPercent: 100, isPass: true },
    ])).toContain('Grade "a" appears more than once.');
  });
});

describe('policies', () => {
  const stored = [
    { policyKey: 'result.pass_percent_subject', value: 40 },
    { policyKey: 'result.pass_percent_subject', value: 33, mediumId: 2 },
    { policyKey: 'result.pass_percent_subject', value: 30, mediumId: 2, standardId: 10 },
    { policyKey: 'result.pass_percent_subject', value: 25, classId: 99 },
  ];
  it('falls back to the default', () => {
    const r = resolvePolicy('attendance.half_day_weight', stored, {});
    expect(r).toMatchObject({ value: 0.5, source: 'DEFAULT' });
  });
  it('most specific scope wins', () => {
    expect(resolvePolicy('result.pass_percent_subject', stored, { mediumId: 1 }).value).toBe(40);
    expect(resolvePolicy('result.pass_percent_subject', stored, { mediumId: 2, standardId: 9 }).value).toBe(33);
    expect(resolvePolicy('result.pass_percent_subject', stored, { mediumId: 2, standardId: 10 }).value).toBe(30);
    expect(resolvePolicy('result.pass_percent_subject', stored, { mediumId: 2, standardId: 10, classId: 99 }).value).toBe(25);
  });
  it('report card attendance default is monthly (school decision)', () => {
    expect(resolvePolicy('reportcard.attendance_mode', [], {}).value).toBe('MONTHLY');
  });
  it('scope key is stable', () => {
    expect(scopeKey({ mediumId: 2 })).toBe('*:2:*:*');
    expect(scopeKey({})).toBe('*:*:*:*');
  });
  it('rejects unknown keys', () => {
    expect(() => resolvePolicy('nope', [], {})).toThrow();
  });
});

describe('sequences', () => {
  it('formats school number styles', () => {
    expect(formatSequence('SE-{0000}', 1510)).toBe('SE-1510');
    expect(examNoPrefix('English Medium', { code: 'I', levelOrder: 1 })).toBe('E-1');
    expect(examNoPrefix('Hindi Medium', { code: 'X', levelOrder: 10 })).toBe('H-10');
    expect(examNoPrefix('English Medium', { code: 'NUR', levelOrder: -2 })).toBe('E-N');
    expect(examNoPrefix('English Medium', { code: 'LKG', levelOrder: -1 })).toBe('E-J');
    expect(examNoPrefix('English Medium', { code: 'UKG', levelOrder: 0 })).toBe('E-S');
    expect(grNoLabel({ grNo: null, grNoTemp: true })).toBe('TEMP');
    expect(formatSequence('{MEDIUM}{YEAR}{00000000}', 1, { medium: mediumToken('Hindi Medium'), year: yearToken('2026-27') })).toBe('HIN202600000001');
    expect(formatSequence('STU{000000}', 1)).toBe('STU000001');
    expect(formatSequence('H{0000}', 1001)).toBe('H1001');
    expect(formatSequence('E{000}', 12345)).toBe('E12345');
  });
  it('validates patterns', () => {
    expect(isValidPattern('SE-{0000}')).toBe(true);
    expect(isValidPattern('SE-')).toBe(false);
    expect(isValidPattern('{00}-{00}')).toBe(false);
  });
});

describe('schemas', () => {
  it('normalises Indian mobile numbers (school sheet stores them as numbers)', () => {
    expect(mobile.parse('+91 95944 42443')).toBe('9594442443');
    expect(mobile.parse('09594442443')).toBe('9594442443');
    expect(mobile.safeParse('12345').success).toBe(false);
    expect(mobile.safeParse('5594442443').success).toBe(false);
  });
  it('optional contact fields may be omitted, blank or null (stored as null)', () => {
    const base = { employeeCode: 'T1', name: 'A' };
    expect(staffSchema.parse(base)).toMatchObject({ mobile: null, email: null, joiningDate: null, employmentType: null });
    expect(staffSchema.parse({ ...base, mobile: '', email: null })).toMatchObject({ mobile: null, email: null });
    expect(staffSchema.safeParse({ ...base, email: 'not-an-email' }).success).toBe(false);
  });
  it('academic year validates name and order', () => {
    expect(academicYearSchema.safeParse({ name: '2026-27', startDate: '2026-06-01', endDate: '2027-04-30' }).success).toBe(true);
    expect(academicYearSchema.safeParse({ name: '2026', startDate: '2026-06-01', endDate: '2027-04-30' }).success).toBe(false);
    expect(academicYearSchema.safeParse({ name: '2026-27', startDate: '2027-06-01', endDate: '2027-04-30' }).success).toBe(false);
  });
  it('subject teacher assignment needs a subject', () => {
    const base = { academicYearId: 1, staffId: 1, sectionId: 1 };
    expect(assignmentSchema.safeParse({ ...base, role: 'SUBJECT_TEACHER' }).success).toBe(false);
    expect(assignmentSchema.safeParse({ ...base, role: 'CLASS_TEACHER' }).success).toBe(true);
  });
});

describe('permissions', () => {
  it('every permission has metadata and role grants are valid codes', () => {
    expect(PERMISSION_META.map((m) => m.code).sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const role of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      for (const p of role.permissions) expect(ALL_PERMISSIONS).toContain(p);
    }
  });
});

describe('academic workflow roles (operator → subject teacher → class teacher → headmaster)', () => {
  const roles = DEFAULT_ROLE_PERMISSIONS;
  it('Super Admin has no academic approval authority by default', () => {
    for (const p of ACADEMIC_APPROVAL_PERMISSIONS) expect(roles.SUPER_ADMIN.permissions).not.toContain(p);
    expect(roles.SUPER_ADMIN.permissions).toContain('users.manage');
  });
  it('Operator can enter data but never verify, approve or publish', () => {
    expect(roles.OPERATOR.permissions).toEqual(expect.arrayContaining(['marks.enter', 'attendance.mark']));
    for (const p of ACADEMIC_APPROVAL_PERMISSIONS) expect(roles.OPERATOR.permissions).not.toContain(p);
  });
  it('each verification stage belongs to exactly the right role', () => {
    expect(roles.SUBJECT_TEACHER.permissions).toContain('marks.verify.subject');
    expect(roles.SUBJECT_TEACHER.permissions).not.toContain('marks.enter');
    expect(roles.CLASS_TEACHER.permissions).toContain('marks.verify.class');
    expect(roles.CLASS_TEACHER.permissions).not.toContain('marks.approve');
    expect(roles.HEADMASTER.permissions).toEqual(expect.arrayContaining(['marks.approve', 'reportcards.publish', 'assignments.manage', 'reports.schoolwide']));
    expect(roles.HEADMASTER.permissions).not.toContain('marks.enter');
  });
  it('mandatory stages cannot be removed from the workflow', () => {
    const def = getPolicyDef('workflow.stages')!;
    expect(def.schema.safeParse(['SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE']).success).toBe(true);
    expect(def.schema.safeParse(['SUBJECT_VERIFY', 'CLASS_APPROVE', 'COORDINATOR_VERIFY', 'HEADMASTER_APPROVE']).success).toBe(true);
    expect(def.schema.safeParse(['CLASS_APPROVE', 'HEADMASTER_APPROVE']).success).toBe(false);
  });
});

describe('admission form', () => {
  it('writes the date of birth in words for the GR and LC', () => {
    expect(dateInWords('2018-06-05')).toBe('Fifth June Two Thousand Eighteen');
    expect(dateInWords('2013-12-31')).toBe('Thirty First December Two Thousand Thirteen');
    expect(dateInWords('1999-01-21')).toBe('Twenty First January One Thousand Nine Hundred Ninety Nine');
    expect(dateInWords('')).toBe('');
    expect(dateInWords(null)).toBe('');
  });

  it('checks PEN, IFSC, bank account, height and weight; blanks become null', () => {
    const base = { fullName: 'A B', gender: 'MALE' };
    const ok = studentSchema.parse({ ...base, pen: '21345678901', bankIfsc: 'sbin0001234', bankAccountNo: '123456789', heightCm: '120', weightKg: '22.5' });
    expect(ok).toMatchObject({ pen: '21345678901', bankIfsc: 'SBIN0001234', heightCm: 120, weightKg: 22.5 });
    const blank = studentSchema.parse({ ...base, pen: '', bankIfsc: '', heightCm: '', weightKg: '', emergencyMobile: '' });
    expect(blank).toMatchObject({ pen: null, bankIfsc: null, heightCm: null, weightKg: null, emergencyMobile: null, isBpl: false });
    for (const bad of [{ bankIfsc: 'SBI1234' }, { bankAccountNo: '12ab' }, { heightCm: '500' }, { pen: '12 34' }, { emergencyMobile: '12345' }]) {
      expect(studentSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });
});

describe('fee ledger', () => {
  it('keeps previous year outstanding apart from the current year fee and clears it first', () => {
    const f = ledgerFigures({ previousOutstanding: 1500, yearFee: 10000, concession: 1000, paid: 2000 });
    expect(f).toEqual({
      previousOutstanding: 1500, currentYearFee: 10000, concession: 1000, currentYearNet: 9000, penalty: 0, totalPayable: 10500,
      paid: 2000, paidTowardsPrevious: 1500, balance: 8500, previousStillDue: 0,
    });
    expect(ledgerState(f)).toBe('PART_PAID');
    expect(ledgerFigures({ previousOutstanding: 3000, yearFee: 0, concession: 0, paid: 1000 }).previousStillDue).toBe(2000);
    expect(ledgerFigures({ previousOutstanding: 0, yearFee: 18500, concession: 0, paid: 0, penalty: 100 })).toMatchObject({ penalty: 100, totalPayable: 18600, balance: 18600 });
    expect(ledgerState(ledgerFigures({ previousOutstanding: 0, yearFee: 0, concession: 0, paid: 0 }))).toBe('NO_FEES');
    expect(ledgerState(ledgerFigures({ previousOutstanding: 0, yearFee: 5000, concession: 0, paid: 5000 }))).toBe('PAID');
    expect(classFeeSchema.safeParse({ amount: -1 }).success).toBe(false);
  });
});

describe('Greensheet mark pattern', () => {
  it('matches the school sheet: class I core 70 + 30, class VII–VIII 40 + 60 (no class work), activity 100 formative', async () => {
    const { defaultPattern, patternMax } = await import('./greensheet');
    expect(patternMax(defaultPattern('I', 'ENG', 'THEORY'))).toEqual({ max1: 70, max2: 30 });
    expect(patternMax(defaultPattern('II', 'GK', 'THEORY'))).toEqual({ max1: 70, max2: 30 });
    expect(patternMax(defaultPattern('III', 'EVS', 'THEORY'))).toEqual({ max1: 60, max2: 40 });
    expect(patternMax(defaultPattern('VI', 'SCI', 'THEORY'))).toEqual({ max1: 50, max2: 50 });
    const vii = defaultPattern('VII', 'MATH', 'THEORY');
    expect(patternMax(vii)).toEqual({ max1: 40, max2: 60 });
    expect(vii.some((p) => p.key === 'CLASSWORK')).toBe(false);
    expect(patternMax(defaultPattern('V', 'WE', 'ACTIVITY'))).toEqual({ max1: 100, max2: null });
    expect(patternMax(defaultPattern('IX', 'SCI', 'THEORY'))).toEqual({ max1: 0, max2: 100 });
    expect(patternMax(defaultPattern('X', 'PE', 'ACTIVITY'))).toEqual({ max1: 0, max2: 100 });
  });
  it('MCQ out of 40 counts out of 10, rounded like the sheet (29→7, 35→9, 15→4)', async () => {
    const { defaultPattern, partTotals } = await import('./greensheet');
    const p = defaultPattern('IX', 'MATH', 'THEORY');
    expect(partTotals(p, { HOMEWORK: 10, MCQ: 29, WRITTEN: 64 })).toEqual({ marks1: 17, marks2: 64 });
    expect(partTotals(p, { HOMEWORK: 10, MCQ: 35 })).toEqual({ marks1: 19, marks2: null });
    expect(partTotals(p, { HOMEWORK: 10, MCQ: 15 })).toEqual({ marks1: 14, marks2: null });
  });
  it('AB (absent for one part) and C (copying) are shown but count as 0; the maximum does not change', async () => {
    const { partSummary, partErrors, missingParts } = await import('./greensheet');
    const pat = [{ key: 'OBS', max: 15 }, { key: 'ORAL', max: 20 }, { key: 'ACTIVITY', max: 10 }, { key: 'PROJECT', max: 15 }, { key: 'OBT', max: 20 }, { key: 'PRACTICAL', max: 20 }] as { key: 'OBS'; max: number }[];
    const s = partSummary(pat, { OBS: 6, ORAL: 6, ACTIVITY: 6, PROJECT: 6, OBT: 'AB', PRACTICAL: 6 });
    expect(s.marks1).toBe(30);
    expect(s.codes).toEqual([{ key: 'OBT', code: 'AB' }]);
    expect(partSummary(pat, { OBS: 'c', ORAL: 6 }).marks1).toBe(6);
    expect(partSummary(pat, Object.fromEntries(pat.map((x) => [x.key, 'AB']))).marks1).toBe(0);
    expect(partErrors(pat, { OBT: 'AB', OBS: 'C' })).toEqual([]);
    expect(missingParts(pat, { OBS: 1, ORAL: 1, ACTIVITY: 1, PROJECT: 1, OBT: 'AB', PRACTICAL: 'C' })).toEqual([]);
  });
  it('monthly performance: 9 skills out of 5, AB counts as 0, grade on the school scale', async () => {
    const { monthlyResult, MONTHLY_SKILLS } = await import('./monthly');
    const all = (v: number | 'AB') => Object.fromEntries(MONTHLY_SKILLS.map((s) => [s.key, v]));
    expect(monthlyResult(all(4))).toEqual({ total: 36, max: 45, percent: 80, grade: 'B1' });
    expect(monthlyResult({ ...all(5), COMPLETION: 'AB' })).toMatchObject({ total: 40, max: 45, grade: 'A2' });
    expect(monthlyResult({})).toEqual({ total: null, max: null, percent: null, grade: null });
  });
  it('rejects parts above their maximum or not in the pattern', async () => {
    const { defaultPattern, partErrors, missingParts } = await import('./greensheet');
    const p = defaultPattern('I', 'ENG', 'THEORY');
    expect(partErrors(p, { OBS: 11 })[0].message).toMatch(/maximum 10/);
    expect(partErrors(p, { MCQ: 1 })[0].message).toMatch(/not part/);
    expect(missingParts(p, { OBS: 5 })).toHaveLength(8);
  });
});

describe('fee instalments', () => {
  const plan = [
    { id: 1, seq: 1, label: '1st instalment', dueDate: '2026-08-10', amount: 5000 },
    { id: 2, seq: 2, label: '2nd instalment', dueDate: '2026-10-10', amount: 4500 },
    { id: 3, seq: 3, label: '3rd instalment', dueDate: '2026-12-10', amount: 4500 },
    { id: 4, seq: 4, label: '4th instalment', dueDate: '2027-02-10', amount: 4500 },
  ];
  it('fills the instalments in order; last year balance is due with the 1st; overdue after the due date', () => {
    const s = instalmentSchedule(plan, { previousOutstanding: 1000, yearFee: 18500, concession: 0, paid: 7000 }, '2026-10-12');
    expect(s.lines.map((l) => [l.total, l.paid, l.status])).toEqual([[6000, 6000, 'PAID'], [4500, 1000, 'OVERDUE'], [4500, 0, 'DUE'], [4500, 0, 'DUE']]);
  });
  it('a discount comes off the last instalment first', () => {
    const s = instalmentSchedule(plan, { previousOutstanding: 0, yearFee: 18500, concession: 6000, paid: 0 }, '2026-07-01');
    expect(s.lines.map((l) => l.amount)).toEqual([5000, 4500, 3000, 0]);
  });
  it('late fees are paid after the instalments; a Sunday due date moves to Monday', () => {
    const s = instalmentSchedule(plan, { previousOutstanding: 0, yearFee: 18500, concession: 0, paid: 18550, penalties: { 2: 100 } }, '2027-03-01');
    expect(s.lines.every((l) => l.status === 'PAID')).toBe(true);
    expect(s).toMatchObject({ penaltyTotal: 100, penaltyPaid: 50, penaltyDue: 50 });
    expect(workingDueDate('2027-01-10')).toBe('2027-01-11'); // Sunday
    expect(workingDueDate('2026-08-10')).toBe('2026-08-10'); // Monday
  });
  it('a plan that does not add up to the year fee is settled on the last instalment', () => {
    expect(instalmentSchedule(plan, { previousOutstanding: 0, yearFee: 18000, concession: 0, paid: 0 }, '2026-07-01').lines.map((l) => l.amount)).toEqual([5000, 4500, 4500, 4000]);
  });
});
