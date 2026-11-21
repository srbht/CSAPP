import { Body, Controller, Delete, Get, Global, HttpCode, Injectable, Module, Param, Patch, Put, Query } from '@nestjs/common';
import {
  formatSequence, getPolicyDef, PERMISSIONS, POLICY_DEFS, policyScopeSchema, policyUpsertSchema, resolveAllPolicies,
  scopeKey, SequenceTokens, sequenceUpdateSchema, StoredPolicy,
} from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalid, notFound } from '../common/errors';
import { big, IdPipe, zBody } from '../common/validation';
import { PrismaService, Tx } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma/client';

const P = PERMISSIONS;
type Scope = z.infer<typeof policyScopeSchema>;

const toStored = (rows: { policyKey: string; value: unknown; academicYearId: bigint | null; mediumId: bigint | null; standardId: bigint | null; classId: bigint | null }[]): StoredPolicy[] =>
  rows.map((r) => ({
    policyKey: r.policyKey, value: r.value,
    academicYearId: r.academicYearId == null ? null : Number(r.academicYearId),
    mediumId: r.mediumId == null ? null : Number(r.mediumId),
    standardId: r.standardId == null ? null : Number(r.standardId),
    classId: r.classId == null ? null : Number(r.classId),
  }));

@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Effective value of every policy for a scope, with where each value came from. */
  async effective(ctx: AccessContext, scope: Scope) {
    const rows = await this.prisma.policy.findMany({ where: { schoolId: ctx.schoolId } });
    const resolved = resolveAllPolicies(toStored(rows), scope);
    return resolved.map((r) => {
      const d = getPolicyDef(r.key)!;
      return { ...r, label: d.label, description: d.description, group: d.group, input: d.input, options: d.options ?? null, default: d.default };
    });
  }

  /** Typed lookup for other modules (attendance, marks, results in later phases). */
  async get<T>(schoolId: bigint, key: string, scope: Scope): Promise<T> {
    const rows = await this.prisma.policy.findMany({ where: { schoolId, policyKey: key } });
    return resolveAllPolicies(toStored(rows), scope).find((r) => r.key === key)!.value as T;
  }

  overrides(ctx: AccessContext) {
    return this.prisma.policy.findMany({
      where: { schoolId: ctx.schoolId },
      include: {
        academicYear: { select: { name: true } }, medium: { select: { nameEn: true } },
        standard: { select: { nameEn: true } }, schoolClass: { select: { displayName: true } },
      },
      orderBy: [{ policyKey: 'asc' }, { scopeKey: 'asc' }],
    });
  }

  async upsert(ctx: AccessContext, input: z.infer<typeof policyUpsertSchema>) {
    const def = getPolicyDef(input.policyKey);
    if (!def) throw invalid(`Unknown setting ${input.policyKey}`);
    const parsed = def.schema.safeParse(input.value);
    if (!parsed.success) throw invalid(`Invalid value for "${def.label}"`, [{ path: 'value', code: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid value' }]);
    await this.assertScopeBelongs(ctx, input);
    const key = scopeKey(input);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.policy.findUnique({ where: { schoolId_policyKey_scopeKey: { schoolId: ctx.schoolId, policyKey: def.key, scopeKey: key } } });
      const data = {
        value: parsed.data as Prisma.InputJsonValue,
        academicYearId: big(input.academicYearId), mediumId: big(input.mediumId), standardId: big(input.standardId), classId: big(input.classId),
      };
      const after = before
        ? await tx.policy.update({ where: { id: before.id }, data: { value: data.value, updatedBy: ctx.userId } })
        : await tx.policy.create({ data: { ...data, schoolId: ctx.schoolId, policyKey: def.key, scopeKey: key, createdBy: ctx.userId } });
      await this.audit.record(ctx, { action: before ? 'UPDATE' : 'CREATE', entityType: 'Policy', entityId: after.id, before, after }, tx);
      return after;
    });
  }

  async remove(ctx: AccessContext, id: bigint) {
    const before = await this.prisma.policy.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!before) throw notFound('Setting');
    await this.prisma.$transaction(async (tx) => {
      await tx.policy.delete({ where: { id } });
      await this.audit.record(ctx, { action: 'DELETE', entityType: 'Policy', entityId: id, before, reason: 'Reverted to inherited value' }, tx);
    });
  }

  private async assertScopeBelongs(ctx: AccessContext, s: Scope) {
    const checks: [number | null | undefined, () => Promise<unknown>, string][] = [
      [s.academicYearId, () => this.prisma.academicYear.findFirst({ where: { id: BigInt(s.academicYearId!), schoolId: ctx.schoolId } }), 'Academic year'],
      [s.mediumId, () => this.prisma.medium.findFirst({ where: { id: BigInt(s.mediumId!), schoolId: ctx.schoolId } }), 'Medium'],
      [s.standardId, () => this.prisma.standard.findFirst({ where: { id: BigInt(s.standardId!), schoolId: ctx.schoolId } }), 'Standard'],
      [s.classId, () => this.prisma.schoolClass.findFirst({ where: { id: BigInt(s.classId!), academicYear: { schoolId: ctx.schoolId } } }), 'Class'],
    ];
    for (const [v, find, label] of checks) if (v != null && !(await find())) throw notFound(label);
  }
}

