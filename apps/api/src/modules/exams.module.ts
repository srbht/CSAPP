import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  copyPatternSchema, defaultPattern, ExamInput, examSchema, legacyPattern, type MarkPattern, partTotals, patternMax, PERMISSIONS,
  SavePatternInput, savePatternSchema, sortPattern,
} from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { invalid, notFound } from '../common/errors';
import { dateOnly, IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';

const P = PERMISSIONS;
const listQuery = z.object({ academicYearId: z.coerce.number().int().positive().optional() });
const subjectsQuery = z.object({ classId: z.coerce.number().int().positive().optional() });
const patternQuery = z.object({ classId: z.coerce.number().int().positive() });
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));

/** The stored pattern of an exam subject; rows from before the Greensheet format fall back to two totals. */
export function patternOf(es: { parts: Prisma.JsonValue | null; max1: Prisma.Decimal | number; max2: Prisma.Decimal | number | null }): MarkPattern {
  const p = es.parts as MarkPattern | null;
  return Array.isArray(p) && p.length ? sortPattern(p) : legacyPattern(Number(es.max1), num(es.max2));
}

/**
 * Exams per academic year follow the Greensheet: Semester I (Formative Evaluation I + Summative Evaluation I) and
 * Semester II (FE-II + SE-II). Creating an exam gives every class subject the school's mark pattern for its standard
 * (OBS, Oral, Activity … Written, Oral); the Headmaster can change it per class while no marks are submitted.
 */
