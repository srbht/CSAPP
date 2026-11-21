import { Body, Controller, Get, HttpCode, Injectable, Module, Patch, Post, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { hash, verify } from '@node-rs/argon2';
import {
  ChangePasswordInput, changePasswordSchema, ERROR_CODES, LoginInput, loginSchema, preferencesSchema,
} from '@cps/shared';
import type { Request, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import {
  AccessContext, AccessTokenPayload, AllowWhenPasswordChangeRequired, Ctx, Public,
} from '../common/auth';
import { AppError } from '../common/errors';
import { ScopeService } from '../common/scope';
import { zBody } from '../common/validation';
import { config } from '../config';
import { PrismaService } from '../infra/prisma.service';

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
export const REFRESH_COOKIE = 'cps_rt';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

// Argon2id, OWASP-recommended parameters (19 MiB is the OWASP minimum; we use 64 MiB).
const ARGON_OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  hash(plain: string) {
    return hash(plain, ARGON_OPTS);
  }
  async verify(hashed: string, plain: string) {
    try {
      return await verify(hashed, plain);
    } catch {
      return false;
    }
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  // Constant-time-ish behaviour for unknown users: verify against a dummy hash.
  private dummyHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
  ) {
    this.dummyHash = this.passwords.hash(randomUUID());
  }

  private async schoolId(): Promise<bigint> {
    const school = await this.prisma.school.findUnique({ where: { code: config().SCHOOL_CODE } });
    if (!school) throw new AppError(503, ERROR_CODES.UNAUTHENTICATED, 'School is not set up yet. Run the database seed.');
    return school.id;
  }

  async login(input: LoginInput, req: Request) {
    const schoolId = await this.schoolId();
    const login = input.login.trim();
    const user = await this.prisma.user.findFirst({
      where: { schoolId, OR: [{ username: login }, ...(/^\d{10}$/.test(login) ? [{ mobile: login }] : [])] },
    });
    const meta = { schoolId, requestId: randomUUID(), ip: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null };

    if (!user) {
      await this.passwords.verify(await this.dummyHash, input.password);
      throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'Incorrect username or password');
    }
    if (user.status !== 'ACTIVE') throw new AppError(403, ERROR_CODES.ACCOUNT_DISABLED, 'This account is disabled. Contact the school admin.');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, ERROR_CODES.ACCOUNT_LOCKED, `Too many failed attempts. Try again after ${user.lockedUntil.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
    }

    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.record({ ...meta, userId: user.id }, { action: lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', entityType: 'User', entityId: user.id });
      throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'Incorrect username or password');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await this.audit.record({ ...meta, userId: user.id }, { action: 'LOGIN', entityType: 'User', entityId: user.id });
    const refresh = await this.issueRefresh(user.id, randomUUID(), req);
    return { accessToken: await this.signAccess(user.id, user.schoolId), refresh, mustChangePassword: user.mustChangePassword };
  }

  private signAccess(userId: bigint, schoolId: bigint) {
    const payload: AccessTokenPayload = { sub: String(userId), sch: String(schoolId) };
    return this.jwt.signAsync(payload, { expiresIn: config().ACCESS_TOKEN_TTL_SECONDS });
  }

  private async issueRefresh(userId: bigint, familyId: string, req: Request) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config().REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const row = await this.prisma.refreshToken.create({
      data: {
        userId, familyId, tokenHash: sha256(token), expiresAt,
        ip: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      },
    });
    return { token, expiresAt, id: row.id };
  }

  /**
   * Rotating refresh tokens with reuse detection: presenting an already-rotated token
   * revokes the whole family (someone copied the cookie).
   */
  async refresh(token: string | undefined, req: Request) {
    const unauth = () => new AppError(401, ERROR_CODES.UNAUTHENTICATED, 'Your session has expired. Please sign in again.');
    if (!token) throw unauth();
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!row) throw unauth();
    if (row.revokedAt) {
      await this.prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(
        { schoolId: row.user.schoolId, userId: row.userId, requestId: randomUUID(), ip: req.ip ?? null, userAgent: null },
        { action: 'REFRESH_TOKEN_REUSE', entityType: 'User', entityId: row.userId },
      );
      throw unauth();
    }
    if (row.expiresAt < new Date() || row.user.status !== 'ACTIVE') throw unauth();

    const next = await this.issueRefresh(row.userId, row.familyId, req);
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: next.id },
    });
    if (rotated.count === 0) throw unauth(); // concurrent refresh lost the race
    return { accessToken: await this.signAccess(row.userId, row.user.schoolId), refresh: next };
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (row) await this.prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async changePassword(ctx: AccessContext, input: ChangePasswordInput) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, 'Current password is incorrect', [
        { path: 'currentPassword', code: 'incorrect', message: 'Current password is incorrect' },
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await this.passwords.hash(input.newPassword), mustChangePassword: false, passwordChangedAt: new Date() },
      });
      // Sign out every other device.
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(ctx, { action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id }, tx);
    });
  }

  async me(ctx: AccessContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      include: { staff: true, school: true, roles: { include: { role: true } } },
    });
    const prefs = (user.preferences ?? {}) as { academicYearId?: number; mediumId?: number; language?: string };
    const currentYear =
      (prefs.academicYearId && (await this.prisma.academicYear.findFirst({ where: { id: BigInt(prefs.academicYearId), schoolId: ctx.schoolId } }))) ||
      (await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } }));
    const scope = currentYear ? await this.scope.resolve(ctx, currentYear.id) : null;
    return {
      id: user.id,
      username: user.username,
      mobile: user.mobile,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
      staff: user.staff ? { id: user.staff.id, name: user.staff.name, employeeCode: user.staff.employeeCode } : null,
      school: { id: user.school.id, name: user.school.name, nameHi: user.school.nameHi, logoFileId: user.school.logoFileId },
      roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name, scopeType: r.scopeType, scopeId: r.scopeId })),
      permissions: [...ctx.permissions].sort(),
      preferences: { language: prefs.language ?? 'en', academicYearId: currentYear?.id ?? null, mediumId: prefs.mediumId ?? null },
      scope: scope ? { all: scope.all, sectionIds: scope.sectionIds, byRole: scope.byRole } : null,
    };
  }

  async updatePreferences(ctx: AccessContext, input: z.infer<typeof preferencesSchema>) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const merged = { ...((user.preferences ?? {}) as object), ...input };
    await this.prisma.user.update({ where: { id: ctx.userId }, data: { preferences: merged } });
    return merged;
  }
}

function setRefreshCookie(res: Response, token: string, expires: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config().NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires,
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: config().LOGIN_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body(zBody(loginSchema)) body: LoginInput, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body, req);
    setRefreshCookie(res, r.refresh.token, r.refresh.expiresAt);
    return { accessToken: r.accessToken, mustChangePassword: r.mustChangePassword };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], req);
    setRefreshCookie(res, r.refresh.token, r.refresh.expiresAt);
    return { accessToken: r.accessToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  @AllowWhenPasswordChangeRequired()
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@Ctx() ctx: AccessContext, @Body(zBody(changePasswordSchema)) body: ChangePasswordInput) {
    await this.auth.changePassword(ctx, body);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @AllowWhenPasswordChangeRequired()
  @Get()
  me(@Ctx() ctx: AccessContext) {
    return this.auth.me(ctx);
  }

  @Patch('preferences')
  prefs(@Ctx() ctx: AccessContext, @Body(zBody(preferencesSchema)) body: z.infer<typeof preferencesSchema>) {
    return this.auth.updatePreferences(ctx, body);
  }
}

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, PasswordService],
  exports: [PasswordService],
})
export class AuthModule {}
