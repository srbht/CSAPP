import { Controller, Get, Injectable, Module, Param, Query, Res } from '@nestjs/common';
import {
  EMPLOYEE_TYPE_LABELS, EMPLOYEE_TYPES, EMPLOYMENT_TYPE_LABELS, EXPENSE_STATUS_LABELS, EXPENSE_STATUSES, GENDER_LABELS, ledgerFigures, MONTH_NAMES, PAYMENT_MODE_LABELS, PERMISSIONS,
  round2, SALARY_MODE_LABELS, STAFF_STATUS_LABELS, STAFF_STATUSES, STUDENT_STATUS_LABELS, type ExpenseStatus, type PaymentMode, type StaffStatus, type StudentStatus, grNoLabel } from '@cps/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AccessContext, Ctx, hasPermission } from '../../common/auth';
import { forbidden, invalid, notFound } from '../../common/errors';
import { ResolvedScope, ScopeService } from '../../common/scope';
import { StreamMarker } from '../../common/serialize';
import { dateOnly, zBody } from '../../common/validation';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma.service';
import { num as n, paidByEnrollment } from '../fee-ledger';
import { Column, ReportResult, Row, SummaryItem, toExcel, toPdf } from './report-output';

const P = PERMISSIONS;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idList = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).map(Number).filter((x) => Number.isInteger(x) && x > 0)));

export const reportQuery = z.object({
  academicYearId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(), to: isoDate.optional(),
  mode: z.string().max(20).optional(),
  classIds: idList,
  sectionId: z.coerce.number().int().positive().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'TRANSFERRED', 'ALL']).optional(),
  minAmount: z.coerce.number().min(0).optional(), maxAmount: z.coerce.number().min(0).optional(),
  includePrevious: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  categoryId: z.coerce.number().int().positive().optional(),
  voucherStatus: z.enum(EXPENSE_STATUSES).optional(),
  createdBy: z.coerce.number().int().positive().optional(),
  enteredBy: z.coerce.number().int().positive().optional(),
  employeeType: z.enum(EMPLOYEE_TYPES).optional(),
  designation: z.string().trim().max(60).optional(),
  department: z.string().trim().max(60).optional(),
  staffStatus: z.enum(STAFF_STATUSES).optional(),
  joinFrom: isoDate.optional(), joinTo: isoDate.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(40).optional(), dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
  all: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
});
export type ReportQuery = z.infer<typeof reportQuery>;

export const REPORT_KEYS = [
  'day-wise-collection', 'class-wise-collection', 'pending-fees', 'gender-wise-students', 'class-wise-students', 'school-at-a-glance',
  'staff-list', 'staff-salary', 'day-wise-expenses', 'category-wise-expenses', 'salary-expenses', 'backdated-fees', 'income-expense',
] as const;
type ReportKey = (typeof REPORT_KEYS)[number];
const FEE_REPORTS: ReportKey[] = ['day-wise-collection', 'class-wise-collection', 'pending-fees', 'backdated-fees', 'income-expense'];
/** Who may open each report (checked on the server for screen, Excel and PDF alike). */
const ACCESS: Record<ReportKey, (ctx: AccessContext) => boolean> = {
  'day-wise-collection': (c) => hasPermission(c, P.FEES_READ),
  'class-wise-collection': (c) => hasPermission(c, P.FEES_READ),
  'pending-fees': (c) => hasPermission(c, P.FEES_READ),
  'gender-wise-students': (c) => hasPermission(c, P.REPORTS_VIEW),
  'class-wise-students': (c) => hasPermission(c, P.REPORTS_VIEW),
  'school-at-a-glance': (c) => hasPermission(c, P.REPORTS_VIEW),
  'staff-list': (c) => hasPermission(c, P.STAFF_READ) || hasPermission(c, P.STAFF_REGISTER) || hasPermission(c, P.STAFF_MANAGE),
  'staff-salary': (c) => hasPermission(c, P.STAFF_SALARY),
  'day-wise-expenses': (c) => hasPermission(c, P.EXPENSES_READ),
  'category-wise-expenses': (c) => hasPermission(c, P.EXPENSES_READ),
  'salary-expenses': (c) => hasPermission(c, P.EXPENSES_READ) && hasPermission(c, P.STAFF_SALARY),
  'backdated-fees': (c) => hasPermission(c, P.FEES_EDIT),
  'income-expense': (c) => hasPermission(c, P.EXPENSES_READ) && hasPermission(c, P.FEES_READ),
};

/** A report before search / sort / paging: the rows plus how to summarise whatever rows remain. */
interface Built {
  title: string;
  filters: { label: string; value: string }[];
  columns: Column[];
  rows: Row[];
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Keys searched by "student name or admission number". */
  search?: string[];
  summarize: (rows: Row[]) => SummaryItem[];
  /** Keys summed into a totals row. */
  totalKeys?: string[];
  numbered?: boolean;
  tables?: ReportResult['tables'];
  /** Extra tables computed from the rows left after search (so they always agree with the list). */
  tablesFor?: (rows: Row[]) => NonNullable<ReportResult['tables']>;
  tablesFirst?: boolean;
  notes?: string[];
}

const ONLINE: PaymentMode[] = ['UPI', 'BANK_TRANSFER', 'CARD'];
const sum = (rows: Row[], key: string) => round2(rows.reduce((t, r) => t + (Number(r[key]) || 0), 0));
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const dmy = (s: string) => s.split('-').reverse().join('/');
const statusGroup = (studentStatus: string, enrollmentStatus: string) =>
  studentStatus === 'TRANSFERRED' || enrollmentStatus === 'TRANSFERRED_OUT' ? 'TRANSFERRED' : studentStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
const STATUS_FILTER_LABEL = { ACTIVE: 'Active', INACTIVE: 'Inactive (left, passed out)', TRANSFERRED: 'Transferred', ALL: 'All' } as const;