@Injectable()
export class ExamsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async year(ctx: AccessContext, academicYearId?: number) {
    const y = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, ...(academicYearId ? { id: BigInt(academicYearId) } : { isCurrent: true }) } });
    if (!y) throw notFound('Academic year');
    return y;
  }

  async list(ctx: AccessContext, academicYearId?: number) {
    const year = await this.year(ctx, academicYearId);
    const exams = await this.prisma.exam.findMany({
      where: { academicYearId: year.id, status: { not: 'ARCHIVED' } },
      orderBy: { sequence: 'asc' },
      include: { _count: { select: { subjects: true } } },
    });
    return exams.map(({ _count, ...e }) => ({ ...e, subjectCount: _count.subjects }));
  }

  async get(ctx: AccessContext, id: bigint) {
    const e = await this.prisma.exam.findFirst({ where: { id, academicYear: { schoolId: ctx.schoolId } } });
    if (!e) throw notFound('Exam');
    return e;
  }

  async create(ctx: AccessContext, input: ExamInput, academicYearId?: number) {
    const year = await this.year(ctx, academicYearId);
    if (year.status === 'CLOSED') throw invalidState('The academic year is closed');
    const same = await this.prisma.exam.findFirst({ where: { academicYearId: year.id, reportTerm: input.reportTerm, status: { not: 'ARCHIVED' } } });
    if (same) throw invalid(`${same.nameEn} already holds ${input.reportTerm === 'TERM1' ? 'Semester I' : 'Semester II'} for ${year.name}`, [{ path: 'reportTerm', code: 'duplicate', message: 'Already set up' }]);
    const classSubjects = await this.prisma.classSubject.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE' } },
      include: { subject: { select: { code: true, subjectType: true } }, schoolClass: { select: { standard: { select: { code: true } } } } },
    });
    return this.prisma.$transaction(async (tx) => {
      const exam = await unique(
        () => tx.exam.create({
          data: { ...input, kind: 'SEMESTER', marksDueDate: dateOnly(input.marksDueDate), academicYearId: year.id, createdBy: ctx.userId },
        }),
        'code', `Exam ${input.code} already exists in ${year.name}`,
      );
      // Same pattern as the other semester when it is already set up, otherwise the school's default.
      const other = await tx.examSubject.findMany({ where: { exam: { academicYearId: year.id, status: { not: 'ARCHIVED' }, id: { not: exam.id } } } });
      const otherBy = new Map(other.map((o) => [String(o.classSubjectId), o]));
      const rows = classSubjects.map((cs) => {
        const o = otherBy.get(String(cs.id));
        const parts = o?.parts ? patternOf(o) : defaultPattern(cs.schoolClass.standard.code, cs.subject.code, cs.subject.subjectType);
        const m = patternMax(parts);
        return { examId: exam.id, classSubjectId: cs.id, max1: m.max1, max2: m.max2, parts: parts as unknown as Prisma.InputJsonValue };
      });
      if (rows.length) await tx.examSubject.createMany({ data: rows });
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'Exam', entityId: exam.id, after: { ...exam, subjects: rows.length } }, tx);
      return { ...exam, subjectCount: rows.length };
    });
  }

  async update(ctx: AccessContext, id: bigint, input: ExamInput) {
    const before = await this.get(ctx, id);
    if (input.reportTerm !== before.reportTerm) throw invalidState('Semester I / II of an exam cannot be changed after it is created');
    return this.prisma.$transaction(async (tx) => {
      const after = await unique(
        () => tx.exam.update({ where: { id }, data: { ...input, kind: before.kind, marksDueDate: dateOnly(input.marksDueDate), updatedBy: ctx.userId } }),
        'code', `Exam ${input.code} already exists`,
      );
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Exam', entityId: id, before, after }, tx);
      return after;
    });
  }

  async subjects(ctx: AccessContext, id: bigint, classId?: number) {
    await this.get(ctx, id);
    const rows = await this.prisma.examSubject.findMany({
      where: { examId: id, ...(classId ? { classSubject: { classId: BigInt(classId) } } : {}) },
      include: { classSubject: { include: { subject: { select: { id: true, code: true, nameEn: true, subjectType: true } }, schoolClass: { select: { id: true, displayName: true } } } } },
      orderBy: [{ classSubject: { classId: 'asc' } }, { classSubject: { displayOrder: 'asc' } }],
    });
    return rows.map((r) => ({ ...r, parts: patternOf(r) }));
  }

  // ------------------------------------------------------------------ mark pattern (per class)

  private async classOf(ctx: AccessContext, classId: number) {
    const cls = await this.prisma.schoolClass.findFirst({
      where: { id: BigInt(classId), academicYear: { schoolId: ctx.schoolId } },
      include: { standard: true, medium: true, academicYear: true },
    });
    if (!cls) throw notFound('Class');
    return cls;
  }

  /** Semester exams × class subjects of one class, with each pattern, the school default and whether it can change. */
  async pattern(ctx: AccessContext, classId: number) {
    const cls = await this.classOf(ctx, classId);
    const exams = await this.prisma.exam.findMany({ where: { academicYearId: cls.academicYearId, status: { not: 'ARCHIVED' } }, orderBy: { sequence: 'asc' } });
    const classSubjects = await this.prisma.classSubject.findMany({ where: { classId: cls.id, status: 'ACTIVE' }, include: { subject: true }, orderBy: { displayOrder: 'asc' } });
    const es = await this.prisma.examSubject.findMany({ where: { examId: { in: exams.map((e) => e.id) }, classSubjectId: { in: classSubjects.map((c) => c.id) } } });
    const subs = await this.prisma.academicSubmission.findMany({
      where: { examId: { in: exams.map((e) => e.id) }, classSubjectId: { in: classSubjects.map((c) => c.id) } },
      select: { examId: true, classSubjectId: true, stage: true, status: true, _count: { select: { marks: true } } },
    });
    const esBy = new Map(es.map((e) => [`${e.examId}:${e.classSubjectId}`, e]));
    const state = (examId: bigint, csId: bigint) => {
      const list = subs.filter((s) => s.examId === examId && s.classSubjectId === csId);
      return {
        locked: list.some((s) => !(s.stage === 'OPERATOR' && s.status === 'DRAFT')),
        hasMarks: list.some((s) => s._count.marks > 0),
      };
    };
    return {
      class: { id: cls.id, displayName: cls.displayName, medium: cls.medium.nameEn, standardCode: cls.standard.code, year: cls.academicYear.name },
      exams: exams.map((e) => ({ id: e.id, code: e.code, nameEn: e.nameEn, reportTerm: e.reportTerm })),
      subjects: classSubjects.map((cs) => ({
        classSubjectId: cs.id, code: cs.subject.code, name: cs.subject.nameEn, subjectType: cs.subject.subjectType, includeInTotal: cs.includeInTotal,
        defaultParts: defaultPattern(cls.standard.code, cs.subject.code, cs.subject.subjectType),
        exams: exams.map((e) => {
          const x = esBy.get(`${e.id}:${cs.id}`);
          return { examId: e.id, parts: x ? patternOf(x) : null, ...state(e.id, cs.id) };
        }),
      })),
    };
  }

  /** Write one pattern; marks already saved in a draft sheet are recalculated (values of removed parts are dropped). */
  private async writePattern(tx: Tx, examId: bigint, classSubjectId: bigint, parts: MarkPattern) {
    const sorted = sortPattern(parts);
    const m = patternMax(sorted);
    await tx.examSubject.upsert({
      where: { examId_classSubjectId: { examId, classSubjectId } },
      update: { max1: m.max1, max2: m.max2, parts: sorted as unknown as Prisma.InputJsonValue },
      create: { examId, classSubjectId, max1: m.max1, max2: m.max2, parts: sorted as unknown as Prisma.InputJsonValue },
    });
    const keys = new Set(sorted.map((p) => p.key));
    const marks = await tx.mark.findMany({ where: { examId, classSubjectId } });
    for (const mk of marks) {
      const old = (mk.parts ?? {}) as Record<string, number | null>;
      const kept = Object.fromEntries(Object.entries(old).filter(([k]) => keys.has(k as never)));
      const t = mk.absent ? { marks1: null, marks2: null } : partTotals(sorted, kept);
      await tx.mark.update({ where: { id: mk.id }, data: { parts: kept, marks1: t.marks1, marks2: t.marks2, passedStage: 'OPERATOR', rowStatus: 'PENDING', verifiedHash: null } });
    }
  }

  async savePattern(ctx: AccessContext, input: SavePatternInput) {
    const current = await this.pattern(ctx, input.classId);
    const examIds = new Set(current.exams.map((e) => String(e.id)));
    for (const id of input.examIds) if (!examIds.has(String(id))) throw invalid('Exam is not set up for this year');
    const skipped: string[] = [];
    const changes: { examId: number; classSubjectId: number; parts: MarkPattern }[] = [];
    for (const item of input.items) {
      const s = current.subjects.find((x) => String(x.classSubjectId) === String(item.classSubjectId));
      if (!s) throw invalid('A subject is not taught in this class');
      for (const examId of input.examIds) {
        const st = s.exams.find((x) => String(x.examId) === String(examId))!;
        if (JSON.stringify(st.parts ? sortPattern(st.parts) : null) === JSON.stringify(sortPattern(item.parts as MarkPattern))) continue;
        // Sheets already submitted keep their pattern (the Headmaster reopens them first if it must change).
        if (st.locked) { skipped.push(`${s.name} (${current.exams.find((e) => String(e.id) === String(examId))?.nameEn})`); continue; }
        changes.push({ examId, classSubjectId: item.classSubjectId, parts: item.parts as MarkPattern });
      }
    }
    if (!changes.length && skipped.length) throw invalidState(`Nothing changed: marks are already submitted for ${skipped.join(', ')}. Reopen those sheets first.`);
    await this.prisma.$transaction(async (tx) => {
      for (const c of changes) await this.writePattern(tx, BigInt(c.examId), BigInt(c.classSubjectId), c.parts);
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'MarkPattern', entityId: BigInt(input.classId), after: { ...input, skipped } }, tx);
    });
    return { ...(await this.pattern(ctx, input.classId)), changed: changes.length, skipped };
  }

  /** Copy one class's pattern to other classes (matched by subject code); subjects with submitted marks are skipped. */
  async copyPattern(ctx: AccessContext, input: z.infer<typeof copyPatternSchema>) {
    const from = await this.pattern(ctx, input.fromClassId);
    let copied = 0;
    const skipped: string[] = [];
    for (const toId of input.toClassIds) {
      if (toId === input.fromClassId) continue;
      const to = await this.pattern(ctx, toId);
      const byExamTerm = (rt: string | null) => to.exams.find((e) => e.reportTerm === rt);
      await this.prisma.$transaction(async (tx) => {
        for (const s of from.subjects) {
          const t = to.subjects.find((x) => x.code === s.code);
          if (!t) continue;
          for (const fe of s.exams) {
            const exam = from.exams.find((e) => e.id === fe.examId);
            const target = byExamTerm(exam?.reportTerm ?? null);
            const st = target && t.exams.find((x) => x.examId === target.id);
            if (!fe.parts || !target || !st) continue;
            if (JSON.stringify(st.parts ? sortPattern(st.parts) : null) === JSON.stringify(sortPattern(fe.parts))) continue;
            if (st.locked) { skipped.push(`${to.class.displayName} ${t.name}`); continue; }
            await this.writePattern(tx, target.id, t.classSubjectId, fe.parts);
            copied++;
          }
        }
      });
    }
    await this.audit.record(ctx, { action: 'UPDATE', entityType: 'MarkPattern', entityId: BigInt(input.fromClassId), after: { copiedTo: input.toClassIds, copied, skipped } });
    return { copied, skipped };
  }
}

