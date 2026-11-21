import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Put, Query } from '@nestjs/common';
import {
  ERROR_CODES, gradeFor, GREENSHEET_RESULT_LABELS, type GreensheetDecisionInput, greensheetDecisionSchema, type GreensheetResult,
  type MarkPattern, partStage, PERMISSIONS, roundHalfUp, grNoLabel } from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { AppError, forbidden, invalid, notFound } from '../common/errors';
import { ResolvedScope, ScopeService } from '../common/scope';
import { IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { patternOf } from './exams.module';
import { ReportCardsModule, ReportCardsService } from './reportcards.module';

const P = PERMISSIONS;
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;
const LEFT = ['TRANSFERRED_OUT', 'WITHDRAWN'];
const NOT_ADMITTED = ['PENDING_APPROVAL', 'REJECTED'];
const listQuery = z.object({ academicYearId: z.coerce.number().int().positive().optional() });

type SemCell = {
  parts: Record<string, number | null>; fe: number | null; se: number | null; total: number | null; max: number; grade: string | null; absent: boolean; entered: boolean;
};

/**
 * Greensheet (the school's yearly result register for one division), built from the marks entered part by part:
 *  - Year Work: Formative Evaluation I and II, part by part (OBS, Oral, … Total A / B)
 *  - Result: FE-I (A) + SE-I (B) = grand total + grade, FE-II (C) + SE-II (D), average and grade, percentage,
 *    result (decided by the Headmaster) and attendance
 *  - Two cover sheets with Boys / Girls / Total: students, left, absent, appeared (and passed, re-exam, passing %).
 * The Headmaster decides each result (PASS / PROMOTED / Re-Exam / Detained, with grace marks) and approves the sheet,
 * which then locks. Approval needs every subject's marks of both semesters and every month's attendance approved.
 */
@Injectable()
export class GreensheetService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scopes: ScopeService, private readonly cards: ReportCardsService) {}

  private async section(ctx: AccessContext, sectionId: bigint) {
    const s = await this.prisma.section.findFirst({
      where: { id: sectionId, schoolClass: { academicYear: { schoolId: ctx.schoolId } } },
      include: { schoolClass: { include: { medium: true, standard: true, academicYear: true, gradingSystem: { include: { bands: true } } } }, greensheet: true },
    });
    if (!s) throw notFound('Division');
    return s;
  }

  private access(ctx: AccessContext, scope: ResolvedScope, sectionId: bigint) {
    const has = (r: keyof ResolvedScope['byRole']) => scope.byRole[r].some((x) => x === sectionId);
    return {
      view: hasPermission(ctx, P.MARKS_READ) && (scope.all || has('OPERATOR') || has('CLASS_TEACHER')),
      decide: hasPermission(ctx, P.MARKS_APPROVE) && scope.all,
    };
  }

  /** "English-1-A", as printed on the school's Greensheet. */
  private classLabel(s: Awaited<ReturnType<GreensheetService['section']>>) {
    const medium = s.schoolClass.medium.nameEn.replace(/\s*medium\s*$/i, '');
    const std = s.schoolClass.standard.levelOrder >= 1 ? String(s.schoolClass.standard.levelOrder) : s.schoolClass.standard.nameEn;
    return `${medium}-${std}-${s.name}`;
  }

  /** Divisions this user can open, with each Greensheet's state. */
  async divisions(ctx: AccessContext, academicYearId?: number) {
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, ...(academicYearId ? { id: BigInt(academicYearId) } : { isCurrent: true }) } });
    if (!year) throw notFound('Academic year');
    const scope = await this.scopes.resolve(ctx, year.id);
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE' }, ...(scope.all ? {} : { id: { in: [...scope.byRole.OPERATOR, ...scope.byRole.CLASS_TEACHER] } }) },
      include: { schoolClass: { include: { medium: true, standard: true } }, greensheet: true, _count: { select: { enrollments: { where: { status: { notIn: NOT_ADMITTED } } } } } },
    });
    return {
      year: { id: year.id, name: year.name },
      divisions: sections
        .filter((s) => this.access(ctx, scope, s.id).view)
        .sort((a, b) => a.schoolClass.medium.sortOrder - b.schoolClass.medium.sortOrder || a.schoolClass.standard.levelOrder - b.schoolClass.standard.levelOrder || a.name.localeCompare(b.name))
        .map((s) => ({
          sectionId: s.id, name: s.name, className: s.schoolClass.displayName, medium: s.schoolClass.medium.nameEn, students: s._count.enrollments,
          status: s.greensheet?.status ?? 'DRAFT', approvedAt: s.greensheet?.approvedAt ?? null,
        })),
    };
  }

  // ------------------------------------------------------------------ the sheet

  /** `internal`: used by promotion (results and percentages), where the caller has already checked access. */
  async sheet(ctx: AccessContext, sectionId: bigint, internal = false) {
    const section = await this.section(ctx, sectionId);
    const cls = section.schoolClass;
    const year = cls.academicYear;
    const scope = await this.scopes.resolve(ctx, year.id);
    const a = this.access(ctx, scope, sectionId);
    if (!a.view && !internal) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'This division is not in your classes');

    const exams = await this.prisma.exam.findMany({ where: { academicYearId: year.id, kind: 'SEMESTER', status: 'ACTIVE', reportTerm: { in: ['TERM1', 'TERM2'] } }, orderBy: { sequence: 'asc' } });
    const sems = [exams.find((e) => e.reportTerm === 'TERM1') ?? null, exams.find((e) => e.reportTerm === 'TERM2') ?? null];
    const classSubjects = await this.prisma.classSubject.findMany({ where: { classId: cls.id, status: 'ACTIVE' }, include: { subject: true }, orderBy: { displayOrder: 'asc' } });
    const es = await this.prisma.examSubject.findMany({ where: { examId: { in: exams.map((e) => e.id) }, classSubjectId: { in: classSubjects.map((c) => c.id) } } });
    const esBy = new Map(es.map((e) => [`${e.examId}:${e.classSubjectId}`, e]));
    const pattern = (si: number, csId: bigint): MarkPattern | null => {
      const e = sems[si] && esBy.get(`${sems[si]!.id}:${csId}`);
      return e ? patternOf(e) : null;
    };
    const subjects = classSubjects
      .filter((cs) => sems.some((e, si) => e && pattern(si, cs.id)))
      .sort((x, y) => Number(y.includeInTotal) - Number(x.includeInTotal) || x.displayOrder - y.displayOrder)
      .map((cs) => ({
        classSubjectId: cs.id, name: cs.subject.nameEn.toUpperCase(), short: cs.subject.shortName ?? (/^[A-Z.& ]+$/.test(cs.subject.nameEn) || cs.subject.nameEn.length <= 5 ? cs.subject.nameEn : cs.subject.nameEn.slice(0, 3)), type: cs.subject.subjectType, includeInTotal: cs.includeInTotal,
        patterns: [pattern(0, cs.id), pattern(1, cs.id)],
      }));

    // Columns: every part used in this class, in the Greensheet's order; and the "Max." rows (subjects that share a pattern).
    const used = new Set(subjects.flatMap((s) => s.patterns.flatMap((p) => p?.map((x) => x.key) ?? [])));
    const allKeys = ['OBS', 'ORAL', 'ACTIVITY', 'PROJECT', 'OBT', 'HOMEWORK', 'CLASSWORK', 'PRACTICAL', 'MCQ', 'FE_TOTAL', 'WRITTEN', 'SE_ORAL', 'SE_PRACT', 'SE_TOTAL'];
    const columns = { fe: allKeys.filter((k) => used.has(k as never) && partStage(k) === 'FE'), se: allKeys.filter((k) => used.has(k as never) && partStage(k) === 'SE') };
    const groupsMap = new Map<string, { patterns: (MarkPattern | null)[]; subjects: typeof subjects }>();
    for (const s of subjects) {
      const sig = JSON.stringify(s.patterns);
      if (!groupsMap.has(sig)) groupsMap.set(sig, { patterns: s.patterns, subjects: [] });
      groupsMap.get(sig)!.subjects.push(s);
    }
    const groupList = [...groupsMap.values()];
    const maxRows = groupList.map((g) => ({
      label: groupList.length <= 2
        ? (g.subjects.every((s) => s.type === 'ACTIVITY') ? 'Opt.Sub.' : 'Com.Sub.')
        : g.subjects.map((s) => s.short).join('/'),
      patterns: g.patterns,
      subjectIds: g.subjects.map((s) => s.classSubjectId),
    }));

    // Grading
    const fallback = await this.prisma.gradeBand.findMany({ where: { gradingSystem: { schoolId: ctx.schoolId, status: 'ACTIVE' } }, orderBy: { sortOrder: 'asc' } });
    const bands = (cls.gradingSystem?.bands?.length ? cls.gradingSystem.bands : fallback).map((b) => ({ grade: b.grade, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent), isPass: b.isPass }));
    const grade = (pct: number | null) => (pct == null ? null : gradeFor(pct, bands)?.grade ?? null);
    const passes = (pct: number) => gradeFor(pct, bands)?.isPass ?? pct >= 33;

    // Students, marks, attendance, decisions
    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { sectionId, status: { notIn: NOT_ADMITTED } },
      include: { student: { select: { id: true, fullName: true, grNo: true, grNoTemp: true, gender: true } }, greensheetResult: true },
      orderBy: [{ rollNo: 'asc' }, { student: { fullName: 'asc' } }],
    });
    const marks = await this.prisma.mark.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) }, examId: { in: exams.map((e) => e.id) } } });
    const mBy = new Map(marks.map((m) => [`${m.enrollmentId}:${m.examId}:${m.classSubjectId}`, m]));
    const att = await this.prisma.attendanceMonthly.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) } }, include: { submission: { select: { workingDays: true } } } });

    const students = enrollments.map((e) => {
      const decision = e.greensheetResult;
      const grace = (decision?.grace ?? {}) as Record<string, number>;
      const rows = subjects.map((s) => {
        const sem: (SemCell | null)[] = sems.map((ex, si) => {
          const p = s.patterns[si];
          if (!ex || !p) return null;
          const x = esBy.get(`${ex.id}:${s.classSubjectId}`)!;
          const max = Number(x.max1) + (num(x.max2) ?? 0);
          const m = mBy.get(`${e.id}:${ex.id}:${s.classSubjectId}`);
          const parts = (m?.parts ?? {}) as Record<string, number | null>;
          if (!m) return { parts: {}, fe: null, se: null, total: null, max, grade: null, absent: false, entered: false };
          if (m.absent) return { parts: {}, fe: null, se: null, total: 0, max, grade: grade(0), absent: true, entered: true };
          const fe = num(m.marks1);
          const seT = num(m.marks2);
          const total = fe == null && seT == null ? null : (fe ?? 0) + (seT ?? 0);
          return { parts, fe, se: seT, total, max, grade: total == null ? null : grade((total / max) * 100), absent: false, entered: true };
        });
        const pcts = sem.filter((c): c is SemCell => !!c).map((c) => (c.total == null ? null : (c.total / c.max) * 100));
        const avg = pcts.length === 2 && pcts.every((x) => x != null) ? roundHalfUp(((pcts[0] as number) + (pcts[1] as number)) / 2) : null;
        const g = grace[String(s.classSubjectId)] ?? 0;
        return { classSubjectId: s.classSubjectId, sem, average: avg, averageGrade: grade(avg), grace: g, passed: avg == null ? null : passes(Math.min(100, avg + g)) };
      });
      const inTotal = rows.filter((r, i) => subjects[i].includeInTotal);
      const semTotals = sems.map((_, si) => {
        const cells = inTotal.map((r) => r.sem[si]).filter((c): c is SemCell => !!c);
        if (!cells.some((c) => c.entered)) return null;
        const seParts: Record<string, number> = {};
        for (const c of cells) for (const [k, v] of Object.entries(c.parts)) if (typeof v === 'number' && partStage(k) === 'SE') seParts[k] = (seParts[k] ?? 0) + v;
        const total = cells.reduce((t, c) => t + (c.total ?? 0), 0);
        const max = cells.reduce((t, c) => t + c.max, 0);
        return { fe: cells.reduce((t, c) => t + (c.fe ?? 0), 0), seParts, se: cells.reduce((t, c) => t + (c.se ?? 0), 0), total, max, grade: max ? grade((total / max) * 100) : null };
      });
      const averageTotal = inTotal.every((r) => r.average != null) && inTotal.length ? inTotal.reduce((t, r) => t + (r.average ?? 0), 0) : null;
      const graceTotal = inTotal.reduce((t, r) => t + r.grace, 0);
      const percentage = averageTotal == null ? null : round2((averageTotal / (inTotal.length * 100)) * 100);
      const lastSem = sems[1] && rows.some((r) => r.sem[1]?.entered) ? 1 : 0;
      const lastCells = rows.map((r) => r.sem[lastSem]).filter((c): c is SemCell => !!c && c.entered);
      const absentAll = lastCells.length > 0 && lastCells.every((c) => c.absent);
      const left = LEFT.includes(e.status);
      const suggested: GreensheetResult | null = averageTotal == null || absentAll || left ? null : inTotal.every((r) => r.passed) ? 'PASS' : 'RE_EXAM';
      const a2 = att.filter((x) => x.enrollmentId === e.id);
      const attendance = a2.length ? { present: a2.reduce((t, x) => t + (num(x.presentDays) ?? 0), 0), working: a2.reduce((t, x) => t + (num(x.submission.workingDays) ?? 0), 0) } : null;
      return {
        enrollmentId: e.id, examNo: e.examNo, rollNo: e.rollNo, grNo: grNoLabel(e.student), name: e.student.fullName, gender: e.student.gender, status: e.status, left, absentAll,
        rows, semTotals, averageTotal, graceTotal, averageGrade: percentage == null ? null : grade(percentage), percentage, attendance,
        suggested, decision: decision ? { result: decision.result as GreensheetResult | null, grace, remark: decision.remark } : null,
        result: (decision?.result as GreensheetResult | null) ?? suggested,
      };
    });

    // Cover sheets (Boys / Girls / Total)
    const count = (f: (s: (typeof students)[number]) => boolean) => {
      const list = students.filter(f);
      return { boys: list.filter((s) => s.gender === 'MALE').length, girls: list.filter((s) => s.gender === 'FEMALE').length, total: list.length };
    };
    const appeared = (s: (typeof students)[number]) => !s.left && !s.absentAll;
    const passed = count((s) => appeared(s) && (s.result === 'PASS' || s.result === 'PROMOTED'));
    const ap = count(appeared);
    const pct = (n: number, d: number) => (d ? round2((n / d) * 100) : null);
    const summary = {
      students: count(() => true), left: count((s) => s.left), absent: count((s) => !s.left && s.absentAll), appeared: ap, passed,
      reExam: count((s) => appeared(s) && (s.result === 'RE_EXAM' || s.result === 'DETAINED')),
      undecided: count((s) => appeared(s) && !s.result),
      // No percentage until at least one result is known (decided or suggested).
      passPercent: students.some((x) => appeared(x) && x.result)
        ? { boys: pct(passed.boys, ap.boys), girls: pct(passed.girls, ap.girls), total: pct(passed.total, ap.total) }
        : { boys: null, girls: null, total: null },
    };

    const gate = await this.cards.gate(ctx, sectionId, 'FINAL');
    const gs = section.greensheet;
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId } });
    const ct = await this.prisma.teachingAssignment.findFirst({ where: { sectionId, role: 'CLASS_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } });
    return {
      section: { id: section.id, name: section.name, className: cls.displayName, label: this.classLabel(section), medium: cls.medium.nameEn, standardCode: cls.standard.code },
      year: { id: year.id, name: year.name },
      school: { name: school.name, motto: school.motto, address: [school.addressLine, school.city, school.pincode].filter(Boolean).join(', '), logoFileId: school.logoFileId == null ? null : Number(school.logoFileId), principalTitle: school.principalTitle ?? 'Head Master' },
      classTeacher: ct?.staff.name ?? null,
      status: gs?.status ?? 'DRAFT', approvedAt: gs?.approvedAt ?? null, approvedByName: gs?.approvedByName ?? null,
      exams: sems.map((e) => (e ? { id: e.id, name: e.nameEn, reportTerm: e.reportTerm } : null)),
      subjects: subjects.map((s) => ({ classSubjectId: s.classSubjectId, name: s.name, short: s.short, type: s.type, includeInTotal: s.includeInTotal, patterns: s.patterns })),
      columns, maxRows, students, summary, gate,
      resultLabels: GREENSHEET_RESULT_LABELS,
      can: { decide: a.decide && gs?.status !== 'APPROVED', approve: a.decide && gs?.status !== 'APPROVED' && gate.ready, reopen: a.decide && gs?.status === 'APPROVED' },
    };
  }

  // ------------------------------------------------------------------ Headmaster decisions

  private async requireDecide(ctx: AccessContext, sectionId: bigint) {
    const section = await this.section(ctx, sectionId);
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!this.access(ctx, scope, sectionId).decide) throw forbidden('Only the Headmaster decides results and approves the Greensheet');
    return section;
  }

  async saveResults(ctx: AccessContext, sectionId: bigint, input: GreensheetDecisionInput) {
    const section = await this.requireDecide(ctx, sectionId);
    if (section.greensheet?.status === 'APPROVED') throw invalidState('The Greensheet is approved and locked. Reopen it first.');
    const enr = await this.prisma.studentEnrollment.findMany({ where: { sectionId, id: { in: input.items.map((i) => BigInt(i.enrollmentId)) } }, select: { id: true } });
    if (enr.length !== new Set(input.items.map((i) => i.enrollmentId)).size) throw invalid('A student is not in this division');
    const cs = new Set((await this.prisma.classSubject.findMany({ where: { classId: section.classId }, select: { id: true } })).map((c) => String(c.id)));
    for (const i of input.items) for (const k of Object.keys(i.grace)) if (!cs.has(k)) throw invalid('Grace marks given for a subject that is not taught in this class');
    await this.prisma.$transaction(async (tx) => {
      for (const i of input.items) {
        const grace = Object.fromEntries(Object.entries(i.grace).filter(([, v]) => v > 0));
        const data = { result: i.result, grace: Object.keys(grace).length ? grace : Prisma.DbNull, remark: i.remark || null, updatedBy: ctx.userId };
        await tx.greensheetResult.upsert({ where: { enrollmentId: BigInt(i.enrollmentId) }, update: data, create: { ...data, enrollmentId: BigInt(i.enrollmentId) } });
      }
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'GreensheetResult', entityId: sectionId, after: input }, tx);
    });
    return this.sheet(ctx, sectionId);
  }

  async approve(ctx: AccessContext, sectionId: bigint) {
    const section = await this.requireDecide(ctx, sectionId);
    if (section.greensheet?.status === 'APPROVED') throw invalidState('The Greensheet is already approved');
    const sheet = await this.sheet(ctx, sectionId);
    if (!sheet.gate.ready) throw invalidState(`Not every sheet is approved yet (${sheet.gate.missing.length} still open: ${sheet.gate.missing.slice(0, 3).map((m) => m.label).join('; ')}${sheet.gate.missing.length > 3 ? ' …' : ''})`);
    const undecided = sheet.students.filter((s) => !s.left && !s.absentAll && !s.decision?.result);
    if (undecided.length) throw invalidState(`Decide the result of every student first (${undecided.length} still open, e.g. ${undecided.slice(0, 3).map((s) => s.name).join(', ')}). Use "Accept suggested results" to start from the calculated ones.`);
    const user = await this.prisma.user.findUnique({ where: { id: ctx.userId }, include: { staff: { select: { name: true } } } });
    const data = { status: 'APPROVED', approvedBy: ctx.userId, approvedByName: user?.staff?.name ?? user?.username ?? null, approvedAt: new Date(), updatedBy: ctx.userId };
    await this.prisma.$transaction(async (tx) => {
      await tx.greensheet.upsert({ where: { sectionId }, update: data, create: { ...data, sectionId } });
      await this.audit.record(ctx, { action: 'APPROVE', entityType: 'Greensheet', entityId: sectionId, after: { summary: sheet.summary } }, tx);
    });
    return this.sheet(ctx, sectionId);
  }

  async reopen(ctx: AccessContext, sectionId: bigint, reason: string) {
    const section = await this.requireDecide(ctx, sectionId);
    if (section.greensheet?.status !== 'APPROVED') throw invalidState('The Greensheet is not approved');
    await this.prisma.$transaction(async (tx) => {
      await tx.greensheet.update({ where: { sectionId }, data: { status: 'DRAFT', approvedBy: null, approvedByName: null, approvedAt: null, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'REOPEN', entityType: 'Greensheet', entityId: sectionId, after: { reason } }, tx);
    });
    return this.sheet(ctx, sectionId);
  }
}

const reopenSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

@Controller()
export class GreensheetController {
  constructor(private readonly gs: GreensheetService) {}

  @Get('greensheet') @RequirePermission(P.MARKS_READ)
  divisions(@Ctx() ctx: AccessContext, @Query(zBody(listQuery)) q: z.infer<typeof listQuery>) { return this.gs.divisions(ctx, q.academicYearId); }

  @Get('greensheet/:sectionId') @RequirePermission(P.MARKS_READ)
  sheet(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint) { return this.gs.sheet(ctx, id); }

  @Put('greensheet/:sectionId/results') @RequirePermission(P.MARKS_APPROVE)
  results(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint, @Body(zBody(greensheetDecisionSchema)) b: GreensheetDecisionInput) { return this.gs.saveResults(ctx, id, b); }

  @Post('greensheet/:sectionId/approve') @HttpCode(200) @RequirePermission(P.MARKS_APPROVE)
  approve(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint) { return this.gs.approve(ctx, id); }

  @Post('greensheet/:sectionId/reopen') @HttpCode(200) @RequirePermission(P.MARKS_APPROVE)
  reopen(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint, @Body(zBody(reopenSchema)) b: z.infer<typeof reopenSchema>) { return this.gs.reopen(ctx, id, b.reason); }
}

@Module({ imports: [ReportCardsModule], controllers: [GreensheetController], providers: [GreensheetService], exports: [GreensheetService] })
export class GreensheetModule {}
