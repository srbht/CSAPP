import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Put, Query } from '@nestjs/common';
import {
  ERROR_CODES, MARK_PARTS, type MarkPartKey, type MarkPattern, missingParts, monthLabel, monthsBetween, partErrors, partTotals, PERMISSIONS, progressBucket, PROGRESS_BUCKETS, type ProgressBucket, RejectInput,
  rejectSchema, REVIEW_STAGES, SaveRowsInput, saveRowsSchema, type Stage, stageIndex, UnitKey, unitKeySchema,
} from '@cps/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { AppError, forbidden, invalid, notFound, outOfScope } from '../common/errors';
import { ResolvedScope, ScopeService } from '../common/scope';
import { IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';
import { patternOf } from './exams.module';

const P = PERMISSIONS;
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));

/**
 * The approval engine (docs/07 §4). Every status change of marks and attendance goes through this service.
 *
 * A unit of work ("submission") is one exam · division · subject (MARKS) or one division · month (ATTENDANCE).
 * Each student row remembers the last stage it passed. At a review stage only rows that have not passed it are
 * reviewed; any edit resets a row to OPERATOR so it re-runs every stage (partial rejection, docs/07 §4).
 */
type Row = {
  id: bigint; enrollmentId: bigint; version: number; rowStatus: string; passedStage: string; verifiedHash: string | null;
  rejectReason: string | null; rejectedStage: string | null; updatedBy: bigint | null;
  marks1?: Prisma.Decimal | null; marks2?: Prisma.Decimal | null; parts?: Prisma.JsonValue | null; absent?: boolean; presentDays?: Prisma.Decimal | null;
};

/** Part values in a stable form (sorted keys, empty parts left out) so equal marks always hash the same. */
const normParts = (p: Prisma.JsonValue | Record<string, number | null> | null | undefined) =>
  Object.entries((p ?? {}) as Record<string, number | string | null>).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === 'string' ? v : Number(v)] as const).sort(([a], [b]) => a.localeCompare(b));

/**
 * Mark sheets with a Unit Test (OBT) column go in two steps. Step 1: only OBT is entered, sent and approved through the
 * whole chain, then locked. Step 2: the rest of the semester marks are entered and sent; the final approval locks all.
 */
const UNIT_TEST_PART = 'OBT';
const lockedOf = (sub: { lockedParts?: Prisma.JsonValue | null } | null | undefined) => (Array.isArray(sub?.lockedParts) ? (sub!.lockedParts as string[]) : []);
const inUnitTestStep = (pattern: MarkPattern | null | undefined, sub: { lockedParts?: Prisma.JsonValue | null; status: string } | null | undefined) =>
  !!pattern?.some((p) => p.key === UNIT_TEST_PART) && !lockedOf(sub).includes(UNIT_TEST_PART) && sub?.status !== 'APPROVED';
/** A part's value for comparing: '' / 'AB' / 'C' / '12'. */
const partText = (v: unknown) => (v == null || v === '' ? '' : typeof v === 'string' ? v.trim().toUpperCase() : String(Number(v)));

const sectionSelect = {
  id: true, name: true, classId: true,
  schoolClass: { select: { id: true, displayName: true, academicYearId: true, medium: { select: { id: true, code: true, nameEn: true } }, standard: { select: { id: true, code: true, levelOrder: true } }, academicYear: { select: { id: true, schoolId: true, name: true, status: true, startDate: true, endDate: true } } } },
} as const;

