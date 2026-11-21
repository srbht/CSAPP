import { defaultPattern, legacyPattern, type MarkPattern, patternGroup, patternMax } from '@cps/shared';
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));
/** Same as WorkflowService.hash for MARKS. */
const markHash = (m: { marks1: Prisma.Decimal | null; marks2: Prisma.Decimal | null; absent: boolean; parts: Record<string, number | null> }) => {
  const parts = Object.entries(m.parts).filter(([, v]) => v != null).map(([k, v]) => [k, Number(v)] as const).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([num(m.marks1), num(m.marks2), !!m.absent, parts])).digest('hex');
};

/**
 * One-time move to the Greensheet format (safe to run again: it only touches what is not converted yet).
 *  1. Unit tests are archived (kept read-only, hidden from lists and task inboxes).
 *  2. Semester subjects WITHOUT marks get the school's Greensheet pattern for their standard.
 *  3. Semester subjects WITH marks keep exactly what was typed: Formative total + Summative total, now stored as
 *     two parts (nothing is invented or rescaled). The Headmaster can switch such a subject to the part-wise pattern
 *     while its sheet is still with the operator.
 *  4. Classes IX–X: activity subjects (Water Security, C.D. & R.S., Phy. Edu.) are left out of the total, as on the sheet.
 */
export async function convertToGreensheet(prisma: PrismaClient, log: (m: string) => void = () => {}) {
  const archived = await prisma.exam.updateMany({ where: { kind: 'UNIT_TEST', status: { not: 'ARCHIVED' } }, data: { status: 'ARCHIVED' } });
  const es = (await prisma.examSubject.findMany({
    where: { exam: { kind: 'SEMESTER' } },
    include: { classSubject: { include: { subject: true, schoolClass: { include: { standard: true } } } } },
  })).filter((e) => e.parts == null);
  let patterned = 0, kept = 0, marksMoved = 0;
  for (const e of es) {
    const marks = await prisma.mark.findMany({ where: { examId: e.examId, classSubjectId: e.classSubjectId } });
    let parts: MarkPattern;
    if (marks.length) {
      parts = legacyPattern(Number(e.max1), num(e.max2));
      kept++;
      for (const m of marks) {
        const p = m.absent ? {} : Object.fromEntries([['FE_TOTAL', num(m.marks1)], ...(e.max2 != null ? [['SE_TOTAL', num(m.marks2)]] : [])].filter(([, v]) => v != null));
        await prisma.mark.update({
          where: { id: m.id },
          data: { parts: p, ...(m.rowStatus === 'VERIFIED' ? { verifiedHash: markHash({ ...m, parts: p as Record<string, number> }) } : {}) },
        });
        marksMoved++;
      }
    } else {
      const cs = e.classSubject;
      parts = defaultPattern(cs.schoolClass.standard.code, cs.subject.code, cs.subject.subjectType);
      patterned++;
    }
    const mx = patternMax(parts);
    await prisma.examSubject.update({ where: { id: e.id }, data: { parts: parts as unknown as Prisma.InputJsonValue, max1: mx.max1, max2: mx.max2 } });
  }
  const senior = await prisma.classSubject.findMany({ where: { includeInTotal: true, subject: { subjectType: 'ACTIVITY' }, schoolClass: { standard: { code: { in: ['IX', 'X'] } } } }, include: { schoolClass: { include: { standard: true } } } });
  const toExclude = senior.filter((c) => patternGroup(c.schoolClass.standard.code) === 'IX-X').map((c) => c.id);
  if (toExclude.length) await prisma.classSubject.updateMany({ where: { id: { in: toExclude } }, data: { includeInTotal: false } });
  if (archived.count || patterned || kept || toExclude.length) {
    log(`Greensheet: ${archived.count} unit test(s) archived · ${patterned} subject(s) given the Greensheet pattern · ${kept} subject(s) with marks kept as totals (${marksMoved} marks) · ${toExclude.length} IX–X activity subject(s) left out of the total`);
  }
  return { archived: archived.count, patterned, kept, marksMoved, excluded: toExclude.length };
}
