import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Put, Query } from '@nestjs/common';
import {
  instalmentPlanSchema, type InstalmentPlanInput, instalmentSchedule, penaltyApplySchema, penaltyWaiveSchema, PERMISSIONS, round2, todayIn, workingDueDate,
} from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { forbidden, invalid, notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { dateOnly, IdPipe, zBody } from '../common/validation';
import { PrismaService, Tx } from '../infra/prisma.service';
import { num as n, paidByEnrollment, syncStudentFees } from './fee-ledger';

const P = PERMISSIONS;
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Late fees are the Headmaster's decision only (like discounts). */
export const isHeadmaster = (ctx: AccessContext) => ctx.roles.some((r) => r.code === 'HEADMASTER');

// ---------------------------------------------------------------- helpers shared with the fee screens
export interface YearPlan {
  /** The due dates, each with its minimum amount for all classes. */
  instalments: { id: number; seq: number; label: string; dueDate: string; amount: number }[];
  /** A class's own minimum where it differs: classId → instalmentId → amount */
  amounts: Map<string, Map<number, number>>;
}

export async function loadPlan(db: Tx | PrismaService, academicYearId: bigint): Promise<YearPlan> {
  const rows = await db.feeInstalment.findMany({ where: { academicYearId }, orderBy: { seq: 'asc' }, include: { amounts: true } });
  const amounts = new Map<string, Map<number, number>>();
  for (const r of rows) {
    for (const a of r.amounts) {
      const k = String(a.classId);
      if (!amounts.has(k)) amounts.set(k, new Map());
      amounts.get(k)!.set(Number(r.id), n(a.amount));
    }
  }
  return { instalments: rows.map((r) => ({ id: Number(r.id), seq: r.seq, label: r.label, dueDate: iso(r.dueDate), amount: n(r.amount) })), amounts };
}

/** Active late fees per ledger: ledgerId → instalmentId → amount. */
export async function activePenalties(db: Tx | PrismaService, ledgerIds: bigint[]) {
  const map = new Map<string, Record<number, number>>();
  if (!ledgerIds.length) return map;
  const rows = await db.feePenalty.findMany({ where: { ledgerId: { in: ledgerIds }, status: 'ACTIVE' } });
  for (const r of rows) {
    const k = String(r.ledgerId);
    map.set(k, { ...(map.get(k) ?? {}), [Number(r.instalmentId)]: n(r.amount) });
  }
  return map;
}

/** What the student must pay by each due date of the year, or null when the year has no due dates (or nothing to pay). */
export function scheduleFor(plan: YearPlan, classId: bigint, l: { previousOutstanding: unknown; yearFee: unknown; concession: unknown } | null, paid: number, penalties: Record<number, number> | undefined, today: string) {
  if (!plan.instalments.length || (n(l?.yearFee as never) <= 0 && n(l?.previousOutstanding as never) <= 0)) return null;
  const own = plan.amounts.get(String(classId));
  return instalmentSchedule(
    plan.instalments.map((i) => ({ ...i, amount: own?.get(i.id) ?? i.amount })),
    { previousOutstanding: n(l?.previousOutstanding as never), yearFee: n(l?.yearFee as never), concession: n(l?.concession as never), paid, penalties },
    today,
  );
}

/** Keep the ledger's penalty total equal to its active late fees, then bring the student's ledgers up to date. */
async function refreshPenalty(tx: Tx, ledgerId: bigint, userId: bigint) {
  const sum = await tx.feePenalty.aggregate({ where: { ledgerId, status: 'ACTIVE' }, _sum: { amount: true } });
  const l = await tx.studentFeeLedger.update({ where: { id: ledgerId }, data: { penalty: round2(n(sum._sum.amount)), version: { increment: 1 }, updatedBy: userId } });
  await syncStudentFees(tx, l.studentId, userId);
}

// ---------------------------------------------------------------- service
@Injectable()
export class FeeInstalmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scopes: ScopeService) {}

  private async year(ctx: AccessContext, academicYearId?: number | bigint) {
    const y = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, ...(academicYearId ? { id: BigInt(academicYearId) } : { isCurrent: true }) } });
    if (!y) throw notFound('Academic year');
    if (!(await this.scopes.resolve(ctx, y.id)).all) throw forbidden('Fees are handled by the school office');
    return y;
  }
  private async today(ctx: AccessContext) {
    const s = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { timezone: true } });
    return todayIn(s.timezone || 'Asia/Kolkata');
  }

  /** Everyone of the year who still owes something on this instalment (students who left and RTE students are not charged). */
  private async owing(yearId: bigint, plan: YearPlan, today: string) {
    const rows = await this.prisma.studentEnrollment.findMany({
      where: { academicYearId: yearId, status: { in: ['ACTIVE', 'PENDING_APPROVAL'] }, student: { isRte: false }, feeLedger: { isNot: null } },
      include: { feeLedger: true, student: { select: { id: true, fullName: true } }, section: { select: { id: true, name: true, schoolClass: { select: { displayName: true, medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } } } } } } },
      orderBy: [{ medium: { sortOrder: 'asc' } }, { schoolClass: { standard: { levelOrder: 'asc' } } }, { section: { name: 'asc' } }, { rollNo: 'asc' }],
    });
    const paid = await paidByEnrollment(this.prisma, rows.map((r) => r.id));
    const pens = await activePenalties(this.prisma, rows.map((r) => r.feeLedger!.id));
    return rows.map((e) => ({ e, s: scheduleFor(plan, e.classId, e.feeLedger, paid.get(String(e.id)) ?? 0, pens.get(String(e.feeLedger!.id)), today) }));
  }

  async plan(ctx: AccessContext, academicYearId?: number) {
    const y = await this.year(ctx, academicYearId);
    const today = await this.today(ctx);
    const [plan, classes, previous] = await Promise.all([
      loadPlan(this.prisma, y.id),
      this.prisma.schoolClass.findMany({
        where: { academicYearId: y.id, status: 'ACTIVE' },
        include: { medium: true, standard: true, classFee: true, _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
        orderBy: [{ medium: { sortOrder: 'asc' } }, { standard: { levelOrder: 'asc' } }],
      }),
      this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, startDate: { lt: y.startDate } }, orderBy: { startDate: 'desc' } }),
    ]);
    // Last year's plan, so the screen can offer "copy from last year" (classes matched by medium and standard).
    let prev: { id: number; name: string; instalments: { seq: number; label: string; dueDate: string; amount: number }[]; bySlot: Map<string, (number | null)[]> } | null = null;
    if (previous) {
      const pp = await loadPlan(this.prisma, previous.id);
      if (pp.instalments.length) {
        const pcl = await this.prisma.schoolClass.findMany({ where: { academicYearId: previous.id }, select: { id: true, mediumId: true, standardId: true } });
        const bySlot = new Map<string, (number | null)[]>();
        for (const c of pcl) {
          const a = pp.amounts.get(String(c.id));
          if (a) bySlot.set(`${c.mediumId}:${c.standardId}`, pp.instalments.map((i) => a.get(i.id) ?? null));
        }
        prev = { id: Number(previous.id), name: previous.name, instalments: pp.instalments.map(({ seq, label, dueDate, amount }) => ({ seq, label, dueDate, amount })), bySlot };
      }
    }
    // Per instalment: how many students still owe it, and the late fees charged.
    const owing = plan.instalments.length ? await this.owing(y.id, plan, today) : [];
    const pen = plan.instalments.length
      ? await this.prisma.feePenalty.groupBy({ by: ['instalmentId', 'status'], where: { instalmentId: { in: plan.instalments.map((i) => BigInt(i.id)) } }, _count: { _all: true }, _sum: { amount: true } })
      : [];
    return {
      year: { id: y.id, name: y.name, startDate: y.startDate, endDate: y.endDate, status: y.status, editable: y.status !== 'CLOSED' },
      today,
      can: { edit: ctx.permissions.has(P.FEES_MANAGE) && y.status !== 'CLOSED', penalty: isHeadmaster(ctx) && ctx.permissions.has(P.FEES_MANAGE) },
      instalments: plan.instalments.map((i) => {
        const dueOn = workingDueDate(i.dueDate);
        const lines = owing.map((o) => o.s?.lines.find((x) => x.id === i.id)).filter((x) => x && x.balance > 0);
        const active = pen.find((p) => Number(p.instalmentId) === i.id && p.status === 'ACTIVE');
        return {
          ...i, dueOn, overdue: today > dueOn,
          unpaidStudents: lines.length, unpaidAmount: round2(lines.reduce((s, x) => s + x!.balance, 0)),
          penalties: active?._count._all ?? 0, penaltyAmount: round2(n(active?._sum.amount)),
        };
      }),
      classes: classes.map((c) => {
        const a = plan.amounts.get(String(c.id));
        return {
          classId: c.id, displayName: c.displayName, medium: c.medium.nameEn, students: c._count.enrollments,
          classFee: c.classFee ? n(c.classFee.amount) : null,
          /** The class's own minimums (null = the amount for all classes). */
          amounts: a ? plan.instalments.map((i) => a.get(i.id) ?? null) : null,
          previousAmounts: prev?.bySlot.get(`${c.mediumId}:${c.standardId}`) ?? null,
        };
      }),
      previousYear: prev ? { id: prev.id, name: prev.name, instalments: prev.instalments } : null,
    };
  }

  /** Save the year's due dates and minimum amounts. The annual class fees are not changed. */
  async save(ctx: AccessContext, input: InstalmentPlanInput) {
    const y = await this.year(ctx, input.academicYearId);
    if (y.status === 'CLOSED') throw invalidState(`${y.name} is closed; its fees cannot be changed`);
    const start = iso(y.startDate);
    const end = iso(y.endDate);
    input.instalments.forEach((x, i) => {
      if (x.dueDate < start || x.dueDate > end) throw invalid(`"${x.label}" must be a date within ${y.name} (${start} to ${end})`, [{ path: `instalments.${i}.dueDate`, code: 'range', message: `Within ${y.name}` }]);
    });
    const classes = await this.prisma.schoolClass.findMany({ where: { academicYearId: y.id }, select: { id: true } });
    const ok = new Set(classes.map((c) => String(c.id)));
    for (const c of input.classes) if (!ok.has(String(c.classId))) throw invalid(`Class ${c.classId} is not a class of ${y.name}`);
    const existing = await this.prisma.feeInstalment.findMany({ where: { academicYearId: y.id }, include: { _count: { select: { penalties: true } } } });
    const removed = existing.filter((e) => e.seq > input.instalments.length);
    const blocked = removed.find((e) => e._count.penalties > 0);
    if (blocked) throw invalidState(`"${blocked.label}" already has late fees charged; it cannot be removed`);
    let ownClasses = 0;
    await this.prisma.$transaction(async (tx) => {
      if (removed.length) await tx.feeInstalment.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
      const ids: bigint[] = [];
      for (const x of input.instalments) {
        const r = await tx.feeInstalment.upsert({
          where: { academicYearId_seq: { academicYearId: y.id, seq: x.seq } },
          create: { academicYearId: y.id, seq: x.seq, label: x.label, dueDate: dateOnly(x.dueDate)!, amount: x.amount, createdBy: ctx.userId },
          update: { label: x.label, dueDate: dateOnly(x.dueDate)!, amount: x.amount, updatedBy: ctx.userId },
        });
        ids.push(r.id);
      }
      // A class's own amounts, only where they differ from the amount for all classes.
      await tx.feeInstalmentAmount.deleteMany({ where: { instalmentId: { in: ids } } });
      const own = input.classes.flatMap((c) => c.amounts.flatMap((a, i) => (a == null || i >= ids.length || a === input.instalments[i].amount ? [] : [{ instalmentId: ids[i], classId: BigInt(c.classId), amount: a }])));
      if (own.length) await tx.feeInstalmentAmount.createMany({ data: own });
      ownClasses = new Set(own.map((o) => String(o.classId))).size;
      await this.audit.record(ctx, {
        action: 'UPDATE', entityType: 'FeeDueDates', entityId: y.id,
        after: { year: y.name, dueDates: input.instalments.map((x) => `${x.label}: ${x.amount} by ${x.dueDate}`), classesWithOwnAmounts: ownClasses },
      }, tx);
    });
    return { dueDates: input.instalments.length, classesWithOwnAmounts: ownClasses };
  }

  private async instalment(ctx: AccessContext, id: bigint) {
    const i = await this.prisma.feeInstalment.findUnique({ where: { id } });
    if (!i) throw notFound('Due date');
    const y = await this.year(ctx, i.academicYearId);
    return { i, y, dueOn: workingDueDate(iso(i.dueDate)) };
  }

  /** Students who have not paid this instalment in full (the late-fee list). */
  async defaulters(ctx: AccessContext, id: bigint) {
    const { i, y, dueOn } = await this.instalment(ctx, id);
    const today = await this.today(ctx);
    const plan = await loadPlan(this.prisma, y.id);
    const owing = await this.owing(y.id, plan, today);
    const existing = await this.prisma.feePenalty.findMany({ where: { instalmentId: id } });
    const exBy = new Map(existing.map((p) => [String(p.ledgerId), p]));
    const rows = owing.flatMap(({ e, s }) => {
      const line = s?.lines.find((x) => x.id === Number(id));
      if (!line || line.balance <= 0) return [];
      const p = exBy.get(String(e.feeLedger!.id));
      return [{
        ledgerId: e.feeLedger!.id, studentId: e.student.id, fullName: e.student.fullName, rollNo: e.rollNo, provisional: e.status === 'PENDING_APPROVAL',
        className: `${e.section.schoolClass.displayName} ${e.section.name}`, due: line.total, paid: line.paid, balance: line.balance,
        penalty: p ? { id: p.id, amount: n(p.amount), status: p.status } : null,
      }];
    });
    return { instalment: { id: i.id, seq: i.seq, label: i.label, dueDate: iso(i.dueDate), dueOn, overdue: today > dueOn }, year: { id: y.id, name: y.name }, rows };
  }

  /** Charge a late fee to every student (or the chosen ones) who has not paid this instalment by its due date. Headmaster only. */
  async applyPenalty(ctx: AccessContext, id: bigint, input: z.infer<typeof penaltyApplySchema>) {
    if (!isHeadmaster(ctx)) throw forbidden('Only the Headmaster can charge a late fee');
    const d = await this.defaulters(ctx, id);
    if (!d.instalment.overdue) throw invalidState(`"${d.instalment.label}" has not passed yet: students can pay until ${d.instalment.dueOn}`);
    const only = input.ledgerIds ? new Set(input.ledgerIds.map(String)) : null;
    // A removed late fee is charged again only when the Headmaster picks that student.
    const targets = d.rows.filter((r) => (!r.penalty || (r.penalty.status === 'WAIVED' && !!only)) && (!only || only.has(String(r.ledgerId))));
    if (!targets.length) throw invalidState('Nobody to charge: everyone has paid what was due by this date, or already has a late fee for it');
    await this.prisma.$transaction(async (tx) => {
      const fresh = targets.filter((t) => !t.penalty);
      if (fresh.length) await tx.feePenalty.createMany({ data: fresh.map((t) => ({ ledgerId: t.ledgerId, instalmentId: id, amount: input.amount, createdBy: ctx.userId })) });
      const again = targets.filter((t) => t.penalty);
      if (again.length) {
        await tx.feePenalty.updateMany({
          where: { id: { in: again.map((t) => BigInt(t.penalty!.id)) } },
          data: { status: 'ACTIVE', amount: input.amount, waiveReason: null, waivedBy: null, waivedAt: null, createdBy: ctx.userId, createdAt: new Date() },
        });
      }
      for (const t of targets) await refreshPenalty(tx, t.ledgerId, ctx.userId);
      await this.audit.record(ctx, { action: 'PENALTY', entityType: 'FeeInstalment', entityId: id, after: { instalment: d.instalment.label, year: d.year.name, amount: input.amount, students: targets.length } }, tx);
    }, { timeout: 120_000 });
    return { charged: targets.length, amount: input.amount, total: round2(targets.length * input.amount) };
  }

  /** Remove this due date's late fee from every student who has one, with a reason. Headmaster only. */
  async waiveAll(ctx: AccessContext, id: bigint, reason: string) {
    if (!isHeadmaster(ctx)) throw forbidden('Only the Headmaster can remove late fees');
    const { i, y } = await this.instalment(ctx, id);
    const active = await this.prisma.feePenalty.findMany({ where: { instalmentId: id, status: 'ACTIVE' } });
    if (!active.length) throw invalidState(`No late fees to remove for "${i.label}"`);
    await this.prisma.$transaction(async (tx) => {
      await tx.feePenalty.updateMany({ where: { id: { in: active.map((p) => p.id) } }, data: { status: 'WAIVED', waiveReason: reason, waivedBy: ctx.userId, waivedAt: new Date() } });
      for (const p of active) await refreshPenalty(tx, p.ledgerId, ctx.userId);
      await this.audit.record(ctx, { action: 'WAIVE', entityType: 'FeeInstalment', entityId: id, after: { instalment: i.label, year: y.name, students: active.length, amount: round2(active.reduce((t, p) => t + n(p.amount), 0)) }, reason }, tx);
    }, { timeout: 120_000 });
    return { removed: active.length };
  }

  /** Remove one student's late fee, with a reason (kept as WAIVED). Headmaster only. */
  async waive(ctx: AccessContext, id: bigint, reason: string) {
    if (!isHeadmaster(ctx)) throw forbidden('Only the Headmaster can remove a late fee');
    const p = await this.prisma.feePenalty.findUnique({ where: { id }, include: { instalment: true } });
    if (!p) throw notFound('Late fee');
    await this.year(ctx, p.instalment.academicYearId);
    if (p.status !== 'ACTIVE') throw invalidState('This late fee is already removed');
    await this.prisma.$transaction(async (tx) => {
      await tx.feePenalty.update({ where: { id }, data: { status: 'WAIVED', waiveReason: reason, waivedBy: ctx.userId, waivedAt: new Date() } });
      await refreshPenalty(tx, p.ledgerId, ctx.userId);
      await this.audit.record(ctx, { action: 'WAIVE', entityType: 'FeePenalty', entityId: id, before: { status: 'ACTIVE', amount: n(p.amount) }, after: { status: 'WAIVED', instalment: p.instalment.label }, reason }, tx);
    });
    return { waived: true };
  }
}

