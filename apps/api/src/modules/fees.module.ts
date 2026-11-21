import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  amountInWords, cancelReceiptSchema, ClassFeeCopyInput, classFeeCopySchema, ClassFeeInput, classFeeSchema, concessionSchema, ledgerFigures, ledgerState,
  type LedgerFigures, type LedgerState, openingBalanceSchema, paymentEditSchema, PaymentInput, paymentReissueSchema, paymentSchema, PERMISSIONS, round2, RTE_CONCESSION_REASON, todayIn, grNoLabel } from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { conflict, forbidden, invalid, isUniqueViolation, notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { page, skipTake } from '../common/serialize';
import { dateOnly, IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';
import { num as n, paidByEnrollment, syncStudentFees } from './fee-ledger';
import { PoliciesSequencesModule, SequencesService } from './policies-sequences.module';
import { activePenalties, isHeadmaster, loadPlan, scheduleFor } from './fee-instalments.module';

const P = PERMISSIONS;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

const studentSel = { id: true, fullName: true, fullNameHi: true, studentCode: true, grNo: true, grNoTemp: true, isRte: true, guardians: { where: { isPrimary: true }, take: 1, include: { guardian: { select: { name: true, mobile: true } } } } } as const;
const sectionSel = { id: true, name: true, schoolClass: { select: { id: true, displayName: true, code: true, medium: { select: { code: true, nameEn: true } }, standard: { select: { code: true, levelOrder: true } } } } } as const;
// A fee discount or late fee is the Headmaster's decision only (not the admin or the office): see isHeadmaster.
const SUM_KEYS = ['previousOutstanding', 'currentYearFee', 'concession', 'currentYearNet', 'penalty', 'totalPayable', 'paid', 'paidTowardsPrevious', 'balance', 'previousStillDue'] as const;
const zero = () => Object.fromEntries(SUM_KEYS.map((k) => [k, 0])) as Record<(typeof SUM_KEYS)[number], number>;
function add(sum: ReturnType<typeof zero>, f: LedgerFigures) {
  for (const k of SUM_KEYS) sum[k] = round2(sum[k] + f[k]);
  return sum;
}
const figuresOf = (l: { previousOutstanding: Prisma.Decimal; yearFee: Prisma.Decimal; concession: Prisma.Decimal; penalty: Prisma.Decimal } | null, paid: number) =>
  ledgerFigures({ previousOutstanding: n(l?.previousOutstanding), yearFee: n(l?.yearFee), concession: n(l?.concession), penalty: n(l?.penalty), paid });

/**
 * Fees: one annual fee per class and year, one ledger per student and year, receipts against the ledger.
 * Office staff collect; the Headmaster / admin set class fees, give concessions and cancel receipts.
 * Fee data is school-wide office work, so it needs school-wide scope (teachers do not see fees).
 */
@Injectable()
export class FeesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scopes: ScopeService, private readonly sequences: SequencesService) {}

  private async year(ctx: AccessContext, academicYearId?: number | bigint) {
    const y = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, ...(academicYearId ? { id: BigInt(academicYearId) } : { isCurrent: true }) } });
    if (!y) throw notFound('Academic year');
    const scope = await this.scopes.resolve(ctx, y.id);
    if (!scope.all) throw forbidden('Fees are handled by the school office');
    return y;
  }

  /** Re-sync every student of these classes (after a class fee changes). */
  private async syncClasses(tx: Prisma.TransactionClient, classIds: bigint[], userId: bigint) {
    const students = await tx.studentEnrollment.findMany({ where: { classId: { in: classIds } }, select: { studentId: true }, distinct: ['studentId'] });
    for (const s of students) await syncStudentFees(tx, s.studentId, userId);
    return students.length;
  }

  // ------------------------------------------------------------------ class fees
  async classFees(ctx: AccessContext, academicYearId?: number) {
    const y = await this.year(ctx, academicYearId);
    const classes = await this.prisma.schoolClass.findMany({
      where: { academicYearId: y.id, status: 'ACTIVE' },
      include: { medium: true, standard: true, classFee: true, _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
      orderBy: [{ medium: { sortOrder: 'asc' } }, { standard: { levelOrder: 'asc' } }],
    });
    // The year before, so the screen can offer "copy last year's fees".
    const previous = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, startDate: { lt: y.startDate } }, orderBy: { startDate: 'desc' }, select: { id: true, name: true } });
    const prevFees = previous
      ? await this.prisma.classFee.findMany({ where: { academicYearId: previous.id }, include: { schoolClass: { select: { mediumId: true, standardId: true } } } })
      : [];
    const prevBy = new Map(prevFees.map((f) => [`${f.schoolClass.mediumId}:${f.schoolClass.standardId}`, n(f.amount)]));
    return {
      year: { id: y.id, name: y.name, status: y.status, editable: y.status !== 'CLOSED' },
      previousYear: previous ? { ...previous, classesWithFees: prevFees.length } : null,
      classes: classes.map((c) => ({
        classId: c.id, displayName: c.displayName, medium: c.medium.nameEn, mediumCode: c.medium.code, students: c._count.enrollments,
        amount: c.classFee ? n(c.classFee.amount) : null, updatedAt: c.classFee?.updatedAt ?? null,
        previousYearAmount: prevBy.get(`${c.mediumId}:${c.standardId}`) ?? null,
      })),
    };
  }

  /** Set a class's annual fee. Only that year's ledgers change; earlier years keep their own fees. */
  async saveClassFee(ctx: AccessContext, classId: bigint, input: ClassFeeInput) {
    const cls = await this.prisma.schoolClass.findFirst({ where: { id: classId, academicYear: { schoolId: ctx.schoolId } }, include: { academicYear: true, classFee: true } });
    if (!cls) throw notFound('Class');
    await this.year(ctx, cls.academicYearId);
    if (cls.academicYear.status === 'CLOSED') throw invalidState(`${cls.academicYear.name} is closed; its fees are kept as history and cannot be changed`);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.classFee.upsert({
        where: { classId },
        create: { academicYearId: cls.academicYearId, classId, amount: input.amount, createdBy: ctx.userId },
        update: { amount: input.amount, updatedBy: ctx.userId },
      });
      const students = await this.syncClasses(tx, [classId], ctx.userId);
      await this.audit.record(ctx, { action: cls.classFee ? 'UPDATE' : 'CREATE', entityType: 'ClassFee', entityId: after.id, before: cls.classFee ? { amount: n(cls.classFee.amount) } : null, after: { class: cls.displayName, year: cls.academicYear.name, amount: input.amount, students } }, tx);
      return { classId, amount: input.amount, students };
    }, { timeout: 60_000 });
  }

  /** Copy last year's class fees into a new year: classes are matched by medium + standard. */
  async copyClassFees(ctx: AccessContext, input: ClassFeeCopyInput) {
    if (input.fromAcademicYearId === input.toAcademicYearId) throw invalid('Choose a different year to copy from');
    const [from, to] = [await this.year(ctx, input.fromAcademicYearId), await this.year(ctx, input.toAcademicYearId)];
    if (to.status === 'CLOSED') throw invalidState(`${to.name} is closed; its fees cannot be changed`);
    const source = await this.prisma.classFee.findMany({ where: { academicYearId: from.id }, include: { schoolClass: { select: { mediumId: true, standardId: true } } } });
    if (!source.length) throw invalidState(`${from.name} has no class fees to copy`);
    const bySlot = new Map(source.map((f) => [`${f.schoolClass.mediumId}:${f.schoolClass.standardId}`, n(f.amount)]));
    const targets = await this.prisma.schoolClass.findMany({ where: { academicYearId: to.id, status: 'ACTIVE' }, include: { classFee: true } });
    const copied: bigint[] = [];
    let skipped = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const c of targets) {
        const amount = bySlot.get(`${c.mediumId}:${c.standardId}`);
        if (amount === undefined) continue;
        if (c.classFee && !input.overwrite) { skipped++; continue; }
        await tx.classFee.upsert({ where: { classId: c.id }, create: { academicYearId: to.id, classId: c.id, amount, createdBy: ctx.userId }, update: { amount, updatedBy: ctx.userId } });
        copied.push(c.id);
      }
      if (copied.length) await this.syncClasses(tx, copied, ctx.userId);
      await this.audit.record(ctx, { action: 'COPY', entityType: 'ClassFee', entityId: to.id, after: { from: from.name, to: to.name, classes: copied.length, skipped, overwrite: input.overwrite } }, tx);
    }, { timeout: 120_000 });
    return { copied: copied.length, skipped, unmatched: targets.length - copied.length - skipped };
  }

  // ------------------------------------------------------------------ one student's ledger
  async account(ctx: AccessContext, studentId: bigint, academicYearId?: number) {
    const y = await this.year(ctx, academicYearId);
    const student = await this.prisma.student.findFirst({ where: { id: studentId, schoolId: ctx.schoolId }, select: studentSel });
    if (!student) throw notFound('Student');
    const load = () => this.prisma.studentEnrollment.findMany({
      where: { studentId, status: { not: 'REJECTED' } }, orderBy: { academicYear: { startDate: 'asc' } },
      include: { feeLedger: true, academicYear: { select: { id: true, name: true, status: true } }, section: { select: sectionSel } },
    });
    let all = await load();
    if (all.some((x) => !x.feeLedger)) {
      // Enrollments from before ledgers existed: open them now.
      await this.prisma.$transaction((tx) => syncStudentFees(tx, studentId, ctx.userId));
      all = await load();
    }
    const e = all.find((x) => x.academicYearId === y.id);
    if (!e?.feeLedger) throw notFound('Student in this academic year');
    const paid = await paidByEnrollment(this.prisma, all.map((x) => x.id));
    const payments = await this.prisma.feePayment.findMany({ where: { enrollmentId: e.id }, orderBy: [{ paidOn: 'desc' }, { id: 'desc' }] });
    const f = figuresOf(e.feeLedger, paid.get(String(e.id)) ?? 0);
    const today = await this.schoolToday(ctx);
    const schedule = scheduleFor(await loadPlan(this.prisma, y.id), e.classId, e.feeLedger, f.paid, (await activePenalties(this.prisma, [e.feeLedger.id])).get(String(e.feeLedger.id)), today);
    const penalties = await this.prisma.feePenalty.findMany({ where: { ledgerId: e.feeLedger.id }, include: { instalment: { select: { label: true } } }, orderBy: { id: 'asc' } });
    const idx = all.indexOf(e);
    const later = all.slice(idx + 1)[0];
    const g = student.guardians[0]?.guardian;
    return {
      year: { id: y.id, name: y.name }, enrollmentId: e.id, ledgerId: e.feeLedger.id,
      student: { id: student.id, fullName: student.fullName, fullNameHi: student.fullNameHi, studentCode: student.studentCode, grNo: grNoLabel(student) || null, provisional: e.status === 'PENDING_APPROVAL', isRte: student.isRte, rollNo: e.rollNo, examNo: e.examNo, contact: g ? { name: g.name, mobile: g.mobile } : null },
      section: e.section,
      ledger: {
        ...f, state: ledgerState(f), concessionReason: e.feeLedger.concessionReason, openingReason: e.feeLedger.openingReason,
        isFirstYear: idx === 0, previousYear: idx > 0 ? all[idx - 1].academicYear.name : null,
        /** Payments are taken on the student's latest year only: older balances have moved forward. */
        canCollect: !later, carriedTo: later ? later.academicYear.name : null,
        /** Only the Headmaster gives a discount (not for RTE students, who pay nothing). */
        canDiscount: isHeadmaster(ctx) && ctx.permissions.has(P.FEES_CONCESSION) && !student.isRte && f.currentYearFee > 0,
        canWaive: isHeadmaster(ctx) && ctx.permissions.has(P.FEES_MANAGE),
      },
      /** The year's instalments (null when no instalment plan is set for the class). */
      instalments: schedule,
      penalties: penalties.map((p) => ({ id: p.id, instalment: p.instalment.label, amount: n(p.amount), status: p.status, waiveReason: p.waiveReason, createdAt: p.createdAt, waivedAt: p.waivedAt })),
      history: all.map((x) => {
        const hf = figuresOf(x.feeLedger, paid.get(String(x.id)) ?? 0);
        return { year: x.academicYear, className: `${x.section.schoolClass.displayName} ${x.section.name}`, status: x.status, ...hf, state: ledgerState(hf) };
      }),
      payments: payments.map((p) => ({
        id: p.id, receiptNo: p.receiptNo, manualReceiptNo: p.manualReceiptNo, isBackdated: p.isBackdated, paidOn: p.paidOn, amount: n(p.amount), mode: p.mode, reference: p.reference, payerName: p.payerName, remarks: p.remarks,
        balanceAfter: n(p.balanceAfter), status: p.status, cancelReason: p.cancelReason, createdAt: p.createdAt,
      })),
    };
  }

  private async ledgerFor(ctx: AccessContext, ledgerId: bigint) {
    const l = await this.prisma.studentFeeLedger.findFirst({ where: { id: ledgerId, enrollment: { student: { schoolId: ctx.schoolId } } }, include: { enrollment: { include: { academicYear: true, student: { select: { fullName: true } } } } } });
    if (!l) throw notFound('Fee ledger');
    await this.year(ctx, l.academicYearId);
    const paid = (await paidByEnrollment(this.prisma, [l.enrollmentId])).get(String(l.enrollmentId)) ?? 0;
    return { l, f: figuresOf(l, paid) };
  }

  async concession(ctx: AccessContext, ledgerId: bigint, input: z.infer<typeof concessionSchema>) {
    if (!isHeadmaster(ctx)) throw forbidden('Only the Headmaster can give a fee discount');
    const { l, f } = await this.ledgerFor(ctx, ledgerId);
    if (l.concessionReason === RTE_CONCESSION_REASON) throw invalidState('RTE students are not charged the year fee; untick RTE on the student to change this');
    if (input.concession > f.currentYearFee) throw invalid(`A concession cannot be more than this year's fee (₹${f.currentYearFee.toLocaleString('en-IN')})`, [{ path: 'concession', code: 'too_much', message: 'More than the year fee' }]);
    return this.prisma.$transaction(async (tx) => {
      await tx.studentFeeLedger.update({ where: { id: ledgerId }, data: { concession: input.concession, concessionReason: input.concession > 0 ? input.reason : null, version: { increment: 1 }, updatedBy: ctx.userId } });
      await syncStudentFees(tx, l.studentId, ctx.userId);
      await this.audit.record(ctx, { action: 'CONCESSION', entityType: 'StudentFeeLedger', entityId: ledgerId, before: { concession: f.concession }, after: { concession: input.concession }, reason: input.reason }, tx);
      return { concession: input.concession };
    });
  }

  /** Outstanding from before the ERP: only on the student's first ledger (later years carry forward automatically). */
  async opening(ctx: AccessContext, ledgerId: bigint, input: z.infer<typeof openingBalanceSchema>) {
    const { l, f } = await this.ledgerFor(ctx, ledgerId);
    const earlier = await this.prisma.studentEnrollment.count({ where: { studentId: l.studentId, academicYear: { startDate: { lt: l.enrollment.academicYear.startDate } } } });
    if (earlier) throw invalidState('Previous year outstanding is carried forward automatically from last year\'s ledger; it can only be typed in for a student\'s first year');
    return this.prisma.$transaction(async (tx) => {
      await tx.studentFeeLedger.update({ where: { id: ledgerId }, data: { previousOutstanding: input.amount, openingReason: input.reason, version: { increment: 1 }, updatedBy: ctx.userId } });
      await syncStudentFees(tx, l.studentId, ctx.userId);
      await this.audit.record(ctx, { action: 'OPENING_BALANCE', entityType: 'StudentFeeLedger', entityId: ledgerId, before: { previousOutstanding: f.previousOutstanding }, after: { previousOutstanding: input.amount }, reason: input.reason }, tx);
      return { previousOutstanding: input.amount };
    });
  }

  // ------------------------------------------------------------------ collect
  private async schoolToday(ctx: AccessContext, at?: Date) {
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { timezone: true } });
    return todayIn(school.timezone || 'Asia/Kolkata', at);
  }

  /** A manual (physical) receipt number may be used by only one valid receipt. */
  private async assertManualFree(db: Tx | PrismaService, ctx: AccessContext, manual: string, exceptId?: bigint) {
    const used = await db.feePayment.findFirst({ where: { schoolId: ctx.schoolId, manualReceiptNo: manual, status: 'VALID', ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { receiptNo: true } });
    if (used) throw conflict('DUPLICATE', `Manual receipt number ${manual} is already used on receipt ${used.receiptNo}`, [{ path: 'manualReceiptNo', code: 'duplicate', message: `Already used on ${used.receiptNo}` }]);
  }

  /**
   * Issue a receipt against the student's ledger. Part payments are normal; the previous year's outstanding is cleared first.
   * A payment dated before today (in the school's timezone) is BACKDATED: the physical receipt book number is required and kept
   * next to the system receipt number, which is always generated and never replaced.
   */
  async collect(ctx: AccessContext, input: PaymentInput) {
    const e = await this.prisma.studentEnrollment.findFirst({ where: { id: BigInt(input.enrollmentId), student: { schoolId: ctx.schoolId } }, include: { academicYear: true } });
    if (!e) throw notFound('Student');
    if (e.status === 'REJECTED') throw invalidState('This admission was rejected; no fees can be collected');
    await this.year(ctx, e.academicYearId);
    const today = await this.schoolToday(ctx);
    if (input.paidOn > today) throw invalid('The payment date cannot be in the future', [{ path: 'paidOn', code: 'future', message: 'Cannot be in the future' }]);
    const backdated = input.paidOn < today;
    if (backdated && !input.manualReceiptNo) throw invalid('This payment is dated before today: enter the manual (physical) receipt number', [{ path: 'manualReceiptNo', code: 'required', message: 'Required for a backdated payment' }]);
    const later = await this.prisma.studentEnrollment.findFirst({ where: { studentId: e.studentId, academicYear: { startDate: { gt: e.academicYear.startDate } } }, include: { academicYear: { select: { name: true } } } });
    if (later) throw invalidState(`${e.academicYear.name} is closed for payments: its balance was carried forward to ${later.academicYear.name}. Collect it in ${later.academicYear.name}.`);
    const receipt = await this.prisma.$transaction((tx) => this.issue(tx, ctx, e, { ...input, isBackdated: backdated }));
    return this.receipt(ctx, receipt.id);
  }

  private async issue(tx: Tx, ctx: AccessContext, e: { id: bigint; studentId: bigint; academicYearId: bigint; academicYear: { name: string } }, input: PaymentInput & { isBackdated: boolean; auditReason?: string }) {
    await syncStudentFees(tx, e.studentId, ctx.userId);
    // Lock this student's ledger so two counters cannot take the same balance twice.
    await tx.$queryRaw`SELECT id FROM student_fee_ledgers WHERE enrollment_id = ${e.id} FOR UPDATE`;
    if (input.manualReceiptNo) await this.assertManualFree(tx, ctx, input.manualReceiptNo);
    const l = await tx.studentFeeLedger.findUniqueOrThrow({ where: { enrollmentId: e.id } });
    const paid = (await paidByEnrollment(tx, [e.id])).get(String(e.id)) ?? 0;
    const f = figuresOf(l, paid);
    if (f.balance <= 0) throw invalidState('This student has no balance to pay');
    if (input.amount > f.balance + 0.001) throw invalid(`The amount is more than the balance (₹${f.balance.toLocaleString('en-IN')})`, [{ path: 'amount', code: 'too_much', message: `Balance is ₹${f.balance.toLocaleString('en-IN')}` }]);
    const key = `fee_receipt:${e.academicYear.name}`;
    await tx.numberSequence.upsert({ where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: key } }, update: {}, create: { schoolId: ctx.schoolId, seqKey: key, label: `Fee receipt ${e.academicYear.name}`, pattern: `FR/${e.academicYear.name}/{00000}`, nextValue: BigInt(1) } });
    const receiptNo = await this.sequences.next(tx, ctx.schoolId, key);
    const balanceAfter = round2(f.balance - input.amount);
    let p;
    try {
      p = await tx.feePayment.create({
        data: {
          schoolId: ctx.schoolId, academicYearId: e.academicYearId, enrollmentId: e.id, receiptNo, manualReceiptNo: input.manualReceiptNo ?? null, isBackdated: input.isBackdated,
          paidOn: dateOnly(input.paidOn)!, amount: input.amount, mode: input.mode, reference: input.reference || null, payerName: input.payerName || null, remarks: input.remarks || null,
          previousOutstanding: f.previousOutstanding, currentYearFee: f.currentYearFee, concession: f.concession, penalty: f.penalty, totalPayable: f.totalPayable, paidBefore: f.paid, balanceAfter,
          createdBy: ctx.userId,
        },
      });
    } catch (err) {
      // The database refuses a second valid receipt with the same manual number (two counters at the same moment).
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', `Manual receipt number ${input.manualReceiptNo} is already used`, [{ path: 'manualReceiptNo', code: 'duplicate', message: 'Already used' }]);
      throw err;
    }
    await this.audit.record(ctx, { action: 'COLLECT', entityType: 'FeePayment', entityId: p.id, after: { receiptNo, manualReceiptNo: p.manualReceiptNo, backdated: input.isBackdated, paidOn: input.paidOn, amount: input.amount, mode: input.mode, balanceAfter }, reason: input.auditReason }, tx);
    return p;
  }

  /**
   * Correct a receipt's details (Headmaster / Super Admin, with a reason): payment date, mode, reference, payer, remarks and
   * manual receipt number. The system receipt number and the amount never change here.
   */
  async edit(ctx: AccessContext, id: bigint, input: z.infer<typeof paymentEditSchema>) {
    const p = await this.prisma.feePayment.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!p) throw notFound('Receipt');
    await this.year(ctx, p.academicYearId);
    if (p.status !== 'VALID') throw invalidState('A cancelled receipt cannot be changed');
    if (input.paidOn > (await this.schoolToday(ctx))) throw invalid('The payment date cannot be in the future', [{ path: 'paidOn', code: 'future', message: 'Cannot be in the future' }]);
    // Backdated = paid before the day it was entered.
    const backdated = input.paidOn < (await this.schoolToday(ctx, p.createdAt));
    if (backdated && !input.manualReceiptNo) throw invalid('This payment is dated before the day it was entered: a manual receipt number is required', [{ path: 'manualReceiptNo', code: 'required', message: 'Required for a backdated payment' }]);
    return this.prisma.$transaction(async (tx) => {
      if (input.manualReceiptNo && input.manualReceiptNo !== p.manualReceiptNo) await this.assertManualFree(tx, ctx, input.manualReceiptNo, id);
      let after;
      try {
        after = await tx.feePayment.update({
          where: { id },
          data: { paidOn: dateOnly(input.paidOn)!, mode: input.mode, reference: input.reference, payerName: input.payerName, remarks: input.remarks, manualReceiptNo: input.manualReceiptNo, isBackdated: backdated },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('DUPLICATE', `Manual receipt number ${input.manualReceiptNo} is already used`);
        throw err;
      }
      const pick = (x: typeof p) => ({ paidOn: iso(x.paidOn), mode: x.mode, reference: x.reference, payerName: x.payerName, remarks: x.remarks, manualReceiptNo: x.manualReceiptNo, isBackdated: x.isBackdated });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'FeePayment', entityId: id, before: pick(p), after: pick(after), reason: input.reason }, tx);
      return after;
    });
  }

  /** Wrong amount: the receipt is cancelled (kept, with the reason) and a corrected receipt is issued for the same payment. */
  async reissue(ctx: AccessContext, id: bigint, input: z.infer<typeof paymentReissueSchema>) {
    const p = await this.prisma.feePayment.findFirst({ where: { id, schoolId: ctx.schoolId }, include: { enrollment: { include: { academicYear: true } } } });
    if (!p) throw notFound('Receipt');
    await this.year(ctx, p.academicYearId);
    if (p.status !== 'VALID') throw invalidState('This receipt is already cancelled');
    if (Math.abs(n(p.amount) - input.amount) < 0.005) throw invalid('The new amount is the same as the old one');
    const newer = await this.prisma.studentEnrollment.findFirst({ where: { studentId: p.enrollment.studentId, academicYear: { startDate: { gt: p.enrollment.academicYear.startDate } } } });
    if (newer) throw invalidState('This year\'s balance has moved to the next year: cancel the receipt and collect the correct amount in the new year');
    const paidOn = iso(p.paidOn);
    const backdated = paidOn < (await this.schoolToday(ctx));
    if (backdated && !p.manualReceiptNo) throw invalid('The original receipt has no manual receipt number: correct its details first, then the amount');
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.feePayment.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: `Amount corrected (re-issued): ${input.reason}`, cancelledBy: ctx.userId, cancelledAt: new Date() } });
      await this.audit.record(ctx, { action: 'CANCEL', entityType: 'FeePayment', entityId: id, before: { status: 'VALID', amount: n(p.amount) }, after: { status: 'CANCELLED', receiptNo: p.receiptNo }, reason: `Re-issue with amount ${input.amount}: ${input.reason}` }, tx);
      return this.issue(tx, ctx, p.enrollment, {
        enrollmentId: Number(p.enrollmentId), paidOn, amount: input.amount, mode: p.mode as PaymentInput['mode'], reference: p.reference, payerName: p.payerName,
        remarks: `Corrected re-issue of ${p.receiptNo}${p.remarks ? ` · ${p.remarks}` : ''}`.slice(0, 300), manualReceiptNo: p.manualReceiptNo, isBackdated: backdated,
        auditReason: `Re-issue of ${p.receiptNo} (amount ${n(p.amount)} → ${input.amount}): ${input.reason}`,
      });
    });
    return this.receipt(ctx, created.id);
  }

  /** The receipt shows the ledger as it was when the money was taken, and only the amount collected in this transaction. */
  async receipt(ctx: AccessContext, id: bigint) {
    const p = await this.prisma.feePayment.findFirst({
      where: { id, schoolId: ctx.schoolId },
      include: { enrollment: { include: { student: { select: studentSel }, section: { select: sectionSel }, academicYear: { select: { name: true } }, feeLedger: true } } },
    });
    if (!p) throw notFound('Receipt');
    await this.year(ctx, p.academicYearId);
    const [school, by] = await Promise.all([
      this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId } }),
      this.prisma.user.findUnique({ where: { id: p.createdBy }, include: { staff: { select: { name: true } } } }),
    ]);
    const currentYearNet = round2(n(p.currentYearFee) - n(p.concession));
    // Which instalments this payment covers (instalments as they stand now, money up to and including this receipt).
    const l = p.enrollment.feeLedger;
    const schedule = l ? scheduleFor(await loadPlan(this.prisma, p.academicYearId), p.enrollment.classId, l, round2(n(p.paidBefore) + n(p.amount)), (await activePenalties(this.prisma, [l.id])).get(String(l.id)), iso(p.paidOn)) : null;
    return {
      id: p.id, receiptNo: p.receiptNo, manualReceiptNo: p.manualReceiptNo, isBackdated: p.isBackdated, paidOn: p.paidOn, amount: n(p.amount), amountInWords: amountInWords(n(p.amount)), mode: p.mode, reference: p.reference,
      payerName: p.payerName, remarks: p.remarks, status: p.status, cancelReason: p.cancelReason, cancelledAt: p.cancelledAt, createdAt: p.createdAt,
      receivedBy: by?.staff?.name ?? by?.username ?? null,
      instalments: schedule ? schedule.lines.map((x) => ({ label: x.label, dueOn: x.dueOn, total: x.total, paid: x.paid, balance: x.balance })) : null,
      ledger: {
        previousOutstanding: n(p.previousOutstanding), currentYearFee: n(p.currentYearFee), concession: n(p.concession), currentYearNet, penalty: n(p.penalty),
        totalPayable: n(p.totalPayable), paidBefore: n(p.paidBefore), paidToday: n(p.amount), totalPaid: round2(n(p.paidBefore) + n(p.amount)), balanceAfter: n(p.balanceAfter),
      },
      student: { id: p.enrollment.student.id, fullName: p.enrollment.student.fullName, studentCode: p.enrollment.student.studentCode, grNo: grNoLabel(p.enrollment.student) || null, provisional: p.enrollment.status === 'PENDING_APPROVAL', rollNo: p.enrollment.rollNo, section: p.enrollment.section, year: p.enrollment.academicYear.name },
      school: { name: school.name, nameHi: school.nameHi, address: [school.addressLine, school.city, school.pincode].filter(Boolean).join(', '), phone: school.phone, logoFileId: school.logoFileId == null ? null : Number(school.logoFileId) },
    };
  }

  async cancel(ctx: AccessContext, id: bigint, reason: string) {
    const p = await this.prisma.feePayment.findFirst({ where: { id, schoolId: ctx.schoolId }, include: { enrollment: { select: { studentId: true } } } });
    if (!p) throw notFound('Receipt');
    await this.year(ctx, p.academicYearId);
    if (p.status === 'CANCELLED') throw invalidState('This receipt is already cancelled');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.feePayment.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason, cancelledBy: ctx.userId, cancelledAt: new Date() } });
      // The amount is owed again; later years' "previous year outstanding" follows automatically.
      await syncStudentFees(tx, p.enrollment.studentId, ctx.userId);
      await this.audit.record(ctx, { action: 'CANCEL', entityType: 'FeePayment', entityId: id, before: { status: p.status }, after: { status: 'CANCELLED', receiptNo: p.receiptNo, amount: n(p.amount) }, reason }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------------ fee certificate (letter for the parent)
  /**
   * Issue a fee certificate: the annual fee of the student's class for the chosen year, numbered (FC-00001 …) and kept
   * in a register. What was printed is saved with it, so a reprint is identical even if the class fee changes later.
   */
  async issueCertificate(ctx: AccessContext, input: z.infer<typeof certificateSchema>) {
    const y = await this.year(ctx, input.academicYearId);
    const e = await this.prisma.studentEnrollment.findFirst({
      where: { studentId: BigInt(input.studentId), academicYearId: y.id, student: { schoolId: ctx.schoolId }, status: { notIn: ['PENDING_APPROVAL', 'REJECTED'] } },
      include: { student: { select: { fullName: true } }, feeLedger: true, schoolClass: { include: { classFee: true, medium: true, standard: true } } },
    });
    if (!e) throw notFound(`The student in ${y.name} (an admission must be approved first)`);
    if (!e.schoolClass.classFee) throw invalidState(`No annual fee is set for ${e.schoolClass.displayName} in ${y.name}. Set it in Fees → Class fees first.`);
    const std = e.schoolClass.standard;
    const className = std.levelOrder >= 1 ? `Std ${std.nameEn}` : std.nameEn;
    const paidNow = (await paidByEnrollment(this.prisma, [e.id])).get(String(e.id)) ?? 0;
    return this.prisma.$transaction(async (tx) => {
      await tx.numberSequence.upsert({ where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: 'fee_certificate' } }, update: {}, create: { schoolId: ctx.schoolId, seqKey: 'fee_certificate', label: 'Fee certificate number', pattern: 'FC-{00000}', nextValue: BigInt(1) } });
      const certificateNo = await this.sequences.next(tx, ctx.schoolId, 'fee_certificate');
      const c = await tx.feeCertificate.create({
        data: {
          schoolId: ctx.schoolId, certificateNo, studentId: BigInt(input.studentId), enrollmentId: e.id, academicYearId: y.id, studentName: e.student.fullName,
          className, mediumName: e.schoolClass.medium.nameEn, yearName: y.name, amount: e.schoolClass.classFee!.amount, issuedBy: ctx.userId,
          // Paid towards THIS year's fee (money that cleared last year's outstanding does not count here).
          ...(() => {
            const f = figuresOf(e.feeLedger, paidNow);
            return { concession: round2(Math.min(f.concession, n(e.schoolClass.classFee!.amount))), paidAmount: round2(Math.max(0, f.paid - f.paidTowardsPrevious)) };
          })(),
        },
      });
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'FeeCertificate', entityId: c.id, after: { certificateNo, student: e.student.fullName, year: y.name, amount: n(c.amount) } }, tx);
      return { id: c.id, certificateNo };
    });
  }

  async certificate(ctx: AccessContext, id: bigint) {
    const c = await this.prisma.feeCertificate.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!c) throw notFound('Fee certificate');
    await this.year(ctx, c.academicYearId);
    const [student, school, by, year] = await Promise.all([
      this.prisma.student.findUniqueOrThrow({ where: { id: c.studentId }, select: { id: true, gender: true, grNo: true, grNoTemp: true, studentCode: true } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId } }),
      this.prisma.user.findUnique({ where: { id: c.issuedBy }, select: { username: true, staff: { select: { name: true } } } }),
      this.prisma.academicYear.findUnique({ where: { id: c.academicYearId }, select: { isCurrent: true } }),
    ]);
    return {
      id: c.id, certificateNo: c.certificateNo, issuedAt: c.issuedAt, issuedBy: by?.staff?.name ?? by?.username ?? null,
      student: { id: student.id, fullName: c.studentName, gender: student.gender, grNo: grNoLabel(student) || null, studentCode: student.studentCode }, className: c.className, mediumName: c.mediumName,
      yearName: c.yearName, currentYear: !!year?.isCurrent, amount: n(c.amount), amountInWords: amountInWords(n(c.amount)),
      ...(c.paidAmount == null ? { breakdown: null } : (() => {
        const concession = n(c.concession);
        const paid = n(c.paidAmount);
        const balance = round2(Math.max(0, n(c.amount) - concession - paid));
        return { breakdown: { concession, paid, balance, balanceInWords: amountInWords(balance) } };
      })()),
      school: { name: school.name, nameHi: school.nameHi, address: [school.addressLine, school.city, school.pincode].filter(Boolean).join(', '), phone: school.phone, email: school.email, udiseCode: school.udiseCode, principalTitle: school.principalTitle, principalName: school.principalName },
    };
  }

  async certificates(ctx: AccessContext, studentId: bigint) {
    await this.year(ctx);
    const rows = await this.prisma.feeCertificate.findMany({ where: { schoolId: ctx.schoolId, studentId }, orderBy: { id: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.issuedBy))] } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    const names = new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
    return rows.map((r) => ({ id: r.id, certificateNo: r.certificateNo, yearName: r.yearName, className: r.className, amount: n(r.amount), issuedAt: r.issuedAt, issuedBy: names.get(String(r.issuedBy)) ?? null }));
  }

  // ------------------------------------------------------------------ registers & reports
  private async yearRows(yearId: bigint, where: Prisma.StudentEnrollmentWhereInput = {}) {
    const enrollments = await this.prisma.studentEnrollment.findMany({
      // Everyone enrolled that year: after promotion last year's students are PROMOTED / DETAINED, and those who left may still owe.
      // Provisional admissions pay fees too, so they are in the registers; rejected applications are not.
      where: { academicYearId: yearId, status: { not: 'REJECTED' }, ...where },
      include: {
        student: { select: studentSel }, section: { select: sectionSel }, feeLedger: true,
        schoolClass: { select: { displayName: true, medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } } } },
        feePayments: { where: { status: 'VALID' }, orderBy: { paidOn: 'desc' }, take: 1, select: { paidOn: true, amount: true } },
      },
      orderBy: [{ medium: { sortOrder: 'asc' } }, { schoolClass: { standard: { levelOrder: 'asc' } } }, { section: { name: 'asc' } }, { rollNo: 'asc' }],
    });
    const paid = await paidByEnrollment(this.prisma, enrollments.map((e) => e.id));
    return enrollments.map((e) => {
      const f = figuresOf(e.feeLedger, paid.get(String(e.id)) ?? 0);
      return { e, f, state: ledgerState(f) };
    });
  }

  /** Per-student fee status for a class or the whole school (also the defaulters list). */
  async register(ctx: AccessContext, q: z.infer<typeof registerQuery>) {
    const y = await this.year(ctx, q.academicYearId);
    let rows = await this.yearRows(y.id, {
      ...(q.sectionId ? { sectionId: BigInt(q.sectionId) } : {}), ...(q.classId ? { classId: BigInt(q.classId) } : {}),
      ...(q.q ? { OR: [{ student: { fullName: { contains: q.q } } }, { student: { grNo: { contains: q.q } } }, { examNo: { contains: q.q } }] } : {}),
    });
    if (q.status) {
      rows = rows.filter((r) => (q.status === 'BALANCE' ? r.f.balance > 0 : q.status === 'PREVIOUS' ? r.f.previousStillDue > 0 : r.state === q.status));
    }
    if (q.sort === 'balance') rows.sort((a, b) => b.f.balance - a.f.balance);
    const sum = zero();
    for (const r of rows) add(sum, r.f);
    const slice = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    // The first instalment not yet paid in full (e.g. "2nd instalment overdue").
    const [plan, pens, today] = await Promise.all([loadPlan(this.prisma, y.id), activePenalties(this.prisma, slice.flatMap((r) => (r.e.feeLedger ? [r.e.feeLedger.id] : []))), this.schoolToday(ctx)]);
    const paged = slice.map(({ e, f, state }) => {
      const g = e.student.guardians[0]?.guardian;
      const next = scheduleFor(plan, e.classId, e.feeLedger, f.paid, e.feeLedger ? pens.get(String(e.feeLedger.id)) : undefined, today)?.lines.find((x) => x.balance > 0);
      return {
        nextInstalment: next ? { label: next.label, dueOn: next.dueOn, balance: next.balance, status: next.status } : null,
        studentId: e.student.id, enrollmentId: e.id, enrollmentStatus: e.status, fullName: e.student.fullName, grNo: grNoLabel(e.student) || null, rollNo: e.rollNo, isRte: e.student.isRte, section: e.section,
        contact: g ? { name: g.name, mobile: g.mobile } : null, ledger: f, state,
        lastPayment: e.feePayments[0] ? { paidOn: e.feePayments[0].paidOn, amount: n(e.feePayments[0].amount) } : null,
      };
    });
    return { ...page(paged, rows.length, q), totals: { ...sum, students: rows.length, withBalance: rows.filter((r) => r.f.balance > 0).length } };
  }

  async payments(ctx: AccessContext, q: z.infer<typeof paymentsQuery>) {
    const y = await this.year(ctx, q.academicYearId);
    const where: Prisma.FeePaymentWhereInput = {
      schoolId: ctx.schoolId, academicYearId: y.id,
      ...(q.from || q.to ? { paidOn: { ...(q.from ? { gte: dateOnly(q.from)! } : {}), ...(q.to ? { lte: dateOnly(q.to)! } : {}) } } : {}),
      ...(q.mode ? { mode: q.mode } : {}), ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ receiptNo: { contains: q.q } }, { manualReceiptNo: { contains: q.q } }, { enrollment: { student: { fullName: { contains: q.q } } } }, { reference: { contains: q.q } }] } : {}),
    };
    const [rows, total, sums] = await Promise.all([
      this.prisma.feePayment.findMany({ where, orderBy: [{ paidOn: 'desc' }, { id: 'desc' }], ...skipTake(q), include: { enrollment: { include: { student: { select: { id: true, fullName: true, grNo: true, grNoTemp: true } }, section: { select: sectionSel } } } } }),
      this.prisma.feePayment.count({ where }),
      this.prisma.feePayment.groupBy({ by: ['mode', 'status'], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const valid = sums.filter((s) => s.status === 'VALID');
    return {
      ...page(rows.map((p) => ({ id: p.id, receiptNo: p.receiptNo, manualReceiptNo: p.manualReceiptNo, isBackdated: p.isBackdated, paidOn: p.paidOn, amount: n(p.amount), mode: p.mode, reference: p.reference, status: p.status, balanceAfter: n(p.balanceAfter), student: p.enrollment.student, section: p.enrollment.section })), total, q),
      totals: { amount: round2(valid.reduce((t, s) => t + n(s._sum.amount), 0)), receipts: valid.reduce((t, s) => t + s._count._all, 0), byMode: valid.map((s) => ({ mode: s.mode, amount: n(s._sum.amount), receipts: s._count._all })), cancelled: sums.filter((s) => s.status === 'CANCELLED').reduce((t, s) => t + s._count._all, 0) },
    };
  }

  /** Fee overview for the home page and the Fees page. */
  async summary(ctx: AccessContext, academicYearId?: number) {
    const y = await this.year(ctx, academicYearId);
    const rows = await this.yearRows(y.id);
    const all = zero();
    const byClass = new Map<string, { classId: bigint; name: string; order: number; students: number; withBalance: number; sum: ReturnType<typeof zero> }>();
    for (const { e, f } of rows) {
      add(all, f);
      const k = String(e.classId);
      const c = byClass.get(k) ?? { classId: e.classId, name: e.schoolClass.displayName, order: e.schoolClass.medium.sortOrder * 100 + e.schoolClass.standard.levelOrder, students: 0, withBalance: 0, sum: zero() };
      c.students++;
      if (f.balance > 0) c.withBalance++;
      add(c.sum, f);
      byClass.set(k, c);
    }
    const t0 = today();
    const since = new Date(); since.setDate(since.getDate() - 29);
    const recent = await this.prisma.feePayment.groupBy({ by: ['paidOn'], where: { schoolId: ctx.schoolId, academicYearId: y.id, status: 'VALID', paidOn: { gte: dateOnly(iso(since))! } }, _sum: { amount: true }, _count: { _all: true } });
    const byMode = await this.prisma.feePayment.groupBy({ by: ['mode'], where: { schoolId: ctx.schoolId, academicYearId: y.id, status: 'VALID' }, _sum: { amount: true }, _count: { _all: true } });
    const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(since); d.setDate(d.getDate() + i); return iso(d); });
    const r = new Map(recent.map((x) => [iso(x.paidOn), x]));
    const pct = (paid: number, payable: number) => (payable ? round2((paid / payable) * 100) : 0);
    return {
      year: { id: y.id, name: y.name },
      totals: {
        ...all, students: rows.length, studentsWithBalance: rows.filter((x) => x.f.balance > 0).length,
        studentsWithPrevious: rows.filter((x) => x.f.previousStillDue > 0).length, studentsNoFee: rows.filter((x) => x.state === 'NO_FEES').length,
        collectedPercent: pct(all.paid, all.totalPayable),
      },
      today: { amount: n(r.get(t0)?._sum.amount), receipts: r.get(t0)?._count._all ?? 0 },
      last30: days.map((d) => ({ date: d, amount: n(r.get(d)?._sum.amount), receipts: r.get(d)?._count._all ?? 0 })),
      byMode: byMode.map((m) => ({ mode: m.mode, amount: n(m._sum.amount), receipts: m._count._all })),
      byClass: [...byClass.values()].sort((a, b) => a.order - b.order).map((c) => ({ classId: c.classId, name: c.name, students: c.students, studentsWithBalance: c.withBalance, ...c.sum, collectedPercent: pct(c.sum.paid, c.sum.totalPayable) })),
    };
  }
}