@Injectable()
export class SequencesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(ctx: AccessContext) {
    return this.prisma.numberSequence.findMany({ where: { schoolId: ctx.schoolId }, orderBy: { seqKey: 'asc' } })
      .then((rows) => rows.map((r) => ({ ...r, preview: formatSequence(r.pattern, Number(r.nextValue)) })));
  }

  async update(ctx: AccessContext, id: bigint, input: z.infer<typeof sequenceUpdateSchema>) {
    const before = await this.prisma.numberSequence.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!before) throw notFound('Number sequence');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.numberSequence.update({ where: { id }, data: { pattern: input.pattern, nextValue: BigInt(input.nextValue), updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'NumberSequence', entityId: id, before, after }, tx);
      return { ...after, preview: formatSequence(after.pattern, Number(after.nextValue)) };
    });
  }

  /**
   * Allocate the next number inside the caller's transaction. The row lock (FOR UPDATE)
   * serialises concurrent admissions so two students can never get the same number.
   */
  async next(tx: Tx, schoolId: bigint, seqKey: string, tokens: SequenceTokens = {}): Promise<string> {
    const rows = await tx.$queryRaw<{ id: bigint; pattern: string; next_value: bigint }[]>`
      SELECT id, pattern, next_value FROM number_sequences WHERE school_id = ${schoolId} AND seq_key = ${seqKey} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw notFound(`Number sequence ${seqKey}`);
    await tx.numberSequence.update({ where: { id: row.id }, data: { nextValue: { increment: 1 } } });
    return formatSequence(row.pattern, Number(row.next_value), tokens);
  }
}

@Controller()
export class PoliciesSequencesController {
  constructor(private readonly policies: PoliciesService, private readonly sequences: SequencesService) {}

  @Get('policies/catalog')
  catalog() {
    return POLICY_DEFS.map((d) => ({ key: d.key, group: d.group, label: d.label, description: d.description, input: d.input, options: 'options' in d ? d.options : null, default: d.default }));
  }

  @Get('policies/effective')
  effective(@Ctx() ctx: AccessContext, @Query(zBody(policyScopeSchema)) q: Scope) { return this.policies.effective(ctx, q); }

  @Get('policies') @RequirePermission(P.SETTINGS_READ)
  overrides(@Ctx() ctx: AccessContext) { return this.policies.overrides(ctx); }

  @Put('policies') @RequirePermission(P.SETTINGS_MANAGE)
  upsert(@Ctx() ctx: AccessContext, @Body(zBody(policyUpsertSchema)) b: z.infer<typeof policyUpsertSchema>) { return this.policies.upsert(ctx, b); }

  @Delete('policies/:id') @HttpCode(204) @RequirePermission(P.SETTINGS_MANAGE)
  remove(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.policies.remove(ctx, id); }

  @Get('sequences') @RequirePermission(P.SETTINGS_READ)
  seqList(@Ctx() ctx: AccessContext) { return this.sequences.list(ctx); }

  @Patch('sequences/:id') @RequirePermission(P.SETTINGS_MANAGE)
  seqUpdate(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(sequenceUpdateSchema)) b: z.infer<typeof sequenceUpdateSchema>) { return this.sequences.update(ctx, id, b); }
}

@Global()
@Module({ controllers: [PoliciesSequencesController], providers: [PoliciesService, SequencesService], exports: [PoliciesService, SequencesService] })
export class PoliciesSequencesModule {}
