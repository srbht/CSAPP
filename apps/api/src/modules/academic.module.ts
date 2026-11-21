import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import {
  AcademicTermInput, academicTermSchema, AcademicYearInput, academicYearSchema, MediumInput, mediumSchema,
  PERMISSIONS, StandardInput, standardSchema,
} from '@cps/shared';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { invalid, notFound } from '../common/errors';
import { dateOnly, IdPipe, zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';

const P = PERMISSIONS;
const iso = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class AcademicService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ------------------------------------------------------------ academic years
  listYears(ctx: AccessContext) {
    return this.prisma.academicYear.findMany({
      where: { schoolId: ctx.schoolId },
      orderBy: { startDate: 'desc' },
      include: { terms: { orderBy: { sequence: 'asc' } }, _count: { select: { classes: true } } },
    });
  }

  async getYear(ctx: AccessContext, id: bigint) {
    const y = await this.prisma.academicYear.findFirst({ where: { id, schoolId: ctx.schoolId }, include: { terms: { orderBy: { sequence: 'asc' } } } });
    if (!y) throw notFound('Academic year');
    return y;
  }

  async createYear(ctx: AccessContext, input: AcademicYearInput) {
    return this.prisma.$transaction(async (tx) => {
      const y = await unique(
        () => tx.academicYear.create({
          data: {
            schoolId: ctx.schoolId, name: input.name, startDate: dateOnly(input.startDate)!, endDate: dateOnly(input.endDate)!,
            weeklyOffDays: input.weeklyOffDays, createdBy: ctx.userId,
          },
        }),
        'name', `Academic year ${input.name} already exists`,
      );
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'AcademicYear', entityId: y.id, after: y }, tx);
      return y;
    });
  }

  async updateYear(ctx: AccessContext, id: bigint, input: AcademicYearInput) {
    const before = await this.getYear(ctx, id);
    if (before.status === 'CLOSED') throw invalidState('A closed academic year cannot be edited');
    const outside = before.terms.filter((t) => iso(t.startDate) < input.startDate || iso(t.endDate) > input.endDate);
    if (outside.length) throw invalid(`Terms ${outside.map((t) => t.code).join(', ')} would fall outside the new dates`);
    return this.prisma.$transaction(async (tx) => {
      const after = await unique(
        () => tx.academicYear.update({
          where: { id },
          data: { name: input.name, startDate: dateOnly(input.startDate)!, endDate: dateOnly(input.endDate)!, weeklyOffDays: input.weeklyOffDays, updatedBy: ctx.userId },
        }),
        'name', `Academic year ${input.name} already exists`,
      );
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'AcademicYear', entityId: id, before, after }, tx);
      return after;
    });
  }

  /** Make this the current year (one per school). Planned years become active. */
  async setCurrent(ctx: AccessContext, id: bigint) {
    const y = await this.getYear(ctx, id);
    if (y.status === 'CLOSED') throw invalidState('A closed academic year cannot be made current');
    return this.prisma.$transaction(async (tx) => {
      await tx.academicYear.updateMany({ where: { schoolId: ctx.schoolId, isCurrent: true, NOT: { id } }, data: { isCurrent: false } });
      const after = await tx.academicYear.update({ where: { id }, data: { isCurrent: true, status: 'ACTIVE', updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'SET_CURRENT', entityType: 'AcademicYear', entityId: id, before: y, after }, tx);
      return after;
    });
  }

  async closeYear(ctx: AccessContext, id: bigint) {
    const y = await this.getYear(ctx, id);
    if (y.isCurrent) throw invalidState('Make another year current before closing this one');
    if (y.status === 'CLOSED') throw invalidState('This academic year is already closed');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.academicYear.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'CLOSE', entityType: 'AcademicYear', entityId: id, before: y, after }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------ terms
  private async validateTerm(year: Awaited<ReturnType<AcademicService['getYear']>>, input: AcademicTermInput, ignoreId?: bigint) {
    if (year.status === 'CLOSED') throw invalidState('A closed academic year cannot be edited');
    if (input.startDate < iso(year.startDate) || input.endDate > iso(year.endDate)) {
      throw invalid('Term dates must be within the academic year', [{ path: 'startDate', code: 'range', message: `Must be between ${iso(year.startDate)} and ${iso(year.endDate)}` }]);
    }
    const overlap = year.terms.find((t) => t.id !== ignoreId && input.startDate <= iso(t.endDate) && input.endDate >= iso(t.startDate));
    if (overlap) throw invalid(`Dates overlap with ${overlap.nameEn}`, [{ path: 'startDate', code: 'overlap', message: `Overlaps ${overlap.nameEn}` }]);
  }

  async createTerm(ctx: AccessContext, yearId: bigint, input: AcademicTermInput) {
    const year = await this.getYear(ctx, yearId);
    await this.validateTerm(year, input);
    return this.prisma.$transaction(async (tx) => {
      const t = await unique(
        () => tx.academicTerm.create({
          data: { academicYearId: yearId, code: input.code, nameEn: input.nameEn, nameHi: input.nameHi, startDate: dateOnly(input.startDate)!, endDate: dateOnly(input.endDate)!, sequence: input.sequence, createdBy: ctx.userId },
        }),
        'code', `Term code ${input.code} already exists in this year`,
      );
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'AcademicTerm', entityId: t.id, after: t }, tx);
      return t;
    });
  }

  async updateTerm(ctx: AccessContext, yearId: bigint, termId: bigint, input: AcademicTermInput) {
    const year = await this.getYear(ctx, yearId);
    const before = year.terms.find((t) => t.id === termId);
    if (!before) throw notFound('Term');
    await this.validateTerm(year, input, termId);
    return this.prisma.$transaction(async (tx) => {
      const after = await unique(
        () => tx.academicTerm.update({
          where: { id: termId },
          data: { code: input.code, nameEn: input.nameEn, nameHi: input.nameHi, startDate: dateOnly(input.startDate)!, endDate: dateOnly(input.endDate)!, sequence: input.sequence, updatedBy: ctx.userId },
        }),
        'code', `Term code ${input.code} already exists in this year`,
      );
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'AcademicTerm', entityId: termId, before, after }, tx);
      return after;
    });
  }

  async deleteTerm(ctx: AccessContext, yearId: bigint, termId: bigint) {
    const year = await this.getYear(ctx, yearId);
    const before = year.terms.find((t) => t.id === termId);
    if (!before) throw notFound('Term');
    if (year.status === 'CLOSED') throw invalidState('A closed academic year cannot be edited');
    // Terms are referenced by exams from Phase 4; until then they can be removed.
    await this.prisma.$transaction(async (tx) => {
      await tx.academicTerm.delete({ where: { id: termId } });
      await this.audit.record(ctx, { action: 'DELETE', entityType: 'AcademicTerm', entityId: termId, before }, tx);
    });
  }

  // ------------------------------------------------------------ mediums
  listMediums(ctx: AccessContext) {
    return this.prisma.medium.findMany({ where: { schoolId: ctx.schoolId }, orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }] });
  }

  async saveMedium(ctx: AccessContext, input: MediumInput, id?: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const before = id ? await tx.medium.findFirst({ where: { id, schoolId: ctx.schoolId } }) : null;
      if (id && !before) throw notFound('Medium');
      const data = { ...input, code: input.code.toUpperCase(), examNoPrefix: input.examNoPrefix?.toUpperCase() ?? null };
      const after = await unique(
        () => id
          ? tx.medium.update({ where: { id }, data: { ...data, updatedBy: ctx.userId } })
          : tx.medium.create({ data: { ...data, schoolId: ctx.schoolId, createdBy: ctx.userId } }),
        'code', `Medium code ${data.code} already exists`,
      );
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'Medium', entityId: after.id, before, after }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------ standards
  listStandards(ctx: AccessContext) {
    return this.prisma.standard.findMany({ where: { schoolId: ctx.schoolId }, orderBy: { levelOrder: 'asc' } });
  }

  async saveStandard(ctx: AccessContext, input: StandardInput, id?: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const before = id ? await tx.standard.findFirst({ where: { id, schoolId: ctx.schoolId } }) : null;
      if (id && !before) throw notFound('Standard');
      const data = { ...input, code: input.code.toUpperCase() };
      const after = await unique(
        () => id
          ? tx.standard.update({ where: { id }, data: { ...data, updatedBy: ctx.userId } })
          : tx.standard.create({ data: { ...data, schoolId: ctx.schoolId, createdBy: ctx.userId } }),
        'code', `Standard code ${data.code} already exists`,
      );
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'Standard', entityId: after.id, before, after }, tx);
      return after;
    });
  }
}

