import {
  CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ERROR_CODES, PermissionCode, ScopeType, SYSTEM_ROLES } from '@cps/shared';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../infra/prisma.service';
import { AppError, forbidden } from './errors';

/** Everything a service needs to know about the caller. Built once per request. */
export interface AccessContext {
  userId: bigint;
  schoolId: bigint;
  staffId: bigint | null;
  username: string;
  permissions: Set<string>;
  roles: { code: string; scopeType: ScopeType; scopeId: bigint | null }[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AccessTokenPayload {
  sub: string; // user id
  sch: string; // school id
}

const IS_PUBLIC = 'cps:isPublic';
const PERMS = 'cps:permissions';
const ALLOW_PWD_CHANGE = 'cps:allowWhenPasswordChangeRequired';

/** Route needs no login. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Caller must hold ALL listed permissions. */
export const RequirePermission = (...codes: PermissionCode[]) => SetMetadata(PERMS, codes);
/** Route usable before the forced first-login password change. */
export const AllowWhenPasswordChangeRequired = () => SetMetadata(ALLOW_PWD_CHANGE, true);

export const Ctx = createParamDecorator((_d: unknown, ctx: ExecutionContext): AccessContext => {
  const req = ctx.switchToHttp().getRequest<Request & { access?: AccessContext }>();
  if (!req.access) throw new AppError(401, ERROR_CODES.UNAUTHENTICATED, 'Please sign in');
  return req.access;
});

/**
 * Explicit permissions only. There is deliberately no "super admin can do anything" shortcut:
 * academic approval authority must be granted through an academic role (docs/07).
 */
export function hasPermission(ctx: AccessContext, code: PermissionCode): boolean {
  return ctx.permissions.has(code);
}

export function assertPermission(ctx: AccessContext, code: PermissionCode) {
  if (!hasPermission(ctx, code)) throw forbidden();
}

/**
 * Global guard: verifies the bearer access token, loads the user's CURRENT roles and permissions
 * from the database (so revoking a role takes effect immediately), enforces forced password change
 * and @RequirePermission. Permission checks happen here on the server, never only in the UI.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<Request & { access?: AccessContext }>();
    (req as Request & { requestId?: string }).requestId ??= randomUUID();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, ERROR_CODES.UNAUTHENTICATED, 'Please sign in');
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7));
    } catch {
      throw new AppError(401, ERROR_CODES.UNAUTHENTICATED, 'Your session has expired. Please sign in again.');
    }

    const access = await loadAccessContext(this.prisma, BigInt(payload.sub), req);
    if (!access || access.schoolId !== BigInt(payload.sch)) {
      throw new AppError(401, ERROR_CODES.UNAUTHENTICATED, 'Please sign in');
    }
    req.access = access;

    if (access.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PWD_CHANGE, handlers)) {
      throw new AppError(403, ERROR_CODES.PASSWORD_CHANGE_REQUIRED, 'Please change your password to continue');
    }

    const required = this.reflector.getAllAndOverride<PermissionCode[]>(PERMS, handlers) ?? [];
    for (const code of required) {
      if (!hasPermission(access, code)) throw forbidden();
    }
    return true;
  }
}

export async function loadAccessContext(
  prisma: PrismaService,
  userId: bigint,
  req: Request,
): Promise<AccessContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
  });
  if (!user || user.status !== 'ACTIVE') return null;
  const permissions = new Set<string>();
  for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
  const roles = user.roles.map((ur) => ({ code: ur.role.code, scopeType: ur.scopeType as ScopeType, scopeId: ur.scopeId }));
  return {
    userId: user.id,
    schoolId: user.schoolId,
    staffId: user.staffId,
    username: user.username,
    permissions,
    roles,
    isSuperAdmin: roles.some((r) => r.code === SYSTEM_ROLES.SUPER_ADMIN),
    mustChangePassword: user.mustChangePassword,
    requestId: (req as Request & { requestId?: string }).requestId ?? randomUUID(),
    ip: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
  };
}
