import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';
import type { AccessContext } from './auth';
import { toJson } from './serialize';

export interface AuditEntry {
  action: string; // CREATE | UPDATE | DEACTIVATE | LOGIN | LOGIN_FAILED | ...
  entityType: string;
  entityId?: bigint | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Only changed keys are stored for updates, keeping logs readable and small. */
function diff(before: unknown, after: unknown): { before: unknown; after: unknown } {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return { before, after };
  const b = toJson(before) as Record<string, unknown>;
  const a = toJson(after) as Record<string, unknown>;
  const ignore = new Set(['updatedAt', 'updatedBy', 'version']);
  const bOut: Record<string, unknown> = {};
  const aOut: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (ignore.has(k)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      bOut[k] = b[k];
      aOut[k] = a[k];
    }
  }
  return { before: bOut, after: aOut };
}

const asJson = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (toJson(v) as Prisma.InputJsonValue));

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Write an audit row. Pass `tx` to make it part of the same transaction as the change. */
  async record(ctx: Pick<AccessContext, 'schoolId' | 'userId' | 'requestId' | 'ip' | 'userAgent'>, e: AuditEntry, tx?: Tx) {
    const d = e.action === 'UPDATE' ? diff(e.before, e.after) : { before: e.before, after: e.after };
    if (e.action === 'UPDATE' && d.after && Object.keys(d.after as object).length === 0) return; // no-op update
    await (tx ?? this.prisma).auditLog.create({
      data: {
        schoolId: ctx.schoolId,
        userId: ctx.userId,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        beforeData: asJson(d.before),
        afterData: asJson(d.after),
        reason: e.reason ?? null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
