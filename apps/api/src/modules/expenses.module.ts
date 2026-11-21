/// <reference types="multer" />
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  amountInWords, ERROR_CODES, EXPENSE_MODES, EXPENSE_STATUS_LABELS, EXPENSE_STATUSES, expenseCategorySchema, expenseDecisionSchema, ExpenseInput, expenseSchema,
  MONTH_NAMES, PAYMENT_MODE_LABELS, PERMISSIONS, round2, type ExpenseStatus, type PaymentMode,
} from '@cps/shared';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { AppError, conflict, forbidden, invalid, notFound } from '../common/errors';
import { page, skipTake, StreamMarker } from '../common/serialize';
import { dateOnly, IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';
import { sniffImage, StorageDriver } from '../infra/storage.service';
import { PoliciesSequencesModule, SequencesService } from './policies-sequences.module';

const P = PERMISSIONS;
const MAX_BILL_BYTES = 5 * 1024 * 1024;
const n = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuery = z.object({
  from: isoDate.optional(), to: isoDate.optional(), categoryId: z.coerce.number().int().positive().optional(), mode: z.enum(EXPENSE_MODES).optional(),
  status: z.enum(EXPENSE_STATUSES).optional(), createdBy: z.coerce.number().int().positive().optional(), staffId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(), sort: z.enum(['date', '-date', 'amount', '-amount', 'voucher', '-voucher']).default('-date'),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const salaryQuery = z.object({ staffId: z.coerce.number().int().positive(), month: z.coerce.number().int().min(1).max(12), year: z.coerce.number().int().min(2000).max(2100), excludeId: z.coerce.number().int().positive().optional() });
const LIVE: ExpenseStatus[] = ['PENDING', 'APPROVED'];

function sniffDocument(buf: Buffer) {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return sniffImage(buf);
}

const include = {
  category: { select: { id: true, name: true, code: true, isSalary: true } },
  staff: { select: { id: true, name: true, employeeCode: true, designation: true } },
  attachments: { orderBy: { id: 'asc' } },
} satisfies Prisma.ExpenseInclude;
type ExpenseFull = Prisma.ExpenseGetPayload<{ include: typeof include }>;

/**
 * Expenses and payment vouchers. Kept apart from fee collection: they only meet in the income & expense summary.
 * Office enters (status PENDING); Headmaster / Super Admin approve or reject; only approved vouchers count as expenses.
 * Nothing is ever deleted: rejected and cancelled vouchers stay with their reason.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sequences: SequencesService,
    @Inject('STORAGE') private readonly storage: StorageDriver,
  ) {}

  private canReadAll = (ctx: AccessContext) => hasPermission(ctx, P.EXPENSES_READ) || hasPermission(ctx, P.EXPENSES_APPROVE);
  private canSalary = (ctx: AccessContext) => hasPermission(ctx, P.STAFF_SALARY);
  /** What this user may see: all vouchers (Headmaster) or their own (office); salary vouchers only with salary access. */
  private visible(ctx: AccessContext): Prisma.ExpenseWhereInput {
    return { schoolId: ctx.schoolId, ...(this.canReadAll(ctx) ? {} : { createdBy: ctx.userId }), ...(this.canSalary(ctx) ? {} : { category: { isSalary: false } }) };
  }
  private async names(ids: (bigint | null | undefined)[]) {
    const list = [...new Set(ids.filter((v): v is bigint => v != null))];
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    return new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
  }
  private shape(e: ExpenseFull, names: Map<string, string>) {
    return {
      id: e.id, voucherNo: e.voucherNo, expenseDate: e.expenseDate, category: e.category, title: e.title, description: e.description, paidTo: e.paidTo,
      amount: n(e.amount), mode: e.mode, reference: e.reference, billNo: e.billNo, remarks: e.remarks, status: e.status,
      staff: e.staff, salaryMonth: e.salaryMonth, salaryYear: e.salaryYear, monthlySalary: e.monthlySalary == null ? null : n(e.monthlySalary),
      createdBy: names.get(String(e.createdBy)) ?? null, createdById: e.createdBy, createdAt: e.createdAt,
      approvedBy: e.approvedBy ? names.get(String(e.approvedBy)) ?? null : null, approvedAt: e.approvedAt,
      rejectedBy: e.rejectedBy ? names.get(String(e.rejectedBy)) ?? null : null, rejectedAt: e.rejectedAt, rejectReason: e.rejectReason,
      cancelledBy: e.cancelledBy ? names.get(String(e.cancelledBy)) ?? null : null, cancelledAt: e.cancelledAt, cancelReason: e.cancelReason,
      attachmentCount: e.attachments.length,
    };
  }

  // ------------------------------------------------------------------ categories
  async categories(ctx: AccessContext) {
    if (!hasPermission(ctx, P.EXPENSES_CREATE) && !this.canReadAll(ctx) && !hasPermission(ctx, P.EXPENSE_CATEGORIES_MANAGE)) throw forbidden('You cannot see expenses');
    const rows = await this.prisma.expenseCategory.findMany({ where: { schoolId: ctx.schoolId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { expenses: true } } } });
    return rows.map((c) => ({ id: c.id, code: c.code, name: c.name, isSalary: c.isSalary, isSystem: c.isSystem, status: c.status, used: c._count.expenses, usable: c.status === 'ACTIVE' && (!c.isSalary || this.canSalary(ctx)) }));
  }
  async saveCategory(ctx: AccessContext, input: z.infer<typeof expenseCategorySchema>, id?: bigint) {
    const before = id ? await this.prisma.expenseCategory.findFirst({ where: { id, schoolId: ctx.schoolId } }) : null;
    if (id && !before) throw notFound('Expense category');
    const code = before?.code ?? input.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.expenseCategory.aggregate({ where: { schoolId: ctx.schoolId }, _max: { sortOrder: true } });
      const after = await unique(
        () => (id
          ? tx.expenseCategory.update({ where: { id }, data: { name: input.name, status: input.status, updatedBy: ctx.userId } })
          : tx.expenseCategory.create({ data: { schoolId: ctx.schoolId, code, name: input.name, status: input.status, sortOrder: (max._max.sortOrder ?? 0) + 1, createdBy: ctx.userId } })),
        'name', `A category named "${input.name}" already exists`,
      );
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'ExpenseCategory', entityId: after.id, before, after }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------------ list and detail
  async list(ctx: AccessContext, q: z.infer<typeof listQuery>) {
    if (!hasPermission(ctx, P.EXPENSES_CREATE) && !this.canReadAll(ctx)) throw forbidden('You cannot see expenses');
    const base = this.visible(ctx);
    const where: Prisma.ExpenseWhereInput = {
      ...base,
      ...(q.from || q.to ? { expenseDate: { ...(q.from ? { gte: dateOnly(q.from)! } : {}), ...(q.to ? { lte: dateOnly(q.to)! } : {}) } } : {}),
      ...(q.categoryId ? { categoryId: BigInt(q.categoryId) } : {}), ...(q.mode ? { mode: q.mode } : {}), ...(q.status ? { status: q.status } : {}),
      ...(q.createdBy ? { createdBy: BigInt(q.createdBy) } : {}), ...(q.staffId ? { staffId: BigInt(q.staffId) } : {}),
      ...(q.q ? { OR: [{ voucherNo: { contains: q.q } }, { title: { contains: q.q } }, { paidTo: { contains: q.q } }, { billNo: { contains: q.q } }] } : {}),
    };
    const orderBy: Prisma.ExpenseOrderByWithRelationInput[] = q.sort.endsWith('amount') ? [{ amount: q.sort.startsWith('-') ? 'desc' : 'asc' }] : q.sort.endsWith('voucher') ? [{ voucherNo: q.sort.startsWith('-') ? 'desc' : 'asc' }] : [{ expenseDate: q.sort.startsWith('-') ? 'desc' : 'asc' }, { id: q.sort.startsWith('-') ? 'desc' : 'asc' }];
    const statusWhere = { ...where, status: undefined };
    const [rows, total, sums] = await Promise.all([
      this.prisma.expense.findMany({ where, include, orderBy, ...skipTake(q) }),
      this.prisma.expense.count({ where }),
      this.prisma.expense.groupBy({ by: ['status'], where: statusWhere, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const names = await this.names(rows.flatMap((r) => [r.createdBy, r.approvedBy, r.rejectedBy, r.cancelledBy]));
    const creators = await this.prisma.expense.findMany({ where: base, select: { createdBy: true }, distinct: ['createdBy'] });
    const creatorNames = await this.names(creators.map((c) => c.createdBy));
    return {
      ...page(rows.map((r) => this.shape(r, names)), total, q),
      byStatus: Object.fromEntries(EXPENSE_STATUSES.map((s) => { const x = sums.find((y) => y.status === s); return [s, { count: x?._count._all ?? 0, amount: round2(n(x?._sum.amount)) }]; })),
      creators: [...creatorNames.entries()].map(([id, name]) => ({ id: Number(id), name })),
      access: { readAll: this.canReadAll(ctx), approve: hasPermission(ctx, P.EXPENSES_APPROVE), correct: hasPermission(ctx, P.EXPENSES_CORRECT), salary: this.canSalary(ctx) },
    };
  }

  private async load(ctx: AccessContext, id: bigint) {
    const e = await this.prisma.expense.findFirst({ where: { id, ...this.visible(ctx) }, include });
    if (!e) throw notFound('Voucher');
    return e;
  }

  async get(ctx: AccessContext, id: bigint) {
    if (!hasPermission(ctx, P.EXPENSES_CREATE) && !this.canReadAll(ctx)) throw forbidden('You cannot see expenses');
    const e = await this.load(ctx, id);
    const files = await this.prisma.file.findMany({ where: { id: { in: e.attachments.map((a) => a.fileId) } }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true } });
    const fileBy = new Map(files.map((f) => [String(f.id), f]));
    const logs = this.canReadAll(ctx) ? await this.prisma.auditLog.findMany({ where: { schoolId: ctx.schoolId, entityType: 'Expense', entityId: id }, orderBy: { id: 'asc' } }) : [];
    const names = await this.names([e.createdBy, e.approvedBy, e.rejectedBy, e.cancelledBy, ...logs.map((l) => l.userId)]);
    const salary = e.staffId && e.salaryMonth && e.salaryYear ? await this.salaryStatus(ctx, { staffId: Number(e.staffId), month: e.salaryMonth, year: e.salaryYear }) : null;
    const mine = e.createdBy === ctx.userId;
    return {
      ...this.shape(e, names),
      attachments: e.attachments.map((a) => ({ id: a.id, fileName: fileBy.get(String(a.fileId))?.originalName ?? '', mimeType: fileBy.get(String(a.fileId))?.mimeType ?? '', sizeBytes: Number(fileBy.get(String(a.fileId))?.sizeBytes ?? 0), createdAt: a.createdAt })),
      history: logs.map((l) => ({ id: l.id, at: l.createdAt, action: l.action, by: l.userId ? names.get(String(l.userId)) ?? null : null, reason: l.reason, before: l.beforeData, after: l.afterData })),
      salary,
      can: {
        edit: (e.status === 'PENDING' && (mine || hasPermission(ctx, P.EXPENSES_APPROVE))) || (e.status === 'APPROVED' && hasPermission(ctx, P.EXPENSES_CORRECT)),
        approve: e.status === 'PENDING' && hasPermission(ctx, P.EXPENSES_APPROVE),
        cancel: (e.status === 'PENDING' && (mine || hasPermission(ctx, P.EXPENSES_APPROVE))) || (e.status === 'APPROVED' && hasPermission(ctx, P.EXPENSES_CORRECT)),
        attach: (e.status === 'PENDING' && mine) || this.canReadAll(ctx),
        history: this.canReadAll(ctx),
      },
    };
  }

  // ------------------------------------------------------------------ salary
  /** Monthly salary, what is already paid (pending + approved vouchers) and what remains, for one staff member and month. */
  async salaryStatus(ctx: AccessContext, q: z.infer<typeof salaryQuery>, db: Tx | PrismaService = this.prisma) {
    if (!this.canSalary(ctx)) throw forbidden('Salary details are restricted');
    const staff = await db.staff.findFirst({ where: { id: BigInt(q.staffId), schoolId: ctx.schoolId }, select: { id: true, name: true, employeeCode: true, designation: true, monthlySalary: true, status: true } });
    if (!staff) throw notFound('Staff member');
    const payments = await db.expense.findMany({
      where: { schoolId: ctx.schoolId, staffId: staff.id, salaryMonth: q.month, salaryYear: q.year, status: { in: LIVE }, ...(q.excludeId ? { id: { not: BigInt(q.excludeId) } } : {}) },
      orderBy: { id: 'asc' }, select: { id: true, voucherNo: true, expenseDate: true, amount: true, status: true },
    });
    const monthly = n(staff.monthlySalary);
    const paid = round2(payments.reduce((t, p) => t + n(p.amount), 0));
    return {
      staff: { ...staff, monthlySalary: staff.monthlySalary == null ? null : monthly }, month: q.month, year: q.year, period: `${MONTH_NAMES[q.month - 1]} ${q.year}`,
      monthlySalary: staff.monthlySalary == null ? null : monthly, paid, remaining: round2(Math.max(0, monthly - paid)),
      payments: payments.map((p) => ({ ...p, amount: n(p.amount) })),
    };
  }

  /** Category rules, salary rules (partial payments allowed, never more than the month's salary, no accidental second payment). */
  private async validate(tx: Tx, ctx: AccessContext, input: ExpenseInput, excludeId?: bigint) {
    const cat = await tx.expenseCategory.findFirst({ where: { id: BigInt(input.categoryId), schoolId: ctx.schoolId } });
    if (!cat) throw notFound('Expense category');
    if (cat.status !== 'ACTIVE') throw invalid(`The category "${cat.name}" is no longer in use`, [{ path: 'categoryId', code: 'inactive', message: 'Choose another category' }]);
    if (!cat.isSalary) return { cat, salary: null };
    if (!this.canSalary(ctx)) throw forbidden('Only the Headmaster or an authorised user can record staff salary');
    if (!input.staffId || !input.salaryMonth || !input.salaryYear) {
      throw invalid('Choose the staff member, salary month and year', [
        ...(!input.staffId ? [{ path: 'staffId', code: 'required', message: 'Choose the staff member' }] : []),
        ...(!input.salaryMonth ? [{ path: 'salaryMonth', code: 'required', message: 'Choose the month' }] : []),
        ...(!input.salaryYear ? [{ path: 'salaryYear', code: 'required', message: 'Choose the year' }] : []),
      ]);
    }
    // Lock the staff row: two people paying the same salary at the same moment cannot both pass the checks.
    await tx.$queryRaw`SELECT id FROM staff WHERE id = ${BigInt(input.staffId)} FOR UPDATE`;
    const st = await this.salaryStatus(ctx, { staffId: input.staffId, month: input.salaryMonth, year: input.salaryYear, excludeId: excludeId ? Number(excludeId) : undefined }, tx);
    if (st.monthlySalary == null || st.monthlySalary <= 0) throw invalid(`${st.staff.name} has no monthly salary set. The Headmaster sets it on the staff profile.`, [{ path: 'staffId', code: 'no_salary', message: 'No monthly salary set' }]);
    if (st.remaining <= 0) throw conflict('DUPLICATE', `${st.staff.name}'s salary for ${st.period} is already fully paid (${st.payments.map((p) => p.voucherNo).join(', ')})`, [{ path: 'salaryMonth', code: 'paid', message: 'Already fully paid' }]);
    if (st.payments.length && !input.confirmAdditional) {
      throw new AppError(409, ERROR_CODES.DUPLICATE, `${st.staff.name} already has ${st.payments.length} salary voucher(s) for ${st.period} (₹${st.paid.toLocaleString('en-IN')} paid, ₹${st.remaining.toLocaleString('en-IN')} remaining). Confirm to record another part payment.`, [{ path: 'confirmAdditional', code: 'confirm', message: 'Confirm a second payment for this month' }]);
    }
    if (input.amount > st.remaining + 0.001) throw invalid(`Only ₹${st.remaining.toLocaleString('en-IN')} of ${st.staff.name}'s ${st.period} salary is still unpaid`, [{ path: 'amount', code: 'too_much', message: `At most ₹${st.remaining.toLocaleString('en-IN')}` }]);
    return { cat, salary: st };
  }

  private async yearOf(tx: Tx, ctx: AccessContext, date: string) {
    const d = dateOnly(date)!;
    return (await tx.academicYear.findFirst({ where: { schoolId: ctx.schoolId, startDate: { lte: d }, endDate: { gte: d } }, select: { id: true } }))?.id ?? null;
  }

  // ------------------------------------------------------------------ create / edit / workflow
  async create(ctx: AccessContext, input: ExpenseInput) {
    return this.prisma.$transaction(async (tx) => {
      const { cat, salary } = await this.validate(tx, ctx, input);
      await tx.numberSequence.upsert({ where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: 'expense_voucher' } }, update: {}, create: { schoolId: ctx.schoolId, seqKey: 'expense_voucher', label: 'Expense voucher number', pattern: 'EXP-{000000}', nextValue: BigInt(1) } });
      const voucherNo = await this.sequences.next(tx, ctx.schoolId, 'expense_voucher');
      const e = await tx.expense.create({
        data: {
          schoolId: ctx.schoolId, voucherNo, academicYearId: await this.yearOf(tx, ctx, input.expenseDate), expenseDate: dateOnly(input.expenseDate)!, categoryId: cat.id,
          title: input.title, description: input.description, paidTo: input.paidTo, amount: input.amount, mode: input.mode, reference: input.reference,
          billNo: input.billNo, remarks: input.remarks,
          ...(salary ? { staffId: BigInt(input.staffId!), salaryMonth: input.salaryMonth, salaryYear: input.salaryYear, monthlySalary: salary.monthlySalary } : {}),
          status: 'PENDING', createdBy: ctx.userId,
        },
        include,
      });
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'Expense', entityId: e.id, after: { voucherNo, category: cat.name, amount: input.amount, paidTo: input.paidTo, status: 'PENDING' } }, tx);
      return this.shape(e, await this.names([e.createdBy]));
    });
  }

  async update(ctx: AccessContext, id: bigint, input: ExpenseInput) {
    const before = await this.load(ctx, id);
    const mine = before.createdBy === ctx.userId;
    if (before.status === 'PENDING') {
      if (!mine && !hasPermission(ctx, P.EXPENSES_APPROVE)) throw forbidden('Only the person who entered this voucher, or the Headmaster, can change it');
    } else if (before.status === 'APPROVED') {
      if (!hasPermission(ctx, P.EXPENSES_CORRECT)) throw forbidden('An approved voucher can be changed only by the Super Admin (with a reason)');
      if (!input.reason) throw invalid('Give the reason for changing an approved voucher', [{ path: 'reason', code: 'required', message: 'Reason required' }]);
    } else {
      throw invalidState(`A ${EXPENSE_STATUS_LABELS[before.status as ExpenseStatus].toLowerCase()} voucher cannot be changed`);
    }
    return this.prisma.$transaction(async (tx) => {
      const { cat, salary } = await this.validate(tx, ctx, input, id);
      const after = await tx.expense.update({
        where: { id },
        data: {
          academicYearId: await this.yearOf(tx, ctx, input.expenseDate), expenseDate: dateOnly(input.expenseDate)!, categoryId: cat.id, title: input.title, description: input.description,
          paidTo: input.paidTo, amount: input.amount, mode: input.mode, reference: input.reference, billNo: input.billNo, remarks: input.remarks,
          staffId: salary ? BigInt(input.staffId!) : null, salaryMonth: salary ? input.salaryMonth : null, salaryYear: salary ? input.salaryYear : null, monthlySalary: salary ? salary.monthlySalary : null,
          version: { increment: 1 }, updatedBy: ctx.userId,
        },
        include,
      });
      const pick = (x: ExpenseFull) => ({ expenseDate: iso(x.expenseDate), category: x.category.name, title: x.title, description: x.description, paidTo: x.paidTo, amount: n(x.amount), mode: x.mode, reference: x.reference, billNo: x.billNo, remarks: x.remarks, staffId: x.staffId, salaryMonth: x.salaryMonth, salaryYear: x.salaryYear });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Expense', entityId: id, before: pick(before), after: pick(after), reason: input.reason ?? undefined }, tx);
      return this.shape(after, await this.names([after.createdBy, after.approvedBy]));
    });
  }

  async decide(ctx: AccessContext, id: bigint, action: 'APPROVE' | 'REJECT' | 'CANCEL', reason?: string) {
    const e = await this.load(ctx, id);
    const mine = e.createdBy === ctx.userId;
    let data: Prisma.ExpenseUpdateInput;
    if (action === 'APPROVE' || action === 'REJECT') {
      if (!hasPermission(ctx, P.EXPENSES_APPROVE)) throw forbidden('Only the Headmaster or Super Admin can approve or reject vouchers');
      if (e.status !== 'PENDING') throw invalidState(`This voucher is already ${EXPENSE_STATUS_LABELS[e.status as ExpenseStatus].toLowerCase()}`);
      data = action === 'APPROVE' ? { status: 'APPROVED', approvedBy: ctx.userId, approvedAt: new Date() } : { status: 'REJECTED', rejectedBy: ctx.userId, rejectedAt: new Date(), rejectReason: reason };
    } else {
      if (e.status === 'PENDING') {
        if (!mine && !hasPermission(ctx, P.EXPENSES_APPROVE)) throw forbidden('You cannot cancel this voucher');
      } else if (e.status === 'APPROVED') {
        // Reversal of an approved expense: it stops counting in the approved totals; the voucher stays on record.
        if (!hasPermission(ctx, P.EXPENSES_CORRECT)) throw forbidden('An approved voucher can be cancelled only by the Super Admin (with a reason)');
      } else throw invalidState('This voucher is already closed');
      data = { status: 'CANCELLED', cancelledBy: ctx.userId, cancelledAt: new Date(), cancelReason: reason };
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.expense.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedBy: ctx.userId }, include });
      await this.audit.record(ctx, { action, entityType: 'Expense', entityId: id, before: { status: e.status }, after: { status: after.status, voucherNo: e.voucherNo, amount: n(e.amount) }, reason }, tx);
      return this.shape(after, await this.names([after.createdBy, after.approvedBy, after.rejectedBy, after.cancelledBy]));
    });
  }

  // ------------------------------------------------------------------ bills
  async attach(ctx: AccessContext, id: bigint, file?: Express.Multer.File) {
    const e = await this.load(ctx, id);
    if (!((e.status === 'PENDING' && e.createdBy === ctx.userId) || this.canReadAll(ctx))) throw forbidden('You cannot add bills to this voucher');
    if (!file) throw invalid('Choose a file to upload');
    if (file.size > MAX_BILL_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The file must be 5 MB or smaller');
    const type = sniffDocument(file.buffer);
    if (!type) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PDF, JPEG, PNG or WebP files are allowed');
    const key = await this.storage.put(`schools/${ctx.schoolId}/expenses`, type.ext, file.buffer);
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.file.create({ data: { schoolId: ctx.schoolId, storageDriver: this.storage.name, storageKey: key, originalName: file.originalname.slice(0, 255), mimeType: type.mime, sizeBytes: BigInt(file.size), sha256: createHash('sha256').update(file.buffer).digest('hex'), purpose: 'EXPENSE_BILL', createdBy: ctx.userId } });
      const a = await tx.expenseAttachment.create({ data: { expenseId: id, fileId: f.id, createdBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Expense', entityId: id, after: { bill: f.originalName }, reason: 'Bill attached' }, tx);
      return { id: a.id, fileName: f.originalName };
    });
  }
  async streamBill(ctx: AccessContext, id: bigint, attachmentId: bigint, res: Response) {
    await this.load(ctx, id);
    const a = await this.prisma.expenseAttachment.findFirst({ where: { id: attachmentId, expenseId: id } });
    const f = a ? await this.prisma.file.findFirst({ where: { id: a.fileId, schoolId: ctx.schoolId } }) : null;
    if (!f) throw notFound('Bill');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${f.originalName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    this.storage.read(f.storageKey).pipe(res);
    return new StreamMarker();
  }

  // ------------------------------------------------------------------ voucher PDF
  async voucherPdf(ctx: AccessContext, id: bigint, res: Response) {
    const v = await this.get(ctx, id);
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId } });
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 28, info: { Title: `Voucher ${v.voucherNo}` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      const W = doc.page.width - 56;
      doc.font('Helvetica-Bold').fontSize(14).text(school.name, { align: 'center' });
      doc.font('Helvetica').fontSize(8).text([school.addressLine, school.city, school.pincode].filter(Boolean).join(', ') + (school.phone ? `  ·  Phone ${school.phone}` : '') + (school.email ? `  ·  ${school.email}` : ''), { align: 'center' });
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).text('PAYMENT VOUCHER', { align: 'center' });
      if (v.status !== 'APPROVED') doc.fillColor('#b91c1c').fontSize(9).text(EXPENSE_STATUS_LABELS[v.status as ExpenseStatus].toUpperCase(), { align: 'center' }).fillColor('#000');
      doc.moveDown(0.5);
      const rows: [string, string][] = [
        ['Voucher No.', v.voucherNo], ['Expense date', iso(v.expenseDate)!.split('-').reverse().join('/')], ['Category', v.category.name], ['Expense title', v.title],
        ['Paid to', v.paidTo], ['Description', v.description],
        ...(v.staff ? [['Salary of', `${v.staff.name} (${v.staff.employeeCode})${v.staff.designation ? `, ${v.staff.designation}` : ''} · ${MONTH_NAMES[(v.salaryMonth ?? 1) - 1]} ${v.salaryYear}`] as [string, string]] : []),
        ['Bill / invoice No.', v.billNo ?? '—'], ['Amount', `Rs ${v.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`], ['Amount in words', amountInWords(v.amount)],
        ['Payment mode', PAYMENT_MODE_LABELS[v.mode as PaymentMode] ?? v.mode], ['Transaction reference', v.reference ?? '—'], ['Remarks', v.remarks ?? '—'],
        ['Prepared by', `${v.createdBy ?? '—'} on ${v.createdAt.toLocaleDateString('en-IN', { timeZone: school.timezone || 'Asia/Kolkata' })}`],
        ['Approved by', v.approvedBy ? `${v.approvedBy} on ${v.approvedAt!.toLocaleDateString('en-IN', { timeZone: school.timezone || 'Asia/Kolkata' })}` : '—'],
      ];
      for (const [k, val] of rows) {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8.5).text(k, 28, y, { width: 130 });
        doc.font('Helvetica').text(val, 165, y, { width: W - 137 });
        doc.y = Math.max(doc.y, y + 12) + 2;
      }
      const sy = Math.min(doc.page.height - 60, doc.y + 30);
      for (const [i, label] of ['Prepared by', 'Approved by', "Receiver's signature"].entries()) {
        const x = 28 + i * (W / 3);
        doc.moveTo(x + 10, sy).lineTo(x + W / 3 - 10, sy).stroke();
        doc.fontSize(8).text(label, x, sy + 4, { width: W / 3, align: 'center' });
      }
      doc.end();
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="voucher-${v.voucherNo}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
    return new StreamMarker();
  }
}

