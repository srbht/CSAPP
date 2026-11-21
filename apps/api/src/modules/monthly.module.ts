import { Body, Controller, Get, HttpCode, Injectable, Module, Post, Put, Query } from '@nestjs/common';
import { MONTHLY_SKILLS, monthlyKeySchema, type MonthlySaveInput, monthlySaveSchema, PERMISSIONS } from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { forbidden, invalid, notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';

const P = PERMISSIONS;
type Key = z.infer<typeof monthlyKeySchema>;
const listQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), sectionId: z.coerce.number().int().positive().optional() });
const returnSchema = monthlyKeySchema.extend({ reason: z.string().trim().min(3, 'Write a short note for the teacher').max(500) });
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/**
 * Monthly performance. Every month each subject teacher scores the students of their divisions on 9 skills (0–5)
 * for their subject and submits; the class teacher and the Headmaster see the sheets; only the Headmaster can send one back.
 */
@Injectable()
export class MonthlyService {
  constructor(private readonly prisma: PrismaService, private readonly scopes: ScopeService, private readonly audit: AuditService) {}

  private async year(ctx: AccessContext) {
    const y = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    if (!y) throw notFound('Current academic year');
    return y;
  }

  /** The months of the current academic year, and the month to open by default (this month, within the year). */
  async months(ctx: AccessContext) {
    const y = await this.year(ctx);
    const months: { value: string; label: string }[] = [];
    const d = new Date(Date.UTC(y.startDate.getUTCFullYear(), y.startDate.getUTCMonth(), 1));
    while (d <= y.endDate && months.length < 24) {
      const v = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      months.push({ value: v, label: monthLabel(v) });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return { year: y.name, months, current: months.some((m) => m.value === cur) ? cur : months[0]?.value ?? null };
  }

  private async access(ctx: AccessContext, k: Key) {
    const section = await this.prisma.section.findFirst({
      where: { id: BigInt(k.sectionId), schoolClass: { academicYear: { schoolId: ctx.schoolId } } },
      include: { schoolClass: { include: { medium: true, academicYear: true } } },
    });
    if (!section) throw notFound('Division');
    const cs = await this.prisma.classSubject.findFirst({ where: { id: BigInt(k.classSubjectId), classId: section.classId }, include: { subject: { select: { nameEn: true, subjectType: true } } } });
    if (!cs) throw notFound('Subject');
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    const teacher = scope.subjectPairs.some((p) => p.sectionId === section.id && p.classSubjectId === cs.id);
    const classTeacher = scope.byRole.CLASS_TEACHER.some((x) => x === section.id);
    const head = scope.all && hasPermission(ctx, P.MARKS_APPROVE);
    if (!teacher && !classTeacher && !scope.all) throw notFound('Division');
    return { section, cs, teacher, classTeacher, head };
  }

  private async names(ids: (bigint | null | undefined)[]) {
    const list = ids.filter((x): x is bigint => x != null);
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, username: true, staff: { select: { name: true } } } }) : [];
    return new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
  }

  /** Every sheet the user can see for a month: their own subjects (teacher), their class (class teacher), all (Headmaster). */
  async list(ctx: AccessContext, q: z.infer<typeof listQuery>) {
    const y = await this.year(ctx);
    const month = q.month ?? (await this.months(ctx)).current;
    const scope = await this.scopes.resolve(ctx, y.id);
    const ctSections = new Set(scope.byRole.CLASS_TEACHER.map(String));
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: y.id, status: 'ACTIVE' }, ...(q.sectionId ? { id: BigInt(q.sectionId) } : {}), ...(scope.all ? {} : { id: { in: scope.sectionIds } }) },
      include: { schoolClass: { select: { displayName: true, id: true, standard: { select: { levelOrder: true } } } } },
    });
    const subjects = await this.prisma.classSubject.findMany({
      where: { classId: { in: sections.map((s) => s.classId) }, status: 'ACTIVE', subject: { subjectType: { not: 'ACTIVITY' } } },
      include: { subject: { select: { nameEn: true } } }, orderBy: { displayOrder: 'asc' },
    });
    const teachers = await this.prisma.teachingAssignment.findMany({ where: { sectionId: { in: sections.map((s) => s.id) }, role: 'SUBJECT_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } });
    const tBy = new Map(teachers.map((t) => [`${t.sectionId}:${t.classSubjectId}`, t.staff.name]));
    const sheets = month ? await this.prisma.monthlyPerformance.findMany({ where: { month, sectionId: { in: sections.map((s) => s.id) } } }) : [];
    const sBy = new Map(sheets.map((s) => [`${s.sectionId}:${s.classSubjectId}`, s]));
    const items = sections.flatMap((sec) => subjects.filter((cs) => cs.classId === sec.classId).flatMap((cs) => {
      const mine = scope.subjectPairs.some((p) => p.sectionId === sec.id && p.classSubjectId === cs.id);
      if (!scope.all && !mine && !ctSections.has(String(sec.id))) return [];
      const sh = sBy.get(`${sec.id}:${cs.id}`);
      return [{
        sectionId: sec.id, division: `${sec.schoolClass.displayName} ${sec.name}`, level: sec.schoolClass.standard.levelOrder, classSubjectId: cs.id, subject: cs.subject.nameEn,
        teacher: tBy.get(`${sec.id}:${cs.id}`) ?? null, status: sh?.status ?? 'NOT_STARTED', submittedAt: sh?.submittedAt ?? null, mine,
      }];
    }));
    items.sort((a, b) => Number(b.mine) - Number(a.mine) || a.level - b.level || a.division.localeCompare(b.division) || a.subject.localeCompare(b.subject));
    return { month, monthLabel: month ? monthLabel(month) : null, items: items.map(({ level: _l, ...i }) => i) };
  }

  async sheet(ctx: AccessContext, k: Key) {
    const { section, cs, teacher, head } = await this.access(ctx, k);
    const sh = await this.prisma.monthlyPerformance.findUnique({ where: { sectionId_classSubjectId_month: { sectionId: section.id, classSubjectId: cs.id, month: k.month } } });
    const students = await this.prisma.studentEnrollment.findMany({
      where: { sectionId: section.id, status: 'ACTIVE' },
      include: { student: { select: { fullName: true } } },
      orderBy: [{ rollNo: { sort: 'asc', nulls: 'last' } }, { student: { fullName: 'asc' } }],
    });
    const scores = (sh?.scores ?? {}) as Record<string, Record<string, number | 'AB' | null>>;
    const [ta, ct, school] = await Promise.all([
      this.prisma.teachingAssignment.findFirst({ where: { sectionId: section.id, classSubjectId: cs.id, role: 'SUBJECT_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } }),
      this.prisma.teachingAssignment.findFirst({ where: { sectionId: section.id, role: 'CLASS_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { name: true, addressLine: true, city: true } }),
    ]);
    const names = await this.names([sh?.submittedBy, sh?.returnedBy]);
    const status = sh?.status ?? 'NOT_STARTED';
    const open = status !== 'SUBMITTED' && section.schoolClass.academicYear.status !== 'CLOSED';
    return {
      school: { name: school.name, address: [school.addressLine, school.city].filter(Boolean).join(', ') },
      year: section.schoolClass.academicYear.name,
      month: k.month, monthLabel: monthLabel(k.month),
      division: { id: section.id, label: `${section.schoolClass.displayName}-${section.name}` },
      subject: { classSubjectId: cs.id, name: cs.subject.nameEn },
      teacher: ta?.staff.name ?? null, classTeacher: ct?.staff.name ?? null,
      skills: MONTHLY_SKILLS,
      status,
      submittedBy: sh?.submittedBy ? names.get(String(sh.submittedBy)) ?? null : null, submittedAt: sh?.submittedAt ?? null,
      returnNote: sh?.returnNote ?? null, returnedBy: sh?.returnedBy ? names.get(String(sh.returnedBy)) ?? null : null, returnedAt: sh?.returnedAt ?? null,
      students: students.map((e, i) => ({ enrollmentId: e.id, serialNo: i + 1, rollNo: e.rollNo, examNo: e.examNo, fullName: e.student.fullName, scores: scores[String(e.id)] ?? {} })),
      can: { edit: teacher && open, submit: teacher && open, sendBack: head && status === 'SUBMITTED' },
    };
  }

  async save(ctx: AccessContext, input: MonthlySaveInput) {
    const { section, cs, teacher } = await this.access(ctx, input);
    if (!teacher) throw forbidden('Only the subject teacher of this class fills this sheet');
    if (section.schoolClass.academicYear.status === 'CLOSED') throw invalidState('The academic year is closed');
    const allowed = new Set<string>(MONTHLY_SKILLS.map((s) => s.key));
    const enrolled = new Set((await this.prisma.studentEnrollment.findMany({ where: { sectionId: section.id }, select: { id: true } })).map((e) => String(e.id)));
    for (const r of input.rows) {
      if (!enrolled.has(String(r.enrollmentId))) throw invalid('A student is not in this division');
      const bad = Object.keys(r.scores).find((k) => !allowed.has(k));
      if (bad) throw invalid(`Unknown column ${bad}`);
    }
    await this.prisma.$transaction(async (tx) => {
      const where = { sectionId_classSubjectId_month: { sectionId: section.id, classSubjectId: cs.id, month: input.month } };
      const sh = await tx.monthlyPerformance.findUnique({ where });
      if (sh?.status === 'SUBMITTED') throw invalidState('This sheet is submitted. Ask the Headmaster to send it back to change it.');
      const scores = { ...((sh?.scores ?? {}) as Record<string, Record<string, unknown>>) };
      for (const r of input.rows) scores[String(r.enrollmentId)] = { ...(scores[String(r.enrollmentId)] ?? {}), ...r.scores };
      if (sh) await tx.monthlyPerformance.update({ where: { id: sh.id }, data: { scores: scores as object, updatedBy: ctx.userId } });
      else await tx.monthlyPerformance.create({ data: { academicYearId: section.schoolClass.academicYearId, sectionId: section.id, classSubjectId: cs.id, month: input.month, scores: scores as object, createdBy: ctx.userId, updatedBy: ctx.userId } });
    });
    return this.sheet(ctx, input);
  }

  async submit(ctx: AccessContext, k: Key) {
    const { section, cs, teacher } = await this.access(ctx, k);
    if (!teacher) throw forbidden('Only the subject teacher of this class submits this sheet');
    const sh = await this.prisma.monthlyPerformance.findUnique({ where: { sectionId_classSubjectId_month: { sectionId: section.id, classSubjectId: cs.id, month: k.month } } });
    if (!sh) throw invalidState('Enter the scores and press Save first');
    if (sh.status === 'SUBMITTED') throw invalidState('This sheet is already submitted');
    const scores = (sh.scores ?? {}) as Record<string, Record<string, unknown>>;
    const students = await this.prisma.studentEnrollment.findMany({ where: { sectionId: section.id, status: 'ACTIVE' }, select: { id: true, rollNo: true } });
    const missing = students.filter((e) => MONTHLY_SKILLS.some((s) => scores[String(e.id)]?.[s.key] == null));
    if (missing.length) {
      throw invalid(`Not complete yet: ${missing.length} student${missing.length > 1 ? 's have' : ' has'} empty boxes (roll ${missing.map((m) => m.rollNo ?? '?').slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}). Type 0–5, or AB if absent.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.monthlyPerformance.update({ where: { id: sh.id }, data: { status: 'SUBMITTED', submittedBy: ctx.userId, submittedAt: new Date(), updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'SUBMIT', entityType: 'MonthlyPerformance', entityId: sh.id, after: { month: k.month, students: students.length } }, tx);
    });
    return this.sheet(ctx, k);
  }

  async sendBack(ctx: AccessContext, input: z.infer<typeof returnSchema>) {
    const { section, cs, head } = await this.access(ctx, input);
    if (!head) throw forbidden('Only the Headmaster can send a sheet back');
    const sh = await this.prisma.monthlyPerformance.findUnique({ where: { sectionId_classSubjectId_month: { sectionId: section.id, classSubjectId: cs.id, month: input.month } } });
    if (!sh || sh.status !== 'SUBMITTED') throw invalidState('Only a submitted sheet can be sent back');
    await this.prisma.$transaction(async (tx) => {
      await tx.monthlyPerformance.update({ where: { id: sh.id }, data: { status: 'RETURNED', returnNote: input.reason, returnedBy: ctx.userId, returnedAt: new Date(), updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'SEND_BACK', entityType: 'MonthlyPerformance', entityId: sh.id, reason: input.reason }, tx);
    });
    return this.sheet(ctx, input);
  }
}

@Controller()
export class MonthlyController {
  constructor(private readonly svc: MonthlyService) {}

  @Get('monthly-performance/months') @RequirePermission(P.MARKS_READ)
  months(@Ctx() ctx: AccessContext) { return this.svc.months(ctx); }

  @Get('monthly-performance') @RequirePermission(P.MARKS_READ)
  list(@Ctx() ctx: AccessContext, @Query(zBody(listQuery)) q: z.infer<typeof listQuery>) { return this.svc.list(ctx, q); }

  @Get('monthly-performance/sheet') @RequirePermission(P.MARKS_READ)
  sheet(@Ctx() ctx: AccessContext, @Query(zBody(monthlyKeySchema)) q: Key) { return this.svc.sheet(ctx, q); }

  @Put('monthly-performance/sheet') @RequirePermission(P.MARKS_READ)
  save(@Ctx() ctx: AccessContext, @Body(zBody(monthlySaveSchema)) b: MonthlySaveInput) { return this.svc.save(ctx, b); }

  @Post('monthly-performance/sheet/submit') @HttpCode(200) @RequirePermission(P.MARKS_READ)
  submit(@Ctx() ctx: AccessContext, @Body(zBody(monthlyKeySchema)) b: Key) { return this.svc.submit(ctx, b); }

  @Post('monthly-performance/sheet/send-back') @HttpCode(200) @RequirePermission(P.MARKS_READ)
  sendBack(@Ctx() ctx: AccessContext, @Body(zBody(returnSchema)) b: z.infer<typeof returnSchema>) { return this.svc.sendBack(ctx, b); }
}

@Module({ controllers: [MonthlyController], providers: [MonthlyService] })
export class MonthlyModule {}
