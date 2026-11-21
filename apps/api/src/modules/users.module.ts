import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ALL_PERMISSIONS, SENSITIVE_PERMISSIONS, listQuerySchema, PERMISSION_META, PERMISSIONS, resetPasswordSchema, RoleInput, roleSchema,
  roleUpdateSchema, SYSTEM_ROLES, UserCreateInput, userCreateSchema, UserUpdateInput, userUpdateSchema,
} from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { forbidden, invalid, notFound } from '../common/errors';
import { page, skipTake } from '../common/serialize';
import { big, IdPipe, zBody } from '../common/validation';
import { PrismaService, Tx } from '../infra/prisma.service';
import { AuthModule, PasswordService } from './auth.module';

const P = PERMISSIONS;
type Grant = UserCreateInput['roles'][number];
const userListQuery = listQuerySchema.extend({ roleId: z.coerce.number().int().positive().optional() });

const userInclude = {
  staff: { select: { id: true, name: true, employeeCode: true } },
  roles: { include: { role: { select: { id: true, code: true, name: true } } } },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly passwords: PasswordService) {}

  async list(ctx: AccessContext, q: z.infer<typeof userListQuery>) {
    const where = {
      schoolId: ctx.schoolId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.roleId ? { roles: { some: { roleId: BigInt(q.roleId) } } } : {}),
      ...(q.q ? { OR: [{ username: { contains: q.q } }, { mobile: { contains: q.q } }, { staff: { name: { contains: q.q } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, include: userInclude, orderBy: { username: 'asc' }, ...skipTake(q) }),
      this.prisma.user.count({ where }),
    ]);
    return page(rows, total, q);
  }

  async get(ctx: AccessContext, id: bigint) {
    const u = await this.prisma.user.findFirst({ where: { id, schoolId: ctx.schoolId }, include: userInclude });
    if (!u) throw notFound('User');
    return u;
  }

  /**
   * Role grants: roles must belong to the school, scopes must point at real records, and a caller
   * can never grant permissions they do not hold themselves (prevents privilege escalation).
   */
  private async validateGrants(ctx: AccessContext, grants: Grant[], staffId: bigint | null) {
    const roles = await this.prisma.role.findMany({
      where: { id: { in: grants.map((g) => BigInt(g.roleId)) }, schoolId: ctx.schoolId },
      include: { permissions: { include: { permission: true } } },
    });
    const errors: { path: string; code: string; message: string }[] = [];
    for (const [i, g] of grants.entries()) {
      const role = roles.find((r) => r.id === BigInt(g.roleId));
      const path = `roles.${i}`;
      if (!role) { errors.push({ path, code: 'not_found', message: 'Role not found' }); continue; }
      if (!ctx.isSuperAdmin) {
        if (role.code === SYSTEM_ROLES.SUPER_ADMIN) throw forbidden('Only a Super Admin can grant the Super Admin role');
        // Sensitive powers (approvals, user/role admin, assignments, school-wide data) can only be passed on
        // by someone who holds them. Ordinary data-entry roles (Operator) can be granted by any user admin.
        const missing = role.permissions.filter((rp) => (SENSITIVE_PERMISSIONS as string[]).includes(rp.permission.code) && !ctx.permissions.has(rp.permission.code));
        if (missing.length) throw forbidden(`You cannot grant "${role.name}" because it includes permissions you do not have`);
      }
      if (g.scopeType === 'SCHOOL' || g.scopeType === 'ASSIGNED') {
        if (g.scopeId != null) errors.push({ path, code: 'scope', message: 'This scope does not take a target' });
        if (g.scopeType === 'ASSIGNED' && !staffId) errors.push({ path, code: 'scope', message: '"Assigned classes" scope needs the user to be linked to a staff member' });
      } else {
        if (g.scopeId == null) { errors.push({ path, code: 'scope', message: 'Choose the medium, class or division for this scope' }); continue; }
        const id = BigInt(g.scopeId);
        const exists =
          g.scopeType === 'MEDIUM' ? await this.prisma.medium.count({ where: { id, schoolId: ctx.schoolId } })
          : g.scopeType === 'CLASS' ? await this.prisma.schoolClass.count({ where: { id, academicYear: { schoolId: ctx.schoolId } } })
          : await this.prisma.section.count({ where: { id, schoolClass: { academicYear: { schoolId: ctx.schoolId } } } });
        if (!exists) errors.push({ path, code: 'scope', message: 'Scope target not found' });
      }
    }
    if (errors.length) throw invalid('Please correct the role assignments', errors);
  }

  private async validateStaff(ctx: AccessContext, staffId: number | null | undefined, userId?: bigint) {
    if (staffId == null) return null;
    const staff = await this.prisma.staff.findFirst({ where: { id: BigInt(staffId), schoolId: ctx.schoolId }, include: { user: true } });
    if (!staff) throw notFound('Staff member');
    if (staff.user && staff.user.id !== userId) throw invalid(`${staff.name} already has a login (${staff.user.username})`, [{ path: 'staffId', code: 'taken', message: 'Already linked to another user' }]);
    return staff.id;
  }

  private async writeGrants(tx: Tx, ctx: AccessContext, userId: bigint, grants: Grant[]) {
    await tx.userRole.deleteMany({ where: { userId } });
    const seen = new Set<string>();
    for (const g of grants) {
      const k = `${g.roleId}:${g.scopeType}:${g.scopeId ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await tx.userRole.create({ data: { userId, roleId: BigInt(g.roleId), scopeType: g.scopeType, scopeId: big(g.scopeId), createdBy: ctx.userId } });
    }
  }

  async create(ctx: AccessContext, input: UserCreateInput) {
    const staffId = await this.validateStaff(ctx, input.staffId);
    await this.validateGrants(ctx, input.roles, staffId);
    const passwordHash = await this.passwords.hash(input.temporaryPassword);
    return this.prisma.$transaction(async (tx) => {
      const u = await unique(
        () => tx.user.create({
          data: { schoolId: ctx.schoolId, username: input.username, mobile: input.mobile, email: input.email, staffId, passwordHash, mustChangePassword: true, createdBy: ctx.userId },
        }),
        'username', 'This username or mobile number is already used by another login',
      );
      await this.writeGrants(tx, ctx, u.id, input.roles);
      const after = await tx.user.findUniqueOrThrow({ where: { id: u.id }, include: userInclude });
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'User', entityId: u.id, after }, tx);
      return after;
    });
  }

  async update(ctx: AccessContext, id: bigint, input: UserUpdateInput) {
    const before = await this.get(ctx, id);
    const staffId = await this.validateStaff(ctx, input.staffId, id);
    await this.validateGrants(ctx, input.roles, staffId);
    const wasSuper = before.roles.some((r) => r.role.code === SYSTEM_ROLES.SUPER_ADMIN);
    if (wasSuper && !ctx.isSuperAdmin) throw forbidden('Only a Super Admin can change a Super Admin account');
    if (id === ctx.userId && input.status !== 'ACTIVE') throw invalidState('You cannot disable your own account');
    if (id === ctx.userId) {
      const key = (g: { roleId: number | bigint; scopeType: string; scopeId?: number | bigint | null }) => `${g.roleId}:${g.scopeType}:${g.scopeId ?? ''}`;
      const now = new Set(before.roles.map((r) => key(r)));
      const next = new Set(input.roles.map((r) => key(r)));
      if (now.size !== next.size || [...next].some((k) => !now.has(k))) {
        throw forbidden('You cannot change your own roles. Ask another administrator.');
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await unique(
        () => tx.user.update({ where: { id }, data: { mobile: input.mobile, email: input.email, staffId, status: input.status, updatedBy: ctx.userId } }),
        'mobile', 'This mobile number is already used by another login',
      );
      await this.writeGrants(tx, ctx, id, input.roles);
      await this.assertSuperAdminRemains(tx, ctx.schoolId);
      if (after.status !== 'ACTIVE') await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      const full = await tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'User', entityId: id, before, after: full }, tx);
      return full;
    });
  }

  private async assertSuperAdminRemains(tx: Tx, schoolId: bigint) {
    const n = await tx.user.count({ where: { schoolId, status: 'ACTIVE', roles: { some: { role: { code: SYSTEM_ROLES.SUPER_ADMIN } } } } });
    if (n === 0) throw invalidState('At least one active Super Admin must remain');
  }

  async resetPassword(ctx: AccessContext, id: bigint, temporaryPassword: string) {
    const u = await this.get(ctx, id);
    if (u.roles.some((r) => r.role.code === SYSTEM_ROLES.SUPER_ADMIN) && !ctx.isSuperAdmin) throw forbidden('Only a Super Admin can reset a Super Admin password');
    const passwordHash = await this.passwords.hash(temporaryPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null, updatedBy: ctx.userId } });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(ctx, { action: 'PASSWORD_RESET', entityType: 'User', entityId: id }, tx);
    });
  }

  async unlock(ctx: AccessContext, id: bigint) {
    await this.get(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
      await this.audit.record(ctx, { action: 'UNLOCK', entityType: 'User', entityId: id }, tx);
    });
  }
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(ctx: AccessContext) {
    const roles = await this.prisma.role.findMany({
      where: { schoolId: ctx.schoolId },
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles.map(({ permissions, _count, ...r }) => ({ ...r, userCount: _count.users, permissions: permissions.map((p) => p.permission.code) }));
  }

  private async setPermissions(tx: Tx, roleId: bigint, codes: string[]) {
    const unknown = codes.filter((c) => !(ALL_PERMISSIONS as string[]).includes(c));
    if (unknown.length) throw invalid(`Unknown permissions: ${unknown.join(', ')}`);
    const perms = await tx.permission.findMany({ where: { code: { in: codes } } });
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (perms.length) await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) });
  }

  async create(ctx: AccessContext, input: RoleInput) {
    return this.prisma.$transaction(async (tx) => {
      const role = await unique(
        () => tx.role.create({ data: { schoolId: ctx.schoolId, code: input.code, name: input.name, isSystem: false, defaultScope: 'SCHOOL', createdBy: ctx.userId } }),
        'code', `Role code ${input.code} already exists`,
      );
      await this.setPermissions(tx, role.id, input.permissions);
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'Role', entityId: role.id, after: { ...role, permissions: input.permissions } }, tx);
      return role;
    });
  }

  async update(ctx: AccessContext, id: bigint, input: Omit<RoleInput, 'code'>) {
    const before = (await this.list(ctx)).find((r) => r.id === id);
    if (!before) throw notFound('Role');
    if (before.code === SYSTEM_ROLES.SUPER_ADMIN) throw invalidState('Super Admin always has every permission and cannot be edited');
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.update({ where: { id }, data: { name: input.name, updatedBy: ctx.userId } });
      await this.setPermissions(tx, id, input.permissions);
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Role', entityId: id, before, after: { ...role, permissions: [...input.permissions].sort() } }, tx);
      return role;
    });
  }
}

const auditQuery = listQuerySchema.extend({
  entityType: z.string().max(40).optional(),
  action: z.string().max(40).optional(),
  userId: z.coerce.number().int().positive().optional(),
  entityId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: AccessContext, q: z.infer<typeof auditQuery>) {
    const where = {
      schoolId: ctx.schoolId,
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.userId ? { userId: BigInt(q.userId) } : {}),
      ...(q.entityId ? { entityId: BigInt(q.entityId) } : {}),
      ...(q.from || q.to ? {
        createdAt: {
          ...(q.from ? { gte: new Date(`${q.from}T00:00:00+05:30`) } : {}),
          ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}),
        },
      } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, ...skipTake(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is bigint => v != null))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } });
    const names = new Map(users.map((u) => [String(u.id), u.username]));
    return page(rows.map((r) => ({ ...r, username: r.userId ? names.get(String(r.userId)) ?? null : null })), total, q);
  }

  async facets(ctx: AccessContext) {
    const [entities, actions] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { schoolId: ctx.schoolId }, distinct: ['entityType'], select: { entityType: true } }),
      this.prisma.auditLog.findMany({ where: { schoolId: ctx.schoolId }, distinct: ['action'], select: { action: true } }),
    ]);
    return { entityTypes: entities.map((e) => e.entityType).sort(), actions: actions.map((a) => a.action).sort() };
  }
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** Phase 1 dashboard: real setup progress counts. Student/attendance/exam cards arrive with their modules. */
  async setup(ctx: AccessContext) {
    const s = ctx.schoolId;
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: s, isCurrent: true } });
    const yearWhere = year ? { academicYearId: year.id } : { academicYearId: BigInt(0) };
    const [school, mediums, standards, classes, sections, subjects, staff, users, gradingSystems, classTeacherCount, classesWithoutSubjects, sectionsWithoutOperator] = await Promise.all([
      this.prisma.school.findUniqueOrThrow({ where: { id: s } }),
      this.prisma.medium.count({ where: { schoolId: s, status: 'ACTIVE' } }),
      this.prisma.standard.count({ where: { schoolId: s, status: 'ACTIVE' } }),
      this.prisma.schoolClass.count({ where: { ...yearWhere, status: 'ACTIVE' } }),
      this.prisma.section.count({ where: { status: 'ACTIVE', schoolClass: { ...yearWhere, status: 'ACTIVE' } } }),
      this.prisma.subject.count({ where: { schoolId: s, status: 'ACTIVE' } }),
      this.prisma.staff.count({ where: { schoolId: s, status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { schoolId: s, status: 'ACTIVE' } }),
      this.prisma.gradingSystem.count({ where: { schoolId: s, status: 'ACTIVE' } }),
      this.prisma.teachingAssignment.count({ where: { ...yearWhere, role: 'CLASS_TEACHER', status: 'ACTIVE' } }),
      this.prisma.schoolClass.count({ where: { ...yearWhere, status: 'ACTIVE', classSubjects: { none: { status: 'ACTIVE' } } } }),
      this.prisma.section.count({ where: { status: 'ACTIVE', schoolClass: { ...yearWhere, status: 'ACTIVE' }, assignments: { none: { role: 'OPERATOR', status: 'ACTIVE' } } } }),
    ]);
    const unassignedSubjects = year
      ? await this.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*) AS n FROM sections s
          JOIN classes c ON c.id = s.class_id AND c.academic_year_id = ${year.id} AND c.status = 'ACTIVE'
          JOIN class_subjects cs ON cs.class_id = c.id AND cs.status = 'ACTIVE'
          WHERE s.status = 'ACTIVE' AND NOT EXISTS (
            SELECT 1 FROM teaching_assignments ta WHERE ta.section_id = s.id AND ta.class_subject_id = cs.id
              AND ta.role = 'SUBJECT_TEACHER' AND ta.status = 'ACTIVE')`
      : [{ n: BigInt(0) }];
    return {
      currentYear: year ? { id: year.id, name: year.name, startDate: year.startDate, endDate: year.endDate } : null,
      counts: { mediums, standards, classes, sections, subjects, staff, users, gradingSystems },
      gaps: {
        profileIncomplete: !school.logoFileId || !school.principalName,
        sectionsWithoutClassTeacher: Math.max(0, sections - classTeacherCount),
        sectionsWithoutOperator,
        classesWithoutSubjects,
        subjectSlotsWithoutTeacher: Number(unassignedSubjects[0]?.n ?? 0),
      },
    };
  }
}

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService, private readonly roles: RolesService,
    private readonly auditLogs: AuditLogsService, private readonly dashboard: DashboardService,
  ) {}

  @Get('users') @RequirePermission(P.USERS_MANAGE)
  list(@Ctx() ctx: AccessContext, @Query(zBody(userListQuery)) q: z.infer<typeof userListQuery>) { return this.users.list(ctx, q); }

  @Get('users/:id') @RequirePermission(P.USERS_MANAGE)
  get(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.users.get(ctx, id); }

  @Post('users') @RequirePermission(P.USERS_MANAGE)
  create(@Ctx() ctx: AccessContext, @Body(zBody(userCreateSchema)) b: UserCreateInput) { return this.users.create(ctx, b); }

  @Patch('users/:id') @RequirePermission(P.USERS_MANAGE)
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(userUpdateSchema)) b: UserUpdateInput) { return this.users.update(ctx, id, b); }

  @Post('users/:id/reset-password') @HttpCode(204) @RequirePermission(P.USERS_MANAGE)
  reset(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(resetPasswordSchema)) b: z.infer<typeof resetPasswordSchema>) {
    return this.users.resetPassword(ctx, id, b.temporaryPassword);
  }

  @Post('users/:id/unlock') @HttpCode(204) @RequirePermission(P.USERS_MANAGE)
  unlock(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.users.unlock(ctx, id); }

  // Users managers need the role list to grant roles.
  @Get('roles') @RequirePermission(P.USERS_MANAGE)
  roleList(@Ctx() ctx: AccessContext) { return this.roles.list(ctx); }

  @Post('roles') @RequirePermission(P.ROLES_MANAGE)
  roleCreate(@Ctx() ctx: AccessContext, @Body(zBody(roleSchema)) b: RoleInput) { return this.roles.create(ctx, b); }

  @Patch('roles/:id') @RequirePermission(P.ROLES_MANAGE)
  roleUpdate(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(roleUpdateSchema)) b: Omit<RoleInput, 'code'>) { return this.roles.update(ctx, id, b); }

  @Get('permissions') @RequirePermission(P.USERS_MANAGE)
  permissions() { return PERMISSION_META; }

  @Get('audit-logs') @RequirePermission(P.AUDIT_READ)
  audit(@Ctx() ctx: AccessContext, @Query(zBody(auditQuery)) q: z.infer<typeof auditQuery>) { return this.auditLogs.list(ctx, q); }

  @Get('audit-logs/facets') @RequirePermission(P.AUDIT_READ)
  auditFacets(@Ctx() ctx: AccessContext) { return this.auditLogs.facets(ctx); }

  @Get('dashboard/setup')
  setup(@Ctx() ctx: AccessContext) { return this.dashboard.setup(ctx); }
}

@Module({ imports: [AuthModule], controllers: [UsersController], providers: [UsersService, RolesService, AuditLogsService, DashboardService] })
export class UsersModule {}