@Controller()
export class ExpensesController {
  constructor(private readonly svc: ExpensesService) {}

  @Get('expense-categories')
  categories(@Ctx() ctx: AccessContext) { return this.svc.categories(ctx); }
  @Post('expense-categories') @RequirePermission(P.EXPENSE_CATEGORIES_MANAGE)
  createCategory(@Ctx() ctx: AccessContext, @Body(zBody(expenseCategorySchema)) b: z.infer<typeof expenseCategorySchema>) { return this.svc.saveCategory(ctx, b); }
  @Patch('expense-categories/:id') @RequirePermission(P.EXPENSE_CATEGORIES_MANAGE)
  updateCategory(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(expenseCategorySchema)) b: z.infer<typeof expenseCategorySchema>) { return this.svc.saveCategory(ctx, b, id); }

  @Get('expenses')
  list(@Ctx() ctx: AccessContext, @Query(zBody(listQuery)) q: z.infer<typeof listQuery>) { return this.svc.list(ctx, q); }
  @Get('expenses/salary-status')
  salary(@Ctx() ctx: AccessContext, @Query(zBody(salaryQuery)) q: z.infer<typeof salaryQuery>) { return this.svc.salaryStatus(ctx, q); }
  @Get('expenses/:id')
  get(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.get(ctx, id); }
  @Post('expenses') @RequirePermission(P.EXPENSES_CREATE)
  create(@Ctx() ctx: AccessContext, @Body(zBody(expenseSchema)) b: ExpenseInput) { return this.svc.create(ctx, b); }
  @Patch('expenses/:id')
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(expenseSchema)) b: ExpenseInput) { return this.svc.update(ctx, id, b); }
  @Post('expenses/:id/approve') @HttpCode(200)
  approve(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.decide(ctx, id, 'APPROVE'); }
  @Post('expenses/:id/reject') @HttpCode(200)
  reject(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(expenseDecisionSchema)) b: { reason: string }) { return this.svc.decide(ctx, id, 'REJECT', b.reason); }
  @Post('expenses/:id/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(expenseDecisionSchema)) b: { reason: string }) { return this.svc.decide(ctx, id, 'CANCEL', b.reason); }
  @Post('expenses/:id/attachments') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BILL_BYTES + 1, files: 1 } }))
  attach(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @UploadedFile() file?: Express.Multer.File) { return this.svc.attach(ctx, id, file); }
  @Get('expenses/:id/attachments/:aid')
  bill(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('aid', IdPipe) aid: bigint, @Res() res: Response) { return this.svc.streamBill(ctx, id, aid, res); }
  @Get('expenses/:id/voucher.pdf')
  pdf(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Res() res: Response) { return this.svc.voucherPdf(ctx, id, res); }
}

@Module({ imports: [PoliciesSequencesModule], controllers: [ExpensesController], providers: [ExpensesService] })
export class ExpensesModule {}
