import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ClassInput, classSchema, classSubjectsSchema, ClassSubjectItemInput, PERMISSIONS, SectionInput, sectionSchema, defaultPattern, patternMax } from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { invalid, notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { big, IdPipe, zBody } from '../common/validation';
import { Tx } from '../infra/prisma.service';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma/client';

const P = PERMISSIONS;
const classQuery = z.object({
  academicYearId: z.coerce.number().int().positive().optional(),
  mediumId: z.coerce.number().int().positive().optional(),
  mine: z.enum(['true', 'false']).optional(),
});
const classUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  gradingSystemId: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scope: ScopeService) {}

  async list(ctx: AccessContext, q: z.infer<typeof classQuery>) {
    const yearId = q.academicYearId
      ? BigInt(q.academicYearId)
      : (await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } }))?.id;
    if (!yearId) return [];
    let sectionIds: bigint[] | undefined;
    if (q.mine === 'true') {
      const s = await this.scope.resolve(ctx, yearId);
      if (!s.all) sectionIds = s.sectionIds;
    }
    const classes = await this.prisma.schoolClass.findMany({
      where: {
        academicYearId: yearId,
        academicYear: { schoolId: ctx.schoolId },
        ...(q.mediumId ? { mediumId: BigInt(q.mediumId) } : {}),
        ...(sectionIds ? { sections: { some: { id: { in: sectionIds } } } } : {}),
      },
      include: {
        medium: true,
        standard: true,
        gradingSystem: { select: { id: true, name: true } },
        sections: {
          where: sectionIds ? { id: { in: sectionIds } } : undefined,
          orderBy: { name: 'asc' },
          include: {
            assignments: {
              where: { role: 'CLASS_TEACHER', status: 'ACTIVE' },
              include: { staff: { select: { id: true, name: true } } },
            },
          },
        },
        _count: { select: { classSubjects: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: [{ medium: { sortOrder: 'asc' } }, { standard: { levelOrder: 'asc' } }],
    });
    return classes.map((c) => ({
      ...c,
      subjectCount: c._count.classSubjects,
      sections: c.sections.map(({ assignments, ...s }) => ({ ...s, classTeacher: assignments[0]?.staff ?? null })),
    }));
  }

  async get(ctx: AccessContext, id: bigint) {
    const c = await this.prisma.schoolClass.findFirst({
      where: { id, academicYear: { schoolId: ctx.schoolId } },
      include: { academicYear: true, medium: true, standard: true, sections: { orderBy: { name: 'asc' } } },
    });
    if (!c) throw notFound('Class');
    return c;
  }

  private assertOpen(year: { status: string }) {
    if (year.status === 'CLOSED') throw invalidState('Classes of a closed academic year cannot be changed');
  }

  private async assertGrading(ctx: AccessContext, id: number | null | undefined) {
    if (id == null) return;
    const g = await this.prisma.gradingSystem.findFirst({ where: { id: BigInt(id), schoolId: ctx.schoolId } });
    if (!g) throw invalid('Grading system not found', [{ path: 'gradingSystemId', code: 'not_found', message: 'Choose a grading system' }]);
  }

  async create(ctx: AccessContext, input: ClassInput) {
    const [year, medium, standard] = await Promise.all([
      this.prisma.academicYear.findFirst({ where: { id: BigInt(input.academicYearId), schoolId: ctx.schoolId } }),
      this.prisma.medium.findFirst({ where: { id: BigInt(input.mediumId), schoolId: ctx.schoolId } }),
      this.prisma.standard.findFirst({ where: { id: BigInt(input.standardId), schoolId: ctx.schoolId } }),
    ]);
    if (!year) throw notFound('Academic year');
    if (!medium) throw notFound('Medium');
    if (!standard) throw notFound('Standard');
    this.assertOpen(year);
    await this.assertGrading(ctx, input.gradingSystemId);
    return this.prisma.$transaction(async (tx) => {
      const c = await unique(
        () => tx.schoolClass.create({
          data: {
            academicYearId: year.id, mediumId: medium.id, standardId: standard.id,
            code: `${medium.code}-${standard.code}`,
            // School convention seen on its marksheets: "ENGLISH-X"
            displayName: input.displayName ?? `${medium.nameEn.replace(/\s*medium\s*/i, '').toUpperCase()}-${standard.code}`,
            gradingSystemId: big(input.gradingSystemId), status: input.status, createdBy: ctx.userId,
          },
        }),
        'standardId', `${standard.nameEn} already exists for ${medium.nameEn} in ${year.name}`,
      );
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'Class', entityId: c.id, after: c }, tx);
      return c;
    });
  }

  async update(ctx: AccessContext, id: bigint, input: z.infer<typeof classUpdateSchema>) {
    const before = await this.get(ctx, id);
    this.assertOpen(before.academicYear);
    await this.assertGrading(ctx, input.gradingSystemId);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.schoolClass.update({
        where: { id },
        data: { displayName: input.displayName, gradingSystemId: big(input.gradingSystemId), status: input.status, updatedBy: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Class', entityId: id, before, after }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------ sections (divisions)
  async createSection(ctx: AccessContext, classId: bigint, input: SectionInput) {
    const c = await this.get(ctx, classId);
    this.assertOpen(c.academicYear);
    return this.prisma.$transaction(async (tx) => {
      const s = await unique(
        () => tx.section.create({ data: { classId, name: input.name, capacity: input.capacity ?? null, room: input.room, status: input.status, createdBy: ctx.userId } }),
        'name', `Division ${input.name} already exists in ${c.displayName}`,
      );
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'Section', entityId: s.id, after: s }, tx);
      return s;
    });
  }

  async updateSection(ctx: AccessContext, id: bigint, input: SectionInput) {
    const before = await this.prisma.section.findFirst({ where: { id, schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: { schoolClass: { include: { academicYear: true } } } });
    if (!before) throw notFound('Division');
    this.assertOpen(before.schoolClass.academicYear);
    return this.prisma.$transaction(async (tx) => {
      const after = await unique(
        () => tx.section.update({ where: { id }, data: { name: input.name, capacity: input.capacity ?? null, room: input.room, status: input.status, updatedBy: ctx.userId } }),
        'name', `Division ${input.name} already exists in this class`,
      );
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Section', entityId: id, before: { ...before, schoolClass: undefined }, after }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------ class subjects
  async listSubjects(ctx: AccessContext, classId: bigint) {
    await this.get(ctx, classId);
    return this.prisma.classSubject.findMany({
      where: { classId },
      include: { subject: { include: { parent: { select: { id: true, nameEn: true, code: true } } } }, gradingSystem: { select: { id: true, name: true } } },
      orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }],
    });
  }

  /**
   * Replace the class's subject list. Subjects removed from the list are deactivated, never deleted,
   * because teacher assignments, exams and marks reference them.
   */
  async saveSubjects(ctx: AccessContext, classId: bigint, items: ClassSubjectItemInput[]) {
    const c = await this.get(ctx, classId);
    this.assertOpen(c.academicYear);
    const ids = items.map((i) => BigInt(i.subjectId));
    if (new Set(ids.map(String)).size !== ids.length) throw invalid('A subject is listed more than once');
    const subjects = await this.prisma.subject.findMany({ where: { id: { in: ids }, schoolId: ctx.schoolId } });
    const byId = new Map(subjects.map((s) => [String(s.id), s]));
    const errors = items.flatMap((i, idx) => {
      const s = byId.get(String(i.subjectId));
      if (!s) return [{ path: `items.${idx}.subjectId`, code: 'not_found', message: 'Subject not found' }];
      // Hindi and English medium are configured independently: a class only takes its own medium's subjects.
      if (s.mediumId !== c.mediumId) return [{ path: `items.${idx}.subjectId`, code: 'medium_mismatch', message: `${s.nameEn} belongs to another medium` }];
      if (s.status !== 'ACTIVE') return [{ path: `items.${idx}.subjectId`, code: 'inactive', message: `${s.nameEn} is inactive` }];
      return [];
    });
    if (errors.length) throw invalid('Some subjects cannot be added to this class', errors);
    for (const gid of new Set(items.map((i) => i.gradingSystemId).filter((g) => g != null))) await this.assertGrading(ctx, gid);

    await this.prisma.$transaction(async (tx: Tx) => {
      const existing = await tx.classSubject.findMany({ where: { classId } });
      const before = existing.map((e) => ({ ...e }));
      for (const i of items) {
        const data = {
          isOptional: i.isOptional, optionalGroup: i.optionalGroup, includeInTotal: i.includeInTotal,
          defaultMaxMarks: i.defaultMaxMarks ?? null, defaultPassMarks: i.defaultPassMarks ?? null,
          gradingSystemId: big(i.gradingSystemId), reportRollup: i.reportRollup, displayOrder: i.displayOrder, status: 'ACTIVE',
        };
        const found = existing.find((e) => e.subjectId === BigInt(i.subjectId));
        if (found) await tx.classSubject.update({ where: { id: found.id }, data: { ...data, updatedBy: ctx.userId } });
        else await tx.classSubject.create({ data: { ...data, classId, subjectId: BigInt(i.subjectId), createdBy: ctx.userId } });
      }
      const keep = new Set(items.map((i) => String(i.subjectId)));
      const removed = existing.filter((e) => !keep.has(String(e.subjectId)) && e.status === 'ACTIVE');
      if (removed.length) {
        await tx.classSubject.updateMany({ where: { id: { in: removed.map((r) => r.id) } }, data: { status: 'INACTIVE', updatedBy: ctx.userId } });
      }
      // Subjects attached after a semester was created get that semester's default mark pattern too, so they appear
      // at once in the Mark pattern, mark entry, blank mark sheets and the Greensheet.
      const exams = await tx.exam.findMany({ where: { academicYearId: c.academicYearId, status: { not: 'ARCHIVED' } }, select: { id: true } });
      if (exams.length) {
        const cls = await tx.schoolClass.findUniqueOrThrow({ where: { id: classId }, select: { standard: { select: { code: true } } } });
        const active = await tx.classSubject.findMany({ where: { classId, status: 'ACTIVE' }, include: { subject: { select: { code: true, subjectType: true } } } });
        const have = new Set((await tx.examSubject.findMany({ where: { examId: { in: exams.map((e) => e.id) }, classSubjectId: { in: active.map((a) => a.id) } }, select: { examId: true, classSubjectId: true } })).map((x) => `${x.examId}:${x.classSubjectId}`));
        const rows = exams.flatMap((e) => active.filter((a) => !have.has(`${e.id}:${a.id}`)).map((a) => {
          const parts = defaultPattern(cls.standard.code, a.subject.code, a.subject.subjectType);
          const m = patternMax(parts);
          return { examId: e.id, classSubjectId: a.id, max1: m.max1, max2: m.max2, parts: parts as unknown as Prisma.InputJsonValue };
        }));
        if (rows.length) await tx.examSubject.createMany({ data: rows });
      }
      const after = await tx.classSubject.findMany({ where: { classId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'ClassSubjects', entityId: classId, before: { items: before }, after: { items: after } }, tx);
    });
    return this.listSubjects(ctx, classId);
  }
}

@Controller()
export class ClassesController {
  constructor(private readonly svc: ClassesService) {}

  @Get('classes') @RequirePermission(P.ACADEMICS_READ)
  list(@Ctx() ctx: AccessContext, @Query(zBody(classQuery)) q: z.infer<typeof classQuery>) { return this.svc.list(ctx, q); }

  @Get('classes/:id') @RequirePermission(P.ACADEMICS_READ)
  get(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.get(ctx, id); }

  @Post('classes') @RequirePermission(P.ACADEMICS_MANAGE)
  create(@Ctx() ctx: AccessContext, @Body(zBody(classSchema)) b: ClassInput) { return this.svc.create(ctx, b); }

  @Patch('classes/:id') @RequirePermission(P.ACADEMICS_MANAGE)
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(classUpdateSchema)) b: z.infer<typeof classUpdateSchema>) { return this.svc.update(ctx, id, b); }

  @Post('classes/:id/sections') @RequirePermission(P.ACADEMICS_MANAGE)
  createSection(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(sectionSchema)) b: SectionInput) { return this.svc.createSection(ctx, id, b); }

  @Patch('sections/:id') @RequirePermission(P.ACADEMICS_MANAGE)
  updateSection(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(sectionSchema)) b: SectionInput) { return this.svc.updateSection(ctx, id, b); }

  @Get('classes/:id/subjects') @RequirePermission(P.ACADEMICS_READ)
  subjects(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.listSubjects(ctx, id); }

  @Put('classes/:id/subjects') @RequirePermission(P.ACADEMICS_MANAGE)
  saveSubjects(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(classSubjectsSchema)) b: z.infer<typeof classSubjectsSchema>) {
    return this.svc.saveSubjects(ctx, id, b.items);
  }
}

@Module({ controllers: [ClassesController], providers: [ClassesService] })
export class ClassesModule {}
