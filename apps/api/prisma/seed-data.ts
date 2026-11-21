import { hash } from '@node-rs/argon2';
import { ADDED_DEFAULT_PERMISSIONS, CCE_9_POINT, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_ROLE_PERMISSIONS, PERMISSION_META, SYSTEM_ROLES } from '@cps/shared';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * Idempotent base data for Children Public School. Safe to run repeatedly: rows the school has
 * edited are left alone, only missing rows are created (the permission catalog is always synced).
 * Values come from the school's own documents (docs/00-school-data-findings.md).
 */
export async function seedBase(
  prisma: PrismaClient,
  opts: { schoolCode: string; adminUsername: string; adminPassword?: string; log?: (m: string) => void },
) {
  const log = opts.log ?? (() => {});

  const school = await prisma.school.upsert({
    where: { code: opts.schoolCode },
    update: {},
    create: {
      code: opts.schoolCode,
      name: 'Children Public School',
      motto: 'तमसो मा ज्योतिर्गमय',
      addressLine: 'Rajaram Galli, Bhagat Singh Nagar No. 2, Link Road, Goregaon (West)',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400104',
      board: 'Maharashtra State Board (SSC)',
      principalTitle: 'Head Mistress',
    },
  });

  for (const p of PERMISSION_META) {
    await prisma.permission.upsert({ where: { code: p.code }, update: { module: p.module, description: p.description }, create: p });
  }
  const permId = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));

  // System roles get default grants once; later edits by the school are preserved.
  // Super Admin is always re-synced to hold every permission.
  for (const [code, def] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const existing = await prisma.role.findUnique({ where: { schoolId_code: { schoolId: school.id, code } } });
    if (existing && code !== SYSTEM_ROLES.SUPER_ADMIN) continue;
    const role =
      existing ??
      (await prisma.role.create({ data: { schoolId: school.id, code, name: def.name, isSystem: true, defaultScope: def.defaultScope } }));
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: def.permissions.map((c) => ({ roleId: role.id, permissionId: permId.get(c)! })) });
  }
  // Permissions introduced in later releases are added to existing system roles on every seed run (other edits are kept).
  for (const [code, perms] of Object.entries(ADDED_DEFAULT_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { schoolId_code: { schoolId: school.id, code } } });
    if (!role || !perms?.length) continue;
    await prisma.rolePermission.createMany({ data: perms.map((c) => ({ roleId: role.id, permissionId: permId.get(c)! })), skipDuplicates: true });
  }

  const mediums = [
    { code: 'EN', nameEn: 'English Medium', nameHi: 'अंग्रेज़ी माध्यम', examNoPrefix: 'E', sortOrder: 1 },
    { code: 'HI', nameEn: 'Hindi Medium', nameHi: 'हिंदी माध्यम', examNoPrefix: 'H', sortOrder: 2 },
  ];
  for (const m of mediums) {
    await prisma.medium.upsert({ where: { schoolId_code: { schoolId: school.id, code: m.code } }, update: {}, create: { ...m, schoolId: school.id } });
  }

  const standards: [string, string, string, number][] = [
    ['NUR', 'Nursery', 'नर्सरी', -2], ['LKG', 'LKG', 'एल.के.जी.', -1], ['UKG', 'UKG', 'यू.के.जी.', 0],
    ['I', 'I', 'पहली', 1], ['II', 'II', 'दूसरी', 2], ['III', 'III', 'तीसरी', 3], ['IV', 'IV', 'चौथी', 4],
    ['V', 'V', 'पाँचवीं', 5], ['VI', 'VI', 'छठी', 6], ['VII', 'VII', 'सातवीं', 7], ['VIII', 'VIII', 'आठवीं', 8],
    ['IX', 'IX', 'नौवीं', 9], ['X', 'X', 'दसवीं', 10],
  ];
  for (const [code, nameEn, nameHi, levelOrder] of standards) {
    await prisma.standard.upsert({
      where: { schoolId_code: { schoolId: school.id, code } },
      update: {},
      create: { schoolId: school.id, code, nameEn, nameHi, levelOrder },
    });
  }

  // Dates follow documented assumption A1 (June–April) and are editable in Settings.
  const yearName = '2026-27';
  let year = await prisma.academicYear.findUnique({ where: { schoolId_name: { schoolId: school.id, name: yearName } } });
  if (!year) {
    const hasCurrent = await prisma.academicYear.count({ where: { schoolId: school.id, isCurrent: true } });
    year = await prisma.academicYear.create({
      data: {
        schoolId: school.id, name: yearName,
        startDate: new Date('2026-06-01T00:00:00Z'), endDate: new Date('2027-04-30T00:00:00Z'),
        weeklyOffDays: [0], status: 'ACTIVE', isCurrent: hasCurrent === 0,
      },
    });
  }

  const gsName = 'Maharashtra CCE 9-point';
  if (!(await prisma.gradingSystem.findUnique({ where: { schoolId_name: { schoolId: school.id, name: gsName } } }))) {
    await prisma.gradingSystem.create({
      data: {
        schoolId: school.id,
        name: gsName,
        bands: {
          create: CCE_9_POINT.map((b, i) => ({
            grade: b.grade, minPercent: b.minPercent, maxPercent: b.maxPercent, gradePoint: b.gradePoint, isPass: b.isPass, sortOrder: i,
          })),
        },
      },
    });
  }

  // Exam numbers continue the school's existing H1001 / E1001 style.
  const sequences = [
    { seqKey: 'student_code', label: 'Student ID (medium + year + number)', pattern: '{MEDIUM}{YEAR}{00000000}', nextValue: 1 },
    { seqKey: 'admission_form', label: 'Admission form number', pattern: 'AF-{YEAR}-{00000}', nextValue: 1 },
    { seqKey: `exam_no:${yearName}:EN`, label: `Exam No. ${yearName} English medium`, pattern: 'E{0000}', nextValue: 1001 },
    { seqKey: `exam_no:${yearName}:HI`, label: `Exam No. ${yearName} Hindi medium`, pattern: 'H{0000}', nextValue: 1001 },
    { seqKey: 'staff_code', label: 'Staff ID', pattern: 'STF{0000}', nextValue: 1 },
    { seqKey: 'expense_voucher', label: 'Expense voucher number', pattern: 'EXP-{000000}', nextValue: 1 },
  ];
  for (const s of sequences) {
    await prisma.numberSequence.upsert({
      where: { schoolId_seqKey: { schoolId: school.id, seqKey: s.seqKey } },
      update: {},
      create: { ...s, nextValue: BigInt(s.nextValue), schoolId: school.id },
    });
  }

  // Default expense categories (added if missing; the school's own changes are kept).
  for (const [i, c] of DEFAULT_EXPENSE_CATEGORIES.entries()) {
    const exists = await prisma.expenseCategory.findFirst({ where: { schoolId: school.id, OR: [{ code: c.code }, { name: c.name }] } });
    if (!exists) await prisma.expenseCategory.create({ data: { schoolId: school.id, code: c.code, name: c.name, isSalary: !!c.isSalary, isSystem: true, sortOrder: i + 1 } });
  }

  let generatedPassword: string | undefined;
  if ((await prisma.user.count({ where: { schoolId: school.id } })) === 0) {
    generatedPassword = opts.adminPassword || `Cps-${randomBytes(6).toString('base64url')}9`;
    const superRole = await prisma.role.findUniqueOrThrow({ where: { schoolId_code: { schoolId: school.id, code: SYSTEM_ROLES.SUPER_ADMIN } } });
    await prisma.user.create({
      data: {
        schoolId: school.id,
        username: opts.adminUsername,
        mustChangePassword: true,
        passwordHash: await hash(generatedPassword, { memoryCost: 65536, timeCost: 3, parallelism: 1 }),
        roles: { create: { roleId: superRole.id, scopeType: 'SCHOOL' } },
      },
    });
    log(`Created Super Admin "${opts.adminUsername}". Temporary password: ${opts.adminPassword ? '(value of SEED_ADMIN_PASSWORD)' : generatedPassword}`);
    log('You will be asked to change it at first login.');
  }
  return { school, year, generatedPassword };
}