@Controller()
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Get('exams') @RequirePermission(P.ACADEMICS_READ)
  list(@Ctx() ctx: AccessContext, @Query(zBody(listQuery)) q: z.infer<typeof listQuery>) { return this.exams.list(ctx, q.academicYearId); }

  @Post('exams') @RequirePermission(P.EXAMS_MANAGE)
  create(@Ctx() ctx: AccessContext, @Query(zBody(listQuery)) q: z.infer<typeof listQuery>, @Body(zBody(examSchema)) b: ExamInput) { return this.exams.create(ctx, b, q.academicYearId); }

  @Get('exams/pattern') @RequirePermission(P.ACADEMICS_READ)
  pattern(@Ctx() ctx: AccessContext, @Query(zBody(patternQuery)) q: z.infer<typeof patternQuery>) { return this.exams.pattern(ctx, q.classId); }

  @Put('exams/pattern') @RequirePermission(P.EXAMS_MANAGE)
  savePattern(@Ctx() ctx: AccessContext, @Body(zBody(savePatternSchema)) b: SavePatternInput) { return this.exams.savePattern(ctx, b); }

  @Post('exams/pattern/copy') @RequirePermission(P.EXAMS_MANAGE)
  copyPattern(@Ctx() ctx: AccessContext, @Body(zBody(copyPatternSchema)) b: z.infer<typeof copyPatternSchema>) { return this.exams.copyPattern(ctx, b); }

  @Patch('exams/:id') @RequirePermission(P.EXAMS_MANAGE)
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(examSchema)) b: ExamInput) { return this.exams.update(ctx, id, b); }

  @Get('exams/:id/subjects') @RequirePermission(P.ACADEMICS_READ)
  subjects(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Query(zBody(subjectsQuery)) q: z.infer<typeof subjectsQuery>) { return this.exams.subjects(ctx, id, q.classId); }
}

@Module({ controllers: [ExamsController], providers: [ExamsService], exports: [ExamsService] })
export class ExamsModule {}
