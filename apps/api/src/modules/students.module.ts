/// <reference types="multer" />
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ADMISSION_DOCUMENTS, ERROR_CODES, EnrollmentInput, enrollmentInputSchema, GuardianInput, MAX_DOCUMENT_BYTES, PERMISSIONS, StudentCreateInput,
  studentCreateSchema, studentDocumentUploadSchema, StudentDuplicateQuery, studentDuplicateQuerySchema, StudentInput, StudentListQuery,
  examNoPrefix, mediumToken, studentListQuerySchema, studentSchema, StudentStatusInput, studentStatusSchema, yearToken,
} from '@cps/shared';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { AppError, invalid, notFound, outOfScope } from '../common/errors';
import { ResolvedScope, ScopeService } from '../common/scope';
import { page, skipTake, StreamMarker } from '../common/serialize';
import { dateOnly, IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';
import { sniffImage, StorageDriver } from '../infra/storage.service';
import { syncStudentFees } from './fee-ledger';
import { PoliciesSequencesModule, SequencesService } from './policies-sequences.module';

const P = PERMISSIONS;
const admissionRejectSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });
/** The Headmaster confirms a provisional admission; the GR No may be entered now or later (office / Headmaster). */
const grNoValue = z.string().trim().max(30).nullish().transform((v) => (v ? v.toUpperCase() : null));
const admissionConfirmSchema = z.object({ grNo: grNoValue });
const grNoSchema = z.object({ grNo: grNoValue });
const rollNumbersSchema = z.object({ items: z.array(z.object({ enrollmentId: z.coerce.number().int().positive(), rollNo: z.coerce.number().int().min(1).max(999) })).min(1).max(300) });
const yearQuerySchema = z.object({ academicYearId: z.coerce.number().int().positive().optional() });
const listNoteSchema = z.object({ note: z.string().trim().max(300).nullish().transform((v) => v || null) });
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What a user may see of ONE student (docs/04 §access):
 * - basic     : anyone whose scope covers the division (operators, subject teachers, verifiers)
 * - contact   : school-wide staff (Headmaster, admin, office) and the CLASS TEACHER of that division
 *               → date of birth, address, parents' mobile numbers, previous school, notes
 * - sensitive : contact + students.sensitive.read → religion, category, caste, Aadhaar (last 4)
 * - edit      : students.write and school-wide scope (office / admin)
 */
export interface StudentAccess {
  contact: boolean; sensitive: boolean; edit: boolean; changeStatus: boolean; approveAdmission: boolean;
  /** Add or change the GR No (office or Headmaster, once the admission is confirmed). */
  editGrNo: boolean;
  /** Move to another division / roll no (office, any time). */
  editEnrollment: boolean;
}

const CONTACT_FIELDS = [
  'dob', 'birthPlace', 'addressLine', 'city', 'pincode', 'previousSchool', 'previousClass', 'previousSchoolYear', 'previousLcNo', 'previousLcDate', 'notes', 'admissionDate', 'documents',
  'transportMode', 'identificationMarks', 'heightCm', 'weightKg', 'medicalNotes', 'emergencyName', 'emergencyRelation', 'emergencyMobile', 'siblingsInSchool',
] as const;
const SENSITIVE_FIELDS = ['religion', 'category', 'caste', 'subCaste', 'aadhaarLast4', 'cwsn', 'isBpl', 'isMinority', 'bankAccountNo', 'bankIfsc', 'bankName'] as const;

/** Magic-byte check for document scans: the photo formats plus PDF. */
function sniffDocument(buf: Buffer) {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return sniffImage(buf);
}

const sectionSelect = {
  id: true, name: true,
  schoolClass: { select: { id: true, displayName: true, code: true, medium: { select: { id: true, code: true, nameEn: true } }, standard: { select: { id: true, code: true, levelOrder: true } } } },
} as const;

const studentInclude = {
  guardians: { include: { guardian: true }, orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }] },
  enrollments: { include: { section: { select: sectionSelect }, academicYear: { select: { id: true, name: true, isCurrent: true } } }, orderBy: { academicYearId: 'desc' } },
  statusHistory: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.StudentInclude;
