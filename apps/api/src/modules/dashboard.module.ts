import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { PAYMENT_MODE_LABELS, PERMISSIONS, round2, todayIn, type PaymentMode } from '@cps/shared';
import { AccessContext, Ctx, hasPermission } from '../common/auth';
import { dateOnly } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { ScopeService } from '../common/scope';

const P = PERMISSIONS;
const n = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));

/**
 * Everything the Headmaster has to act on, in one call: admissions, vouchers, new staff and report cards waiting for
 * approval, plus today's and this month's money and the latest activity. Each part is included only when the user
 * holds the permission for it (marks and attendance come from /workflow/tasks).
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService, private readonly scopes: ScopeService) {}

  /**
   * "Waiting for you": every step in the class-list, admission, promotion and GR No flows that needs THIS user now,
   * so nobody has to open each class to find out. (Marks and attendance come from /workflow/tasks; the Headmaster's
   * admissions, vouchers and promotions from /dashboard/overview.)
   */
  async todo(ctx: AccessContext) {
    const items: { key: string; group: string; title: string; detail: string; to: string; at?: Date | null }[] = [];
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    if (!year) return { items };
    const scope = await this.scopes.resolve(ctx, year.id);
    const approver = scope.all && hasPermission(ctx, P.STUDENTS_ADMISSION_APPROVE);
    const office = scope.all && hasPermission(ctx, P.STUDENTS_WRITE);
    const has = (role: 'CLASS_TEACHER' | 'OPERATOR', id: bigint) => scope.byRole[role].some((x) => x === id);

    // ---- class lists
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE' }, ...(scope.all ? {} : { id: { in: scope.sectionIds } }) },
      include: { schoolClass: { select: { id: true, displayName: true, examNosAt: true, medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } } } }, assignments: { where: { status: 'ACTIVE', role: 'CLASS_TEACHER' }, select: { id: true } } },
    });
    const studying = new Set((await this.prisma.studentEnrollment.groupBy({ by: ['sectionId'], where: { sectionId: { in: sections.map((x) => x.id) }, status: 'ACTIVE' } })).map((g) => String(g.sectionId)));
    sections.sort((a, b) => a.schoolClass.medium.sortOrder - b.schoolClass.medium.sortOrder || a.schoolClass.standard.levelOrder - b.schoolClass.standard.levelOrder || a.name.localeCompare(b.name));
    for (const s of sections) {
      const label = `${s.schoolClass.displayName} ${s.name}`;
      const to = `/classes/${s.id}`;
      if (s.listStatus === 'READY' && (has('CLASS_TEACHER', s.id) || (approver && !s.assignments.length))) {
        items.push({ key: `cl-confirm-${s.id}`, group: 'Class list', title: `Check and confirm the class list of ${label}`, detail: 'You can still change roll numbers before confirming', to, at: s.listReadyAt });
      }
      if (s.listStatus === 'CONFIRMED' && approver) {
        items.push({ key: `cl-final-${s.id}`, group: 'Class list', title: `Finalize the class list of ${label}`, detail: 'Confirmed by the class teacher', to, at: s.listConfirmedAt });
      }
      if (s.listStatus === 'DRAFT' && s.listNote && (office || approver || has('OPERATOR', s.id))) {
        items.push({ key: `cl-back-${s.id}`, group: 'Class list', title: `Class list of ${label} was sent back`, detail: s.listNote, to });
      } else if (s.listStatus === 'DRAFT' && ((office && !approver) || has('OPERATOR', s.id)) && studying.has(String(s.id))) {
        items.push({ key: `cl-prepare-${s.id}`, group: 'Class list', title: `Prepare the class list of ${label}`, detail: 'Arrange roll numbers and send it to the class teacher', to });
      }
    }
    if (approver || office) {
      const byClass = new Map<string, typeof sections>();
      for (const s of sections) byClass.set(String(s.schoolClass.id), [...(byClass.get(String(s.schoolClass.id)) ?? []), s]);
      for (const list of byClass.values()) {
        const c = list[0].schoolClass;
        if (!c.examNosAt && list.every((s) => s.listStatus === 'FINAL')) {
          items.push({ key: `exam-${c.id}`, group: 'Exam Nos', title: `Generate the Exam Nos of ${c.displayName}`, detail: `Class list${list.length > 1 ? 's of every division are' : ' is'} final`, to: `/classes/${list[0].id}` });
        }
      }
    }

    // ---- admissions sent back to the office for correction
    if (office && !approver) {
      const back = await this.prisma.student.findMany({ where: { schoolId: ctx.schoolId, status: 'PENDING_APPROVAL', correctionNote: { not: null } }, orderBy: { correctionRequestedAt: 'asc' }, take: 20, select: { id: true, fullName: true, correctionNote: true, correctionRequestedAt: true } });
      for (const s of back) items.push({ key: `adm-${s.id}`, group: 'Admission', title: `Correct the admission of ${s.fullName}`, detail: `Headmaster: ${s.correctionNote}`, to: `/students/${s.id}`, at: s.correctionRequestedAt });
    }

    // ---- promotions the Headmaster sent back (latest decision of each division, if nothing newer was sent)
    if (office || scope.byRole.OPERATOR.length) {
      const reqs = await this.prisma.promotionRequest.findMany({
        where: { schoolId: ctx.schoolId, ...(office ? {} : { fromSectionId: { in: scope.byRole.OPERATOR } }) }, orderBy: { id: 'desc' },
        include: { fromSection: { select: { id: true, name: true, schoolClass: { select: { displayName: true } } } } },
      });
      const seen = new Set<string>();
      for (const r of reqs) {
        const k = String(r.fromSectionId);
        if (seen.has(k)) continue;
        seen.add(k);
        if (r.status === 'REJECTED') items.push({ key: `promo-${r.id}`, group: 'Promotion', title: `Promotion of ${r.fromSection.schoolClass.displayName} ${r.fromSection.name} was sent back`, detail: r.note ? `Headmaster: ${r.note}` : 'Correct it and send it again', to: `/classes/${r.fromSection.id}/promote`, at: r.decidedAt });
      }
    }

    // ---- GR numbers still to enter
    if (office || approver) {
      const [temp, missing] = await Promise.all([
        this.prisma.student.count({ where: { schoolId: ctx.schoolId, status: 'ACTIVE', grNoTemp: true } }),
        this.prisma.student.count({ where: { schoolId: ctx.schoolId, status: 'ACTIVE', grNo: null, grNoTemp: false } }),
      ]);
      if (temp) items.push({ key: 'gr-temp', group: 'GR No', title: `${temp} student${temp > 1 ? 's have' : ' has'} GR No "TEMP"`, detail: 'Promoted into Std I / V: enter the new GR No', to: '/students?gr=TEMP&status=ACTIVE' });
      if (missing) items.push({ key: 'gr-missing', group: 'GR No', title: `${missing} confirmed student${missing > 1 ? 's have' : ' has'} no GR No yet`, detail: 'Open each student and use "Add GR No"', to: '/students?gr=MISSING&status=ACTIVE' });
    }
    return { items };
  }

  private async names(ids: (bigint | null | undefined)[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids.filter((v): v is bigint => v != null))] } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    return new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
  }

  async overview(ctx: AccessContext) {
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { timezone: true } });
    const today = todayIn(school.timezone || 'Asia/Kolkata');
    const monthStart = `${today.slice(0, 8)}01`;
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    const out: Record<string, unknown> = { today };

    // ---- approvals
    const approvals: Record<string, unknown> = {};
    if (hasPermission(ctx, P.STUDENTS_ADMISSION_APPROVE)) {
      const rows = await this.prisma.student.findMany({
        // Waiting for the Headmaster; those sent back to the office for correction are not.
        where: { schoolId: ctx.schoolId, status: 'PENDING_APPROVAL', correctionNote: null }, orderBy: { createdAt: 'asc' }, take: 6,
        include: { enrollments: { where: { status: 'PENDING_APPROVAL' }, take: 1, include: { section: { select: { name: true, schoolClass: { select: { displayName: true } } } } } } },
      });
      const count = await this.prisma.student.count({ where: { schoolId: ctx.schoolId, status: 'PENDING_APPROVAL', correctionNote: null } });
      const by = await this.names(rows.map((r) => r.createdBy));
      approvals.admissions = {
        count, oldest: rows[0]?.createdAt ?? null,
        items: rows.map((r) => ({ id: r.id, title: r.fullName, detail: r.enrollments[0] ? `${r.enrollments[0].section.schoolClass.displayName} ${r.enrollments[0].section.name}` : '', by: r.createdBy ? by.get(String(r.createdBy)) ?? null : null, at: r.createdAt, isRte: r.isRte })),
      };
    }
    if (hasPermission(ctx, P.STUDENTS_PROMOTE)) {
      const rows = await this.prisma.promotionRequest.findMany({
        where: { schoolId: ctx.schoolId, status: 'PENDING' }, orderBy: { requestedAt: 'asc' }, take: 6,
        include: { fromSection: { select: { id: true, name: true, schoolClass: { select: { displayName: true } } } } },
      });
      const count = await this.prisma.promotionRequest.count({ where: { schoolId: ctx.schoolId, status: 'PENDING' } });
      const by = await this.names(rows.map((r) => r.requestedBy));
      approvals.promotions = {
        count, oldest: rows[0]?.requestedAt ?? null,
        items: rows.map((r) => ({ id: r.id, sectionId: r.fromSection.id, title: `${r.fromSection.schoolClass.displayName} ${r.fromSection.name}`, detail: `${(r.items as unknown[]).length} students`, by: by.get(String(r.requestedBy)) ?? null, at: r.requestedAt })),
      };
    }
    if (hasPermission(ctx, P.EXPENSES_APPROVE)) {
      const where: Prisma.ExpenseWhereInput = { schoolId: ctx.schoolId, status: 'PENDING', ...(hasPermission(ctx, P.STAFF_SALARY) ? {} : { category: { isSalary: false } }) };
      const [rows, agg] = await Promise.all([
        this.prisma.expense.findMany({ where, orderBy: { createdAt: 'asc' }, take: 6, include: { category: { select: { name: true, isSalary: true } }, staff: { select: { name: true } } } }),
        this.prisma.expense.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
      ]);
      const salaries = await this.prisma.expense.aggregate({ where: { ...where, category: { isSalary: true } }, _sum: { amount: true }, _count: { _all: true } });
      const by = await this.names(rows.map((r) => r.createdBy));
      approvals.vouchers = {
        count: agg._count._all, amount: round2(n(agg._sum.amount)), oldest: rows[0]?.createdAt ?? null,
        salaries: { count: salaries._count._all, amount: round2(n(salaries._sum.amount)) },
        items: rows.map((r) => ({ id: r.id, title: `${r.voucherNo} · ${r.staff ? `Salary: ${r.staff.name}` : r.title}`, detail: r.category.name, amount: n(r.amount), mode: PAYMENT_MODE_LABELS[r.mode as PaymentMode] ?? r.mode, by: by.get(String(r.createdBy)) ?? null, at: r.createdAt })),
      };
    }
    if (hasPermission(ctx, P.STAFF_MANAGE)) {
      const rows = await this.prisma.staff.findMany({ where: { schoolId: ctx.schoolId, status: 'PENDING_ASSIGNMENT' }, orderBy: { createdAt: 'asc' }, take: 6 });
      const count = await this.prisma.staff.count({ where: { schoolId: ctx.schoolId, status: 'PENDING_ASSIGNMENT' } });
      const by = await this.names(rows.map((r) => r.createdBy));
      approvals.staff = { count, oldest: rows[0]?.createdAt ?? null, items: rows.map((r) => ({ id: r.id, title: r.name, detail: r.employeeCode, by: r.createdBy ? by.get(String(r.createdBy)) ?? null : null, at: r.createdAt })) };
    }
    if (hasPermission(ctx, P.REPORTCARDS_PUBLISH) && year) {
      const count = await this.prisma.reportCard.count({ where: { status: 'GENERATED', enrollment: { academicYearId: year.id } } });
      approvals.reportCards = { count };
    }
    out.approvals = approvals;

    // ---- money (fees and expenses are never mixed)
    if (hasPermission(ctx, P.FEES_READ)) {
      const valid = { schoolId: ctx.schoolId, status: 'VALID' } as const;
      const [todayAgg, todayByMode, monthAgg, backdatedToday, cancelledToday] = await Promise.all([
        this.prisma.feePayment.aggregate({ where: { ...valid, paidOn: dateOnly(today)! }, _sum: { amount: true }, _count: { _all: true } }),
        this.prisma.feePayment.groupBy({ by: ['mode'], where: { ...valid, paidOn: dateOnly(today)! }, _sum: { amount: true } }),
        this.prisma.feePayment.aggregate({ where: { ...valid, paidOn: { gte: dateOnly(monthStart)!, lte: dateOnly(today)! } }, _sum: { amount: true }, _count: { _all: true } }),
        // Backdated receipts entered in the last 24 hours (for the Headmaster's attention).
        this.prisma.feePayment.count({ where: { schoolId: ctx.schoolId, isBackdated: true, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
        this.prisma.feePayment.count({ where: { schoolId: ctx.schoolId, status: 'CANCELLED', cancelledAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
      ]);
      out.fees = {
        today: round2(n(todayAgg._sum.amount)), todayReceipts: todayAgg._count._all,
        todayByMode: todayByMode.map((m) => ({ mode: m.mode, label: PAYMENT_MODE_LABELS[m.mode as PaymentMode] ?? m.mode, amount: round2(n(m._sum.amount)) })),
        month: round2(n(monthAgg._sum.amount)), monthReceipts: monthAgg._count._all, backdatedLastDay: backdatedToday, cancelledLastDay: cancelledToday,
      };
    }
    if (hasPermission(ctx, P.EXPENSES_READ)) {
      const range = { gte: dateOnly(monthStart)!, lte: dateOnly(today)! };
      const [approved, todayApproved] = await Promise.all([
        this.prisma.expense.aggregate({ where: { schoolId: ctx.schoolId, status: 'APPROVED', expenseDate: range }, _sum: { amount: true }, _count: { _all: true } }),
        this.prisma.expense.aggregate({ where: { schoolId: ctx.schoolId, status: 'APPROVED', expenseDate: dateOnly(today)! }, _sum: { amount: true } }),
      ]);
      out.expenses = { month: round2(n(approved._sum.amount)), monthVouchers: approved._count._all, today: round2(n(todayApproved._sum.amount)) };
    }
    if (hasPermission(ctx, P.STUDENTS_READ) && year) {
      const [newThisMonth, newThisYear] = await Promise.all([
        this.prisma.studentStatusHistory.count({ where: { student: { schoolId: ctx.schoolId }, toStatus: 'ACTIVE', OR: [{ fromStatus: null }, { fromStatus: 'PENDING_APPROVAL' }], createdAt: { gte: dateOnly(monthStart)! } } }),
        this.prisma.studentEnrollment.count({ where: { academicYearId: year.id, status: 'ACTIVE', student: { enrollments: { every: { academicYear: { startDate: { gte: year.startDate } } } } } } }),
      ]);
      out.admissions = { thisMonth: newThisMonth, thisYear: newThisYear };
    }

    // ---- latest activity
    if (hasPermission(ctx, P.AUDIT_READ)) {
      const logs = await this.prisma.auditLog.findMany({
        where: { schoolId: ctx.schoolId, action: { in: ['CREATE', 'APPROVE', 'REJECT', 'CANCEL', 'COLLECT', 'STATUS', 'CONCESSION'] }, entityType: { in: ['Student', 'Expense', 'FeePayment', 'Staff', 'StudentFeeLedger'] } },
        orderBy: { id: 'desc' }, take: 8,
      });
      const by = await this.names(logs.map((l) => l.userId));
      out.activity = logs.map((l) => ({ id: l.id, at: l.createdAt, action: l.action, entityType: l.entityType, entityId: l.entityId, by: l.userId ? by.get(String(l.userId)) ?? null : null, reason: l.reason, after: l.afterData }));
    }
    return out;
  }
}

@Controller()
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('dashboard/overview')
  overview(@Ctx() ctx: AccessContext) { return this.svc.overview(ctx); }

  @Get('dashboard/todo')
  todo(@Ctx() ctx: AccessContext) { return this.svc.todo(ctx); }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