const yearQuery = z.object({ academicYearId: z.coerce.number().int().positive().optional() });
const certificateSchema = z.object({ studentId: z.coerce.number().int().positive(), academicYearId: z.coerce.number().int().positive() });
const LEDGER_FILTERS = ['PAID', 'PART_PAID', 'DUE', 'NO_FEES', 'BALANCE', 'PREVIOUS'] as const satisfies readonly (LedgerState | 'BALANCE' | 'PREVIOUS')[];
const registerQuery = z.object({
  academicYearId: z.coerce.number().int().positive().optional(), sectionId: z.coerce.number().int().positive().optional(), classId: z.coerce.number().int().positive().optional(),
  status: z.enum(LEDGER_FILTERS).optional(), q: z.string().trim().max(100).optional(),
  sort: z.enum(['roll', 'balance']).default('roll'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const paymentsQuery = z.object({
  academicYearId: z.coerce.number().int().positive().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mode: z.string().max(20).optional(), status: z.enum(['VALID', 'CANCELLED']).optional(), q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('fees')
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('class-fees') @RequirePermission(P.FEES_READ)
  classFees(@Ctx() ctx: AccessContext, @Query(zBody(yearQuery)) q: z.infer<typeof yearQuery>) { return this.fees.classFees(ctx, q.academicYearId); }
  @Post('class-fees/copy') @HttpCode(200) @RequirePermission(P.FEES_MANAGE)
  copy(@Ctx() ctx: AccessContext, @Body(zBody(classFeeCopySchema)) b: ClassFeeCopyInput) { return this.fees.copyClassFees(ctx, b); }
  @Put('class-fees/:classId') @RequirePermission(P.FEES_MANAGE)
  saveClassFee(@Ctx() ctx: AccessContext, @Param('classId', IdPipe) id: bigint, @Body(zBody(classFeeSchema)) b: ClassFeeInput) { return this.fees.saveClassFee(ctx, id, b); }

  @Get('students/:studentId') @RequirePermission(P.FEES_READ)
  account(@Ctx() ctx: AccessContext, @Param('studentId', IdPipe) id: bigint, @Query(zBody(yearQuery)) q: z.infer<typeof yearQuery>) { return this.fees.account(ctx, id, q.academicYearId); }
  @Patch('ledgers/:id/concession') @RequirePermission(P.FEES_CONCESSION)
  concession(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(concessionSchema)) b: z.infer<typeof concessionSchema>) { return this.fees.concession(ctx, id, b); }
  @Patch('ledgers/:id/opening') @RequirePermission(P.FEES_MANAGE)
  opening(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(openingBalanceSchema)) b: z.infer<typeof openingBalanceSchema>) { return this.fees.opening(ctx, id, b); }

  @Post('payments') @RequirePermission(P.FEES_COLLECT)
  collect(@Ctx() ctx: AccessContext, @Body(zBody(paymentSchema)) b: PaymentInput) { return this.fees.collect(ctx, b); }
  @Get('payments') @RequirePermission(P.FEES_READ)
  payments(@Ctx() ctx: AccessContext, @Query(zBody(paymentsQuery)) q: z.infer<typeof paymentsQuery>) { return this.fees.payments(ctx, q); }
  @Patch('payments/:id') @RequirePermission(P.FEES_EDIT)
  edit(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(paymentEditSchema)) b: z.infer<typeof paymentEditSchema>) { return this.fees.edit(ctx, id, b); }
  @Post('payments/:id/reissue') @HttpCode(200) @RequirePermission(P.FEES_EDIT)
  reissue(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(paymentReissueSchema)) b: z.infer<typeof paymentReissueSchema>) { return this.fees.reissue(ctx, id, b); }
  @Get('payments/:id') @RequirePermission(P.FEES_READ)
  receipt(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.fees.receipt(ctx, id); }
  @Post('payments/:id/cancel') @HttpCode(200) @RequirePermission(P.FEES_CANCEL)
  cancel(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(cancelReceiptSchema)) b: z.infer<typeof cancelReceiptSchema>) { return this.fees.cancel(ctx, id, b.reason); }

  @Post('certificates') @RequirePermission(P.CERTIFICATES_ISSUE)
  issueCertificate(@Ctx() ctx: AccessContext, @Body(zBody(certificateSchema)) b: z.infer<typeof certificateSchema>) { return this.fees.issueCertificate(ctx, b); }
  @Get('certificates/:id') @RequirePermission(P.CERTIFICATES_ISSUE)
  certificate(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.fees.certificate(ctx, id); }
  @Get('students/:studentId/certificates') @RequirePermission(P.CERTIFICATES_ISSUE)
  studentCertificates(@Ctx() ctx: AccessContext, @Param('studentId', IdPipe) id: bigint) { return this.fees.certificates(ctx, id); }

  @Get('register') @RequirePermission(P.FEES_READ)
  register(@Ctx() ctx: AccessContext, @Query(zBody(registerQuery)) q: z.infer<typeof registerQuery>) { return this.fees.register(ctx, q); }
  @Get('summary') @RequirePermission(P.FEES_READ)
  summary(@Ctx() ctx: AccessContext, @Query(zBody(yearQuery)) q: z.infer<typeof yearQuery>) { return this.fees.summary(ctx, q.academicYearId); }
}

@Module({ imports: [PoliciesSequencesModule], controllers: [FeesController], providers: [FeesService] })
export class FeesModule {}