type StudentFull = Prisma.StudentGetPayload<{ include: typeof studentInclude }>;

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopes: ScopeService,
    private readonly sequences: SequencesService,
    @Inject('STORAGE') private readonly storage: StorageDriver,
  ) {}

  private async year(ctx: AccessContext, academicYearId?: number) {
    const y = await this.prisma.academicYear.findFirst({
      where: { schoolId: ctx.schoolId, ...(academicYearId ? { id: BigInt(academicYearId) } : { isCurrent: true }) },
    });
    if (!y) throw notFound('Academic year');
    return y;
  }

  access(ctx: AccessContext, scope: ResolvedScope, sectionId: bigint): StudentAccess {
    const contact = scope.all || scope.byRole.CLASS_TEACHER.some((s) => s === sectionId);
    return {
      contact,
      sensitive: contact && hasPermission(ctx, P.STUDENTS_SENSITIVE_READ),
      edit: scope.all && hasPermission(ctx, P.STUDENTS_WRITE),
      changeStatus: scope.all && hasPermission(ctx, P.STUDENTS_STATUS),
      approveAdmission: scope.all && hasPermission(ctx, P.STUDENTS_ADMISSION_APPROVE),
      editGrNo: false,
      editEnrollment: scope.all && hasPermission(ctx, P.STUDENTS_WRITE),
    };
  }

  // ------------------------------------------------------------------ list
  async list(ctx: AccessContext, q: StudentListQuery) {
    const year = await this.year(ctx, q.academicYearId);
    const scope = await this.scopes.resolve(ctx, year.id);
    // Default: everyone studying now. The office and Headmaster also see provisional admissions (not yet confirmed).
    const current = scope.all ? { in: ['ACTIVE', 'PENDING_APPROVAL'] } : 'ACTIVE';
    // CORRECTION: provisional admissions the Headmaster sent back to the office.
    const status = q.status === 'ALL' ? undefined : !q.status || q.status === 'CURRENT' ? current : q.status === 'CORRECTION' ? 'PENDING_APPROVAL' : q.status;
    const text = q.q?.trim();
    const where: Prisma.StudentEnrollmentWhereInput = {
      academicYearId: year.id,
      student: { schoolId: ctx.schoolId, ...(status ? { status } : {}), ...(q.status === 'CORRECTION' ? { correctionNote: { not: null } } : {}), ...(q.gender ? { gender: q.gender } : {}), ...(q.gr === 'TEMP' ? { grNoTemp: true } : q.gr === 'MISSING' ? { grNo: null, grNoTemp: false } : {}) },
      ...(q.mediumId ? { mediumId: BigInt(q.mediumId) } : {}),
      ...(q.classId ? { classId: BigInt(q.classId) } : {}),
      // A division outside the user's scope simply returns nothing.
      sectionId: q.sectionId
        ? (this.scopes.canView(scope, BigInt(q.sectionId)) ? BigInt(q.sectionId) : { in: [] })
        : this.scopes.sectionFilter(scope),
      ...(text ? {
        OR: [
          { student: { fullName: { contains: text } } }, { student: { fullNameHi: { contains: text } } },
          { student: { grNo: { contains: text } } }, { student: { studentCode: { contains: text } } }, { examNo: { contains: text } },
        ],
      } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.studentEnrollment.findMany({
        where,
        include: {
          section: { select: sectionSelect },
          student: { include: { guardians: { where: { isPrimary: true }, include: { guardian: { select: { name: true, mobile: true } } }, take: 1 } } },
        },
        orderBy: [{ medium: { sortOrder: 'asc' } }, { schoolClass: { standard: { levelOrder: 'asc' } } }, { section: { name: 'asc' } }, { rollNo: { sort: 'asc', nulls: 'last' } }, { student: { fullName: 'asc' } }],
        ...skipTake(q),
      }),
      this.prisma.studentEnrollment.count({ where }),
    ]);
    const data = rows.map((e) => {
      const a = this.access(ctx, scope, e.sectionId);
      const g = e.student.guardians[0]?.guardian;
      return {
        id: e.student.id, enrollmentId: e.id, studentCode: e.student.studentCode, grNo: e.student.grNo, grNoTemp: e.student.grNoTemp, correctionNote: e.student.correctionNote,
        fullName: e.student.fullName, fullNameHi: e.student.fullNameHi, gender: e.student.gender, status: e.student.status,
        photoFileId: e.student.photoFileId, rollNo: e.rollNo, examNo: e.examNo, section: e.section,
        dob: a.contact ? e.student.dob : null,
        primaryContact: a.contact && g ? { name: g.name, mobile: g.mobile } : null,
      };
    });
    return { ...page(data, total, q), year: { id: year.id, name: year.name } };
  }

  // ------------------------------------------------------------------ one student
  private async load(ctx: AccessContext, id: bigint, db: Tx | PrismaService = this.prisma) {
    const s = await db.student.findFirst({ where: { id, schoolId: ctx.schoolId }, include: studentInclude });
    if (!s) throw notFound('Student');
    return s;
  }

  /** The enrollment that decides visibility: current year first, else the latest one. */
  private async visibleEnrollment(ctx: AccessContext, s: StudentFull) {
    const e = s.enrollments.find((x) => x.academicYear.isCurrent) ?? s.enrollments[0];
    if (!e) throw notFound('Student');
    const scope = await this.scopes.resolve(ctx, e.academicYearId);
    // Hide existence from users outside scope (same answer as a missing id).
    if (!this.scopes.canView(scope, e.sectionId)) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'Student not found in your classes');
    const base = this.access(ctx, scope, e.sectionId);
    const provisional = s.status === 'PENDING_APPROVAL';
    const access: StudentAccess = {
      ...base,
      // The office edits every section (reserved details too) while the admission is provisional; once the
      // Headmaster confirms it, only the Headmaster edits the record and the office may only add the GR No.
      edit: base.edit && (provisional || base.approveAdmission),
      sensitive: base.sensitive || (provisional && base.edit),
      editGrNo: base.edit && !provisional && s.status !== 'REJECTED',
    };
    return { enrollment: e, scope, access };
  }

  async get(ctx: AccessContext, id: bigint) {
    const s = await this.load(ctx, id);
    const { enrollment, access } = await this.visibleEnrollment(ctx, s);
    const staffOf = await this.prisma.teachingAssignment.findMany({
      where: { sectionId: enrollment.sectionId, status: 'ACTIVE', role: { in: ['CLASS_TEACHER', 'OPERATOR'] } },
      include: { staff: { select: { id: true, name: true } } },
    });
    const out: Record<string, unknown> = { ...s };
    if (!access.contact) for (const f of CONTACT_FIELDS) out[f] = null;
    if (!access.sensitive) for (const f of SENSITIVE_FIELDS) out[f] = null;
    out.guardians = s.guardians.map((sg) => ({
      relation: sg.relation, isPrimary: sg.isPrimary, id: sg.guardian.id, name: sg.guardian.name, nameHi: sg.guardian.nameHi,
      mobile: access.contact ? sg.guardian.mobile : null, altMobile: access.contact ? sg.guardian.altMobile : null,
      occupation: access.contact ? sg.guardian.occupation : null,
      education: access.contact ? sg.guardian.education : null,
      annualIncome: access.sensitive ? sg.guardian.annualIncome : null,
      whatsapp: access.contact ? sg.guardian.whatsapp : null,
      email: access.contact ? sg.guardian.email : null,
    }));
    const [documentFiles, siblings] = access.contact
      ? await Promise.all([this.documentList(s.id), this.siblings(ctx, s)])
      : [[], []];
    return {
      ...out,
      documentFiles,
      siblings,
      current: enrollment,
      classTeacher: staffOf.find((a) => a.role === 'CLASS_TEACHER')?.staff ?? null,
      operators: staffOf.filter((a) => a.role === 'OPERATOR').map((a) => a.staff),
      access,
    };
  }

  // ------------------------------------------------------------------ admission
  /**
   * New admission. Entered by the office it is Provisional (PENDING_APPROVAL) until the Headmaster confirms it: no GR No,
   * roll no or exam no yet, and it does not appear in class lists, marks or attendance, but its fee ledger opens at once
   * so the office can collect fees. The Headmaster's own admissions are confirmed at once.
   */
  async create(ctx: AccessContext, input: StudentCreateInput) {
    const section = await this.admissionSection(ctx, input.enrollment.sectionId);
    const pending = !hasPermission(ctx, P.STUDENTS_ADMISSION_APPROVE);
    // The GR No is never generated. A provisional admission has none; it is entered after confirmation.
    if (pending && input.student.grNo) throw invalidState('Leave the GR No blank: it is entered after the Headmaster confirms the admission.');
    return this.prisma.$transaction((tx) => this.admitInTx(tx, ctx, section, input, undefined, pending));
  }

  /** New admissions waiting for the Headmaster (newest first). */
  async pendingAdmissions(ctx: AccessContext) {
    const rows = await this.prisma.student.findMany({
      where: { schoolId: ctx.schoolId, status: 'PENDING_APPROVAL', correctionNote: null },
      include: { enrollments: { where: { status: 'PENDING_APPROVAL' }, take: 1, include: { section: { select: sectionSelect } } }, guardians: { where: { isPrimary: true }, take: 1, include: { guardian: { select: { name: true, mobile: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.createdBy).filter((v): v is bigint => v != null) } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    const names = new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
    return rows.map((r) => ({
      id: r.id, fullName: r.fullName, gender: r.gender, dob: r.dob, isRte: r.isRte, section: r.enrollments[0]?.section ?? null,
      parent: r.guardians[0]?.guardian ?? null, enteredBy: r.createdBy ? names.get(String(r.createdBy)) ?? null : null, enteredAt: r.createdAt,
    }));
  }

  /** Headmaster confirms (GR No now or later); roll no and exam no are given now. */
  async approveAdmission(ctx: AccessContext, id: bigint, grNo: string | null) {
    const s = await this.load(ctx, id);
    if (s.status !== 'PENDING_APPROVAL') throw invalidState('This admission is not provisional');
    if (s.correctionNote) throw invalidState('This admission was sent back to the office for correction; it can be confirmed once the office sends it again');
    const e = await this.prisma.studentEnrollment.findFirst({ where: { studentId: id, status: 'PENDING_APPROVAL' }, include: { section: { include: { schoolClass: { include: { academicYear: true, medium: true } } } } } });
    if (!e) throw invalidState('This admission has no class');
    if (e.section.schoolClass.academicYear.status === 'CLOSED') throw invalidState('The academic year is closed');
    return this.prisma.$transaction(async (tx) => {
      const rollNo = e.rollNo ?? (((await tx.studentEnrollment.aggregate({ where: { sectionId: e.sectionId }, _max: { rollNo: true } }))._max.rollNo ?? 0) + 1);
      // Exam No only once the class's numbers were generated (lists confirmed); a late student takes the next one.
      const examNo = e.examNo ?? (await this.lateExamNo(tx, ctx, e.section.classId));
      await unique(() => tx.student.update({ where: { id }, data: { grNo, status: 'ACTIVE', correctionNote: null, correctionRequestedAt: null, version: { increment: 1 }, updatedBy: ctx.userId } }), 'grNo', `GR No ${grNo} is already used by another student`);
      try {
        await tx.studentEnrollment.update({ where: { id: e.id }, data: { status: 'ACTIVE', rollNo, examNo, updatedBy: ctx.userId } });
      } catch (err) {
        throw this.enrollmentConflict(err, rollNo, examNo);
      }
      await tx.studentStatusHistory.create({ data: { studentId: id, fromStatus: 'PENDING_APPROVAL', toStatus: 'ACTIVE', effectiveDate: e.joinedOn, reason: `Admission confirmed: ${e.section.schoolClass.displayName}-${e.section.name}`, createdBy: ctx.userId } });
      await syncStudentFees(tx, id, ctx.userId); // fees collected while provisional stay on the ledger
      await this.audit.record(ctx, { action: 'APPROVE', entityType: 'Student', entityId: id, before: { status: 'PENDING_APPROVAL', grNo: s.grNo }, after: { status: 'ACTIVE', grNo, rollNo, examNo }, reason: 'Admission confirmed' }, tx);
      return this.load(ctx, id, tx);
    });
  }

  /** Headmaster rejects (with a reason). The application stays on record; nothing is deleted. */
  async rejectAdmission(ctx: AccessContext, id: bigint, reason: string) {
    const s = await this.load(ctx, id);
    if (s.status !== 'PENDING_APPROVAL') throw invalidState('This admission is not provisional');
    const receipts = await this.prisma.feePayment.count({ where: { status: 'VALID', enrollment: { studentId: id, status: 'PENDING_APPROVAL' } } });
    if (receipts) throw invalidState(`Fees were collected for this admission (${receipts} receipt${receipts > 1 ? 's' : ''}). Cancel or refund ${receipts > 1 ? 'them' : 'it'} in Fees before rejecting.`);
    return this.prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id }, data: { status: 'REJECTED', version: { increment: 1 }, updatedBy: ctx.userId } });
      await tx.studentEnrollment.updateMany({ where: { studentId: id, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED', rollNo: null, examNo: null, updatedBy: ctx.userId } });
      await tx.studentStatusHistory.create({ data: { studentId: id, fromStatus: 'PENDING_APPROVAL', toStatus: 'REJECTED', effectiveDate: dateOnly(today())!, reason: `Admission rejected: ${reason}`, createdBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'REJECT', entityType: 'Student', entityId: id, before: { status: 'PENDING_APPROVAL' }, after: { status: 'REJECTED' }, reason }, tx);
      return this.load(ctx, id, tx);
    });
  }

  /** Division a student can be admitted to by this user (office/admin, open year). */
  async admissionSection(ctx: AccessContext, sectionId: number) {
    const section = await this.prisma.section.findFirst({
      where: { id: BigInt(sectionId), status: 'ACTIVE', schoolClass: { academicYear: { schoolId: ctx.schoolId } } },
      include: { schoolClass: { include: { academicYear: true, medium: true, standard: true } } },
    });
    if (!section) throw notFound('Division');
    if (section.schoolClass.academicYear.status === 'CLOSED') throw invalidState('The academic year is closed');
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYear.id);
    if (!this.access(ctx, scope, section.id).edit) throw outOfScope('Only school office staff can admit students');
    return section;
  }

  async admitInTx(tx: Tx, ctx: AccessContext, section: Awaited<ReturnType<StudentsService['admissionSection']>>, input: StudentCreateInput, reason?: string, pending = false) {
    // Student ID: medium + year + running number (pattern in Settings → Number formats), e.g. ENG202600000001.
    const tokens = { medium: mediumToken(section.schoolClass.medium.nameEn), year: yearToken(section.schoolClass.academicYear.name) };
    const studentCode = await this.sequences.next(tx, ctx.schoolId, 'student_code', tokens);
    // A new admission gets its form number (Excel imports are students already in the school: no form).
    const admissionFormNo = reason ? null : await this.sequences.next(tx, ctx.schoolId, 'admission_form', tokens);
    // A pending admission holds its permanent student ID in place of the GR No; the real GR No is given on approval,
    // so the General Register has no gaps for rejected applications.
    // No GR No for a provisional admission; the Headmaster's own admissions and imports may carry one.
    const grNo = pending ? null : input.student.grNo?.toUpperCase() || null;
    const { guardians, ...fields } = input.student;
    const student = await unique(
      () => tx.student.create({
        data: { ...this.studentData(fields), grNo, studentCode, admissionFormNo, status: pending ? 'PENDING_APPROVAL' : 'ACTIVE', schoolId: ctx.schoolId, createdBy: ctx.userId },
      }),
      'student.grNo', `GR No ${grNo} is already used by another student`,
    );
    await this.writeGuardians(tx, ctx, student.id, guardians);
    const enrollment = await this.writeEnrollment(tx, ctx, student.id, section, input.enrollment, pending);
    await tx.studentStatusHistory.create({
      data: {
        studentId: student.id, toStatus: pending ? 'PENDING_APPROVAL' : 'ACTIVE', effectiveDate: enrollment.joinedOn, createdBy: ctx.userId,
        reason: reason ?? (pending ? `Admission entered for ${section.schoolClass.displayName}-${section.name}; waiting for the Headmaster` : `Admitted to ${section.schoolClass.displayName}-${section.name}`),
      },
    });
    const after = await this.load(ctx, student.id, tx);
    await this.audit.record(ctx, { action: reason ? 'IMPORT' : 'CREATE', entityType: 'Student', entityId: student.id, after }, tx);
    return after;
  }

  private studentData(f: Omit<StudentInput, 'guardians'>) {
    return {
      ...f,
      fullName: f.fullName.replace(/\s+/g, ' ').toUpperCase(),
      grNo: f.grNo ? f.grNo.toUpperCase() : undefined,
      dob: dateOnly(f.dob), admissionDate: dateOnly(f.admissionDate), previousLcDate: dateOnly(f.previousLcDate),
    };
  }

  async writeEnrollment(
    tx: Tx, ctx: AccessContext, studentId: bigint,
    section: { id: bigint; classId: bigint; schoolClass: { academicYearId: bigint; mediumId: bigint; medium: { code: string }; academicYear: { name: string; startDate: Date } } },
    input: EnrollmentInput,
    pending = false,
  ) {
    // Pending admissions get their roll no and exam no when the Headmaster approves (unless typed in).
    const rollNo = input.rollNo ?? (pending ? null : (((await tx.studentEnrollment.aggregate({ where: { sectionId: section.id }, _max: { rollNo: true } }))._max.rollNo ?? 0) + 1));
    const examNo = input.examNo?.toUpperCase() ?? (pending ? null : await this.lateExamNo(tx, ctx, section.classId));
    const joinedOn = dateOnly(input.joinedOn) ?? (new Date() < section.schoolClass.academicYear.startDate ? section.schoolClass.academicYear.startDate : dateOnly(today())!);
    let enrollment;
    try {
      enrollment = await tx.studentEnrollment.create({
        data: {
          studentId, academicYearId: section.schoolClass.academicYearId, classId: section.classId, sectionId: section.id,
          mediumId: section.schoolClass.mediumId, rollNo, examNo, joinedOn, status: pending ? 'PENDING_APPROVAL' : 'ACTIVE', createdBy: ctx.userId,
        },
      });
    } catch (e) {
      throw this.enrollmentConflict(e, rollNo, examNo);
    }
    // Every year in school gets its own fee ledger: this class's annual fee, plus last year's unpaid balance carried forward.
    // Provisional admissions too, so the office can take the fee before the Headmaster confirms.
    await syncStudentFees(tx, studentId, ctx.userId);
    return enrollment;
  }

  private enrollmentConflict(e: unknown, rollNo: number | null, examNo: string | null) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = JSON.stringify(e.meta ?? {});
      if (target.includes('roll')) return new AppError(409, ERROR_CODES.DUPLICATE, `Roll no ${rollNo} is already taken in this division`, [{ path: 'enrollment.rollNo', code: 'duplicate', message: 'Already taken in this division' }]);
      if (target.includes('exam')) return new AppError(409, ERROR_CODES.DUPLICATE, `Exam no ${examNo} is already used this year`, [{ path: 'enrollment.examNo', code: 'duplicate', message: 'Already used this year' }]);
      return new AppError(409, ERROR_CODES.DUPLICATE, 'This student is already enrolled for this year');
    }
    return e;
  }

  /** Father / mother / guardian rows are matched by relation and updated in place (history stays in audit). */
  private async writeGuardians(tx: Tx, ctx: AccessContext, studentId: bigint, guardians: GuardianInput[], keepIncome = false) {
    const existing = await tx.studentGuardian.findMany({ where: { studentId }, include: { guardian: true } });
    const primaryIdx = Math.max(0, guardians.findIndex((g) => g.isPrimary));
    const keep = new Set<bigint>();
    for (const [i, g] of guardians.entries()) {
      const { relation, isPrimary: _ignored, ...data } = g;
      const link = existing.find((x) => x.relation === relation && !keep.has(x.id));
      if (link) {
        // Family income is hidden from users without sensitive access; do not overwrite it with their blank value.
        if (keepIncome) delete (data as { annualIncome?: unknown }).annualIncome;
        await tx.guardian.update({ where: { id: link.guardianId }, data: { ...data, updatedBy: ctx.userId } });
        await tx.studentGuardian.update({ where: { id: link.id }, data: { isPrimary: i === primaryIdx } });
        keep.add(link.id);
      } else {
        const row = await tx.guardian.create({ data: { ...data, schoolId: ctx.schoolId, createdBy: ctx.userId } });
        const l = await tx.studentGuardian.create({ data: { studentId, guardianId: row.id, relation, isPrimary: i === primaryIdx } });
        keep.add(l.id);
      }
    }
    const remove = existing.filter((x) => !keep.has(x.id)).map((x) => x.id);
    if (remove.length) await tx.studentGuardian.deleteMany({ where: { id: { in: remove } } });
  }

  // ------------------------------------------------------------------ edits
  private async assertEdit(ctx: AccessContext, s: StudentFull) {
    const v = await this.visibleEnrollment(ctx, s);
    if (!v.access.edit) {
      throw outOfScope(v.access.editEnrollment
        ? "This admission is confirmed: only the Headmaster can change the student's details now"
        : 'Only school office staff can edit student records');
    }
    return v;
  }

  /** GR No added (or corrected) after confirmation, by the office or the Headmaster. Empty clears it. */
  async setGrNo(ctx: AccessContext, id: bigint, grNo: string | null) {
    const s = await this.load(ctx, id);
    const { access } = await this.visibleEnrollment(ctx, s);
    if (!access.editGrNo) throw s.status === 'PENDING_APPROVAL' ? invalidState('The GR No is entered after the Headmaster confirms the admission') : outOfScope('You cannot change the GR No');
    if (grNo === s.grNo && !(grNo && s.grNoTemp)) return this.load(ctx, id);
    return this.prisma.$transaction(async (tx) => {
      await unique(() => tx.student.update({ where: { id }, data: { grNo, grNoTemp: grNo ? false : s.grNoTemp, version: { increment: 1 }, updatedBy: ctx.userId } }), 'grNo', `GR No ${grNo} is already used by another student`);
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Student', entityId: id, before: { grNo: s.grNo }, after: { grNo }, reason: s.grNo ? 'GR No changed' : 'GR No given' }, tx);
      return this.load(ctx, id, tx);
    });
  }

  /** Headmaster sends a provisional admission back to the office with what to correct (fees are not touched). */
  async returnAdmission(ctx: AccessContext, id: bigint, reason: string) {
    const s = await this.load(ctx, id);
    if (s.status !== 'PENDING_APPROVAL') throw invalidState('This admission is not provisional');
    return this.prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id }, data: { correctionNote: reason, correctionRequestedAt: new Date(), version: { increment: 1 }, updatedBy: ctx.userId } });
      await tx.studentStatusHistory.create({ data: { studentId: id, fromStatus: 'PENDING_APPROVAL', toStatus: 'PENDING_APPROVAL', effectiveDate: dateOnly(today())!, reason: `Sent back for correction: ${reason}`, createdBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'RETURN', entityType: 'Student', entityId: id, after: { correctionNote: reason }, reason }, tx);
      return this.load(ctx, id, tx);
    });
  }

  /** The office has corrected the admission and sends it to the Headmaster again. */
  async resubmitAdmission(ctx: AccessContext, id: bigint) {
    const s = await this.load(ctx, id);
    await this.assertEdit(ctx, s);
    if (s.status !== 'PENDING_APPROVAL' || !s.correctionNote) throw invalidState('This admission was not sent back for correction');
    return this.prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id }, data: { correctionNote: null, correctionRequestedAt: null, version: { increment: 1 }, updatedBy: ctx.userId } });
      await tx.studentStatusHistory.create({ data: { studentId: id, fromStatus: 'PENDING_APPROVAL', toStatus: 'PENDING_APPROVAL', effectiveDate: dateOnly(today())!, reason: 'Corrected by the office and sent to the Headmaster again', createdBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'RESUBMIT', entityType: 'Student', entityId: id, before: { correctionNote: s.correctionNote }, after: { correctionNote: null } }, tx);
      return this.load(ctx, id, tx);
    });
  }

  async update(ctx: AccessContext, id: bigint, input: StudentInput) {
    const before = await this.load(ctx, id);
    const { access } = await this.assertEdit(ctx, before);
    return this.prisma.$transaction(async (tx) => {
      const { guardians, ...fields } = input;
      const data = this.studentData(fields);
      // The GR No is given after confirmation (Headmaster here; office with "Add GR No").
      if (!data.grNo || data.grNo === before.grNo) delete (data as { grNo?: string }).grNo;
      else if (before.status === 'PENDING_APPROVAL') throw invalidState('The GR No is entered after the admission is confirmed');
      // Fields this user cannot see arrive blank; keep the stored values instead of wiping them.
      if (!access.sensitive) for (const f of SENSITIVE_FIELDS) delete (data as Record<string, unknown>)[f];
      await unique(
        () => tx.student.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedBy: ctx.userId } }),
        'grNo', `GR No ${data.grNo} is already used by another student`,
      );
      await this.writeGuardians(tx, ctx, id, guardians, !access.sensitive);
      if (access.sensitive && before.isRte !== data.isRte) await syncStudentFees(tx, id, ctx.userId); // RTE waives the year fee
      const after = await this.load(ctx, id, tx);
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Student', entityId: id, before, after }, tx);
      return after;
    });
  }

  /** Change division / roll no / exam no for the current year. */
  async updateEnrollment(ctx: AccessContext, id: bigint, input: EnrollmentInput) {
    const s = await this.load(ctx, id);
    const { enrollment, access } = await this.visibleEnrollment(ctx, s);
    if (!access.editEnrollment) throw outOfScope('Only school office staff can edit student records');
    const section = await this.prisma.section.findFirst({
      where: { id: BigInt(input.sectionId), status: 'ACTIVE', schoolClass: { academicYearId: enrollment.academicYearId } },
      include: { schoolClass: true },
    });
    if (!section) throw notFound('Division (in the same academic year)');
    return this.prisma.$transaction(async (tx) => {
      const moving = section.id !== enrollment.sectionId;
      const rollNo = input.rollNo ?? (moving ? (((await tx.studentEnrollment.aggregate({ where: { sectionId: section.id }, _max: { rollNo: true } }))._max.rollNo ?? 0) + 1) : enrollment.rollNo);
      const examNo = input.examNo?.toUpperCase() ?? enrollment.examNo;
      try {
        const after = await tx.studentEnrollment.update({
          where: { id: enrollment.id },
          data: { sectionId: section.id, classId: section.classId, mediumId: section.schoolClass.mediumId, rollNo, examNo, version: { increment: 1 }, updatedBy: ctx.userId },
        });
        if (section.classId !== enrollment.classId) await syncStudentFees(tx, id, ctx.userId); // another class has another fee
        await this.audit.record(ctx, { action: 'UPDATE', entityType: 'StudentEnrollment', entityId: enrollment.id, before: enrollment, after, reason: moving ? 'Division changed' : undefined }, tx);
        return after;
      } catch (e) {
        throw this.enrollmentConflict(e, rollNo, examNo);
      }
    });
  }

  async changeStatus(ctx: AccessContext, id: bigint, input: StudentStatusInput) {
    const s = await this.load(ctx, id);
    const { enrollment, access } = await this.visibleEnrollment(ctx, s);
    if (!access.changeStatus) throw outOfScope('You cannot change the status of students');
    if (s.status === 'PENDING_APPROVAL' || s.status === 'REJECTED') throw invalidState('This admission is provisional: the Headmaster confirms or rejects it first');
    if (s.status === input.status) throw invalidState('The student already has this status');
    const effective = dateOnly(input.effectiveDate)!;
    if (input.status !== 'ACTIVE' && effective < enrollment.joinedOn) {
      throw invalid('The leaving date cannot be before the student joined this class', [
        { path: 'effectiveDate', code: 'before_joining', message: `Joined on ${enrollment.joinedOn.toISOString().slice(0, 10).split('-').reverse().join('/')}` },
      ]);
    }
    const enrStatus = input.status === 'ACTIVE' ? 'ACTIVE' : input.status === 'TRANSFERRED' ? 'TRANSFERRED_OUT' : input.status === 'PASSED_OUT' ? 'COMPLETED' : 'WITHDRAWN';
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.student.update({ where: { id }, data: { status: input.status, version: { increment: 1 }, updatedBy: ctx.userId } });
      await tx.studentEnrollment.update({
        where: { id: enrollment.id },
        data: { status: enrStatus, leftOn: input.status === 'ACTIVE' ? null : dateOnly(input.effectiveDate), updatedBy: ctx.userId },
      });
      await tx.studentStatusHistory.create({
        data: { studentId: id, fromStatus: s.status, toStatus: input.status, effectiveDate: dateOnly(input.effectiveDate)!, reason: input.reason, createdBy: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'STATUS', entityType: 'Student', entityId: id, before: { status: s.status }, after: { status: after.status }, reason: input.reason }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------------ class list and Exam Nos
  /** Who may act on a division's class list: prepare (Headmaster / office / operator), confirm (class teacher). */
  async listAccess(ctx: AccessContext, scope: ResolvedScope, sectionId: bigint) {
    const approver = scope.all && hasPermission(ctx, P.STUDENTS_ADMISSION_APPROVE);
    const prepare = (scope.all && hasPermission(ctx, P.STUDENTS_WRITE)) || approver || scope.byRole.OPERATOR.some((x) => x === sectionId);
    const hasCt = await this.prisma.teachingAssignment.count({ where: { sectionId, role: 'CLASS_TEACHER', status: 'ACTIVE' } });
    // The class teacher confirms; the Headmaster only when the division has no class teacher yet.
    const confirm = scope.byRole.CLASS_TEACHER.some((x) => x === sectionId) || (approver && !hasCt);
    // The Headmaster finalizes; Exam Nos are generated by the Headmaster or the office once every division is final.
    const finalize = approver;
    const generate = approver || (scope.all && hasPermission(ctx, P.STUDENTS_WRITE));
    return { prepare, confirm, finalize, generate };
  }

  /** Roll numbers can be changed by whoever holds the list: preparers while it is a draft, the class teacher while checking. */
  private canEditRolls(can: { prepare: boolean; confirm: boolean }, status: string) {
    return (status === 'DRAFT' && can.prepare) || (status === 'READY' && can.confirm);
  }

  /**
   * Every division's class list for the year: its step, whom it is waiting for, and whether that is this user
   * (so the Headmaster sees exactly which lists to finalize and which classes are ready for Exam Nos).
   */
  async classListsOverview(ctx: AccessContext, academicYearId?: number) {
    const year = await this.year(ctx, academicYearId);
    const scope = await this.scopes.resolve(ctx, year.id);
    const approver = scope.all && hasPermission(ctx, P.STUDENTS_ADMISSION_APPROVE);
    const office = scope.all && hasPermission(ctx, P.STUDENTS_WRITE);
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE' }, ...(scope.all ? {} : { id: { in: scope.sectionIds } }) },
      include: {
        schoolClass: { select: { id: true, displayName: true, examNosAt: true, medium: { select: { code: true, nameEn: true, sortOrder: true } }, standard: { select: { code: true, levelOrder: true } } } },
        assignments: { where: { status: 'ACTIVE', role: 'CLASS_TEACHER' }, select: { staff: { select: { name: true } } } },
      },
    });
    const counts = new Map((await this.prisma.studentEnrollment.groupBy({ by: ['sectionId'], where: { sectionId: { in: sections.map((s) => s.id) }, status: 'ACTIVE' }, _count: { _all: true } })).map((g) => [String(g.sectionId), g._count._all]));
    const byClass = new Map<string, string[]>();
    for (const s of sections) byClass.set(String(s.classId), [...(byClass.get(String(s.classId)) ?? []), s.listStatus]);
    const has = (role: 'CLASS_TEACHER' | 'OPERATOR', id: bigint) => scope.byRole[role].some((x) => x === id);
    const rows = sections.map((s) => {
      const ct = s.assignments[0]?.staff.name ?? null;
      const allFinal = (byClass.get(String(s.classId)) ?? []).every((x) => x === 'FINAL');
      let step: 'PREPARE' | 'CLASS_TEACHER' | 'HEADMASTER' | 'OTHER_DIVISIONS' | 'GENERATE' | 'DONE';
      let mine = false;
      if (s.schoolClass.examNosAt) step = 'DONE';
      else if (s.listStatus === 'FINAL') { step = allFinal ? 'GENERATE' : 'OTHER_DIVISIONS'; mine = allFinal && (approver || office); }
      else if (s.listStatus === 'CONFIRMED') { step = 'HEADMASTER'; mine = approver; }
      else if (s.listStatus === 'READY') { step = 'CLASS_TEACHER'; mine = has('CLASS_TEACHER', s.id) || (approver && !ct); }
      else { step = 'PREPARE'; mine = ((office && !approver) || has('OPERATOR', s.id)) && (counts.get(String(s.id)) ?? 0) > 0; }
      return {
        sectionId: s.id, name: s.name, classId: s.classId, className: s.schoolClass.displayName, medium: s.schoolClass.medium.nameEn,
        students: counts.get(String(s.id)) ?? 0, classTeacher: ct, listStatus: s.listStatus, note: s.listNote, step, mine,
        readyAt: s.listReadyAt, confirmedAt: s.listConfirmedAt, finalAt: s.listFinalAt, examNosAt: s.schoolClass.examNosAt,
        examPrefix: examNoPrefix(s.schoolClass.medium.nameEn, s.schoolClass.standard),
        _sort: [s.schoolClass.medium.sortOrder, s.schoolClass.standard.levelOrder, s.name] as const,
      };
    });
    rows.sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2].localeCompare(b._sort[2]));
    return { year: { id: year.id, name: year.name }, rows: rows.map(({ _sort, ...r }) => r) };
  }

  /** Class-list status of a division and what this user may do with it. */
  async listState(ctx: AccessContext, sectionId: bigint) {
    const section = await this.prisma.section.findFirst({ where: { id: sectionId, schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: { schoolClass: { include: { medium: true, standard: true, academicYear: true } } } });
    if (!section) throw notFound('Division');
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!this.scopes.canView(scope, sectionId)) throw notFound('Division');
    const can = await this.listAccess(ctx, scope, sectionId);
    const divisions = await this.prisma.section.findMany({ where: { classId: section.classId, status: 'ACTIVE' }, select: { name: true, listStatus: true }, orderBy: { name: 'asc' } });
    const st = section.listStatus;
    const allFinal = divisions.every((d) => d.listStatus === 'FINAL');
    return {
      status: st, note: section.listNote, readyAt: section.listReadyAt, confirmedAt: section.listConfirmedAt, finalAt: section.listFinalAt,
      examNosAt: section.schoolClass.examNosAt, examPrefix: examNoPrefix(section.schoolClass.medium.nameEn, section.schoolClass.standard), divisions, allFinal,
      can: {
        ready: can.prepare && st === 'DRAFT',
        withdraw: (can.prepare || can.confirm) && st === 'READY',
        confirm: can.confirm && st === 'READY',
        editRolls: this.canEditRolls(can, st),
        finalize: can.finalize && st === 'CONFIRMED',
        sendBackToTeacher: can.finalize && st === 'CONFIRMED',
        generate: can.generate && allFinal && !section.schoolClass.examNosAt,
      },
    };
  }

  private async listSection(ctx: AccessContext, sectionId: bigint) {
    const section = await this.prisma.section.findFirst({ where: { id: sectionId, status: 'ACTIVE', schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: { schoolClass: { include: { academicYear: true } } } });
    if (!section) throw notFound('Division');
    if (section.schoolClass.academicYear.status === 'CLOSED') throw invalidState('The academic year is closed');
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    return { section, can: await this.listAccess(ctx, scope, sectionId) };
  }

  /** The class list (students and roll numbers) is ready for the class teacher to check. */
  async listReady(ctx: AccessContext, sectionId: bigint) {
    const { section, can } = await this.listSection(ctx, sectionId);
    if (!can.prepare) throw outOfScope('The Headmaster, the office or the division\'s operator prepares the class list');
    if (section.listStatus !== 'DRAFT') throw invalidState(section.listStatus === 'READY' ? 'The class list is already with the class teacher' : 'The class list is already confirmed');
    const students = await this.prisma.studentEnrollment.count({ where: { sectionId, status: 'ACTIVE' } });
    if (!students) throw invalidState('This division has no confirmed students yet');
    const noRoll = await this.prisma.studentEnrollment.count({ where: { sectionId, status: 'ACTIVE', rollNo: null } });
    if (noRoll) throw invalidState(`${noRoll} student${noRoll > 1 ? 's have' : ' has'} no roll number: use "Roll numbers A–Z" first`);
    await this.prisma.$transaction(async (tx) => {
      await tx.section.update({ where: { id: sectionId }, data: { listStatus: 'READY', listReadyBy: ctx.userId, listReadyAt: new Date(), listNote: null, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'LIST_READY', entityType: 'Section', entityId: sectionId, after: { students } }, tx);
    });
    return { listStatus: 'READY' };
  }

  /** Back to draft: withdrawn by whoever prepared it, or sent back by the class teacher with a note. */
  async listReturn(ctx: AccessContext, sectionId: bigint, note: string | null) {
    const { section, can } = await this.listSection(ctx, sectionId);
    // Confirmed list: the Headmaster sends it back to the class teacher (roll numbers editable again).
    const to = section.listStatus === 'CONFIRMED' ? 'READY' : 'DRAFT';
    if (section.listStatus === 'CONFIRMED' ? !can.finalize : section.listStatus !== 'READY' || (!can.prepare && !can.confirm)) {
      throw section.listStatus === 'READY' || section.listStatus === 'CONFIRMED' ? outOfScope('You cannot send this class list back') : invalidState('This class list cannot be sent back now');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.section.update({ where: { id: sectionId }, data: { listStatus: to, listNote: note, ...(to === 'READY' ? { listConfirmedAt: null, listConfirmedBy: null } : {}), updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'LIST_RETURN', entityType: 'Section', entityId: sectionId, reason: note ?? 'Withdrawn' }, tx);
    });
    return { listStatus: to };
  }

  /** The class teacher confirms; the list is then locked and goes to the Headmaster for finalization. */
  async listConfirm(ctx: AccessContext, sectionId: bigint) {
    const { section, can } = await this.listSection(ctx, sectionId);
    if (!can.confirm) throw outOfScope('Only the class teacher of this division confirms its class list');
    if (section.listStatus !== 'READY') throw invalidState(section.listStatus === 'DRAFT' ? 'The class list has not been prepared yet' : 'The class list is already confirmed');
    await this.prisma.$transaction(async (tx) => {
      await tx.section.update({ where: { id: sectionId }, data: { listStatus: 'CONFIRMED', listConfirmedBy: ctx.userId, listConfirmedAt: new Date(), listNote: null, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'LIST_CONFIRM', entityType: 'Section', entityId: sectionId }, tx);
    });
    return { listStatus: 'CONFIRMED' };
  }

  /** The Headmaster finalizes the confirmed list (or sends it back to the class teacher with listReturn). */
  async listFinalize(ctx: AccessContext, sectionId: bigint) {
    const { section, can } = await this.listSection(ctx, sectionId);
    if (!can.finalize) throw outOfScope('Only the Headmaster finalizes the class list');
    if (section.listStatus !== 'CONFIRMED') throw invalidState(section.listStatus === 'FINAL' ? 'The class list is already final' : 'The class teacher has not confirmed the class list yet');
    await this.prisma.$transaction(async (tx) => {
      await tx.section.update({ where: { id: sectionId }, data: { listStatus: 'FINAL', listFinalBy: ctx.userId, listFinalAt: new Date(), updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'LIST_FINAL', entityType: 'Section', entityId: sectionId }, tx);
    });
    const waiting = await this.prisma.section.count({ where: { classId: section.classId, status: 'ACTIVE', listStatus: { not: 'FINAL' } } });
    return { listStatus: 'FINAL', divisionsWaiting: waiting };
  }

  /** Generate the class's Exam Nos (all divisions final), by the Headmaster or the office. */
  async generateClassExamNos(ctx: AccessContext, sectionId: bigint) {
    const { section, can } = await this.listSection(ctx, sectionId);
    if (!can.generate) throw outOfScope('The Headmaster or the office generates Exam Nos');
    const cls = await this.prisma.schoolClass.findUniqueOrThrow({ where: { id: section.classId } });
    if (cls.examNosAt) throw invalidState('Exam Nos of this class are already generated');
    const waiting = await this.prisma.section.findMany({ where: { classId: section.classId, status: 'ACTIVE', listStatus: { not: 'FINAL' } }, select: { name: true } });
    if (waiting.length) throw invalidState(`The class list of division ${waiting.map((w) => w.name).join(', ')} is not final yet`);
    const generated = await this.prisma.$transaction((tx) => this.generateExamNos(tx, ctx, section.classId), { timeout: 60_000 });
    return { generated };
  }

  /** Change roll numbers by hand (unique, 1–999) while the list is a draft or with the class teacher. */
  async saveRollNumbers(ctx: AccessContext, sectionId: bigint, items: { enrollmentId: number; rollNo: number }[]) {
    const { section, can } = await this.listSection(ctx, sectionId);
    if (!this.canEditRolls(can, section.listStatus)) {
      throw section.listStatus === 'CONFIRMED' || section.listStatus === 'FINAL' ? invalidState('The class list is confirmed: roll numbers can no longer be changed') : outOfScope('You cannot change roll numbers of this division now');
    }
    const active = await this.prisma.studentEnrollment.findMany({ where: { sectionId, status: 'ACTIVE' }, select: { id: true } });
    const ids = new Set(active.map((a) => Number(a.id)));
    if (items.some((i) => !ids.has(i.enrollmentId))) throw invalid('A student is not studying in this division');
    if (new Set(items.map((i) => i.enrollmentId)).size !== items.length) throw invalid('A student appears twice in the list');
    const seen = new Map<number, number>();
    for (const i of items) {
      if (seen.has(i.rollNo)) throw invalid(`Roll number ${i.rollNo} is given to two students`, [{ path: `rolls.${i.enrollmentId}`, code: 'duplicate', message: 'Used twice' }]);
      seen.set(i.rollNo, i.enrollmentId);
    }
    const taken = await this.prisma.studentEnrollment.findFirst({ where: { sectionId, status: { not: 'ACTIVE' }, rollNo: { in: [...seen.keys()] } }, select: { rollNo: true } });
    if (taken) throw invalid(`Roll number ${taken.rollNo} still belongs to a student who left this division`);
    await this.prisma.$transaction(async (tx) => {
      await tx.studentEnrollment.updateMany({ where: { id: { in: items.map((i) => BigInt(i.enrollmentId)) } }, data: { rollNo: null } });
      for (const i of items) await tx.studentEnrollment.update({ where: { id: BigInt(i.enrollmentId) }, data: { rollNo: i.rollNo, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'ROLL_NUMBERS', entityType: 'Section', entityId: sectionId, after: { students: items.length } }, tx);
    });
    return { saved: items.length };
  }

  /** Exam No series of a class: E-1-001, E-1-002 … (one series for all its divisions, restarting every year). */
  private async nextExamNo(tx: Tx, ctx: AccessContext, cls: { academicYear: { name: string }; medium: { nameEn: string }; standard: { code: string; levelOrder: number } }) {
    const prefix = examNoPrefix(cls.medium.nameEn, cls.standard);
    const key = `exam_series:${cls.academicYear.name}:${prefix}`;
    await tx.numberSequence.upsert({
      where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: key } }, update: {},
      create: { schoolId: ctx.schoolId, seqKey: key, label: `Exam No. ${cls.academicYear.name} · ${prefix}-…`, pattern: `${prefix}-{000}`, nextValue: BigInt(1) },
    });
    return this.sequences.next(tx, ctx.schoolId, key);
  }

  /** Number every student of the class: division A then B …, each in roll-number (A–Z) order. */
  private async generateExamNos(tx: Tx, ctx: AccessContext, classId: bigint) {
    const cls = await tx.schoolClass.findUniqueOrThrow({ where: { id: classId }, include: { academicYear: true, medium: true, standard: true } });
    if (cls.examNosAt) return 0;
    const rows = await tx.studentEnrollment.findMany({
      where: { classId, status: 'ACTIVE', examNo: null },
      include: { section: { select: { name: true } }, student: { select: { fullName: true } } },
    });
    rows.sort((a, b) => a.section.name.localeCompare(b.section.name) || (a.rollNo ?? 9999) - (b.rollNo ?? 9999) || a.student.fullName.localeCompare(b.student.fullName));
    // Start right after the highest number still in use in this year's series (normally none → 001), so numbers
    // given out earlier and taken back (a student who left, a reset list) leave no gap at roll 1.
    const prefix = examNoPrefix(cls.medium.nameEn, cls.standard);
    const used = await tx.studentEnrollment.findMany({ where: { academicYearId: cls.academicYearId, examNo: { startsWith: `${prefix}-` } }, select: { examNo: true } });
    const highest = used.reduce((m, u) => Math.max(m, Number(u.examNo!.slice(prefix.length + 1)) || 0), 0);
    const key = `exam_series:${cls.academicYear.name}:${prefix}`;
    await tx.numberSequence.upsert({
      where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: key } }, update: { nextValue: BigInt(highest + 1) },
      create: { schoolId: ctx.schoolId, seqKey: key, label: `Exam No. ${cls.academicYear.name} · ${prefix}-…`, pattern: `${prefix}-{000}`, nextValue: BigInt(highest + 1) },
    });
    for (const r of rows) await tx.studentEnrollment.update({ where: { id: r.id }, data: { examNo: await this.nextExamNo(tx, ctx, cls), updatedBy: ctx.userId } });
    await tx.schoolClass.update({ where: { id: classId }, data: { examNosAt: new Date() } });
    await this.audit.record(ctx, { action: 'EXAM_NOS', entityType: 'SchoolClass', entityId: classId, after: { students: rows.length, prefix: examNoPrefix(cls.medium.nameEn, cls.standard) } }, tx);
    return rows.length;
  }

  /** A student joining after the class's Exam Nos were generated takes the next free number. */
  async lateExamNo(tx: Tx, ctx: AccessContext, classId: bigint) {
    const cls = await tx.schoolClass.findUniqueOrThrow({ where: { id: classId }, include: { academicYear: true, medium: true, standard: true } });
    return cls.examNosAt ? this.nextExamNo(tx, ctx, cls) : null;
  }

  /** Re-number a division alphabetically (1..n), the way schools usually arrange roll numbers. */
  async renumber(ctx: AccessContext, sectionId: bigint) {
    const section = await this.prisma.section.findFirst({ where: { id: sectionId, schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: { schoolClass: true } });
    if (!section) throw notFound('Division');
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    const can = await this.listAccess(ctx, scope, sectionId);
    if (!this.canEditRolls(can, section.listStatus)) {
      throw section.listStatus === 'CONFIRMED' || section.listStatus === 'FINAL' ? invalidState('The class list is confirmed: roll numbers can no longer be changed') : outOfScope('You cannot change roll numbers of this division now');
    }
    const rows = await this.prisma.studentEnrollment.findMany({ where: { sectionId, status: 'ACTIVE' }, include: { student: { select: { fullName: true } } } });
    rows.sort((a, b) => a.student.fullName.localeCompare(b.student.fullName));
    await this.prisma.$transaction(async (tx) => {
      await tx.studentEnrollment.updateMany({ where: { sectionId }, data: { rollNo: null } });
      for (const [i, r] of rows.entries()) await tx.studentEnrollment.update({ where: { id: r.id }, data: { rollNo: i + 1, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'RENUMBER', entityType: 'Section', entityId: sectionId, after: { students: rows.length }, reason: 'Roll numbers arranged alphabetically' }, tx);
    });
    return { renumbered: rows.length };
  }

  // ------------------------------------------------------------------ siblings, duplicates
  /** Other students whose parent has the same mobile number (the school records siblings this way). */
  private async siblings(ctx: AccessContext, s: StudentFull) {
    const mobiles = [...new Set(s.guardians.map((g) => g.guardian.mobile).filter((m): m is string => !!m))];
    if (!mobiles.length) return [];
    const rows = await this.prisma.student.findMany({
      where: { schoolId: ctx.schoolId, id: { not: s.id }, status: 'ACTIVE', guardians: { some: { guardian: { mobile: { in: mobiles } } } } },
      select: { id: true, fullName: true, grNo: true, enrollments: { where: { academicYear: { isCurrent: true } }, select: { section: { select: sectionSelect } }, take: 1 } },
      take: 10,
    });
    return rows.map((r) => ({ id: r.id, fullName: r.fullName, grNo: r.grNo, section: r.enrollments[0]?.section ?? null }));
  }

  /** Students who may be the same child: same full name, or same date of birth and mother's name. */
  async duplicates(ctx: AccessContext, q: StudentDuplicateQuery) {
    const name = q.fullName?.replace(/\s+/g, ' ').trim().toUpperCase();
    const dob = q.dob ? dateOnly(q.dob) : null;
    const mother = q.motherName?.trim();
    const or: Prisma.StudentWhereInput[] = [];
    if (name && name.length >= 3) or.push({ fullName: name });
    if (dob && mother && mother.length >= 2) or.push({ dob, motherName: mother });
    if (dob && name && name.length >= 3) {
      // Same birthday and the same first two words of the name (SURNAME FIRST ...).
      const head = name.split(' ').slice(0, 2).join(' ');
      if (head.includes(' ')) or.push({ dob, fullName: { startsWith: head } });
    }
    if (!or.length) return [];
    const rows = await this.prisma.student.findMany({
      where: { schoolId: ctx.schoolId, OR: or, ...(q.excludeId ? { id: { not: BigInt(q.excludeId) } } : {}) },
      select: {
        id: true, fullName: true, grNo: true, dob: true, motherName: true, status: true,
        enrollments: { orderBy: { academicYearId: 'desc' }, take: 1, select: { section: { select: sectionSelect }, academicYear: { select: { name: true } } } },
      },
      take: 10,
    });
    return rows.map((r) => {
      const reasons: string[] = [];
      if (name && r.fullName === name) reasons.push('same name');
      if (dob && r.dob && r.dob.getTime() === dob.getTime()) reasons.push('same date of birth');
      if (mother && r.motherName && r.motherName.toLowerCase() === mother.toLowerCase()) reasons.push("same mother's name");
      return {
        id: r.id, fullName: r.fullName, grNo: r.grNo, dob: r.dob, motherName: r.motherName, status: r.status,
        section: r.enrollments[0]?.section ?? null, year: r.enrollments[0]?.academicYear.name ?? null, reasons,
      };
    });
  }

  // ------------------------------------------------------------------ documents
  private async documentList(studentId: bigint) {
    const rows = await this.prisma.studentDocument.findMany({ where: { studentId }, orderBy: { id: 'asc' } });
    const files = await this.prisma.file.findMany({ where: { id: { in: rows.map((r) => r.fileId) } }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true } });
    const byId = new Map(files.map((f) => [String(f.id), f]));
    return rows.map((r) => {
      const f = byId.get(String(r.fileId));
      return { id: r.id, docType: r.docType, fileName: f?.originalName ?? '', mimeType: f?.mimeType ?? '', sizeBytes: f ? Number(f.sizeBytes) : 0, createdAt: r.createdAt };
    });
  }

  async uploadDocument(ctx: AccessContext, id: bigint, docType: string, file: Express.Multer.File | undefined) {
    const s = await this.load(ctx, id);
    await this.assertEdit(ctx, s);
    if (!(ADMISSION_DOCUMENTS as readonly string[]).includes(docType)) throw invalid('Unknown document type', [{ path: 'docType', code: 'invalid', message: 'Choose a document from the list' }]);
    if (!file) throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, 'Choose a file to upload');
    if (file.size > MAX_DOCUMENT_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The file must be 5 MB or smaller');
    const type = sniffDocument(file.buffer);
    if (!type) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PDF, JPEG, PNG or WebP files are allowed');
    const key = await this.storage.put(`schools/${ctx.schoolId}/student-documents`, type.ext, file.buffer);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.file.create({
        data: {
          schoolId: ctx.schoolId, storageDriver: this.storage.name, storageKey: key, originalName: file.originalname.slice(0, 255),
          mimeType: type.mime, sizeBytes: BigInt(file.size), sha256: createHash('sha256').update(file.buffer).digest('hex'),
          purpose: 'STUDENT_DOCUMENT', createdBy: ctx.userId,
        },
      });
      const doc = await tx.studentDocument.create({ data: { studentId: id, docType, fileId: row.id, createdBy: ctx.userId } });
      // Uploading a scan also ticks the document as received.
      const received = Array.isArray(s.documents) ? (s.documents as string[]) : [];
      if (!received.includes(docType)) await tx.student.update({ where: { id }, data: { documents: [...received, docType], updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Student', entityId: id, after: { documentId: doc.id, docType, fileName: row.originalName }, reason: `Document uploaded: ${docType}` }, tx);
      return { id: doc.id, docType, fileName: row.originalName, mimeType: row.mimeType, sizeBytes: file.size, createdAt: doc.createdAt };
    });
  }

  /** Scans are shown only to people who may see the student's contact details. */
  async streamDocument(ctx: AccessContext, id: bigint, docId: bigint, res: Response) {
    const s = await this.load(ctx, id);
    const { access } = await this.visibleEnrollment(ctx, s);
    if (!access.contact) throw outOfScope('Documents are visible to the class teacher, Headmaster and office');
    const doc = await this.prisma.studentDocument.findFirst({ where: { id: docId, studentId: id } });
    const f = doc ? await this.prisma.file.findFirst({ where: { id: doc.fileId, schoolId: ctx.schoolId, purpose: 'STUDENT_DOCUMENT' } }) : null;
    if (!f) throw notFound('Document');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${f.originalName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    this.storage.read(f.storageKey).pipe(res);
    return new StreamMarker();
  }

  async deleteDocument(ctx: AccessContext, id: bigint, docId: bigint) {
    const s = await this.load(ctx, id);
    await this.assertEdit(ctx, s);
    const doc = await this.prisma.studentDocument.findFirst({ where: { id: docId, studentId: id } });
    if (!doc) throw notFound('Document');
    await this.prisma.$transaction(async (tx) => {
      // The file row stays (audit trail); only the link to the student is removed.
      await tx.studentDocument.delete({ where: { id: docId } });
      await this.audit.record(ctx, { action: 'DELETE', entityType: 'Student', entityId: id, before: { documentId: doc.id, docType: doc.docType, fileId: doc.fileId }, reason: `Document removed: ${doc.docType}` }, tx);
    });
    return { removed: true };
  }

  // ------------------------------------------------------------------ photo
  async uploadPhoto(ctx: AccessContext, id: bigint, file: Express.Multer.File | undefined) {
    const s = await this.load(ctx, id);
    await this.assertEdit(ctx, s);
    if (!file) throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, 'Choose a photo to upload');
    if (file.size > MAX_PHOTO_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'Photo must be 2 MB or smaller');
    const type = sniffImage(file.buffer);
    if (!type) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PNG, JPEG or WebP photos are allowed');
    const key = await this.storage.put(`schools/${ctx.schoolId}/students`, type.ext, file.buffer);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.file.create({
        data: {
          schoolId: ctx.schoolId, storageDriver: this.storage.name, storageKey: key, originalName: file.originalname.slice(0, 255),
          mimeType: type.mime, sizeBytes: BigInt(file.size), sha256: createHash('sha256').update(file.buffer).digest('hex'),
          purpose: 'STUDENT_PHOTO', createdBy: ctx.userId,
        },
      });
      const after = await tx.student.update({ where: { id }, data: { photoFileId: row.id, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Student', entityId: id, before: { photoFileId: s.photoFileId }, after: { photoFileId: row.id }, reason: 'Photo uploaded' }, tx);
      return after;
    });
  }

  /** Photos are served only to users who can see the student. */
  async streamPhoto(ctx: AccessContext, id: bigint, res: Response) {
    const s = await this.load(ctx, id);
    await this.visibleEnrollment(ctx, s);
    const f = s.photoFileId ? await this.prisma.file.findFirst({ where: { id: s.photoFileId, schoolId: ctx.schoolId, purpose: 'STUDENT_PHOTO' } }) : null;
    if (!f) throw notFound('Photo');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    this.storage.read(f.storageKey).pipe(res);
    return new StreamMarker();
  }

  // ------------------------------------------------------------------ overview (home page)
  /** Divisions the user can see, with student counts and the people responsible. */
  async overview(ctx: AccessContext, academicYearId?: number) {
    const year = await this.year(ctx, academicYearId);
    const scope = await this.scopes.resolve(ctx, year.id);
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE' }, ...(scope.all ? {} : { id: { in: scope.sectionIds } }) },
      select: {
        ...sectionSelect,
        schoolClass: { select: { ...sectionSelect.schoolClass.select, examNosAt: true } },
        capacity: true, listStatus: true, listNote: true, listReadyAt: true, listConfirmedAt: true,
        assignments: { where: { status: 'ACTIVE', role: { in: ['CLASS_TEACHER', 'OPERATOR'] } }, select: { role: true, staff: { select: { id: true, name: true } } } },
      },
    });
    const counts = await this.prisma.studentEnrollment.groupBy({
      by: ['sectionId'],
      where: { academicYearId: year.id, status: 'ACTIVE', sectionId: { in: sections.map((s) => s.id) } },
      _count: { _all: true },
    });
    const girls = await this.prisma.studentEnrollment.groupBy({
      by: ['sectionId'],
      where: { academicYearId: year.id, status: 'ACTIVE', sectionId: { in: sections.map((s) => s.id) }, student: { gender: 'FEMALE' } },
      _count: { _all: true },
    });
    const n = new Map(counts.map((c) => [String(c.sectionId), c._count._all]));
    const g = new Map(girls.map((c) => [String(c.sectionId), c._count._all]));
    const rows = sections
      .map((s) => {
        const total = n.get(String(s.id)) ?? 0;
        const girlsN = g.get(String(s.id)) ?? 0;
        const mine = (Object.keys(scope.byRole) as (keyof ResolvedScope['byRole'])[]).filter((r) => scope.byRole[r].some((x) => x === s.id));
        return {
          sectionId: s.id, name: s.name, capacity: s.capacity, schoolClass: s.schoolClass, students: total, girls: girlsN, boys: total - girlsN,
          classTeacher: s.assignments.find((a) => a.role === 'CLASS_TEACHER')?.staff ?? null,
          operators: s.assignments.filter((a) => a.role === 'OPERATOR').map((a) => a.staff),
          myRoles: mine,
          list: { status: s.listStatus, note: s.listNote, readyAt: s.listReadyAt, confirmedAt: s.listConfirmedAt, examNosAt: s.schoolClass.examNosAt },
        };
      })
      .sort((a, b) => (a.schoolClass.medium.code === b.schoolClass.medium.code ? 0 : a.schoolClass.medium.code === 'EN' ? -1 : 1)
        || a.schoolClass.standard.levelOrder - b.schoolClass.standard.levelOrder || a.name.localeCompare(b.name));
    const total = rows.reduce((t, r) => t + r.students, 0);
    const byMedium = Object.values(rows.reduce<Record<string, { code: string; name: string; students: number; divisions: number }>>((acc, r) => {
      const m = r.schoolClass.medium;
      acc[m.code] ??= { code: m.code, name: m.nameEn, students: 0, divisions: 0 };
      acc[m.code].students += r.students;
      acc[m.code].divisions += 1;
      return acc;
    }, {}));
    return {
      year: { id: year.id, name: year.name, startDate: year.startDate, endDate: year.endDate },
      scopeAll: scope.all,
      totals: { students: total, girls: rows.reduce((t, r) => t + r.girls, 0), boys: rows.reduce((t, r) => t + r.boys, 0), divisions: rows.length },
      byMedium,
      sections: rows,
    };
  }
}

const overviewQuery = z.object({ academicYearId: z.coerce.number().int().positive().optional() });

@Controller()
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get('students') @RequirePermission(P.STUDENTS_READ)
  list(@Ctx() ctx: AccessContext, @Query(zBody(studentListQuerySchema)) q: StudentListQuery) { return this.students.list(ctx, q); }

  @Get('students/overview') @RequirePermission(P.STUDENTS_READ)
  overview(@Ctx() ctx: AccessContext, @Query(zBody(overviewQuery)) q: z.infer<typeof overviewQuery>) { return this.students.overview(ctx, q.academicYearId); }

  @Get('students/duplicates') @RequirePermission(P.STUDENTS_WRITE)
  duplicates(@Ctx() ctx: AccessContext, @Query(zBody(studentDuplicateQuerySchema)) q: StudentDuplicateQuery) { return this.students.duplicates(ctx, q); }

  @Get('students/admissions/pending') @RequirePermission(P.STUDENTS_READ)
  pending(@Ctx() ctx: AccessContext) { return this.students.pendingAdmissions(ctx); }

  @Post('students/:id/admission/approve') @HttpCode(200) @RequirePermission(P.STUDENTS_ADMISSION_APPROVE)
  approveAdmission(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(admissionConfirmSchema)) b: { grNo: string | null }) { return this.students.approveAdmission(ctx, id, b.grNo); }

  @Post('students/:id/admission/return') @HttpCode(200) @RequirePermission(P.STUDENTS_ADMISSION_APPROVE)
  returnAdmission(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(admissionRejectSchema)) b: { reason: string }) { return this.students.returnAdmission(ctx, id, b.reason); }

  @Post('students/:id/admission/resubmit') @HttpCode(200) @RequirePermission(P.STUDENTS_WRITE)
  resubmitAdmission(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.resubmitAdmission(ctx, id); }

  @Patch('students/:id/gr-no') @RequirePermission(P.STUDENTS_WRITE)
  setGrNo(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(grNoSchema)) b: { grNo: string | null }) { return this.students.setGrNo(ctx, id, b.grNo); }

  @Post('students/:id/admission/reject') @HttpCode(200) @RequirePermission(P.STUDENTS_ADMISSION_APPROVE)
  rejectAdmission(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(admissionRejectSchema)) b: { reason: string }) { return this.students.rejectAdmission(ctx, id, b.reason); }

  @Get('students/:id') @RequirePermission(P.STUDENTS_READ)
  get(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.get(ctx, id); }

  @Post('students') @RequirePermission(P.STUDENTS_WRITE)
  create(@Ctx() ctx: AccessContext, @Body(zBody(studentCreateSchema)) b: StudentCreateInput) { return this.students.create(ctx, b); }

  @Patch('students/:id') @RequirePermission(P.STUDENTS_WRITE)
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(studentSchema)) b: StudentInput) { return this.students.update(ctx, id, b); }

  @Patch('students/:id/enrollment') @RequirePermission(P.STUDENTS_WRITE)
  enrollment(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(enrollmentInputSchema)) b: EnrollmentInput) { return this.students.updateEnrollment(ctx, id, b); }

  @Post('students/:id/status') @HttpCode(200) @RequirePermission(P.STUDENTS_STATUS)
  status(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(studentStatusSchema)) b: StudentStatusInput) { return this.students.changeStatus(ctx, id, b); }

  @Post('students/:id/photo') @HttpCode(200) @RequirePermission(P.STUDENTS_WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES + 1, files: 1 } }))
  photo(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @UploadedFile() file?: Express.Multer.File) { return this.students.uploadPhoto(ctx, id, file); }

  @Get('students/:id/photo') @RequirePermission(P.STUDENTS_READ)
  photoContent(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Res() res: Response) { return this.students.streamPhoto(ctx, id, res); }

  @Post('students/:id/documents') @HttpCode(200) @RequirePermission(P.STUDENTS_WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES + 1, files: 1 } }))
  uploadDocument(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(studentDocumentUploadSchema)) b: { docType: string }, @UploadedFile() file?: Express.Multer.File) {
    return this.students.uploadDocument(ctx, id, b.docType, file);
  }

  @Get('students/:id/documents/:docId') @RequirePermission(P.STUDENTS_READ)
  documentContent(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('docId', IdPipe) docId: bigint, @Res() res: Response) {
    return this.students.streamDocument(ctx, id, docId, res);
  }

  @Delete('students/:id/documents/:docId') @RequirePermission(P.STUDENTS_WRITE)
  deleteDocument(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('docId', IdPipe) docId: bigint) { return this.students.deleteDocument(ctx, id, docId); }

  @Get('class-lists') @RequirePermission(P.STUDENTS_READ)
  classLists(@Ctx() ctx: AccessContext, @Query(zBody(yearQuerySchema)) q: { academicYearId?: number }) { return this.students.classListsOverview(ctx, q.academicYearId); }

  @Get('sections/:id/list') @RequirePermission(P.STUDENTS_READ)
  async listState(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.listState(ctx, id); }

  @Post('sections/:id/list/ready') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  listReady(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.listReady(ctx, id); }

  @Post('sections/:id/list/return') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  listReturn(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(listNoteSchema)) b: { note: string | null }) { return this.students.listReturn(ctx, id, b.note); }

  @Post('sections/:id/list/confirm') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  listConfirm(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.listConfirm(ctx, id); }

  @Post('sections/:id/list/finalize') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  listFinalize(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.listFinalize(ctx, id); }

  @Post('sections/:id/exam-nos') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  generateExamNos(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.generateClassExamNos(ctx, id); }

  @Put('sections/:id/roll-numbers') @RequirePermission(P.STUDENTS_READ)
  saveRollNumbers(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(rollNumbersSchema)) b: z.infer<typeof rollNumbersSchema>) { return this.students.saveRollNumbers(ctx, id, b.items); }

  @Post('sections/:id/renumber') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  renumber(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.students.renumber(ctx, id); }
}

@Module({ imports: [PoliciesSequencesModule], controllers: [StudentsController], providers: [StudentsService], exports: [StudentsService] })
export class StudentsModule {}