export const unitKeyOf = (u: UnitKey) => (u.recordType === 'MARKS' ? `M:${u.examId}:${u.sectionId}:${u.classSubjectId}` : `A:${u.sectionId}:${u.period}`);

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scopes: ScopeService) {}

  private rows(tx: Tx | PrismaService, type: string) {
    // Both tables share the workflow columns; the delegate is chosen by record type.
    return (type === 'MARKS' ? tx.mark : tx.attendanceMonthly) as unknown as {
      findMany: (a: object) => Promise<Row[]>; update: (a: object) => Promise<Row>; create: (a: object) => Promise<Row>; updateMany: (a: object) => Promise<unknown>;
    };
  }

  private hash(type: string, r: Partial<Row>, workingDays?: number | null) {
    const v = type === 'MARKS' ? [num(r.marks1), num(r.marks2), !!r.absent, normParts(r.parts)] : [num(r.presentDays), workingDays ?? null];
    return createHash('sha256').update(JSON.stringify(v)).digest('hex');
  }

  // ------------------------------------------------------------------ unit resolution & permissions

  async resolveUnit(ctx: AccessContext, u: UnitKey) {
    const section = await this.prisma.section.findFirst({ where: { id: BigInt(u.sectionId), schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, select: sectionSelect });
    if (!section) throw notFound('Division');
    const year = section.schoolClass.academicYear;
    if (u.recordType === 'MARKS') {
      const es = await this.prisma.examSubject.findFirst({
        where: { examId: BigInt(u.examId), classSubjectId: BigInt(u.classSubjectId), classSubject: { classId: section.classId }, exam: { academicYearId: year.id } },
        include: { exam: true, classSubject: { include: { subject: { select: { id: true, code: true, nameEn: true, nameHi: true, subjectType: true } } } } },
      });
      if (!es) throw notFound('This subject in this exam for this class');
      return { key: unitKeyOf(u), u, section, year, exam: es.exam, classSubject: es.classSubject, max1: Number(es.max1), max2: num(es.max2), pattern: patternOf(es), period: null as string | null };
    }
    const months = monthsBetween(year.startDate.toISOString(), year.endDate.toISOString());
    if (!months.includes(u.period)) throw invalid(`${monthLabel(u.period)} is outside the academic year ${year.name}`);
    return { key: unitKeyOf(u), u, section, year, exam: null, classSubject: null, max1: null as number | null, max2: null as number | null, pattern: null as MarkPattern | null, period: u.period };
  }
  type = (unit: { u: UnitKey }) => unit.u.recordType;

  private canView(ctx: AccessContext, scope: ResolvedScope, unit: Awaited<ReturnType<WorkflowService['resolveUnit']>>) {
    const s = unit.section.id;
    const readPerm = unit.u.recordType === 'MARKS'
      ? hasPermission(ctx, P.MARKS_READ)
      : [P.ATTENDANCE_MARK, P.ATTENDANCE_VERIFY, P.ATTENDANCE_CORRECT_APPROVE, P.REPORTS_VIEW].some((p) => hasPermission(ctx, p));
    if (!readPerm) return false;
    if (scope.all) return true;
    const has = (r: keyof ResolvedScope['byRole']) => scope.byRole[r].some((x) => x === s);
    if (has('OPERATOR') || has('CLASS_TEACHER')) return true;
    if (unit.u.recordType === 'MARKS') return scope.subjectPairs.some((p) => p.sectionId === s && p.classSubjectId === BigInt((unit.u as { classSubjectId: number }).classSubjectId));
    return has('ATTENDANCE_VERIFIER');
  }

  private canEnter(ctx: AccessContext, scope: ResolvedScope, type: string, sectionId: bigint) {
    const perm = type === 'MARKS' ? P.MARKS_ENTER : P.ATTENDANCE_MARK;
    return hasPermission(ctx, perm) && scope.byRole.OPERATOR.some((x) => x === sectionId);
  }

  /** Can this user act at `stage` for this unit (permission AND assignment)? */
  private async canActAt(ctx: AccessContext, scope: ResolvedScope, type: string, stage: string, sectionId: bigint, classSubjectId: bigint | null) {
    const ct = scope.byRole.CLASS_TEACHER.some((x) => x === sectionId);
    if (stage === 'SUBJECT_VERIFY') {
      if (type === 'MARKS') return hasPermission(ctx, P.MARKS_VERIFY_SUBJECT) && scope.subjectPairs.some((p) => p.sectionId === sectionId && p.classSubjectId === classSubjectId);
      if (!hasPermission(ctx, P.ATTENDANCE_VERIFY)) return false;
      if (scope.byRole.ATTENDANCE_VERIFIER.some((x) => x === sectionId)) return true;
      const verifiers = await this.prisma.teachingAssignment.count({ where: { sectionId, role: 'ATTENDANCE_VERIFIER', status: 'ACTIVE' } });
      return verifiers === 0 && ct; // no verifier assigned: the class teacher verifies
    }
    if (stage === 'CLASS_APPROVE') return ct && hasPermission(ctx, type === 'MARKS' ? P.MARKS_VERIFY_CLASS : P.ATTENDANCE_VERIFY);
    if (stage === 'HEADMASTER_APPROVE') return scope.all && hasPermission(ctx, type === 'MARKS' ? P.MARKS_APPROVE : P.ATTENDANCE_CORRECT_APPROVE);
    return false;
  }

  private stageError(type: string, stage: string) {
    const who = stage === 'SUBJECT_VERIFY' ? (type === 'MARKS' ? 'the assigned subject teacher' : 'the attendance verifier (or class teacher)') : stage === 'CLASS_APPROVE' ? 'the class teacher of this division' : 'the Headmaster';
    return outOfScope(`Only ${who} can do this now`);
  }

  // ------------------------------------------------------------------ read one unit

  async view(ctx: AccessContext, u: UnitKey) {
    const unit = await this.resolveUnit(ctx, u);
    const scope = await this.scopes.resolve(ctx, unit.year.id);
    if (!this.canView(ctx, scope, unit)) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'This sheet is not in your classes');
    const sub = await this.prisma.academicSubmission.findUnique({ where: { unitKey: unit.key } });
    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { sectionId: unit.section.id, OR: [{ status: 'ACTIVE' }, ...(sub ? [{ [u.recordType === 'MARKS' ? 'marks' : 'attendance']: { some: { submissionId: sub.id } } }] : [])] },
      include: { student: { select: { id: true, fullName: true, fullNameHi: true, gender: true } } },
      orderBy: [{ rollNo: 'asc' }, { student: { fullName: 'asc' } }],
    });
    const rows = sub ? await this.rows(this.prisma, u.recordType).findMany({ where: { submissionId: sub.id } }) : [];
    const byEnr = new Map(rows.map((r) => [String(r.enrollmentId), r]));
    const stage = (sub?.stage ?? 'OPERATOR') as Stage;
    const reviewing = REVIEW_STAGES.includes(stage);
    const canReview = reviewing && sub?.status === 'SUBMITTED' && (await this.canActAt(ctx, scope, u.recordType, stage, unit.section.id, unit.classSubject?.id ?? null));
    const ownWork = !!sub && (sub.submittedBy === ctx.userId || rows.some((r) => stageIndex(r.passedStage) < stageIndex(stage) && r.updatedBy === ctx.userId));
    // Marks are entered only on a blank mark sheet the Headmaster generated.
    const blankSheet = u.recordType === 'MARKS'
      ? await this.prisma.blankMarkSheet.findFirst({ where: { examId: unit.exam!.id, sectionId: unit.section.id, classSubjectId: unit.classSubject!.id }, select: { id: true, sheetNo: true } })
      : null;
    const editable = stage === 'OPERATOR' && sub?.status !== 'APPROVED' && this.canEnter(ctx, scope, u.recordType, unit.section.id) && unit.year.status !== 'CLOSED' && unit.exam?.status !== 'ARCHIVED'
      && (u.recordType !== 'MARKS' || !!blankSheet);
    // Mark sheets sent back one step: the holder of this step sends it further down or back up.
    const returned = u.recordType === 'MARKS' && sub?.status === 'RETURNED' && REVIEW_STAGES.includes(stage)
      && (await this.canActAt(ctx, scope, u.recordType, stage, unit.section.id, unit.classSubject?.id ?? null));
    const locked = lockedOf(sub);
    const unitTestStep = u.recordType === 'MARKS' && inUnitTestStep(unit.pattern, sub);
    const hasUnitTest = u.recordType === 'MARKS' && !!unit.pattern?.some((p) => p.key === UNIT_TEST_PART);
    const actions = sub ? await this.prisma.verificationAction.findMany({ where: { submissionId: sub.id }, orderBy: { createdAt: 'desc' }, take: 50 }) : [];
    const [classTeacher, operators] = await Promise.all([
      this.prisma.teachingAssignment.findFirst({ where: { sectionId: unit.section.id, role: 'CLASS_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } }),
      this.prisma.teachingAssignment.findMany({ where: { sectionId: unit.section.id, role: 'OPERATOR', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } }),
    ]);
    const subjectTeacher = u.recordType === 'MARKS'
      ? await this.prisma.teachingAssignment.findFirst({ where: { sectionId: unit.section.id, classSubjectId: unit.classSubject!.id, role: 'SUBJECT_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } })
      : await this.prisma.teachingAssignment.findFirst({ where: { sectionId: unit.section.id, role: 'ATTENDANCE_VERIFIER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } });
    return {
      unit: {
        key: unit.key, ...u, section: unit.section, exam: unit.exam, classSubject: unit.classSubject, max1: unit.max1, max2: unit.max2, pattern: unit.pattern, period: unit.period,
      },
      people: { operators: operators.map((o) => o.staff.name), firstReviewer: subjectTeacher?.staff.name ?? (u.recordType === 'ATTENDANCE' ? classTeacher?.staff.name ?? null : null), classTeacher: classTeacher?.staff.name ?? null },
      submission: sub,
      blankSheet,
      /** Mark sheets with a Unit Test column: UNIT_TEST = step 1 (OBT only), FINAL = step 2 (the rest). */
      step: !hasUnitTest ? null : unitTestStep ? 'UNIT_TEST' : 'FINAL',
      lockedParts: locked,
      bucket: progressBucket(sub),
      rows: enrollments.map((e) => {
        const r = byEnr.get(String(e.id));
        return {
          enrollmentId: e.id, rollNo: e.rollNo, examNo: e.examNo, student: e.student, enrollmentStatus: e.status,
          id: r?.id ?? null, version: r?.version ?? null, rowStatus: r?.rowStatus ?? null, passedStage: r?.passedStage ?? null,
          rejectReason: r?.rejectReason ?? null, rejectedStage: r?.rejectedStage ?? null,
          marks1: num(r?.marks1), marks2: num(r?.marks2), parts: (r?.parts ?? null) as Record<string, number | null> | null, absent: r?.absent ?? false, presentDays: num(r?.presentDays),
          needsReview: !!r && reviewing && stageIndex(r.passedStage) < stageIndex(stage),
        };
      }),
      can: {
        edit: editable,
        // Attendance in correction: only the rows sent back are editable. Mark sheets come back whole.
        editRowsLimited: editable && sub?.status === 'CORRECTION_REQUIRED' && u.recordType !== 'MARKS',
        // Mark sheets: "send back" goes one step down; a returned sheet can also go back up.
        sendDown: u.recordType === 'MARKS' && ((canReview && !ownWork) || returned),
        returnUp: returned,
        lowerStep: u.recordType === 'MARKS' && REVIEW_STAGES.includes(stage) ? (stage === 'SUBJECT_VERIFY' ? 'OPERATOR' : REVIEW_STAGES[REVIEW_STAGES.indexOf(stage) - 1]) : null,
        upperStep: returned ? sub!.returnedFrom : null,
        submit: editable && !!sub,
        /** Mark parts the operator may type in now. */
        editParts: editable && u.recordType === 'MARKS' ? (unitTestStep ? [UNIT_TEST_PART] : (unit.pattern ?? []).map((p) => p.key).filter((k) => !locked.includes(k))) : [],
        /** Whole-subject Absent: not in the unit-test step, and not once a part is locked (use AB in the boxes). */
        absentTick: editable && !unitTestStep && !locked.length,
        reopenUnitTest: locked.includes(UNIT_TEST_PART) && (stage === 'OPERATOR' || sub?.status === 'APPROVED') && scope.all && hasPermission(ctx, P.MARKS_REOPEN),
        review: canReview && !ownWork,
        reopen: sub?.status === 'APPROVED' && scope.all && hasPermission(ctx, u.recordType === 'MARKS' ? P.MARKS_REOPEN : P.ATTENDANCE_CORRECT_APPROVE),
        ownWorkBlocked: canReview && ownWork,
      },
      history: actions,
    };
  }

  // ------------------------------------------------------------------ operator: save rows

  async save(ctx: AccessContext, input: SaveRowsInput) {
    const unit = await this.resolveUnit(ctx, input.unit);
    const type = input.unit.recordType;
    const scope = await this.scopes.resolve(ctx, unit.year.id);
    if (!this.canEnter(ctx, scope, type, unit.section.id)) throw outOfScope('Only an operator assigned to this division can enter this');
    if (unit.year.status === 'CLOSED') throw invalidState('The academic year is closed');
    if (unit.exam?.status === 'ARCHIVED') throw invalidState('This exam was removed (unit tests are no longer used); its marks are kept read-only');
    if (type === 'MARKS' && !(await this.prisma.blankMarkSheet.findFirst({ where: { examId: unit.exam!.id, sectionId: unit.section.id, classSubjectId: unit.classSubject!.id }, select: { id: true } }))) {
      throw invalidState('The Headmaster has not generated the blank mark sheet for this subject yet');
    }

    const enrollments = await this.prisma.studentEnrollment.findMany({ where: { sectionId: unit.section.id }, select: { id: true, rollNo: true, status: true } });
    const enr = new Map(enrollments.map((e) => [String(e.id), e]));
    const errors: { path: string; code: string; message: string }[] = [];
    input.rows.forEach((r, i) => {
      const e = enr.get(String(r.enrollmentId));
      if (!e) errors.push({ path: `rows.${i}.enrollmentId`, code: 'not_in_division', message: 'Student is not in this division' });
      if (type === 'MARKS') {
        if (r.absent) return;
        for (const pe of partErrors(unit.pattern!, r.parts ?? {})) errors.push({ path: `rows.${i}.parts.${pe.key}`, code: 'invalid_part', message: `Roll ${e?.rollNo ?? '?'}: ${pe.message}` });
      }
    });

    const result = await this.prisma.$transaction(async (tx) => {
      let sub = await tx.academicSubmission.findUnique({ where: { unitKey: unit.key } });
      if (sub && sub.stage !== 'OPERATOR') throw invalidState(`This sheet is with the ${sub.stage === 'DONE' ? 'Headmaster (approved and locked)' : sub.stage === 'SUBJECT_VERIFY' ? 'subject teacher' : sub.stage === 'CLASS_APPROVE' ? 'class teacher' : 'Headmaster'} and cannot be changed now`);
      const workingDays = type === 'ATTENDANCE' ? (input.workingDays ?? num(sub?.workingDays)) : null;
      if (type === 'ATTENDANCE') {
        if (input.workingDays == null && sub?.workingDays == null) errors.push({ path: 'workingDays', code: 'required', message: 'Enter the number of working days in the month' });
        input.rows.forEach((r, i) => {
          if (r.presentDays != null && workingDays != null && r.presentDays > workingDays) errors.push({ path: `rows.${i}.presentDays`, code: 'too_high', message: `Roll ${enr.get(String(r.enrollmentId))?.rollNo ?? '?'}: present days are more than working days (${workingDays})` });
        });
      }
      if (errors.length) throw invalid(errors[0].message, errors);

      if (!sub) {
        sub = await tx.academicSubmission.create({
          data: {
            academicYearId: unit.year.id, sectionId: unit.section.id, recordType: type, unitKey: unit.key,
            examId: unit.exam?.id ?? null, classSubjectId: unit.classSubject?.id ?? null, period: unit.period, workingDays, createdBy: ctx.userId,
          },
        });
      }
      const workingChanged = type === 'ATTENDANCE' && num(sub.workingDays) !== workingDays;
      if (workingChanged) await tx.academicSubmission.update({ where: { id: sub.id }, data: { workingDays, updatedBy: ctx.userId } });

      const repo = this.rows(tx, type);
      const existing = new Map((await repo.findMany({ where: { submissionId: sub.id } })).map((r) => [String(r.enrollmentId), r]));
      const changed: { enrollmentId: number; before: unknown; after: unknown }[] = [];
      const unitTestStep = type === 'MARKS' && inUnitTestStep(unit.pattern, sub);
      const locked = lockedOf(sub);
      const closed = type !== 'MARKS' ? [] : (unit.pattern ?? []).map((p) => p.key as string).filter((k) => (unitTestStep ? k !== UNIT_TEST_PART : locked.includes(k)));
      for (const [i, r] of input.rows.entries()) {
        const before = existing.get(String(r.enrollmentId));
        if (closed.length) {
          // Parts not open in this step keep their saved value; changing one is refused.
          const roll = enr.get(String(r.enrollmentId))?.rollNo ?? '?';
          const was = (before?.parts ?? {}) as Record<string, unknown>;
          if (!!r.absent !== !!before?.absent) throw invalidState(`Roll ${roll}: the whole-subject Absent tick cannot be used now. Type AB in the box for the part the student missed.`);
          // After the unit test is locked, an EMPTY OBT box (a student who joined later) may still be filled.
          const bad = closed.find((k) => partText(r.parts?.[k]) !== partText(was[k]) && (unitTestStep || partText(was[k]) !== ''));
          if (bad) {
            throw invalidState(unitTestStep
              ? `Roll ${roll}: only the Unit Test (OBT) can be entered now. The other marks open after the Headmaster approves the unit test.`
              : `Roll ${roll}: the Unit Test (OBT) marks are approved and locked.`);
          }
        }
        const parts = r.absent ? {} : Object.fromEntries(Object.entries(r.parts ?? {}).filter(([, v]) => v != null)) as Record<string, number>;
        const totals = type === 'MARKS' && !r.absent ? partTotals(unit.pattern!, parts) : { marks1: null, marks2: null };
        const values = type === 'MARKS'
          ? { marks1: totals.marks1, marks2: totals.marks2, parts, absent: !!r.absent }
          : { presentDays: r.presentDays ?? null };
        if (before && r.version != null && before.version !== r.version) {
          throw new AppError(409, ERROR_CODES.VERSION_CONFLICT, `Roll ${enr.get(String(r.enrollmentId))?.rollNo}: changed by someone else a moment ago. Reload the sheet.`, [{ path: `rows.${i}`, code: 'version', message: 'Changed by someone else' }]);
        }
        const newHash = this.hash(type, values as Partial<Row>, workingDays);
        if (before && this.hash(type, before, workingDays) === newHash && !workingChanged) continue;
        if (before && sub.status === 'CORRECTION_REQUIRED' && before.rowStatus === 'VERIFIED' && before.verifiedHash !== newHash) {
          throw invalidState(`Roll ${enr.get(String(r.enrollmentId))?.rollNo} was already verified. During correction only the rows sent back can be changed.`);
        }
        const reset = newHash !== before?.verifiedHash;
        const data = { ...values, updatedBy: ctx.userId, ...(reset ? { passedStage: 'OPERATOR', rowStatus: 'PENDING' } : {}) };
        if (before) await repo.update({ where: { id: before.id }, data: { ...data, version: { increment: 1 } } });
        else await repo.create({ data: { ...data, submissionId: sub.id, enrollmentId: BigInt(r.enrollmentId), ...(type === 'MARKS' ? { examId: unit.exam!.id, classSubjectId: unit.classSubject!.id } : { period: unit.period }) } });
        if (sub.revision > 1 || sub.status === 'CORRECTION_REQUIRED') changed.push({ enrollmentId: r.enrollmentId, before: before ? (type === 'MARKS' ? { marks1: num(before.marks1), marks2: num(before.marks2), parts: before.parts, absent: before.absent } : { presentDays: num(before.presentDays) }) : null, after: values });
      }
      // A changed working-days figure changes every student's percentage: all rows re-run all stages.
      if (workingChanged && existing.size) await repo.updateMany({ where: { submissionId: sub.id }, data: { passedStage: 'OPERATOR', rowStatus: 'PENDING' } });
      if (changed.length) await this.audit.record(ctx, { action: 'CORRECT', entityType: type === 'MARKS' ? 'Marks' : 'Attendance', entityId: sub.id, after: { rows: changed } }, tx);
      return sub;
    });
    void result;
    return this.view(ctx, input.unit);
  }

  // ------------------------------------------------------------------ transitions

  /** Row-locks the submission (serialises concurrent decisions) and checks it belongs to the user's school. */
  private async lock(tx: Tx, ctx: AccessContext, id: bigint) {
    await tx.$queryRaw`SELECT id FROM academic_submissions WHERE id = ${id} FOR UPDATE`;
    const sub = await tx.academicSubmission.findUnique({ where: { id }, include: { section: { select: sectionSelect } } });
    if (!sub || sub.section.schoolClass.academicYear.schoolId !== ctx.schoolId) throw notFound('Sheet');
    return sub;
  }

  private async act(tx: Tx, ctx: AccessContext, sub: { id: bigint; revision: number; status: string }, stage: string, action: string, toStatus: string, extra: { comment?: string | null; rowCount?: number; enrollmentIds?: bigint[] } = {}) {
    const user = await tx.user.findUnique({ where: { id: ctx.userId }, include: { staff: { select: { name: true } } } });
    await tx.verificationAction.create({
      data: {
        submissionId: sub.id, revision: sub.revision, stage, action, actorUserId: ctx.userId, actorName: user?.staff?.name ?? user?.username ?? null,
        fromStatus: sub.status, toStatus, comment: extra.comment ?? null, rowCount: extra.rowCount ?? null,
        enrollmentIds: extra.enrollmentIds ? extra.enrollmentIds.map(Number) : undefined,
      },
    });
  }

  /** Next review stage that still has rows which have not passed it. */
  private nextStage(rows: Row[], after: Stage | 'OPERATOR'): Stage {
    for (const s of REVIEW_STAGES) {
      if (stageIndex(s) <= stageIndex(after)) continue;
      if (rows.some((r) => stageIndex(r.passedStage) < stageIndex(s))) return s;
    }
    return 'DONE';
  }

  async submit(ctx: AccessContext, id: bigint, comment?: string) {
    return this.prisma.$transaction(async (tx) => {
      const sub = await this.lock(tx, ctx, id);
      const scope = await this.scopes.resolve(ctx, sub.academicYearId);
      if (!this.canEnter(ctx, scope, sub.recordType, sub.sectionId)) throw outOfScope('Only an operator assigned to this division can submit');
      if (sub.stage !== 'OPERATOR' || sub.status === 'APPROVED') throw invalidState('This sheet has already been submitted');
      const repo = this.rows(tx, sub.recordType);
      const rows = await repo.findMany({ where: { submissionId: id } });
      const active = await tx.studentEnrollment.findMany({ where: { sectionId: sub.sectionId, status: 'ACTIVE' }, select: { id: true, rollNo: true } });
      const byEnr = new Map(rows.map((r) => [String(r.enrollmentId), r]));
      const es = sub.recordType === 'MARKS' ? await tx.examSubject.findFirst({ where: { examId: sub.examId!, classSubjectId: sub.classSubjectId! } }) : null;
      const pattern = es ? patternOf(es) : null;
      const unitTestStep = sub.recordType === 'MARKS' && inUnitTestStep(pattern, sub);
      if (unitTestStep) {
        const empty = active.filter((e) => { const r = byEnr.get(String(e.id)); return !r || (!r.absent && partText((r.parts as Record<string, unknown> | null)?.[UNIT_TEST_PART]) === ''); });
        if (empty.length) {
          throw invalid(`Not complete yet: Unit Test (OBT) is empty for ${empty.length} student${empty.length > 1 ? 's' : ''} (roll ${empty.map((m) => m.rollNo ?? '?').slice(0, 8).join(', ')}${empty.length > 8 ? ' …' : ''}). Type the mark, AB if absent, or C for copying.`);
        }
      }
      const missing = unitTestStep ? [] : active.filter((e) => {
        const r = byEnr.get(String(e.id));
        if (!r) return true;
        if (sub.recordType === 'ATTENDANCE') return r.presentDays == null;
        return !r.absent && missingParts(pattern!, r.parts as Record<string, number | null> | null).length > 0;
      });
      if (sub.recordType === 'ATTENDANCE' && sub.workingDays == null) throw invalid('Enter the number of working days first');
      if (missing.length && sub.recordType === 'MARKS') {
        // Say WHICH boxes are empty: e.g. "Written is empty for 31 students (roll 1, 2, 3 …)".
        const rolls = (l: { rollNo: number | null }[]) => `roll ${l.map((m) => m.rollNo ?? '?').slice(0, 8).join(', ')}${l.length > 8 ? ' …' : ''}`;
        const plural = (n: number) => `${n} student${n > 1 ? 's' : ''}`;
        const none = missing.filter((e) => !byEnr.get(String(e.id)));
        const byPart = new Map<string, { rollNo: number | null }[]>();
        for (const e of missing) {
          const r = byEnr.get(String(e.id));
          if (!r) continue;
          for (const k of missingParts(pattern!, r.parts as Record<string, number | null> | null)) byPart.set(k, [...(byPart.get(k) ?? []), e]);
        }
        const lines = [
          ...[...byPart].map(([k, l]) => `${MARK_PARTS[k as MarkPartKey]?.label ?? k} is empty for ${plural(l.length)} (${rolls(l)})`),
          ...(none.length ? [`no marks at all for ${plural(none.length)} (${rolls(none)})`] : []),
        ];
        throw invalid(`Not complete yet: ${lines.join('; ')}. Type the mark, AB if the student missed only that part, or tick Absent if the student missed the whole subject.`);
      }
      if (missing.length) {
        throw invalid(`${missing.length} student${missing.length > 1 ? 's have' : ' has'} days present missing (roll ${missing.map((m) => m.rollNo ?? '?').slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}).`);
      }
      // Rows sent back go through every stage again; a mark sheet is checked again as a whole.
      await repo.updateMany({ where: { submissionId: id, ...(sub.recordType === 'MARKS' ? {} : { rowStatus: 'REJECTED' }) }, data: { rowStatus: 'PENDING', passedStage: 'OPERATOR' } });
      const fresh = await repo.findMany({ where: { submissionId: id } });
      const next = this.nextStage(fresh, 'OPERATOR');
      const status = next === 'DONE' ? 'APPROVED' : 'SUBMITTED';
      await this.act(tx, ctx, sub, 'OPERATOR', sub.status === 'CORRECTION_REQUIRED' ? 'RESUBMIT' : 'SUBMIT', status, { comment: comment ?? (unitTestStep ? 'Unit Test (OBT) marks' : null), rowCount: fresh.filter((r) => r.passedStage === 'OPERATOR').length });
      const after = await tx.academicSubmission.update({
        where: { id }, data: { stage: next, status, returnedFrom: null, submittedBy: ctx.userId, submittedAt: new Date(), version: { increment: 1 }, updatedBy: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'SUBMIT', entityType: 'AcademicSubmission', entityId: id, before: { stage: sub.stage, status: sub.status }, after: { stage: after.stage, status: after.status } }, tx);
      return after;
    });
  }

  private async reviewChecks(tx: Tx, ctx: AccessContext, id: bigint) {
    const sub = await this.lock(tx, ctx, id);
    const stage = sub.stage as Stage;
    if (!REVIEW_STAGES.includes(stage) || sub.status !== 'SUBMITTED') throw invalidState('This sheet is not waiting for review');
    const scope = await this.scopes.resolve(ctx, sub.academicYearId);
    if (!(await this.canActAt(ctx, scope, sub.recordType, stage, sub.sectionId, sub.classSubjectId))) throw this.stageError(sub.recordType, stage);
    const repo = this.rows(tx, sub.recordType);
    const rows = await repo.findMany({ where: { submissionId: id } });
    const pending = rows.filter((r) => stageIndex(r.passedStage) < stageIndex(stage));
    // Separation of duties: nobody verifies data they entered, whatever other roles they hold.
    if (sub.submittedBy === ctx.userId || pending.some((r) => r.updatedBy === ctx.userId)) throw forbidden('You entered this data, so someone else must verify it');
    return { sub, stage, scope, repo, rows, pending };
  }

  async verify(ctx: AccessContext, id: bigint, comment?: string) {
    return this.prisma.$transaction(async (tx) => {
      const { sub, stage, scope, repo, rows, pending } = await this.reviewChecks(tx, ctx, id);
      // Attendance checked by the class teacher (no separate verifier): counts as the class-teacher approval too.
      const passed: Stage = sub.recordType === 'ATTENDANCE' && stage === 'SUBJECT_VERIFY' && scope.byRole.CLASS_TEACHER.some((x) => x === sub.sectionId) ? 'CLASS_APPROVE' : stage;
      for (const r of pending) {
        await repo.update({ where: { id: r.id }, data: { passedStage: passed, rowStatus: 'VERIFIED', verifiedHash: this.hash(sub.recordType, r, num(sub.workingDays)), rejectReason: null, rejectedStage: null } });
      }
      const after = rows.map((r) => (pending.includes(r) ? { ...r, passedStage: passed } : r));
      const next = this.nextStage(after, passed);
      if (next === 'DONE' && sub.recordType === 'MARKS') {
        const es = await tx.examSubject.findFirst({ where: { examId: sub.examId!, classSubjectId: sub.classSubjectId! } });
        if (inUnitTestStep(es ? patternOf(es) : null, sub)) {
          // Unit Test approved: OBT is locked; the sheet goes back to the operator for the rest of the semester marks.
          await repo.updateMany({ where: { submissionId: id }, data: { passedStage: 'OPERATOR', rowStatus: 'PENDING', verifiedHash: null } });
          await this.act(tx, ctx, sub, stage, 'APPROVE', 'DRAFT', { comment: comment ?? 'Unit Test (OBT) approved and locked', rowCount: pending.length });
          const updated = await tx.academicSubmission.update({
            where: { id },
            data: { stage: 'OPERATOR', status: 'DRAFT', lockedParts: [...lockedOf(sub), UNIT_TEST_PART], returnedFrom: null, version: { increment: 1 }, updatedBy: ctx.userId },
          });
          await this.audit.record(ctx, { action: 'UNIT_TEST_APPROVE', entityType: 'AcademicSubmission', entityId: id, before: { stage }, after: { stage: 'OPERATOR', locked: [UNIT_TEST_PART] } }, tx);
          return updated;
        }
      }
      const status = next === 'DONE' ? 'APPROVED' : 'SUBMITTED';
      await this.act(tx, ctx, sub, stage, stage === 'SUBJECT_VERIFY' ? 'VERIFY' : 'APPROVE', status, { comment, rowCount: pending.length });
      const updated = await tx.academicSubmission.update({
        where: { id },
        data: { stage: next, status, version: { increment: 1 }, updatedBy: ctx.userId, ...(next === 'DONE' ? { approvedBy: ctx.userId, approvedAt: new Date() } : {}) },
      });
      await this.audit.record(ctx, { action: next === 'DONE' ? 'FINAL_APPROVE' : 'VERIFY', entityType: 'AcademicSubmission', entityId: id, before: { stage }, after: { stage: next, status } }, tx);
      return updated;
    });
  }

  /** Reject selected rows (or the whole sheet). Untouched rows are verified at this stage; the sheet goes back to the operator. */
  async reject(ctx: AccessContext, id: bigint, input: RejectInput) {
    return this.prisma.$transaction(async (tx) => {
      const head = await tx.academicSubmission.findUnique({ where: { id }, select: { recordType: true } });
      if (head?.recordType === 'MARKS') return this.marksSendDown(tx, ctx, id, input);
      const { sub, stage, repo, rows, pending } = await this.reviewChecks(tx, ctx, id);
      return this.sendBack(tx, ctx, sub, stage, repo, rows, pending, input, 'REJECT');
    });
  }

  /** Who holds a mark sheet at a review step (reviewing it, or after it was returned to them). */
  private async marksHolder(tx: Tx, ctx: AccessContext, id: bigint, statuses: string[]) {
    const sub = await this.lock(tx, ctx, id);
    const stage = sub.stage as Stage;
    if (sub.recordType !== 'MARKS' || !REVIEW_STAGES.includes(stage) || !statuses.includes(sub.status)) throw invalidState('This mark sheet is not waiting for you');
    const scope = await this.scopes.resolve(ctx, sub.academicYearId);
    if (!(await this.canActAt(ctx, scope, 'MARKS', stage, sub.sectionId, sub.classSubjectId))) throw this.stageError('MARKS', stage);
    const repo = this.rows(tx, 'MARKS');
    const rows = await repo.findMany({ where: { submissionId: id } });
    if (sub.status === 'SUBMITTED' && (sub.submittedBy === ctx.userId || rows.some((r) => r.updatedBy === ctx.userId))) throw forbidden('You entered this data, so someone else must verify it');
    return { sub, stage, repo, rows };
  }

  /**
   * Mark sheet sent back ONE step: Headmaster → class teacher → subject teacher → operator. The whole sheet goes, with
   * the note and the students to correct highlighted. At the operator it is corrected and passes every step again.
   */
  private async marksSendDown(tx: Tx, ctx: AccessContext, id: bigint, input: RejectInput) {
    const { sub, stage, repo, rows } = await this.marksHolder(tx, ctx, id, ['SUBMITTED', 'RETURNED']);
    const lower: Stage | 'OPERATOR' = stage === 'SUBJECT_VERIFY' ? 'OPERATOR' : REVIEW_STAGES[REVIEW_STAGES.indexOf(stage) - 1];
    const ids = input.enrollmentIds?.length ? new Set(input.enrollmentIds.map(String)) : null;
    if (ids && rows.filter((r) => ids.has(String(r.enrollmentId))).length !== ids.size) throw invalid('Some selected students are not on this sheet');
    // The step below reviews the sheet again: rows count as passed up to the step before it.
    const passed = lower === 'CLASS_APPROVE' ? 'SUBJECT_VERIFY' : 'OPERATOR';
    for (const r of rows) {
      const flagged = ids ? ids.has(String(r.enrollmentId)) : !!r.rejectReason;
      await repo.update({
        where: { id: r.id },
        data: { passedStage: passed, rowStatus: flagged ? 'REJECTED' : 'PENDING', rejectReason: flagged ? (ids ? input.reason : r.rejectReason) : null, rejectedStage: flagged ? (ids ? stage : r.rejectedStage) : null },
      });
    }
    const toOperator = lower === 'OPERATOR';
    const status = toOperator ? 'CORRECTION_REQUIRED' : 'RETURNED';
    const flaggedIds = rows.filter((r) => (ids ? ids.has(String(r.enrollmentId)) : !!r.rejectReason)).map((r) => r.enrollmentId);
    await this.act(tx, ctx, sub, stage, 'SEND_BACK', status, { comment: input.reason, rowCount: flaggedIds.length, enrollmentIds: flaggedIds });
    const updated = await tx.academicSubmission.update({
      where: { id: sub.id },
      data: { stage: lower, status, returnedFrom: stage, approvedBy: null, approvedAt: null, ...(toOperator ? { revision: { increment: 1 } } : {}), version: { increment: 1 }, updatedBy: ctx.userId },
    });
    await this.audit.record(ctx, { action: 'SEND_BACK', entityType: 'AcademicSubmission', entityId: sub.id, before: { stage, status: sub.status }, after: { stage: lower, status, students: flaggedIds.length }, reason: input.reason }, tx);
    return updated;
  }

  /** A returned mark sheet goes back up to the step that sent it (with a note): this step's check stands. */
  async returnUp(ctx: AccessContext, id: bigint, input: RejectInput) {
    return this.prisma.$transaction(async (tx) => {
      const { sub, stage, repo, rows } = await this.marksHolder(tx, ctx, id, ['RETURNED']);
      const upper = (sub.returnedFrom ?? REVIEW_STAGES[REVIEW_STAGES.indexOf(stage) + 1]) as Stage;
      for (const r of rows) await repo.update({ where: { id: r.id }, data: { passedStage: stage, rowStatus: r.rejectReason ? 'REJECTED' : 'PENDING' } });
      await this.act(tx, ctx, sub, stage, 'RETURN_UP', 'SUBMITTED', { comment: input.reason });
      const updated = await tx.academicSubmission.update({ where: { id }, data: { stage: upper, status: 'SUBMITTED', returnedFrom: null, version: { increment: 1 }, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'RETURN_UP', entityType: 'AcademicSubmission', entityId: id, before: { stage, status: 'RETURNED' }, after: { stage: upper, status: 'SUBMITTED' }, reason: input.reason }, tx);
      return updated;
    });
  }

  /** Headmaster reopens an approved sheet (reason required). Selected rows, or all, must pass every stage again. */
  async reopen(ctx: AccessContext, id: bigint, input: RejectInput) {
    return this.prisma.$transaction(async (tx) => {
      const sub = await this.lock(tx, ctx, id);
      if (sub.status !== 'APPROVED') throw invalidState('Only an approved sheet can be reopened');
      const scope = await this.scopes.resolve(ctx, sub.academicYearId);
      if (!scope.all || !hasPermission(ctx, sub.recordType === 'MARKS' ? P.MARKS_REOPEN : P.ATTENDANCE_CORRECT_APPROVE)) throw forbidden('Only the Headmaster can reopen approved data');
      const repo = this.rows(tx, sub.recordType);
      const rows = await repo.findMany({ where: { submissionId: id } });
      return this.sendBack(tx, ctx, sub, 'HEADMASTER_APPROVE', repo, rows, [], input, 'REOPEN');
    });
  }

  /** Headmaster reopens an approved Unit Test (OBT), with a reason: it is corrected and goes through every step again. */
  async reopenUnitTest(ctx: AccessContext, id: bigint, input: RejectInput) {
    return this.prisma.$transaction(async (tx) => {
      const sub = await this.lock(tx, ctx, id);
      if (sub.recordType !== 'MARKS' || !lockedOf(sub).includes(UNIT_TEST_PART)) throw invalidState('The unit test of this sheet is not approved yet');
      if (sub.stage !== 'OPERATOR' && sub.status !== 'APPROVED') throw invalidState('The sheet is being checked now; reopen the unit test when it comes back');
      const scope = await this.scopes.resolve(ctx, sub.academicYearId);
      if (!scope.all || !hasPermission(ctx, P.MARKS_REOPEN)) throw forbidden('Only the Headmaster can reopen approved marks');
      await tx.mark.updateMany({ where: { submissionId: id }, data: { passedStage: 'OPERATOR', rowStatus: 'PENDING', verifiedHash: null } });
      await this.act(tx, ctx, sub, 'HEADMASTER_APPROVE', 'REOPEN', 'CORRECTION_REQUIRED', { comment: `Unit Test (OBT) reopened: ${input.reason}` });
      const updated = await tx.academicSubmission.update({
        where: { id },
        data: { stage: 'OPERATOR', status: 'CORRECTION_REQUIRED', lockedParts: lockedOf(sub).filter((k) => k !== UNIT_TEST_PART), revision: { increment: 1 }, approvedBy: null, approvedAt: null, version: { increment: 1 }, updatedBy: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'REOPEN', entityType: 'AcademicSubmission', entityId: id, before: { status: sub.status, locked: lockedOf(sub) }, after: { status: 'CORRECTION_REQUIRED', locked: [] }, reason: `Unit Test (OBT): ${input.reason}` }, tx);
      return updated;
    });
  }

  private async sendBack(
    tx: Tx, ctx: AccessContext, sub: { id: bigint; revision: number; status: string; recordType: string; workingDays: Prisma.Decimal | null },
    stage: Stage, repo: ReturnType<WorkflowService['rows']>, rows: Row[], pending: Row[], input: RejectInput, action: string,
  ) {
    const ids = input.enrollmentIds?.length ? new Set(input.enrollmentIds.map(String)) : null;
    const target = ids ? rows.filter((r) => ids.has(String(r.enrollmentId))) : rows;
    if (ids && target.length !== ids.size) throw invalid('Some selected students are not on this sheet');
    for (const r of target) {
      await repo.update({ where: { id: r.id }, data: { rowStatus: 'REJECTED', passedStage: 'OPERATOR', rejectReason: input.reason, rejectedStage: stage } });
    }
    // Rows the reviewer did not reject count as checked at this stage, so their work is not lost.
    for (const r of pending.filter((p) => !target.includes(p))) {
      await repo.update({ where: { id: r.id }, data: { passedStage: stage, rowStatus: 'VERIFIED', verifiedHash: this.hash(sub.recordType, r, num(sub.workingDays)) } });
    }
    await this.act(tx, ctx, sub, stage, action, 'CORRECTION_REQUIRED', { comment: input.reason, rowCount: target.length, enrollmentIds: target.map((r) => r.enrollmentId) });
    const updated = await tx.academicSubmission.update({
      where: { id: sub.id },
      data: { stage: 'OPERATOR', status: 'CORRECTION_REQUIRED', revision: { increment: 1 }, approvedBy: null, approvedAt: null, version: { increment: 1 }, updatedBy: ctx.userId },
    });
    await this.audit.record(ctx, { action, entityType: 'AcademicSubmission', entityId: sub.id, before: { stage, status: sub.status }, after: { stage: 'OPERATOR', status: 'CORRECTION_REQUIRED', rows: target.length }, reason: input.reason }, tx);
    return updated;
  }

  // ------------------------------------------------------------------ progress overview (who is waiting for whom)

  /**
   * Progress of every unit of work the user can see, per division. For marks: one exam, every subject.
   * For attendance: one month (or every month up to now).
   */
  async summary(ctx: AccessContext, q: z.infer<typeof summaryQuery>) {
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, ...(q.academicYearId ? { id: BigInt(q.academicYearId) } : { isCurrent: true }) } });
    if (!year) throw notFound('Academic year');
    const scope = await this.scopes.resolve(ctx, year.id);
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE' }, ...(scope.all ? {} : { id: { in: scope.sectionIds } }) },
      select: sectionSelect,
    });
    const sectionIds = sections.map((s) => s.id);
    type Item = { key: string; label: string; classSubjectId?: number; period?: string; bucket: ProgressBucket; submissionId: number | null; examId?: number; mine: boolean };
    const units: Map<bigint, Item[]> = new Map(sections.map((s) => [s.id, []]));

    if (q.recordType === 'MARKS') {
      const exam = q.examId
        ? await this.prisma.exam.findFirst({ where: { id: BigInt(q.examId), academicYearId: year.id } })
        : await this.prisma.exam.findFirst({ where: { academicYearId: year.id, status: 'ACTIVE' }, orderBy: { sequence: 'asc' } });
      if (!exam) return { year: { id: year.id, name: year.name }, exam: null, period: null, divisions: [], totals: emptyBuckets() };
      const es = await this.prisma.examSubject.findMany({
        where: { examId: exam.id, classSubject: { classId: { in: sections.map((s) => s.classId) }, status: 'ACTIVE' } },
        include: { classSubject: { include: { subject: { select: { nameEn: true } } } } }, orderBy: { classSubject: { displayOrder: 'asc' } },
      });
      const subs = await this.prisma.academicSubmission.findMany({ where: { examId: exam.id, sectionId: { in: sectionIds } }, select: { id: true, unitKey: true, stage: true, status: true, sectionId: true, classSubjectId: true } });
      const byKey = new Map(subs.map((s) => [s.unitKey, s]));
      for (const s of sections) {
        for (const e of es.filter((x) => x.classSubject.classId === s.classId)) {
          // Subject teachers without school-wide view see only their own subjects in a division.
          const mineSubject = scope.subjectPairs.some((p) => p.sectionId === s.id && p.classSubjectId === e.classSubjectId);
          if (!scope.all && !mineSubject && !scope.byRole.OPERATOR.some((x) => x === s.id) && !scope.byRole.CLASS_TEACHER.some((x) => x === s.id)) continue;
          const key = unitKeyOf({ recordType: 'MARKS', examId: Number(exam.id), sectionId: Number(s.id), classSubjectId: Number(e.classSubjectId) });
          const sub = byKey.get(key);
          units.get(s.id)!.push({ key, label: e.classSubject.subject.nameEn, classSubjectId: Number(e.classSubjectId), examId: Number(exam.id), bucket: progressBucket(sub), submissionId: sub ? Number(sub.id) : null, mine: false });
        }
      }
      await this.markMine(ctx, scope, 'MARKS', units);
      return this.summaryResult(year, sections, units, { exam }, scope);
    }

    const allMonths = monthsBetween(year.startDate.toISOString(), year.endDate.toISOString());
    const now = new Date().toISOString().slice(0, 7);
    const months = q.period ? [q.period] : allMonths.filter((m) => m <= now);
    const subs = await this.prisma.academicSubmission.findMany({ where: { recordType: 'ATTENDANCE', sectionId: { in: sectionIds }, period: { in: months } }, select: { id: true, unitKey: true, stage: true, status: true } });
    const byKey = new Map(subs.map((s) => [s.unitKey, s]));
    for (const s of sections) {
      for (const m of months) {
        const key = unitKeyOf({ recordType: 'ATTENDANCE', sectionId: Number(s.id), period: m });
        const sub = byKey.get(key);
        units.get(s.id)!.push({ key, label: monthLabel(m), period: m, bucket: progressBucket(sub), submissionId: sub ? Number(sub.id) : null, mine: false });
      }
    }
    await this.markMine(ctx, scope, 'ATTENDANCE', units);
    return this.summaryResult(year, sections, units, { period: q.period ?? null, months }, scope);
  }

  /** Flag the units where THIS user is the one who has to act now. */
  private async markMine(ctx: AccessContext, scope: ResolvedScope, type: string, units: Map<bigint, { bucket: ProgressBucket; classSubjectId?: number; mine: boolean }[]>) {
    for (const [sectionId, items] of units) {
      for (const it of items) {
        if (it.bucket === 'APPROVED') continue;
        if (['NOT_STARTED', 'OPERATOR', 'CORRECTION'].includes(it.bucket)) it.mine = this.canEnter(ctx, scope, type, sectionId);
        else it.mine = await this.canActAt(ctx, scope, type, it.bucket, sectionId, it.classSubjectId ? BigInt(it.classSubjectId) : null);
      }
    }
  }

  private summaryResult(
    year: { id: bigint; name: string }, sections: { id: bigint; name: string; schoolClass: { displayName: string; medium: { code: string; nameEn: string }; standard: { code: string; levelOrder: number } } }[],
    units: Map<bigint, { bucket: ProgressBucket; mine: boolean }[]>, extra: Record<string, unknown>, scope: ResolvedScope,
  ) {
    const totals = emptyBuckets();
    const divisions = sections
      .map((s) => {
        const items = units.get(s.id) ?? [];
        const buckets = emptyBuckets();
        for (const i of items) { buckets[i.bucket]++; totals[i.bucket]++; }
        return { sectionId: s.id, name: s.name, schoolClass: s.schoolClass, total: items.length, buckets, myPending: items.filter((i) => i.mine).length, items };
      })
      .filter((d) => d.total > 0)
      .sort((a, b) => (a.schoolClass.medium.code === b.schoolClass.medium.code ? 0 : a.schoolClass.medium.code === 'EN' ? -1 : 1) || a.schoolClass.standard.levelOrder - b.schoolClass.standard.levelOrder || a.name.localeCompare(b.name));
    return { year: { id: year.id, name: year.name }, scopeAll: scope.all, ...extra, divisions, totals, myPending: divisions.reduce((n, d) => n + d.myPending, 0) };
  }

  /** Counts for the menu badge and the home page: what is waiting for this user. */
  async tasks(ctx: AccessContext) {
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    if (!year) return { review: 0, corrections: 0, items: [] };
    const scope = await this.scopes.resolve(ctx, year.id);
    const subs = await this.prisma.academicSubmission.findMany({
      where: {
        academicYearId: year.id, status: { in: ['SUBMITTED', 'CORRECTION_REQUIRED', 'RETURNED'] }, ...(scope.all ? {} : { sectionId: { in: scope.sectionIds } }),
        OR: [{ examId: null }, { exam: { status: { not: 'ARCHIVED' } } }], // removed unit tests are no longer anyone's task
      },
      include: { section: { select: sectionSelect }, exam: { select: { id: true, code: true, nameEn: true } }, classSubject: { include: { subject: { select: { nameEn: true } } } } },
      orderBy: { updatedAt: 'asc' },
    });
    const items = [];
    for (const s of subs) {
      const mine = s.status === 'CORRECTION_REQUIRED'
        ? this.canEnter(ctx, scope, s.recordType, s.sectionId)
        : (await this.canActAt(ctx, scope, s.recordType, s.stage, s.sectionId, s.classSubjectId)) && (s.status === 'RETURNED' || s.submittedBy !== ctx.userId);
      if (!mine) continue;
      items.push({
        submissionId: s.id, recordType: s.recordType, stage: s.stage, status: s.status, since: s.updatedAt,
        section: s.section, exam: s.exam, subject: s.classSubject?.subject.nameEn ?? null, period: s.period,
        unit: s.recordType === 'MARKS' ? { recordType: 'MARKS', examId: Number(s.examId), sectionId: Number(s.sectionId), classSubjectId: Number(s.classSubjectId) } : { recordType: 'ATTENDANCE', sectionId: Number(s.sectionId), period: s.period },
      });
    }
    return {
      review: items.filter((i) => i.status === 'SUBMITTED' || i.status === 'RETURNED').length,
      corrections: items.filter((i) => i.status === 'CORRECTION_REQUIRED').length,
      items: items.slice(0, 200),
    };
  }
}

const emptyBuckets = () => Object.fromEntries(PROGRESS_BUCKETS.map((b) => [b, 0])) as Record<ProgressBucket, number>;

const summaryQuery = z.object({
  academicYearId: z.coerce.number().int().positive().optional(),
  recordType: z.enum(['MARKS', 'ATTENDANCE']).default('MARKS'),
  examId: z.coerce.number().int().positive().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
const commentSchema = z.object({ comment: z.string().trim().max(500).optional() });

@Controller()
export class WorkflowController {
  constructor(private readonly wf: WorkflowService) {}

  // Read access is decided per unit inside the service (operator / subject teacher / class teacher / headmaster).
  @Get('sheets')
  view(@Ctx() ctx: AccessContext, @Query(zBody(unitKeySchema)) q: UnitKey) { return this.wf.view(ctx, q); }

  @Put('sheets')
  save(@Ctx() ctx: AccessContext, @Body(zBody(saveRowsSchema)) b: SaveRowsInput) { return this.wf.save(ctx, b); }

  @Post('submissions/:id/submit') @HttpCode(200)
  submit(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(commentSchema)) b: z.infer<typeof commentSchema>) { return this.wf.submit(ctx, id, b.comment); }

  @Post('submissions/:id/verify') @HttpCode(200)
  verify(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(commentSchema)) b: z.infer<typeof commentSchema>) { return this.wf.verify(ctx, id, b.comment); }

  @Post('submissions/:id/reject') @HttpCode(200)
  reject(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(rejectSchema)) b: RejectInput) { return this.wf.reject(ctx, id, b); }

  @Post('submissions/:id/return-up') @HttpCode(200)
  returnUp(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(rejectSchema)) b: RejectInput) { return this.wf.returnUp(ctx, id, b); }

  @Post('submissions/:id/reopen-unit-test') @HttpCode(200)
  reopenUnitTest(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(rejectSchema)) b: RejectInput) { return this.wf.reopenUnitTest(ctx, id, b); }

  @Post('submissions/:id/reopen') @HttpCode(200)
  reopen(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(rejectSchema)) b: RejectInput) { return this.wf.reopen(ctx, id, b); }

  @Get('workflow/summary')
  summary(@Ctx() ctx: AccessContext, @Query(zBody(summaryQuery)) q: z.infer<typeof summaryQuery>) { return this.wf.summary(ctx, q); }

  @Get('workflow/tasks')
  tasks(@Ctx() ctx: AccessContext) { return this.wf.tasks(ctx); }
}

@Module({ controllers: [WorkflowController], providers: [WorkflowService], exports: [WorkflowService] })
export class WorkflowModule {}
