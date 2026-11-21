import { ledgerFigures, RTE_CONCESSION_REASON, round2 } from '@cps/shared';
import { invalidState } from '../common/crud';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService, Tx } from '../infra/prisma.service';

export const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));

/** Sum of VALID receipts per enrollment (= per ledger). */
export async function paidByEnrollment(db: Tx | PrismaService, enrollmentIds: bigint[]) {
  if (!enrollmentIds.length) return new Map<string, number>();
  const rows = await db.feePayment.groupBy({ by: ['enrollmentId'], where: { enrollmentId: { in: enrollmentIds }, status: 'VALID' }, _sum: { amount: true } });
  return new Map(rows.map((r) => [String(r.enrollmentId), round2(num(r._sum.amount))]));
}

/**
 * Bring all of one student's ledgers up to date, oldest year first:
 *  - every enrollment (admission, promotion, re-admission) has exactly one ledger;
 *  - the ledger's year fee is the class's annual fee for that year (0 until the office sets it);
 *  - RTE students get the whole year fee as concession;
 *  - each year's "previous year outstanding" is the closing balance of the year before — carried forward,
 *    never copied into the year fee. The first ledger keeps the opening balance typed in by the office.
 * A change that would leave a ledger with more paid than payable is refused (refund / cancel first).
 */
export async function syncStudentFees(tx: Tx, studentId: bigint, userId: bigint | null) {
  const student = await tx.student.findUnique({ where: { id: studentId }, select: { isRte: true, fullName: true } });
  if (!student) return;
  const enrollments = await tx.studentEnrollment.findMany({
    // Provisional admissions (waiting for the Headmaster) are charged like confirmed ones; rejected ones are not.
    where: { studentId, status: { not: 'REJECTED' } },
    include: { academicYear: { select: { name: true, startDate: true } }, feeLedger: true, schoolClass: { select: { classFee: { select: { amount: true } } } } },
    orderBy: { academicYear: { startDate: 'asc' } },
  });
  const paid = await paidByEnrollment(tx, enrollments.map((e) => e.id));
  let carry = 0;
  for (const [i, e] of enrollments.entries()) {
    const l = e.feeLedger;
    const yearFee = num(e.schoolClass.classFee?.amount);
    let concession = l ? num(l.concession) : 0;
    let reason = l?.concessionReason ?? null;
    if (student.isRte) {
      concession = yearFee;
      reason = RTE_CONCESSION_REASON;
    } else if (reason === RTE_CONCESSION_REASON) {
      concession = 0;
      reason = null;
    }
    concession = round2(Math.min(concession, yearFee));
    const previousOutstanding = i === 0 ? (l ? num(l.previousOutstanding) : 0) : carry;
    const data = {
      yearFee, concession, concessionReason: concession > 0 ? reason : null, previousOutstanding,
      openingReason: i === 0 ? (l?.openingReason ?? null) : null,
    };
    if (!l) {
      await tx.studentFeeLedger.create({ data: { studentId, academicYearId: e.academicYearId, enrollmentId: e.id, ...data, createdBy: userId } });
    } else if (num(l.yearFee) !== yearFee || num(l.concession) !== concession || num(l.previousOutstanding) !== previousOutstanding
      || l.concessionReason !== data.concessionReason || l.openingReason !== data.openingReason) {
      await tx.studentFeeLedger.update({ where: { id: l.id }, data: { ...data, version: { increment: 1 }, updatedBy: userId } });
    }
    const f = ledgerFigures({ previousOutstanding, yearFee, concession, penalty: l ? num(l.penalty) : 0, paid: paid.get(String(e.id)) ?? 0 });
    if (f.balance < -0.004) {
      throw invalidState(`${student.fullName} has already paid ₹${f.paid.toLocaleString('en-IN')} for ${e.academicYear.name}, more than the new total of ₹${f.totalPayable.toLocaleString('en-IN')}. Cancel or adjust that receipt first.`);
    }
    carry = Math.max(0, f.balance);
  }
}