@Controller()
export class AcademicController {
  constructor(private readonly svc: AcademicService) {}

  // Years feed the global year switcher, so every signed-in user can read them.
  @Get('academic-years')
  years(@Ctx() ctx: AccessContext) { return this.svc.listYears(ctx); }

  @Post('academic-years') @RequirePermission(P.SETTINGS_MANAGE)
  createYear(@Ctx() ctx: AccessContext, @Body(zBody(academicYearSchema)) b: AcademicYearInput) { return this.svc.createYear(ctx, b); }

  @Patch('academic-years/:id') @RequirePermission(P.SETTINGS_MANAGE)
  updateYear(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(academicYearSchema)) b: AcademicYearInput) { return this.svc.updateYear(ctx, id, b); }

  @Post('academic-years/:id/set-current') @HttpCode(200) @RequirePermission(P.SETTINGS_MANAGE)
  setCurrent(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.setCurrent(ctx, id); }

  @Post('academic-years/:id/close') @HttpCode(200) @RequirePermission(P.SETTINGS_MANAGE)
  close(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.closeYear(ctx, id); }

  @Post('academic-years/:id/terms') @RequirePermission(P.SETTINGS_MANAGE)
  createTerm(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(academicTermSchema)) b: AcademicTermInput) { return this.svc.createTerm(ctx, id, b); }

  @Patch('academic-years/:id/terms/:termId') @RequirePermission(P.SETTINGS_MANAGE)
  updateTerm(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('termId', IdPipe) termId: bigint, @Body(zBody(academicTermSchema)) b: AcademicTermInput) { return this.svc.updateTerm(ctx, id, termId, b); }

  @Delete('academic-years/:id/terms/:termId') @HttpCode(204) @RequirePermission(P.SETTINGS_MANAGE)
  deleteTerm(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('termId', IdPipe) termId: bigint) { return this.svc.deleteTerm(ctx, id, termId); }

  // Mediums and standards are needed by every signed-in user for filters, so reads are open to all.
  @Get('mediums')
  mediums(@Ctx() ctx: AccessContext) { return this.svc.listMediums(ctx); }

  @Post('mediums') @RequirePermission(P.SETTINGS_MANAGE)
  createMedium(@Ctx() ctx: AccessContext, @Body(zBody(mediumSchema)) b: MediumInput) { return this.svc.saveMedium(ctx, b); }

  @Patch('mediums/:id') @RequirePermission(P.SETTINGS_MANAGE)
  updateMedium(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(mediumSchema)) b: MediumInput) { return this.svc.saveMedium(ctx, b, id); }

  @Get('standards')
  standards(@Ctx() ctx: AccessContext) { return this.svc.listStandards(ctx); }

  @Post('standards') @RequirePermission(P.SETTINGS_MANAGE)
  createStandard(@Ctx() ctx: AccessContext, @Body(zBody(standardSchema)) b: StandardInput) { return this.svc.saveStandard(ctx, b); }

  @Patch('standards/:id') @RequirePermission(P.SETTINGS_MANAGE)
  updateStandard(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(standardSchema)) b: StandardInput) { return this.svc.saveStandard(ctx, b, id); }
}

@Module({ controllers: [AcademicController], providers: [AcademicService], exports: [AcademicService] })
export class AcademicModule {}
