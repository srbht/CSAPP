import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  GradingSystemInput, gradingSystemSchema, PERMISSIONS, SubjectInput, subjectSchema, validateGradeBands,
} from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { unique } from '../common/crud';
import { invalid, notFound } from '../common/errors';
import { big, IdPipe, zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';

const P = PERMISSIONS;
const subjectQuery = z.object({ mediumId: z.coerce.number().int().positive().optional() });

@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(ctx: AccessContext, mediumId?: number) {
    return this.prisma.subject.findMany({
      where: { schoolId: ctx.schoolId, ...(mediumId ? { mediumId: BigInt(mediumId) } : {}) },
      include: { medium: { select: { id: true, code: true, nameEn: true } }, parent: { select: { id: true, nameEn: true, code: true } }, _count: { select: { papers: true } } },
      orderBy: [{ medium: { sortOrder: 'asc' } }, { nameEn: 'asc' }],
    });
  }

  /** Papers (Algebra, Geometry) sit one level under a parent subject (Mathematics) of the same medium. */
  private async validateParent(ctx: AccessContext, input: SubjectInput, selfId?: bigint) {
    if (input.parentSubjectId == null) return;
    const parent = await this.prisma.subject.findFirst({ where: { id: BigInt(input.parentSubjectId), schoolId: ctx.schoolId } });
    const fail = (message: string) => invalid(message, [{ path: 'parentSubjectId', code: 'invalid_parent', message }]);
    if (!parent) throw fail('Parent subject not found');
    if (selfId && parent.id === selfId) throw fail('A subject cannot be its own parent');
    if (parent.mediumId !== BigInt(input.mediumId)) throw fail('Parent subject must be in the same medium');
    if (parent.parentSubjectId) throw fail('A paper cannot have papers of its own (only one level)');
    if (selfId && (await this.prisma.subject.count({ where: { parentSubjectId: selfId } })) > 0) {
      throw fail('This subject has papers, so it cannot become a paper itself');
    }
  }

  async save(ctx: AccessContext, input: SubjectInput, id?: bigint) {
    const medium = await this.prisma.medium.findFirst({ where: { id: BigInt(input.mediumId), schoolId: ctx.schoolId } });
    if (!medium) throw notFound('Medium');
    await this.validateParent(ctx, input, id);
    return this.prisma.$transaction(async (tx) => {
      const before = id ? await tx.subject.findFirst({ where: { id, schoolId: ctx.schoolId } }) : null;
      if (id && !before) throw notFound('Subject');
      if (before && before.mediumId !== medium.id && (await tx.classSubject.count({ where: { subjectId: id } })) > 0) {
        throw invalid('This subject is already used by classes, so its medium cannot change');
      }
      const data = { ...input, code: input.code.toUpperCase(), mediumId: medium.id, parentSubjectId: big(input.parentSubjectId) };
      const after = await unique(
        () => id
          ? tx.subject.update({ where: { id }, data: { ...data, updatedBy: ctx.userId } })
          : tx.subject.create({ data: { ...data, schoolId: ctx.schoolId, createdBy: ctx.userId } }),
        'code', `Subject code ${data.code} already exists in ${medium.nameEn}`,
      );
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'Subject', entityId: after.id, before, after }, tx);
      return after;
    });
  }
}

@Injectable()
export class GradingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(ctx: AccessContext) {
    return this.prisma.gradingSystem.findMany({
      where: { schoolId: ctx.schoolId },
      include: { bands: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  async save(ctx: AccessContext, input: GradingSystemInput, id?: bigint) {
    const problems = validateGradeBands(input.bands);
    if (problems.length) throw invalid('Grade bands are not valid', problems.map((m) => ({ path: 'bands', code: 'bands', message: m })));
    return this.prisma.$transaction(async (tx) => {
      const before = id ? await tx.gradingSystem.findFirst({ where: { id, schoolId: ctx.schoolId }, include: { bands: true } }) : null;
      if (id && !before) throw notFound('Grading system');
      const gs = await unique(
        () => id
          ? tx.gradingSystem.update({ where: { id }, data: { name: input.name, status: input.status, updatedBy: ctx.userId } })
          : tx.gradingSystem.create({ data: { name: input.name, status: input.status, schoolId: ctx.schoolId, createdBy: ctx.userId } }),
        'name', `A grading system named ${input.name} already exists`,
      );
      // Bands are value objects of the system: replaced as a whole (history kept in the audit log).
      await tx.gradeBand.deleteMany({ where: { gradingSystemId: gs.id } });
      const sorted = [...input.bands].sort((a, b) => b.minPercent - a.minPercent);
      await tx.gradeBand.createMany({
        data: sorted.map((b, i) => ({
          gradingSystemId: gs.id, grade: b.grade.toUpperCase(), minPercent: b.minPercent, maxPercent: b.maxPercent,
          gradePoint: b.gradePoint ?? null, labelEn: b.labelEn, labelHi: b.labelHi, isPass: b.isPass, sortOrder: i,
        })),
      });
      const after = await tx.gradingSystem.findUniqueOrThrow({ where: { id: gs.id }, include: { bands: { orderBy: { sortOrder: 'asc' } } } });
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'GradingSystem', entityId: gs.id, before, after }, tx);
      return after;
    });
  }
}

@Controller()
export class SubjectsGradingController {
  constructor(private readonly subjects: SubjectsService, private readonly grading: GradingService) {}

  @Get('subjects') @RequirePermission(P.ACADEMICS_READ)
  list(@Ctx() ctx: AccessContext, @Query(zBody(subjectQuery)) q: z.infer<typeof subjectQuery>) { return this.subjects.list(ctx, q.mediumId); }

  @Post('subjects') @RequirePermission(P.ACADEMICS_MANAGE)
  create(@Ctx() ctx: AccessContext, @Body(zBody(subjectSchema)) b: SubjectInput) { return this.subjects.save(ctx, b); }

  @Patch('subjects/:id') @RequirePermission(P.ACADEMICS_MANAGE)
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(subjectSchema)) b: SubjectInput) { return this.subjects.save(ctx, b, id); }

  @Get('grading-systems') @RequirePermission(P.ACADEMICS_READ)
  gradingList(@Ctx() ctx: AccessContext) { return this.grading.list(ctx); }

  @Post('grading-systems') @RequirePermission(P.ACADEMICS_MANAGE)
  gradingCreate(@Ctx() ctx: AccessContext, @Body(zBody(gradingSystemSchema)) b: GradingSystemInput) { return this.grading.save(ctx, b); }

  @Put('grading-systems/:id') @RequirePermission(P.ACADEMICS_MANAGE)
  gradingUpdate(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(gradingSystemSchema)) b: GradingSystemInput) { return this.grading.save(ctx, b, id); }
}

@Module({ controllers: [SubjectsGradingController], providers: [SubjectsService, GradingService] })
export class SubjectsGradingModule {}