/** GR No for printing: blank until one is given. */
const grOf = (s: { grNo: string | null; grNoTemp?: boolean }) => grNoLabel(s);

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly scopes: ScopeService) {}

  // ------------------------------------------------------------------ entry point
  async run(ctx: AccessContext, key: string, q: ReportQuery) {
    if (!(REPORT_KEYS as readonly string[]).includes(key)) throw notFound('Report');
    const k = key as ReportKey;
    if (!ACCESS[k](ctx)) throw forbidden('You do not have access to this report');
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, ...(q.academicYearId ? { id: BigInt(q.academicYearId) } : { isCurrent: true }) } });
    if (!year) throw notFound('Academic year');
    const scope = await this.scopes.resolve(ctx, year.id);
    if (FEE_REPORTS.includes(k) && !scope.all) throw forbidden('Fee reports are for the school office');
    const classNames = q.classIds.length ? (await this.prisma.schoolClass.findMany({ where: { id: { in: q.classIds.map(BigInt) }, academicYearId: year.id } })).map((c) => c.displayName) : [];
    const common = [{ label: 'Academic year', value: year.name }, ...(classNames.length ? [{ label: 'Class', value: classNames.join(', ') }] : [])];
    const built = await this.build(k, ctx, scope, year, q, common);
    return this.finish(ctx, built, q);
  }

  private build(k: ReportKey, ctx: AccessContext, scope: ResolvedScope, year: { id: bigint; name: string; startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']) {
    switch (k) {
      case 'day-wise-collection': return this.dayWise(ctx, year, q, common);
      case 'class-wise-collection': return this.classWiseCollection(year, q, common);
      case 'pending-fees': return this.pending(year, q, common);
      case 'gender-wise-students': return this.studentList('gender', ctx, scope, year, q, common);
      case 'class-wise-students': return this.studentList('class', ctx, scope, year, q, common);
      case 'school-at-a-glance': return this.glance(scope, year, q, common);
      case 'staff-list': return this.staffList(ctx, q, common);
      case 'staff-salary': return this.staffSalary(ctx, year, q, common);
      case 'day-wise-expenses': return this.dayWiseExpenses(ctx, year, q, common);
      case 'category-wise-expenses': return this.categoryWiseExpenses(ctx, year, q, common);
      case 'salary-expenses': return this.salaryExpenses(ctx, year, q, common);
      case 'backdated-fees': return this.backdatedFees(ctx, year, q, common);
      case 'income-expense': return this.incomeExpense(ctx, year, q, common);
    }
  }

  /** Search, sort, totals, paging (screen) or the complete report (Excel / PDF / print). */
  private async finish(ctx: AccessContext, b: Built, q: ReportQuery) {
    let rows = b.rows;
    if (q.q && b.search?.length) {
      const t = q.q.toLowerCase();
      rows = rows.filter((r) => b.search!.some((k) => String(r[k] ?? '').toLowerCase().includes(t)));
    }
    const sortKey = q.sort && b.columns.some((c) => c.key === q.sort) ? q.sort : b.defaultSort?.key;
    const dir = q.sort ? q.dir : (b.defaultSort?.dir ?? 'asc');
    if (sortKey) {
      const m = dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, c) => {
        const x = a[sortKey]; const y = c[sortKey];
        if (x === y) return 0;
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
        return String(x).localeCompare(String(y), 'en', { numeric: true }) * m;
      });
    }
    if (b.numbered) rows = rows.map((r, i) => ({ ...r, srNo: i + 1 }));
    const filters = [...b.filters, ...(q.q ? [{ label: 'Search', value: q.q }] : [])];
    const totals = b.totalKeys ? Object.fromEntries([[b.columns[0].key, 'Total'], ...b.totalKeys.map((k) => [k, sum(rows, k)])]) as Row : undefined;
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { name: true } });
    const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
    const result: ReportResult = { title: b.title, school: school.name, generatedAt, filters, summary: b.summarize(rows), columns: b.columns, rows, totals, tables: b.tablesFor ? b.tablesFor(rows) : b.tables, tablesFirst: b.tablesFirst, notes: b.notes };
    if (q.format !== 'json' || q.all) return { result, total: rows.length };
    return { result: { ...result, rows: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize) }, total: rows.length };
  }

  async data(ctx: AccessContext, key: string, q: ReportQuery) {
    const { result, total } = await this.run(ctx, key, { ...q, format: 'json' });
    return { ...result, meta: { page: q.all ? 1 : q.page, pageSize: q.all ? total : q.pageSize, total } };
  }

  async export(ctx: AccessContext, key: string, q: ReportQuery, res: Response) {
    if (q.format === 'json') throw invalid('Choose xlsx or pdf');
    const { result } = await this.run(ctx, key, q);
    const file = `${key}-${new Date().toISOString().slice(0, 10)}`;
    const buf = q.format === 'xlsx' ? await toExcel(result) : await toPdf(result);
    res.setHeader('Content-Type', q.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.${q.format}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
    return new StreamMarker();
  }

  async people(ctx: AccessContext) {
    const fees = hasPermission(ctx, P.FEES_READ) ? await this.prisma.feePayment.findMany({ where: { schoolId: ctx.schoolId }, select: { createdBy: true }, distinct: ['createdBy'] }) : [];
    const exp = hasPermission(ctx, P.EXPENSES_READ) ? await this.prisma.expense.findMany({ where: { schoolId: ctx.schoolId }, select: { createdBy: true }, distinct: ['createdBy'] }) : [];
    const names = await this.userNames([...fees.map((f) => f.createdBy), ...exp.map((e) => e.createdBy)]);
    const list = (ids: bigint[]) => ids.map((id) => ({ id: Number(id), name: names.get(String(id)) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
    return { feeCollectors: list(fees.map((f) => f.createdBy)), expenseCreators: list(exp.map((e) => e.createdBy)) };
  }

  // ------------------------------------------------------------------ shared lookups
  private dateRange(q: ReportQuery, year: { startDate: Date }) {
    const from = q.from ?? iso(year.startDate)!;
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    if (from > to) throw invalid('"From date" is after "To date"', [{ path: 'from', code: 'order', message: 'After the To date' }]);
    return { from, to };
  }
  private async collectors(userIds: bigint[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    return new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
  }
  /** Part of a receipt that cleared the previous year's outstanding (cleared first), from the figures saved on the receipt. */
  private split(p: { amount: Prisma.Decimal; previousOutstanding: Prisma.Decimal; paidBefore: Prisma.Decimal }) {
    const previous = round2(Math.min(n(p.amount), Math.max(0, n(p.previousOutstanding) - n(p.paidBefore))));
    return { previous, current: round2(n(p.amount) - previous) };
  }
  private studentBase = {
    id: true, fullName: true, studentCode: true, grNo: true, grNoTemp: true, gender: true, dob: true, admissionDate: true, status: true, fatherName: true, motherName: true,
    guardians: { include: { guardian: { select: { name: true, mobile: true } } } },
  } as const;
  private parents(s: { fatherName: string | null; motherName: string | null; guardians: { relation: string; isPrimary: boolean; guardian: { name: string; mobile: string | null } }[] }) {
    const father = s.guardians.find((g) => g.relation === 'FATHER')?.guardian.name ?? s.fatherName;
    const mother = s.guardians.find((g) => g.relation === 'MOTHER')?.guardian.name ?? s.motherName;
    const contact = (s.guardians.find((g) => g.isPrimary) ?? s.guardians.find((g) => g.guardian.mobile))?.guardian.mobile ?? null;
    return { father: father ?? null, mother: mother ?? null, parents: [father, mother].filter(Boolean).join(' / ') || null, contact };
  }

  // ------------------------------------------------------------------ 1. day-wise collection
  private async dayWise(ctx: AccessContext, year: { id: bigint; startDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.dateRange(q, year);
    const payments = await this.prisma.feePayment.findMany({
      where: {
        schoolId: ctx.schoolId, academicYearId: year.id, status: 'VALID', paidOn: { gte: dateOnly(from)!, lte: dateOnly(to)! },
        ...(q.mode ? { mode: q.mode } : {}), ...(q.classIds.length ? { enrollment: { classId: { in: q.classIds.map(BigInt) } } } : {}),
      },
      include: { enrollment: { include: { student: { select: { fullName: true, grNo: true, grNoTemp: true, studentCode: true } }, section: { select: { name: true, schoolClass: { select: { displayName: true, medium: { select: { nameEn: true, sortOrder: true } } } } } } } } },
    });
    const by = await this.collectors(payments.map((p) => p.createdBy));
    const allMediums = (await this.prisma.medium.findMany({ where: { schoolId: ctx.schoolId, status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' }, select: { nameEn: true } })).map((m) => m.nameEn);
    // Approved expenses paid in the same period, by payment mode (school-wide, so only when no class is chosen).
    const expenses = q.classIds.length ? [] : await this.prisma.expense.groupBy({
      by: ['mode'], where: { schoolId: ctx.schoolId, status: 'APPROVED', expenseDate: { gte: dateOnly(from)!, lte: dateOnly(to)! }, ...(q.mode ? { mode: q.mode } : {}) }, _sum: { amount: true },
    });
    const rows: Row[] = payments.map((p) => {
      const s = this.split(p);
      return {
        date: iso(p.paidOn), receiptNo: p.receiptNo, studentName: p.enrollment.student.fullName, studentId: p.enrollment.student.studentCode, admissionNo: grOf(p.enrollment.student),
        className: `${p.enrollment.section.schoolClass.displayName} ${p.enrollment.section.name}`, previousCollected: s.previous, currentCollected: s.current,
        total: n(p.amount), mode: PAYMENT_MODE_LABELS[p.mode as PaymentMode] ?? p.mode, modeCode: p.mode, collectedBy: by.get(String(p.createdBy)) ?? '',
        medium: p.enrollment.section.schoolClass.medium.nameEn, mediumOrder: p.enrollment.section.schoolClass.medium.sortOrder,
      };
    });
    /** Collection summary: one row per medium, one column per payment mode, then Total, Expense and Grand Total (collection − expense). */
    const summaryTable = (list: Row[]) => {
      const fixed = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'];
      const extraModes = [...new Set([...list.map((r) => String(r.modeCode)), ...expenses.map((e) => e.mode)])].filter((m) => !fixed.includes(m));
      const modes = [...fixed, ...extraModes];
      const label: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'NEFT / Bank', CHEQUE: 'Cheque', CARD: 'Card', DD: 'DD' };
      const line = (name: string, amounts: Record<string, number>) => {
        const row: Row = { name };
        let total = 0;
        for (const m of modes) { row[m] = round2(amounts[m] ?? 0); total += amounts[m] ?? 0; }
        row.total = round2(total);
        return row;
      };
      // Every medium is shown (zero when nothing was collected), plus any older medium that still has receipts.
      const mediums = [...allMediums, ...[...new Set(list.map((r) => String(r.medium)))].filter((m) => !allMediums.includes(m))];
      const byMode = (rows: Row[]) => rows.reduce<Record<string, number>>((acc, r) => { acc[String(r.modeCode)] = (acc[String(r.modeCode)] ?? 0) + Number(r.total); return acc; }, {});
      const totals = byMode(list);
      const exp = Object.fromEntries(expenses.map((e) => [e.mode, n(e._sum.amount)]));
      const rows: Row[] = [...mediums.map((m) => line(m, byMode(list.filter((r) => r.medium === m)))), line('Total', totals)];
      if (!q.classIds.length) {
        rows.push(line('Expense (approved)', exp));
        rows.push(line('Grand Total', Object.fromEntries(modes.map((m) => [m, (totals[m] ?? 0) - (exp[m] ?? 0)]))));
      }
      return [{
        title: 'Collection summary', emphasis: ['Total', 'Grand Total'], rows,
        columns: [{ key: 'name', label: '' }, ...modes.map((m) => ({ key: m, label: label[m] ?? m, type: 'money' as const })), { key: 'total', label: 'Total', type: 'money' as const }],
      }];
    };
    return {
      title: 'Day-wise Fees Collection Report',
      filters: [...common, { label: 'From', value: dmy(from) }, { label: 'To', value: dmy(to) }, { label: 'Payment mode', value: q.mode ? PAYMENT_MODE_LABELS[q.mode as PaymentMode] ?? q.mode : 'All modes' }],
      columns: [
        { key: 'date', label: 'Collection Date', type: 'date' }, { key: 'receiptNo', label: 'Receipt No.' }, { key: 'studentName', label: 'Student Name' },
        { key: 'studentId', label: 'Student ID' }, { key: 'admissionNo', label: 'Admission No.' }, { key: 'className', label: 'Class' }, { key: 'previousCollected', label: 'Previous Year Fees Collected', type: 'money' },
        { key: 'currentCollected', label: 'Current Year Fees Collected', type: 'money' }, { key: 'total', label: 'Total Amount Collected', type: 'money' },
        { key: 'mode', label: 'Payment Mode' }, { key: 'collectedBy', label: 'Collected By' },
      ],
      rows, defaultSort: { key: 'receiptNo', dir: 'asc' }, search: ['studentName', 'admissionNo', 'receiptNo'],
      totalKeys: ['previousCollected', 'currentCollected', 'total'],
      tablesFor: summaryTable, tablesFirst: true,
      summarize: (r) => {
        const cash = r.filter((x) => x.modeCode === 'CASH');
        const online = r.filter((x) => ONLINE.includes(x.modeCode as PaymentMode));
        const other = r.filter((x) => x.modeCode !== 'CASH' && !ONLINE.includes(x.modeCode as PaymentMode));
        return [
          { label: 'Total receipts', value: r.length, type: 'number' },
          { label: 'Cash collection', value: sum(cash, 'total'), type: 'money' },
          { label: 'Online collection (UPI, bank transfer, card)', value: sum(online, 'total'), type: 'money' },
          ...(other.length ? [{ label: 'Cheque / DD collection', value: sum(other, 'total'), type: 'money' as const }] : []),
          { label: 'Previous year fees collected', value: sum(r, 'previousCollected'), type: 'money' },
          { label: 'Current year fees collected', value: sum(r, 'currentCollected'), type: 'money' },
          { label: 'Total collection', value: sum(r, 'total'), type: 'money' },
        ];
      },
      notes: [
        'Cancelled receipts are not included. "Previous year fees collected" is the part of a receipt that cleared the carried-forward balance (it is cleared first).',
        q.classIds.length ? 'Expenses are school-wide, so they are not deducted when a class is chosen.' : 'Expense = approved expense vouchers dated in the same period, by payment mode. Grand Total = collection − expense.',
      ],
    };
  }

  // ------------------------------------------------------------------ 2. class-wise collection
  private async classWiseCollection(year: { id: bigint; startDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.dateRange(q, year);
    const classes = await this.prisma.schoolClass.findMany({
      where: { academicYearId: year.id, status: 'ACTIVE', ...(q.classIds.length ? { id: { in: q.classIds.map(BigInt) } } : {}) },
      include: { medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } }, enrollments: { where: { status: { not: 'REJECTED' } }, select: { id: true, feeLedger: true } } },
      orderBy: [{ medium: { sortOrder: 'asc' } }, { standard: { levelOrder: 'asc' } }],
    });
    const enrollmentIds = classes.flatMap((c) => c.enrollments.map((e) => e.id));
    const paidAll = await paidByEnrollment(this.prisma, enrollmentIds);
    const inRange = await this.prisma.feePayment.findMany({
      where: { enrollmentId: { in: enrollmentIds }, status: 'VALID', paidOn: { gte: dateOnly(from)!, lte: dateOnly(to)! }, ...(q.mode ? { mode: q.mode } : {}) },
      select: { enrollmentId: true, amount: true, previousOutstanding: true, paidBefore: true },
    });
    const byEnr = new Map<string, { previous: number; current: number }>();
    for (const p of inRange) {
      const s = this.split(p);
      const x = byEnr.get(String(p.enrollmentId)) ?? { previous: 0, current: 0 };
      x.previous = round2(x.previous + s.previous); x.current = round2(x.current + s.current);
      byEnr.set(String(p.enrollmentId), x);
    }
    const rows: Row[] = classes.map((c, i) => {
      let previousApplicable = 0; let currentApplicable = 0; let outstanding = 0; let previous = 0; let current = 0;
      for (const e of c.enrollments) {
        const f = ledgerFigures({ previousOutstanding: n(e.feeLedger?.previousOutstanding), yearFee: n(e.feeLedger?.yearFee), concession: n(e.feeLedger?.concession), penalty: n(e.feeLedger?.penalty), paid: paidAll.get(String(e.id)) ?? 0 });
        previousApplicable += f.previousOutstanding; currentApplicable += f.currentYearNet; outstanding += f.balance;
        const x = byEnr.get(String(e.id));
        if (x) { previous += x.previous; current += x.current; }
      }
      return {
        order: i, className: c.displayName, students: c.enrollments.length, previousApplicable: round2(previousApplicable), currentApplicable: round2(currentApplicable),
        applicable: round2(previousApplicable + currentApplicable), previousCollected: round2(previous), currentCollected: round2(current), collected: round2(previous + current),
        outstanding: round2(outstanding),
      };
    });
    return {
      title: 'Class-wise Fees Collection Report',
      filters: [...common, { label: 'Collected from', value: dmy(from) }, { label: 'To', value: dmy(to) }, { label: 'Payment mode', value: q.mode ? PAYMENT_MODE_LABELS[q.mode as PaymentMode] ?? q.mode : 'All modes' }],
      columns: [
        { key: 'className', label: 'Class' }, { key: 'students', label: 'Total Students', type: 'number' },
        { key: 'previousApplicable', label: 'Previous Year Outstanding (carried)', type: 'money' }, { key: 'currentApplicable', label: 'Current Year Fees', type: 'money' },
        { key: 'applicable', label: 'Total Fees Applicable', type: 'money' }, { key: 'previousCollected', label: 'Previous Year Outstanding Collected', type: 'money' },
        { key: 'currentCollected', label: 'Current Year Fees Collected', type: 'money' }, { key: 'collected', label: 'Total Fees Collected', type: 'money' },
        { key: 'outstanding', label: 'Remaining Fees Outstanding', type: 'money' },
      ],
      rows, defaultSort: { key: 'order', dir: 'asc' },
      totalKeys: ['students', 'previousApplicable', 'currentApplicable', 'applicable', 'previousCollected', 'currentCollected', 'collected', 'outstanding'],
      summarize: (r) => [
        { label: 'Classes', value: r.length, type: 'number' },
        { label: 'Total fees applicable', value: sum(r, 'applicable'), type: 'money' },
        { label: 'Previous year outstanding collected', value: sum(r, 'previousCollected'), type: 'money' },
        { label: 'Current year fees collected', value: sum(r, 'currentCollected'), type: 'money' },
        { label: 'Total collection (selected classes)', value: sum(r, 'collected'), type: 'money' },
        { label: 'Remaining fees outstanding', value: sum(r, 'outstanding'), type: 'money' },
      ],
      notes: ['Collections are for the dates and payment mode chosen. "Total fees applicable" and "Remaining fees outstanding" are for the whole year, as of today.'],
    };
  }

  // ------------------------------------------------------------------ 3. pending fees
  private async pending(year: { id: bigint }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { academicYearId: year.id, status: { not: 'REJECTED' }, ...(q.classIds.length ? { classId: { in: q.classIds.map(BigInt) } } : {}), ...(q.gender ? { student: { gender: q.gender } } : {}) },
      include: {
        student: { select: this.studentBase }, feeLedger: true, section: { select: { name: true, schoolClass: { select: { displayName: true, medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } } } } } },
        feePayments: { where: { status: 'VALID' }, orderBy: { paidOn: 'desc' }, take: 1, select: { paidOn: true } },
      },
    });
    const paid = await paidByEnrollment(this.prisma, enrollments.map((e) => e.id));
    let rows: Row[] = enrollments.map((e) => {
      const f = ledgerFigures({ previousOutstanding: n(e.feeLedger?.previousOutstanding), yearFee: n(e.feeLedger?.yearFee), concession: n(e.feeLedger?.concession), penalty: n(e.feeLedger?.penalty), paid: paid.get(String(e.id)) ?? 0 });
      const currentDue = round2(f.balance - f.previousStillDue);
      const p = this.parents(e.student);
      return {
        studentName: e.student.fullName, studentId: e.student.studentCode, admissionNo: grOf(e.student), parents: p.parents, contact: p.contact,
        className: `${e.section.schoolClass.displayName} ${e.section.name}`, classOrder: e.section.schoolClass.medium.sortOrder * 1000 + e.section.schoolClass.standard.levelOrder * 10,
        previousDue: q.includePrevious ? f.previousStillDue : null, currentDue, pending: q.includePrevious ? f.balance : currentDue,
        lastPayment: iso(e.feePayments[0]?.paidOn), paid: f.paid,
      };
    });
    rows = rows.filter((r) => Number(r.pending) > 0 && (q.minAmount === undefined || Number(r.pending) >= q.minAmount) && (q.maxAmount === undefined || Number(r.pending) <= q.maxAmount));
    const columns: Column[] = [
      { key: 'studentName', label: 'Student Name' }, { key: 'studentId', label: 'Student ID' }, { key: 'admissionNo', label: 'Admission No.' }, { key: 'parents', label: 'Father / Mother Name' },
      { key: 'contact', label: 'Contact No.' }, { key: 'className', label: 'Class' },
      ...(q.includePrevious ? [{ key: 'previousDue', label: 'Previous Year Outstanding', type: 'money' as const }] : []),
      { key: 'currentDue', label: 'Current Year Outstanding', type: 'money' }, { key: 'pending', label: 'Total Pending Amount', type: 'money' },
      { key: 'lastPayment', label: 'Last Payment Date', type: 'date' }, { key: 'paid', label: 'Total Amount Paid', type: 'money' },
    ];
    return {
      title: 'Class-wise Pending Fees Report',
      filters: [...common, ...(q.gender ? [{ label: 'Gender', value: GENDER_LABELS[q.gender] }] : []),
        ...(q.minAmount !== undefined || q.maxAmount !== undefined ? [{ label: 'Pending amount', value: `${q.minAmount !== undefined ? `from Rs ${q.minAmount}` : ''} ${q.maxAmount !== undefined ? `up to Rs ${q.maxAmount}` : ''}`.trim() }] : []),
        { label: 'Include previous year outstanding', value: q.includePrevious ? 'Yes' : 'No' }],
      columns, rows, defaultSort: { key: 'classOrder', dir: 'asc' }, search: ['studentName', 'admissionNo'],
      totalKeys: [...(q.includePrevious ? ['previousDue'] : []), 'currentDue', 'pending', 'paid'],
      summarize: (r) => [
        { label: 'Students with pending fees', value: r.length, type: 'number' },
        ...(q.includePrevious ? [{ label: 'Total previous year outstanding', value: sum(r, 'previousDue'), type: 'money' as const }] : []),
        { label: 'Total current year outstanding', value: sum(r, 'currentDue'), type: 'money' },
        { label: 'Total pending fees', value: sum(r, 'pending'), type: 'money' },
      ],
    };
  }

  // ------------------------------------------------------------------ student lists (shared by 4, 5 and 6)
  private async enrollmentsFor(scope: ResolvedScope, year: { id: bigint }, q: ReportQuery) {
    const rows = await this.prisma.studentEnrollment.findMany({
      where: {
        academicYearId: year.id, sectionId: this.scopes.sectionFilter(scope), status: { notIn: ['PENDING_APPROVAL', 'REJECTED'] },
        ...(q.classIds.length ? { classId: { in: q.classIds.map(BigInt) } } : {}), ...(q.sectionId ? { sectionId: BigInt(q.sectionId) } : {}),
        ...(q.gender ? { student: { gender: q.gender } } : {}),
      },
      include: { student: { select: this.studentBase }, section: { select: { id: true, name: true, schoolClass: { select: { id: true, displayName: true, medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } } } } } } },
    });
    const status = q.status ?? 'ACTIVE';
    return rows.filter((e) => status === 'ALL' || statusGroup(e.student.status, e.status) === status);
  }
  private contactAllowed(scope: ResolvedScope, sectionId: bigint) {
    return scope.all || scope.byRole.CLASS_TEACHER.some((s) => s === sectionId);
  }
  private statusFilters(q: ReportQuery) {
    return [...(q.gender ? [{ label: 'Gender', value: GENDER_LABELS[q.gender] }] : []), { label: 'Student status', value: STATUS_FILTER_LABEL[q.status ?? 'ACTIVE'] }];
  }
  private genderSummary(r: Row[]): SummaryItem[] {
    return [
      { label: 'Male students', value: r.filter((x) => x.genderCode === 'MALE').length, type: 'number' },
      { label: 'Female students', value: r.filter((x) => x.genderCode === 'FEMALE').length, type: 'number' },
      { label: 'Other students', value: r.filter((x) => x.genderCode === 'OTHER').length, type: 'number' },
      { label: 'Total students', value: r.length, type: 'number' },
    ];
  }

  // ------------------------------------------------------------------ 4 / 5. gender-wise and class-wise lists
  private async studentList(kind: 'gender' | 'class', _ctx: AccessContext, scope: ResolvedScope, year: { id: bigint }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const list = await this.enrollmentsFor(scope, year, q);
    const section = q.sectionId ? list.find((e) => e.sectionId === BigInt(q.sectionId!))?.section : null;
    const rows: Row[] = list.map((e) => {
      const p = this.parents(e.student);
      const contact = this.contactAllowed(scope, e.sectionId);
      return {
        studentName: e.student.fullName, studentId: e.student.studentCode, admissionNo: grOf(e.student), gender: GENDER_LABELS[e.student.gender as 'MALE'] ?? e.student.gender, genderCode: e.student.gender,
        dob: contact ? iso(e.student.dob) : null, className: e.section.schoolClass.displayName, section: e.section.name,
        order: `${String(e.section.schoolClass.medium.sortOrder).padStart(2, '0')}${String(e.section.schoolClass.standard.levelOrder + 10).padStart(3, '0')}${e.section.name}${String(e.rollNo ?? 999).padStart(4, '0')}`,
        father: p.father, mother: p.mother, parents: p.parents, contact: contact ? p.contact : null, admissionDate: contact ? iso(e.student.admissionDate) : null,
        status: STUDENT_STATUS_LABELS[e.student.status as StudentStatus] ?? e.student.status, rollNo: e.rollNo,
      };
    });
    const filters = [...common, ...(section ? [{ label: 'Section', value: section.name }] : []), ...this.statusFilters(q)];
    const notes = scope.all ? [] : ['Only the divisions you are assigned to are included. Date of birth, contact number and admission date are shown only for divisions where you are the class teacher.'];
    if (kind === 'gender') {
      return {
        title: 'Gender-wise Student List', filters, notes, rows, search: ['studentName', 'admissionNo'], defaultSort: { key: 'gender', dir: 'asc' },
        columns: [
          { key: 'studentName', label: 'Student Name' }, { key: 'studentId', label: 'Student ID' }, { key: 'admissionNo', label: 'Admission No.' }, { key: 'gender', label: 'Gender' },
          { key: 'dob', label: 'Date of Birth', type: 'date' }, { key: 'className', label: 'Class' }, { key: 'section', label: 'Section' },
          { key: 'parents', label: 'Father / Mother Name' }, { key: 'contact', label: 'Contact No.' }, { key: 'admissionDate', label: 'Admission Date', type: 'date' },
          { key: 'status', label: 'Student Status' },
        ],
        summarize: (r) => this.genderSummary(r),
      };
    }
    return {
      title: 'Class-wise Student List', filters, notes, rows, search: ['studentName', 'admissionNo'], defaultSort: { key: 'order', dir: 'asc' }, numbered: true,
      columns: [
        { key: 'srNo', label: 'Sr. No.', type: 'number' }, { key: 'studentId', label: 'Student ID' }, { key: 'admissionNo', label: 'Admission No.' }, { key: 'studentName', label: 'Student Name' },
        { key: 'gender', label: 'Gender' }, { key: 'dob', label: 'Date of Birth', type: 'date' }, { key: 'className', label: 'Class' }, { key: 'section', label: 'Section' },
        { key: 'father', label: 'Father Name' }, { key: 'mother', label: 'Mother Name' }, { key: 'contact', label: 'Contact No.' },
        { key: 'admissionDate', label: 'Admission Date', type: 'date' }, { key: 'status', label: 'Student Status' },
      ],
      summarize: (r) => this.genderSummary(r),
    };
  }


  // ================================================================== office reports: staff, expenses, backdated fees, income & expense
  private async userNames(ids: (bigint | null | undefined)[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids.filter((v): v is bigint => v != null))] } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    return new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
  }
  private periodOf(q: ReportQuery, year: { startDate: Date; endDate: Date }) {
    const from = q.from ?? iso(year.startDate)!;
    const to = q.to ?? iso(year.endDate)!;
    if (from > to) throw invalid('"From date" is after "To date"', [{ path: 'from', code: 'order', message: 'After the To date' }]);
    return { from, to };
  }

  /** Staff list (all / teaching / non-teaching / active / inactive are the same report with preset filters). */
  private async staffList(ctx: AccessContext, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const rows = await this.prisma.staff.findMany({
      where: {
        schoolId: ctx.schoolId, ...(q.employeeType ? { employeeType: q.employeeType } : {}), ...(q.designation ? { designation: q.designation } : {}),
        ...(q.department ? { department: q.department } : {}), ...(q.staffStatus ? { status: q.staffStatus === 'INACTIVE' ? { in: ['INACTIVE', 'RESIGNED'] } : q.staffStatus } : {}),
        ...(q.joinFrom || q.joinTo ? { joiningDate: { ...(q.joinFrom ? { gte: dateOnly(q.joinFrom)! } : {}), ...(q.joinTo ? { lte: dateOnly(q.joinTo)! } : {}) } } : {}),
      },
    });
    const managers = new Map((await this.prisma.staff.findMany({ where: { id: { in: rows.map((r) => r.reportingManagerId).filter((v): v is bigint => v != null) } }, select: { id: true, name: true } })).map((m) => [String(m.id), m.name]));
    return {
      title: 'Staff List Report',
      filters: [...common.filter((f) => f.label !== 'Academic year'), ...this.staffFilters(q)],
      columns: [
        { key: 'code', label: 'Staff ID' }, { key: 'name', label: 'Staff Name' }, { key: 'gender', label: 'Gender' }, { key: 'employeeType', label: 'Employee Type' },
        { key: 'designation', label: 'Designation' }, { key: 'department', label: 'Department' }, { key: 'mobile', label: 'Mobile No.' }, { key: 'qualification', label: 'Qualification' },
        { key: 'joiningDate', label: 'Joining Date', type: 'date' }, { key: 'employmentType', label: 'Employment Type' }, { key: 'manager', label: 'Reporting Manager' }, { key: 'status', label: 'Status' },
      ],
      rows: rows.map((s) => ({
        code: s.employeeCode, name: s.name, gender: s.gender ? GENDER_LABELS[s.gender as 'MALE'] ?? s.gender : null, employeeType: s.employeeType ? EMPLOYEE_TYPE_LABELS[s.employeeType as 'TEACHING'] : null,
        employeeTypeCode: s.employeeType, designation: s.designation, department: s.department, mobile: s.mobile, qualification: s.qualification, joiningDate: iso(s.joiningDate),
        employmentType: s.employmentType ? EMPLOYMENT_TYPE_LABELS[s.employmentType as 'PERMANENT'] ?? s.employmentType : null,
        manager: s.reportingManagerId ? managers.get(String(s.reportingManagerId)) ?? null : null, status: STAFF_STATUS_LABELS[s.status as StaffStatus] ?? s.status, statusCode: s.status,
      })),
      defaultSort: { key: 'name', dir: 'asc' }, search: ['name', 'code', 'mobile'],
      summarize: (r) => [
        { label: 'Total staff', value: r.length, type: 'number' },
        { label: 'Teaching', value: r.filter((x) => x.employeeTypeCode === 'TEACHING').length, type: 'number' },
        { label: 'Non-teaching', value: r.filter((x) => x.employeeTypeCode === 'NON_TEACHING').length, type: 'number' },
        { label: 'Active', value: r.filter((x) => x.statusCode === 'ACTIVE').length, type: 'number' },
        { label: 'Pending assignment', value: r.filter((x) => x.statusCode === 'PENDING_ASSIGNMENT').length, type: 'number' },
        { label: 'Inactive / resigned', value: r.filter((x) => x.statusCode === 'INACTIVE' || x.statusCode === 'RESIGNED').length, type: 'number' },
      ],
    };
  }
  private staffFilters(q: ReportQuery) {
    return [
      ...(q.employeeType ? [{ label: 'Employee type', value: EMPLOYEE_TYPE_LABELS[q.employeeType] }] : []), ...(q.designation ? [{ label: 'Designation', value: q.designation }] : []),
      ...(q.department ? [{ label: 'Department', value: q.department }] : []), ...(q.staffStatus ? [{ label: 'Status', value: q.staffStatus === 'INACTIVE' ? 'Inactive / resigned' : STAFF_STATUS_LABELS[q.staffStatus] }] : []),
      ...(q.joinFrom ? [{ label: 'Joined from', value: dmy(q.joinFrom) }] : []), ...(q.joinTo ? [{ label: 'Joined up to', value: dmy(q.joinTo) }] : []),
    ];
  }

  /** Salary set-up per staff member and what was paid in the period (approved salary vouchers). */
  private async staffSalary(ctx: AccessContext, year: { startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.periodOf(q, year);
    const staff = await this.prisma.staff.findMany({
      where: { schoolId: ctx.schoolId, ...(q.employeeType ? { employeeType: q.employeeType } : {}), ...(q.designation ? { designation: q.designation } : {}), ...(q.department ? { department: q.department } : {}), status: q.staffStatus ? (q.staffStatus === 'INACTIVE' ? { in: ['INACTIVE', 'RESIGNED'] } : q.staffStatus) : 'ACTIVE' },
    });
    const paid = await this.prisma.expense.groupBy({ by: ['staffId'], where: { schoolId: ctx.schoolId, status: 'APPROVED', staffId: { in: staff.map((s) => s.id) }, expenseDate: { gte: dateOnly(from)!, lte: dateOnly(to)! } }, _sum: { amount: true } });
    const paidBy = new Map(paid.map((p) => [String(p.staffId), n(p._sum.amount)]));
    return {
      title: 'Staff Salary Report',
      filters: [...common.filter((f) => f.label !== 'Academic year'), { label: 'Salary paid from', value: dmy(from) }, { label: 'To', value: dmy(to) }, ...this.staffFilters({ ...q, staffStatus: q.staffStatus ?? 'ACTIVE' })],
      columns: [
        { key: 'code', label: 'Staff ID' }, { key: 'name', label: 'Staff Name' }, { key: 'designation', label: 'Designation' }, { key: 'department', label: 'Department' },
        { key: 'monthlySalary', label: 'Monthly Salary', type: 'money' }, { key: 'mode', label: 'Payment Mode' }, { key: 'bank', label: 'Bank' }, { key: 'account', label: 'Account No.' },
        { key: 'ifsc', label: 'IFSC' }, { key: 'paid', label: 'Salary Paid in Period (approved)', type: 'money' },
      ],
      rows: staff.map((s) => ({
        code: s.employeeCode, name: s.name, designation: s.designation, department: s.department, monthlySalary: s.monthlySalary == null ? null : n(s.monthlySalary),
        mode: s.salaryMode ? SALARY_MODE_LABELS[s.salaryMode as 'CASH'] ?? s.salaryMode : null, bank: s.bankName, account: s.bankAccountNo, ifsc: s.bankIfsc, paid: paidBy.get(String(s.id)) ?? 0,
      })),
      defaultSort: { key: 'name', dir: 'asc' }, search: ['name', 'code'], totalKeys: ['monthlySalary', 'paid'],
      summarize: (r) => [
        { label: 'Staff', value: r.length, type: 'number' }, { label: 'Monthly salary bill', value: sum(r, 'monthlySalary'), type: 'money' },
        { label: 'Salary without amount set', value: r.filter((x) => x.monthlySalary == null).length, type: 'number' }, { label: 'Salary paid in period', value: sum(r, 'paid'), type: 'money' },
      ],
    };
  }

  private expenseWhere(ctx: AccessContext, q: ReportQuery, from: string, to: string): Prisma.ExpenseWhereInput {
    return {
      schoolId: ctx.schoolId, expenseDate: { gte: dateOnly(from)!, lte: dateOnly(to)! },
      ...(q.categoryId ? { categoryId: BigInt(q.categoryId) } : {}), ...(q.mode ? { mode: q.mode } : {}), ...(q.voucherStatus ? { status: q.voucherStatus } : {}),
      ...(q.createdBy ? { createdBy: BigInt(q.createdBy) } : {}),
      // Salary vouchers only for users with salary access.
      ...(hasPermission(ctx, P.STAFF_SALARY) ? {} : { category: { isSalary: false } }),
    };
  }
  private async expenseFilters(q: ReportQuery, from: string, to: string) {
    const cat = q.categoryId ? await this.prisma.expenseCategory.findUnique({ where: { id: BigInt(q.categoryId) }, select: { name: true } }) : null;
    const by = q.createdBy ? (await this.userNames([BigInt(q.createdBy)])).get(String(q.createdBy)) : null;
    return [
      { label: 'From', value: dmy(from) }, { label: 'To', value: dmy(to) }, ...(cat ? [{ label: 'Category', value: cat.name }] : []),
      ...(q.mode ? [{ label: 'Payment mode', value: PAYMENT_MODE_LABELS[q.mode as PaymentMode] ?? q.mode }] : []),
      ...(q.voucherStatus ? [{ label: 'Voucher status', value: EXPENSE_STATUS_LABELS[q.voucherStatus] }] : []), ...(by ? [{ label: 'Created by', value: by }] : []),
    ];
  }

  private async dayWiseExpenses(ctx: AccessContext, year: { startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.periodOf(q, year);
    const list = await this.prisma.expense.findMany({ where: this.expenseWhere(ctx, q, from, to), include: { category: { select: { name: true } } } });
    const names = await this.userNames(list.flatMap((e) => [e.createdBy, e.approvedBy]));
    return {
      title: 'Day-wise Expense Report',
      filters: [...common, ...(await this.expenseFilters(q, from, to))],
      columns: [
        { key: 'date', label: 'Expense Date', type: 'date' }, { key: 'voucherNo', label: 'Voucher No.' }, { key: 'category', label: 'Expense Category' }, { key: 'title', label: 'Expense Title' },
        { key: 'paidTo', label: 'Paid To' }, { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'mode', label: 'Payment Mode' },
        { key: 'status', label: 'Voucher Status' }, { key: 'createdBy', label: 'Created By' }, { key: 'approvedBy', label: 'Approved By' },
      ],
      rows: list.map((e) => ({
        date: iso(e.expenseDate), voucherNo: e.voucherNo, category: e.category.name, title: e.title, paidTo: e.paidTo, description: e.description, amount: n(e.amount),
        mode: PAYMENT_MODE_LABELS[e.mode as PaymentMode] ?? e.mode, status: EXPENSE_STATUS_LABELS[e.status as ExpenseStatus], statusCode: e.status,
        createdBy: names.get(String(e.createdBy)) ?? '', approvedBy: e.approvedBy ? names.get(String(e.approvedBy)) ?? '' : null,
      })),
      defaultSort: { key: 'voucherNo', dir: 'asc' }, search: ['voucherNo', 'title', 'paidTo'], totalKeys: ['amount'],
      summarize: (r) => [
        { label: 'Vouchers', value: r.length, type: 'number' },
        ...EXPENSE_STATUSES.map((s) => ({ label: `${EXPENSE_STATUS_LABELS[s]}`, value: sum(r.filter((x) => x.statusCode === s), 'amount'), type: 'money' as const })),
      ],
      notes: ['Only APPROVED vouchers are final expenses. Pending, rejected and cancelled vouchers are shown separately in the summary.'],
    };
  }

  private async categoryWiseExpenses(ctx: AccessContext, year: { startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.periodOf(q, year);
    const where = this.expenseWhere(ctx, { ...q, voucherStatus: undefined }, from, to);
    const groups = await this.prisma.expense.groupBy({ by: ['categoryId', 'status'], where, _sum: { amount: true }, _count: { _all: true } });
    const cats = await this.prisma.expenseCategory.findMany({ where: { schoolId: ctx.schoolId, ...(q.categoryId ? { id: BigInt(q.categoryId) } : {}), ...(hasPermission(ctx, P.STAFF_SALARY) ? {} : { isSalary: false }) }, orderBy: { sortOrder: 'asc' } });
    const rows: Row[] = cats.map((c, i) => {
      const g = groups.filter((x) => x.categoryId === c.id);
      const get = (s: string) => g.find((x) => x.status === s);
      return {
        order: i, category: c.name, transactions: g.filter((x) => x.status === 'APPROVED' || x.status === 'PENDING').reduce((t, x) => t + x._count._all, 0),
        approved: n(get('APPROVED')?._sum.amount), pending: n(get('PENDING')?._sum.amount), rejected: n(get('REJECTED')?._sum.amount), cancelled: n(get('CANCELLED')?._sum.amount),
      };
    }).filter((r) => Number(r.transactions) > 0 || Number(r.rejected) > 0 || Number(r.cancelled) > 0 || q.categoryId);
    return {
      title: 'Category-wise Expense Report',
      filters: [...common, ...(await this.expenseFilters({ ...q, voucherStatus: undefined }, from, to))],
      columns: [
        { key: 'category', label: 'Expense Category' }, { key: 'transactions', label: 'No. of Transactions (approved + pending)', type: 'number' },
        { key: 'approved', label: 'Total Approved Amount', type: 'money' }, { key: 'pending', label: 'Total Pending Amount', type: 'money' },
        { key: 'rejected', label: 'Rejected', type: 'money' }, { key: 'cancelled', label: 'Cancelled / Reversed', type: 'money' },
      ],
      rows, defaultSort: { key: 'order', dir: 'asc' }, totalKeys: ['transactions', 'approved', 'pending', 'rejected', 'cancelled'],
      summarize: (r) => [
        { label: 'Total approved expenses', value: sum(r, 'approved'), type: 'money' }, { label: 'Pending approval', value: sum(r, 'pending'), type: 'money' },
        { label: 'Rejected', value: sum(r, 'rejected'), type: 'money' }, { label: 'Cancelled / reversed', value: sum(r, 'cancelled'), type: 'money' },
      ],
    };
  }

  private async salaryExpenses(ctx: AccessContext, year: { startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.periodOf(q, year);
    const list = await this.prisma.expense.findMany({
      where: { schoolId: ctx.schoolId, staffId: { not: null }, expenseDate: { gte: dateOnly(from)!, lte: dateOnly(to)! }, ...(q.voucherStatus ? { status: q.voucherStatus } : {}), ...(q.mode ? { mode: q.mode } : {}), ...(q.designation ? { staff: { designation: q.designation } } : {}) },
      include: { staff: { select: { employeeCode: true, name: true, designation: true } } },
      orderBy: [{ salaryYear: 'asc' }, { salaryMonth: 'asc' }, { id: 'asc' }],
    });
    // Remaining salary per staff member and month counts pending + approved payments, as on the voucher form.
    const live = new Map<string, number>();
    for (const e of list) if (e.status === 'APPROVED' || e.status === 'PENDING') live.set(`${e.staffId}:${e.salaryYear}:${e.salaryMonth}`, (live.get(`${e.staffId}:${e.salaryYear}:${e.salaryMonth}`) ?? 0) + n(e.amount));
    return {
      title: 'Staff Salary Expense Report',
      filters: [...common, { label: 'Paid from', value: dmy(from) }, { label: 'To', value: dmy(to) }, ...(q.voucherStatus ? [{ label: 'Voucher status', value: EXPENSE_STATUS_LABELS[q.voucherStatus] }] : [])],
      columns: [
        { key: 'code', label: 'Staff ID' }, { key: 'name', label: 'Staff Name' }, { key: 'designation', label: 'Designation' }, { key: 'month', label: 'Salary Month' },
        { key: 'year', label: 'Salary Year', type: 'number' }, { key: 'monthlySalary', label: 'Monthly Salary', type: 'money' }, { key: 'amount', label: 'Amount Paid', type: 'money' },
        { key: 'remaining', label: 'Remaining Salary', type: 'money' }, { key: 'date', label: 'Payment Date', type: 'date' }, { key: 'voucherNo', label: 'Voucher No.' }, { key: 'status', label: 'Payment Status' },
      ],
      rows: list.map((e) => ({
        code: e.staff?.employeeCode ?? '', name: e.staff?.name ?? '', designation: e.staff?.designation ?? null, month: e.salaryMonth ? MONTH_NAMES[e.salaryMonth - 1] : '', monthNo: e.salaryMonth,
        year: e.salaryYear, monthlySalary: n(e.monthlySalary), amount: n(e.amount),
        remaining: round2(Math.max(0, n(e.monthlySalary) - (live.get(`${e.staffId}:${e.salaryYear}:${e.salaryMonth}`) ?? 0))),
        date: iso(e.expenseDate), voucherNo: e.voucherNo, status: EXPENSE_STATUS_LABELS[e.status as ExpenseStatus], statusCode: e.status,
      })),
      defaultSort: { key: 'voucherNo', dir: 'asc' }, search: ['name', 'code', 'voucherNo'], totalKeys: ['amount'],
      summarize: (r) => [
        { label: 'Salary vouchers', value: r.length, type: 'number' }, { label: 'Approved salary paid', value: sum(r.filter((x) => x.statusCode === 'APPROVED'), 'amount'), type: 'money' },
        { label: 'Pending approval', value: sum(r.filter((x) => x.statusCode === 'PENDING'), 'amount'), type: 'money' },
      ],
    };
  }

  /** Every receipt whose payment date is before the day it was entered, with both receipt numbers. */
  private async backdatedFees(ctx: AccessContext, year: { id: bigint; startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.periodOf(q, year);
    const list = await this.prisma.feePayment.findMany({
      where: {
        schoolId: ctx.schoolId, academicYearId: year.id, isBackdated: true, paidOn: { gte: dateOnly(from)!, lte: dateOnly(to)! },
        ...(q.classIds.length ? { enrollment: { classId: { in: q.classIds.map(BigInt) } } } : {}), ...(q.enteredBy ? { createdBy: BigInt(q.enteredBy) } : {}),
      },
      include: { enrollment: { include: { student: { select: { fullName: true, grNo: true, grNoTemp: true, studentCode: true } }, section: { select: { name: true, schoolClass: { select: { displayName: true } } } } } } },
    });
    const names = await this.userNames(list.map((p) => p.createdBy));
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { timezone: true } });
    const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: school.timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', '');
    return {
      title: 'Backdated Fee Collection Report',
      filters: [...common, { label: 'Payment dates from', value: dmy(from) }, { label: 'To', value: dmy(to) }, ...(q.enteredBy ? [{ label: 'Entered by', value: names.get(String(q.enteredBy)) ?? '' }] : [])],
      columns: [
        { key: 'paidOn', label: 'Actual Payment Date', type: 'date' }, { key: 'enteredAt', label: 'System Entry Date' }, { key: 'receiptNo', label: 'System Receipt No.' },
        { key: 'manualNo', label: 'Manual Receipt No.' }, { key: 'studentName', label: 'Student Name' }, { key: 'studentId', label: 'Student ID' }, { key: 'admissionNo', label: 'Admission No.' }, { key: 'className', label: 'Class' },
        { key: 'amount', label: 'Amount Received', type: 'money' }, { key: 'mode', label: 'Payment Mode' }, { key: 'enteredBy', label: 'Entered By' }, { key: 'status', label: 'Status' },
      ],
      rows: list.map((p) => ({
        paidOn: iso(p.paidOn), enteredAt: local(p.createdAt), receiptNo: p.receiptNo, manualNo: p.manualReceiptNo, studentName: p.enrollment.student.fullName, studentId: p.enrollment.student.studentCode, admissionNo: grOf(p.enrollment.student),
        className: `${p.enrollment.section.schoolClass.displayName} ${p.enrollment.section.name}`, amount: n(p.amount), mode: PAYMENT_MODE_LABELS[p.mode as PaymentMode] ?? p.mode,
        enteredBy: names.get(String(p.createdBy)) ?? '', status: p.status === 'VALID' ? 'Valid' : 'Cancelled', statusCode: p.status,
        daysLate: Math.round((dateOnly(local(p.createdAt).slice(0, 10))!.getTime() - p.paidOn.getTime()) / 86_400_000),
      })),
      defaultSort: { key: 'receiptNo', dir: 'asc' }, search: ['studentName', 'admissionNo', 'receiptNo', 'manualNo'], totalKeys: ['amount'],
      summarize: (r) => [
        { label: 'Backdated receipts', value: r.filter((x) => x.statusCode === 'VALID').length, type: 'number' },
        { label: 'Amount (valid receipts)', value: sum(r.filter((x) => x.statusCode === 'VALID'), 'amount'), type: 'money' },
        { label: 'Cancelled backdated receipts', value: r.filter((x) => x.statusCode !== 'VALID').length, type: 'number' },
        { label: 'Most days between payment and entry', value: Math.max(0, ...r.map((x) => Number(x.daysLate) || 0)), type: 'number' },
      ],
    };
  }

  /** Income (fee collection) and APPROVED expenses side by side, kept as separate totals, with a month-wise table. */
  private async incomeExpense(ctx: AccessContext, year: { id: bigint; startDate: Date; endDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const { from, to } = this.periodOf(q, year);
    const range = { gte: dateOnly(from)!, lte: dateOnly(to)! };
    const [fees, cats, approved, reversed, pending] = await Promise.all([
      this.prisma.feePayment.findMany({ where: { schoolId: ctx.schoolId, status: 'VALID', paidOn: range }, select: { paidOn: true, amount: true, previousOutstanding: true, paidBefore: true } }),
      this.prisma.expenseCategory.findMany({ where: { schoolId: ctx.schoolId }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.expense.findMany({ where: { schoolId: ctx.schoolId, status: 'APPROVED', expenseDate: range }, select: { expenseDate: true, amount: true, categoryId: true } }),
      this.prisma.expense.aggregate({ where: { schoolId: ctx.schoolId, status: 'CANCELLED', approvedAt: { not: null }, expenseDate: range }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.expense.aggregate({ where: { schoolId: ctx.schoolId, status: 'PENDING', expenseDate: range }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const prevPart = (p: (typeof fees)[number]) => round2(Math.min(n(p.amount), Math.max(0, n(p.previousOutstanding) - n(p.paidBefore))));
    const feeTotal = round2(fees.reduce((t, p) => t + n(p.amount), 0));
    const feePrev = round2(fees.reduce((t, p) => t + prevPart(p), 0));
    const otherIncome = 0;
    const byCat = new Map<string, number>();
    for (const e of approved) byCat.set(String(e.categoryId), round2((byCat.get(String(e.categoryId)) ?? 0) + n(e.amount)));
    const expenseTotal = round2(approved.reduce((t, e) => t + n(e.amount), 0));
    const rows: Row[] = [
      { order: 1, head: 'INCOME', item: 'Fee collection: previous years\' outstanding', amount: feePrev },
      { order: 2, head: 'INCOME', item: 'Fee collection: current year fees', amount: round2(feeTotal - feePrev) },
      { order: 3, head: 'INCOME', item: 'Total fee collection', amount: feeTotal },
      { order: 4, head: 'INCOME', item: 'Other school income', amount: otherIncome },
      { order: 5, head: 'INCOME', item: 'Total income', amount: round2(feeTotal + otherIncome) },
      ...cats.filter((c) => byCat.has(String(c.id))).map((c, i) => ({ order: 10 + i, head: 'EXPENSES (approved)', item: c.name, amount: byCat.get(String(c.id)) ?? 0 })),
      { order: 90, head: 'EXPENSES (approved)', item: 'Total approved expenses', amount: expenseTotal },
      { order: 99, head: 'SUMMARY', item: 'Net balance (total income − total approved expenses)', amount: round2(feeTotal + otherIncome - expenseTotal) },
    ];
    // Month by month.
    const months = new Map<string, { income: number; expense: number }>();
    const mk = (d: Date) => iso(d)!.slice(0, 7);
    for (const p of fees) { const m = months.get(mk(p.paidOn)) ?? { income: 0, expense: 0 }; m.income = round2(m.income + n(p.amount)); months.set(mk(p.paidOn), m); }
    for (const e of approved) { const m = months.get(mk(e.expenseDate)) ?? { income: 0, expense: 0 }; m.expense = round2(m.expense + n(e.amount)); months.set(mk(e.expenseDate), m); }
    const monthRows = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ month: `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`, income: v.income, expense: v.expense, net: round2(v.income - v.expense) }));
    return {
      title: 'Income & Expense Summary',
      filters: [...common, { label: 'From', value: dmy(from) }, { label: 'To', value: dmy(to) }],
      columns: [{ key: 'head', label: 'Section' }, { key: 'item', label: 'Item' }, { key: 'amount', label: 'Amount', type: 'money' }],
      rows, defaultSort: { key: 'order', dir: 'asc' },
      summarize: () => [
        { label: 'Total income', value: round2(feeTotal + otherIncome), type: 'money' }, { label: 'Total approved expenses', value: expenseTotal, type: 'money' },
        { label: 'Net balance', value: round2(feeTotal + otherIncome - expenseTotal), type: 'money' },
        { label: `Pending vouchers (not counted, ${pending._count._all})`, value: n(pending._sum.amount), type: 'money' },
      ],
      tables: [{
        title: 'Month-wise', columns: [{ key: 'month', label: 'Month' }, { key: 'income', label: 'Fee collection', type: 'money' }, { key: 'expense', label: 'Approved expenses', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }],
        rows: monthRows, totals: { month: 'Total', income: feeTotal, expense: expenseTotal, net: round2(feeTotal - expenseTotal) },
      }],
      notes: [
        'Fee collection = valid fee receipts by payment date. Expenses = APPROVED vouchers by expense date; pending, rejected and cancelled vouchers are not counted.',
        `${reversed._count._all} approved voucher(s) worth Rs ${n(reversed._sum.amount).toLocaleString('en-IN')} were later cancelled (reversed) and are excluded.`,
        'Other school income is not recorded in the system yet.',
      ],
    };
  }

  // ------------------------------------------------------------------ 6. school at a glance
  private async glance(scope: ResolvedScope, year: { id: bigint; startDate: Date }, q: ReportQuery, common: Built['filters']): Promise<Built> {
    const list = await this.enrollmentsFor(scope, year, { ...q, status: q.status ?? 'ALL' });
    // New admission = this is the student's first year in the school.
    const earlier = new Set((await this.prisma.studentEnrollment.findMany({
      where: { studentId: { in: list.map((e) => e.studentId) }, academicYear: { startDate: { lt: year.startDate } } }, select: { studentId: true }, distinct: ['studentId'],
    })).map((e) => String(e.studentId)));
    type Agg = { name: string; order: number; male: number; female: number; other: number; total: number; active: number; inactive: number; newAdm: number; transferred: number };
    const blank = (name: string, order: number): Agg => ({ name, order, male: 0, female: 0, other: 0, total: 0, active: 0, inactive: 0, newAdm: 0, transferred: 0 });
    const add = (a: Agg, e: (typeof list)[number]) => {
      a.total++;
      if (e.student.gender === 'MALE') a.male++; else if (e.student.gender === 'FEMALE') a.female++; else a.other++;
      const g = statusGroup(e.student.status, e.status);
      if (g === 'ACTIVE') a.active++; else if (g === 'TRANSFERRED') a.transferred++; else a.inactive++;
      if (!earlier.has(String(e.studentId))) a.newAdm++;
    };
    const all = blank('Grand total', 0);
    const byClass = new Map<string, Agg>();
    const bySection = new Map<string, Agg>();
    for (const e of list) {
      const c = e.section.schoolClass;
      const order = c.medium.sortOrder * 1000 + c.standard.levelOrder;
      const ca = byClass.get(String(c.id)) ?? blank(c.displayName, order);
      const sa = bySection.get(String(e.sectionId)) ?? blank(`${c.displayName} ${e.section.name}`, order * 100 + e.section.name.charCodeAt(0));
      add(all, e); add(ca, e); add(sa, e);
      byClass.set(String(c.id), ca); bySection.set(String(e.sectionId), sa);
    }
    const toRow = (a: Agg): Row => ({ className: a.name, order: a.order, male: a.male, female: a.female, other: a.other, total: a.total, active: a.active, inactive: a.inactive, newAdm: a.newAdm, transferred: a.transferred });
    const pct = (x: number) => (all.total ? round2((x / all.total) * 100) : 0);
    return {
      title: 'School at a Glance – Student Overview',
      filters: [...common, ...(q.sectionId ? [{ label: 'Section', value: list.find((e) => e.sectionId === BigInt(q.sectionId!))?.section.name ?? '' }] : []),
        ...(q.gender ? [{ label: 'Gender', value: GENDER_LABELS[q.gender] }] : []), { label: 'Student status', value: STATUS_FILTER_LABEL[q.status ?? 'ALL'] }],
      columns: [
        { key: 'className', label: 'Class' }, { key: 'male', label: 'Male', type: 'number' }, { key: 'female', label: 'Female', type: 'number' },
        { key: 'other', label: 'Other', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'active', label: 'Active', type: 'number' },
        { key: 'inactive', label: 'Inactive', type: 'number' }, { key: 'newAdm', label: 'New Admissions', type: 'number' }, { key: 'transferred', label: 'Transferred Out', type: 'number' },
      ],
      rows: [...byClass.values()].map(toRow), defaultSort: { key: 'order', dir: 'asc' },
      totalKeys: ['male', 'female', 'other', 'total', 'active', 'inactive', 'newAdm', 'transferred'],
      summarize: () => [
        { label: 'Total enrolled students', value: all.total, type: 'number' }, { label: 'Male students', value: all.male, type: 'number' },
        { label: 'Female students', value: all.female, type: 'number' }, { label: 'Other students', value: all.other, type: 'number' },
        { label: 'Active students', value: all.active, type: 'number' }, { label: 'Inactive students', value: all.inactive, type: 'number' },
        { label: 'New admissions', value: all.newAdm, type: 'number' }, { label: 'Transferred students', value: all.transferred, type: 'number' },
      ],
      tables: [
        {
          title: 'Gender-wise distribution',
          columns: [{ key: 'gender', label: 'Gender' }, { key: 'count', label: 'Students', type: 'number' }, { key: 'share', label: 'Share', type: 'percent' }],
          rows: [{ gender: 'Male', count: all.male, share: pct(all.male) }, { gender: 'Female', count: all.female, share: pct(all.female) }, { gender: 'Other', count: all.other, share: pct(all.other) }],
          totals: { gender: 'Total', count: all.total, share: all.total ? 100 : 0 },
        },
        {
          title: 'Active vs inactive',
          columns: [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Students', type: 'number' }, { key: 'share', label: 'Share', type: 'percent' }],
          rows: [{ status: 'Active', count: all.active, share: pct(all.active) }, { status: 'Inactive (left, passed out)', count: all.inactive, share: pct(all.inactive) }, { status: 'Transferred out', count: all.transferred, share: pct(all.transferred) }],
          totals: { status: 'Total', count: all.total, share: all.total ? 100 : 0 },
        },
        {
          title: 'Section-wise strength',
          columns: [{ key: 'className', label: 'Class & section' }, { key: 'male', label: 'Male', type: 'number' }, { key: 'female', label: 'Female', type: 'number' }, { key: 'other', label: 'Other', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'newAdm', label: 'New Admissions', type: 'number' }],
          rows: [...bySection.values()].sort((a, b) => a.order - b.order).map(toRow),
          totals: { className: 'Grand total', male: all.male, female: all.female, other: all.other, total: all.total, newAdm: all.newAdm },
        },
      ],
      notes: [
        'New admission = the student\'s first academic year in the school. Inactive = left the school or passed out.',
        ...(scope.all ? [] : ['Only the divisions you are assigned to are included.']),
      ],
    };
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** People for the "entered by" / "created by" filters. */
  @Get('options/people')
  people(@Ctx() ctx: AccessContext) { return this.reports.people(ctx); }

  /** Every report on screen: searched, sorted and paged (or ?all=true for printing). */
  @Get(':key')
  report(@Ctx() ctx: AccessContext, @Param('key') key: string, @Query(zBody(reportQuery)) q: ReportQuery) {
    return this.reports.data(ctx, key, q);
  }

  /** The complete report as Excel or PDF, with the applied filters, summary and totals. */
  @Get(':key/export')
  export(@Ctx() ctx: AccessContext, @Param('key') key: string, @Query(zBody(reportQuery)) q: ReportQuery, @Res() res: Response) {
    return this.reports.export(ctx, key, q, res);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
