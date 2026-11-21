import { Global, Injectable, Module } from '@nestjs/common';
import type { AssignmentRole } from '@cps/shared';
import { PrismaService } from '../infra/prisma.service';
import type { AccessContext } from './auth';
import { outOfScope } from './errors';

/**
 * Resolves WHICH records a user may see/act on (data scope), separate from WHAT they may do (permissions).
 *
 * - Viewing: SCHOOL scope (or super admin) sees all; MEDIUM / CLASS / SECTION scopes see that slice;
 *   ASSIGNED sees divisions from any active assignment in the academic year.
 * - Acting: each workflow action is checked against the assignment of the matching role, never the
 *   union. A user who is both Operator and Subject Teacher of 5-A may enter data there (operator) but the
 *   workflow forbids verifying their own entry (docs/07 §separation of duties).
 */
export interface ResolvedScope {
  all: boolean;
  /** Divisions the user may VIEW. Empty + all=false means nothing. */
  sectionIds: bigint[];
  /** Divisions per assignment role (for ACTIONS). */
  byRole: Record<AssignmentRole, bigint[]>;
  /** (division, class-subject) pairs where the user is the assigned subject teacher. */
  subjectPairs: { sectionId: bigint; classSubjectId: bigint }[];
}

const emptyByRole = (): ResolvedScope['byRole'] => ({ OPERATOR: [], SUBJECT_TEACHER: [], CLASS_TEACHER: [], ATTENDANCE_VERIFIER: [] });
const uniq = (ids: bigint[]) => [...new Set(ids.map(String))].map(BigInt);

@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(ctx: AccessContext, academicYearId: bigint): Promise<ResolvedScope> {
    const scope: ResolvedScope = { all: false, sectionIds: [], byRole: emptyByRole(), subjectPairs: [] };

    // Assignments always count for actions, even for users who can view the whole school.
    if (ctx.staffId) {
      const assignments = await this.prisma.teachingAssignment.findMany({
        where: { staffId: ctx.staffId, academicYearId, status: 'ACTIVE' },
        select: { role: true, sectionId: true, classSubjectId: true },
      });
      for (const a of assignments) {
        scope.byRole[a.role as AssignmentRole]?.push(a.sectionId);
        if (a.role === 'SUBJECT_TEACHER' && a.classSubjectId) scope.subjectPairs.push({ sectionId: a.sectionId, classSubjectId: a.classSubjectId });
      }
    }
    for (const k of Object.keys(scope.byRole) as AssignmentRole[]) scope.byRole[k] = uniq(scope.byRole[k]);

    if (ctx.isSuperAdmin || ctx.roles.some((r) => r.scopeType === 'SCHOOL')) {
      scope.all = true;
      return scope;
    }

    const view: bigint[] = [];
    if (ctx.roles.some((r) => r.scopeType === 'ASSIGNED')) view.push(...Object.values(scope.byRole).flat());
    const mediumIds = ctx.roles.filter((r) => r.scopeType === 'MEDIUM' && r.scopeId).map((r) => r.scopeId!);
    const classIds = ctx.roles.filter((r) => r.scopeType === 'CLASS' && r.scopeId).map((r) => r.scopeId!);
    view.push(...ctx.roles.filter((r) => r.scopeType === 'SECTION' && r.scopeId).map((r) => r.scopeId!));
    if (mediumIds.length || classIds.length) {
      const sections = await this.prisma.section.findMany({
        where: { schoolClass: { academicYearId, OR: [{ mediumId: { in: mediumIds } }, { id: { in: classIds } }] } },
        select: { id: true },
      });
      view.push(...sections.map((s) => s.id));
    }
    scope.sectionIds = uniq(view);
    return scope;
  }

  canView(scope: ResolvedScope, sectionId: bigint): boolean {
    return scope.all || scope.sectionIds.some((s) => s === sectionId);
  }

  /** Throw 403 OUT_OF_SCOPE unless the user holds `role` for this division (and subject, for subject teachers). */
  assertAssigned(scope: ResolvedScope, role: AssignmentRole, sectionId: bigint, classSubjectId?: bigint) {
    const ok =
      role === 'SUBJECT_TEACHER'
        ? scope.subjectPairs.some((p) => p.sectionId === sectionId && (classSubjectId === undefined || p.classSubjectId === classSubjectId))
        : scope.byRole[role].some((s) => s === sectionId);
    if (!ok) throw outOfScope(`You are not assigned as ${role.toLowerCase().replace('_', ' ')} for this division${role === 'SUBJECT_TEACHER' ? ' and subject' : ''}`);
  }

  /** Prisma `where` fragment for section-keyed tables (viewing). */
  sectionFilter(scope: ResolvedScope): { in: bigint[] } | undefined {
    return scope.all ? undefined : { in: scope.sectionIds };
  }
}

@Global()
@Module({ providers: [ScopeService], exports: [ScopeService] })
export class ScopeModule {}