const yearQuery = z.object({ academicYearId: z.coerce.number().int().positive().optional() });

@Controller('fees')
export class FeeInstalmentsController {
  constructor(private readonly svc: FeeInstalmentsService) {}

  @Get('instalments') @RequirePermission(P.FEES_READ)
  plan(@Ctx() ctx: AccessContext, @Query(zBody(yearQuery)) q: z.infer<typeof yearQuery>) { return this.svc.plan(ctx, q.academicYearId); }
  @Put('instalments') @RequirePermission(P.FEES_MANAGE)
  save(@Ctx() ctx: AccessContext, @Body(zBody(instalmentPlanSchema)) b: InstalmentPlanInput) { return this.svc.save(ctx, b); }
  @Get('instalments/:id/defaulters') @RequirePermission(P.FEES_READ)
  defaulters(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.defaulters(ctx, id); }
  @Post('instalments/:id/penalty') @HttpCode(200) @RequirePermission(P.FEES_MANAGE)
  penalty(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(penaltyApplySchema)) b: z.infer<typeof penaltyApplySchema>) { return this.svc.applyPenalty(ctx, id, b); }
  @Post('instalments/:id/penalty/waive-all') @HttpCode(200) @RequirePermission(P.FEES_MANAGE)
  waiveAll(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(penaltyWaiveSchema)) b: z.infer<typeof penaltyWaiveSchema>) { return this.svc.waiveAll(ctx, id, b.reason); }
  @Post('penalties/:id/waive') @HttpCode(200) @RequirePermission(P.FEES_MANAGE)
  waive(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(penaltyWaiveSchema)) b: z.infer<typeof penaltyWaiveSchema>) { return this.svc.waive(ctx, id, b.reason); }
}

@Module({ controllers: [FeeInstalmentsController], providers: [FeeInstalmentsService] })
export class FeeInstalmentsModule {}
