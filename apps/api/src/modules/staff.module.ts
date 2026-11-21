/// <reference types="multer" />
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ASSIGNMENT_ROLES, AssignmentInput, assignmentSchema, EMPLOYEE_TYPES, ERROR_CODES, listQuerySchema, PERMISSIONS, STAFF_EMPLOYMENT_FIELDS, STAFF_SALARY_FIELDS,
  StaffInput, staffRegistrationSchema, staffSchema, staffStatusSchema,
} from '@cps/shared';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState, unique } from '../common/crud';
import { AppError, conflict, forbidden, invalid, isUniqueViolation, notFound } from '../common/errors';
import { page, skipTake, StreamMarker } from '../common/serialize';
import { big, dateOnly, IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, Tx } from '../infra/prisma.service';
import { sniffImage, StorageDriver } from '../infra/storage.service';
import { PoliciesSequencesModule, SequencesService } from './policies-sequences.module';

const P = PERMISSIONS;
const assignmentQuery = z.object({
  academicYearId: z.coerce.number().int().positive(),
  staffId: z.coerce.number().int().positive().optional(),
  sectionId: z.coerce.number().int().positive().optional(),
  classId: z.coerce.number().int().positive().optional(),
  mediumId: z.coerce.number().int().positive().optional(),
  role: z.enum(ASSIGNMENT_ROLES).optional(),
  includeEnded: z.enum(['true', 'false']).optional(),
});
const replaceSchema = z.object({ staffId: z.coerce.number().int().positive(), reason: z.string().trim().min(3, 'Give a reason').max(500) });
const endSchema = z.object({ validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const classTeacherSchema = z.object({ staffId: z.coerce.number().int().positive() });
const today = () => new Date().toISOString().slice(0, 10);

const assignmentInclude = {
  staff: { select: { id: true, name: true, employeeCode: true } },
  section: { select: { id: true, name: true, schoolClass: { select: { id: true, displayName: true, medium: { select: { id: true, code: true } } } } } },
  classSubject: { select: { id: true, subject: { select: { id: true, nameEn: true, shortName: true, code: true } } } },
} as const;

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const staffListQuery = listQuerySchema.extend({
  designation: z.string().max(60).optional(), department: z.string().max(60).optional(), employeeType: z.enum(EMPLOYEE_TYPES).optional(),
  joinFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), joinTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const docUpload = z.object({ title: z.string().trim().min(2, 'Give the document a name').max(100) });
const MANAGER_FIELDS = new Set<string>(STAFF_EMPLOYMENT_FIELDS);
const SALARY_FIELDS = new Set<string>(STAFF_SALARY_FIELDS);
const REQUIRED_TO_ACTIVATE = ['employeeType', 'designation', 'department', 'joiningDate', 'employmentType'] as const;
const LABEL: Record<string, string> = {
  employeeType: 'employee type', designation: 'designation', department: 'department', qualification: 'qualification', joiningDate: 'joining date',
  employmentType: 'employment type', reportingManagerId: 'reporting manager', leavingDate: 'leaving date', remarks: 'remarks',
};

function sniffDocument(buf: Buffer) {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return sniffImage(buf);
}
const canSeeStaff = (ctx: AccessContext) => hasPermission(ctx, P.STAFF_READ) || hasPermission(ctx, P.STAFF_REGISTER) || hasPermission(ctx, P.STAFF_MANAGE);

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sequences: SequencesService, @Inject('STORAGE') private readonly storage: StorageDriver) {}

  private assertView(ctx: AccessContext) {
    if (!canSeeStaff(ctx)) throw forbidden('You cannot view staff records');
  }
  /** Salary and bank details only for users with the salary permission. */
  private view<T extends Record<string, unknown>>(ctx: AccessContext, s: T) {
    if (hasPermission(ctx, P.STAFF_SALARY)) return { ...s, canSeeSalary: true };
    const out: Record<string, unknown> = { ...s, canSeeSalary: false };
    for (const k of STAFF_SALARY_FIELDS) out[k] = null;
    return out as T & { canSeeSalary: boolean };
  }

  async list(ctx: AccessContext, q: z.infer<typeof staffListQuery>) {
    this.assertView(ctx);
    const where: Prisma.StaffWhereInput = {
      schoolId: ctx.schoolId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.designation ? { designation: q.designation } : {}),
      ...(q.department ? { department: q.department } : {}),
      ...(q.employeeType ? { employeeType: q.employeeType } : {}),
      ...(q.joinFrom || q.joinTo ? { joiningDate: { ...(q.joinFrom ? { gte: dateOnly(q.joinFrom)! } : {}), ...(q.joinTo ? { lte: dateOnly(q.joinTo)! } : {}) } } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { employeeCode: { contains: q.q } }, { mobile: { contains: q.q } }] } : {}),
    };
    const orderBy: Prisma.StaffOrderByWithRelationInput = q.sort === '-name' ? { name: 'desc' } : q.sort === 'employeeCode' ? { employeeCode: 'asc' } : q.sort === 'joiningDate' ? { joiningDate: 'asc' } : q.sort === '-joiningDate' ? { joiningDate: 'desc' } : { name: 'asc' };
    const [rows, total, pending] = await Promise.all([
      this.prisma.staff.findMany({ where, orderBy, ...skipTake(q), include: { user: { select: { id: true, username: true, status: true } } } }),
      this.prisma.staff.count({ where }),
      this.prisma.staff.count({ where: { schoolId: ctx.schoolId, status: 'PENDING_ASSIGNMENT' } }),
    ]);
    return { ...page(rows.map((r) => this.view(ctx, r)), total, q), pendingAssignment: pending };
  }

  async get(ctx: AccessContext, id: bigint) {
    this.assertView(ctx);
    const s = await this.prisma.staff.findFirst({ where: { id, schoolId: ctx.schoolId }, include: { user: { select: { id: true, username: true, status: true } }, documents: { orderBy: { id: 'asc' } } } });
    if (!s) throw notFound('Staff member');
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    const assignments = year ? await this.prisma.teachingAssignment.findMany({ where: { staffId: id, academicYearId: year.id, status: 'ACTIVE' }, include: assignmentInclude }) : [];
    const workload = {
      classTeacherOf: assignments.filter((a) => a.role === 'CLASS_TEACHER').length,
      subjectPeriods: assignments.filter((a) => a.role === 'SUBJECT_TEACHER').length,
      attendanceDivisions: assignments.filter((a) => a.role === 'ATTENDANCE_VERIFIER').length,
      operatorDivisions: assignments.filter((a) => a.role === 'OPERATOR').length,
    };
    const manager = s.reportingManagerId ? await this.prisma.staff.findUnique({ where: { id: s.reportingManagerId }, select: { id: true, name: true, designation: true } }) : null;
    const files = await this.prisma.file.findMany({ where: { id: { in: s.documents.map((d) => d.fileId) } }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true } });
    const fileBy = new Map(files.map((f) => [String(f.id), f]));
    const canHistory = hasPermission(ctx, P.STAFF_MANAGE) || hasPermission(ctx, P.AUDIT_READ);
    const history = canHistory ? await this.history(ctx, id) : null;
    const { documents, ...rest } = s;
    return {
      ...this.view(ctx, rest), currentYear: year ? { id: year.id, name: year.name } : null, assignments, workload, reportingManager: manager,
      documents: documents.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, fileName: fileBy.get(String(d.fileId))?.originalName ?? '', mimeType: fileBy.get(String(d.fileId))?.mimeType ?? '', sizeBytes: Number(fileBy.get(String(d.fileId))?.sizeBytes ?? 0) })),
      history,
      access: { manage: hasPermission(ctx, P.STAFF_MANAGE), register: hasPermission(ctx, P.STAFF_REGISTER) || hasPermission(ctx, P.STAFF_MANAGE), salary: hasPermission(ctx, P.STAFF_SALARY), assign: hasPermission(ctx, P.ASSIGNMENTS_MANAGE) },
    };
  }

  /** Every change to the record (who, when, what, why). Salary values are hidden from users without salary access. */
  private async history(ctx: AccessContext, id: bigint) {
    const logs = await this.prisma.auditLog.findMany({ where: { schoolId: ctx.schoolId, entityType: 'Staff', entityId: id }, orderBy: { id: 'desc' }, take: 100 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.userId).filter((v): v is bigint => v != null))] } }, select: { id: true, username: true } });
    const names = new Map(users.map((u) => [String(u.id), u.username]));
    const hide = !hasPermission(ctx, P.STAFF_SALARY);
    const strip = (v: unknown) => {
      if (!hide || !v || typeof v !== 'object') return v;
      const o = { ...(v as Record<string, unknown>) };
      for (const k of STAFF_SALARY_FIELDS) if (k in o) o[k] = '(hidden)';
      return o;
    };
    return logs.map((l) => ({ id: l.id, at: l.createdAt, action: l.action, reason: l.reason, by: l.userId ? names.get(String(l.userId)) ?? null : null, before: strip(l.beforeData), after: strip(l.afterData) }));
  }

  /**
   * One save for everyone; WHO may change WHAT is checked here (backend rule, not only hidden buttons):
   *  - personal details: staff.register (office) or staff.manage
   *  - employment fields and status: staff.manage (Headmaster / Super Admin)
   *  - salary and bank details: staff.salary
   * A field a user may not change must be absent (or unchanged) in what they send.
   */
  async save(ctx: AccessContext, input: StaffInput, id?: bigint) {
    const manage = hasPermission(ctx, P.STAFF_MANAGE);
    const salary = hasPermission(ctx, P.STAFF_SALARY);
    if (!manage && !hasPermission(ctx, P.STAFF_REGISTER)) throw forbidden('You cannot add or edit staff');
    const before = id ? await this.prisma.staff.findFirst({ where: { id, schoolId: ctx.schoolId } }) : null;
    if (id && !before) throw notFound('Staff member');
    if (!id && !manage) {
      const r = staffRegistrationSchema.safeParse(input);
      if (!r.success) throw invalid('Please fill in the required personal details', r.error.issues.map((i) => ({ path: i.path.join('.'), code: 'required', message: i.message })));
    }
    const stored = (before ?? {}) as Record<string, unknown>;
    const same = (k: string, v: unknown) => {
      const cur = stored[k];
      if (v === null || v === undefined) return true; // not sent by this user: keep what is stored
      if (cur instanceof Date) return cur.toISOString().slice(0, 10) === String(v);
      if (cur != null && typeof cur === 'object') return Number(cur) === Number(v); // Decimal
      if (typeof cur === 'bigint') return cur === BigInt(v as number);
      return cur === v;
    };
    const data: Record<string, unknown> = {};
    const blocked: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (k === 'status' || k === 'employeeCode') continue;
      if (MANAGER_FIELDS.has(k) && !manage) { if (!same(k, v)) blocked.push(LABEL[k] ?? k); continue; }
      if (SALARY_FIELDS.has(k) && !salary) { if (!same(k, v)) blocked.push('salary and bank details'); continue; }
      data[k] = v;
    }
    if (blocked.length) throw forbidden(`Only the Headmaster can set the ${[...new Set(blocked)].join(', ')}`);
    for (const k of ['dob', 'joiningDate', 'leavingDate']) if (k in data) data[k] = dateOnly(data[k] as string | null);
    if ('reportingManagerId' in data) {
      const m = data.reportingManagerId as number | null;
      if (m != null) {
        if (id && BigInt(m) === id) throw invalid('A staff member cannot report to themselves', [{ path: 'reportingManagerId', code: 'self', message: 'Choose someone else' }]);
        if (!(await this.prisma.staff.findFirst({ where: { id: BigInt(m), schoolId: ctx.schoolId } }))) throw notFound('Reporting manager');
      }
      data.reportingManagerId = m == null ? null : BigInt(m);
    }
    // Status: the office registers as "pending assignment"; only the Headmaster changes status.
    let status = before?.status ?? (manage ? 'ACTIVE' : 'PENDING_ASSIGNMENT');
    if (input.status && input.status !== status) {
      if (!manage) throw forbidden('Only the Headmaster can activate staff or change their status');
      status = input.status;
    }
    if (status === 'ACTIVE' && before?.status === 'PENDING_ASSIGNMENT') {
      const merged = { ...stored, ...data };
      const missing = REQUIRED_TO_ACTIVATE.filter((k) => merged[k] == null || merged[k] === '');
      if (missing.length) throw invalid(`Before activating, assign the ${missing.map((k) => LABEL[k]).join(', ')}`, missing.map((k) => ({ path: k, code: 'required', message: 'Required to activate' })));
    }
    return this.prisma.$transaction(async (tx) => {
      let employeeCode = input.employeeCode?.toUpperCase() ?? before?.employeeCode ?? null;
      if (!employeeCode) {
        await tx.numberSequence.upsert({ where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: 'staff_code' } }, update: {}, create: { schoolId: ctx.schoolId, seqKey: 'staff_code', label: 'Staff ID', pattern: 'STF{0000}', nextValue: BigInt(1) } });
        employeeCode = await this.sequences.next(tx, ctx.schoolId, 'staff_code');
      }
      if (before && input.employeeCode && input.employeeCode.toUpperCase() !== before.employeeCode && !manage) throw forbidden('Only the Headmaster can change the Staff ID');
      const after = await unique(
        () => (id
          ? tx.staff.update({ where: { id }, data: { ...data, employeeCode, status, updatedBy: ctx.userId } })
          : tx.staff.create({ data: { ...(data as Prisma.StaffUncheckedCreateInput), name: input.name, employeeCode: employeeCode!, status, schoolId: ctx.schoolId, createdBy: ctx.userId } })),
        'employeeCode', `Staff ID ${employeeCode} already exists`,
      );
      if (before && before.status === 'ACTIVE' && ['INACTIVE', 'RESIGNED'].includes(after.status)) await this.endAssignments(tx, ctx, after.id);
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entityType: 'Staff', entityId: after.id, before, after }, tx);
      return this.view(ctx, after);
    });
  }

  private async endAssignments(tx: Tx, ctx: AccessContext, staffId: bigint) {
    // Leaving staff: end their active class / subject assignments (history kept).
    await tx.teachingAssignment.updateMany({ where: { staffId, status: 'ACTIVE' }, data: { status: 'INACTIVE', validTo: dateOnly(today()), updatedBy: ctx.userId } });
  }

  /** Activate, deactivate, resigned — Headmaster / Super Admin, always with a reason. */
  async changeStatus(ctx: AccessContext, id: bigint, input: z.infer<typeof staffStatusSchema>) {
    const before = await this.prisma.staff.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!before) throw notFound('Staff member');
    if (before.status === input.status) throw invalidState('The staff member already has this status');
    if (input.status === 'ACTIVE') {
      const missing = REQUIRED_TO_ACTIVATE.filter((k) => (before as Record<string, unknown>)[k] == null);
      if (missing.length) throw invalid(`Before activating, assign the ${missing.map((k) => LABEL[k]).join(', ')}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.staff.update({
        where: { id }, data: { status: input.status, ...(input.status === 'RESIGNED' || input.status === 'INACTIVE' ? { leavingDate: dateOnly(input.leavingDate ?? today()) } : {}), updatedBy: ctx.userId },
      });
      if (['INACTIVE', 'RESIGNED'].includes(input.status)) await this.endAssignments(tx, ctx, id);
      await this.audit.record(ctx, { action: 'STATUS', entityType: 'Staff', entityId: id, before: { status: before.status }, after: { status: after.status, leavingDate: after.leavingDate }, reason: input.reason }, tx);
      return this.view(ctx, after);
    });
  }

  // ------------------------------------------------------------------ photo and documents
  private async canEditFiles(ctx: AccessContext, id: bigint) {
    if (!hasPermission(ctx, P.STAFF_REGISTER) && !hasPermission(ctx, P.STAFF_MANAGE)) throw forbidden('You cannot change staff files');
    const s = await this.prisma.staff.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!s) throw notFound('Staff member');
    return s;
  }
  private async storeFile(ctx: AccessContext, file: Express.Multer.File, type: { mime: string; ext: string }, purpose: string, tx: Tx) {
    const key = await this.storage.put(`schools/${ctx.schoolId}/staff`, type.ext, file.buffer);
    return tx.file.create({
      data: {
        schoolId: ctx.schoolId, storageDriver: this.storage.name, storageKey: key, originalName: file.originalname.slice(0, 255), mimeType: type.mime,
        sizeBytes: BigInt(file.size), sha256: createHash('sha256').update(file.buffer).digest('hex'), purpose, createdBy: ctx.userId,
      },
    });
  }
  async uploadPhoto(ctx: AccessContext, id: bigint, file?: Express.Multer.File) {
    const s = await this.canEditFiles(ctx, id);
    if (!file) throw invalid('Choose a photo to upload');
    if (file.size > MAX_PHOTO_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'Photo must be 2 MB or smaller');
    const type = sniffImage(file.buffer);
    if (!type) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PNG, JPEG or WebP photos are allowed');
    return this.prisma.$transaction(async (tx) => {
      const f = await this.storeFile(ctx, file, type, 'STAFF_PHOTO', tx);
      const after = await tx.staff.update({ where: { id }, data: { photoFileId: f.id, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Staff', entityId: id, before: { photoFileId: s.photoFileId }, after: { photoFileId: f.id }, reason: 'Photo uploaded' }, tx);
      return { photoFileId: after.photoFileId };
    });
  }
  async uploadDocument(ctx: AccessContext, id: bigint, title: string, file?: Express.Multer.File) {
    await this.canEditFiles(ctx, id);
    if (!file) throw invalid('Choose a file to upload');
    if (file.size > MAX_DOC_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The file must be 5 MB or smaller');
    const type = sniffDocument(file.buffer);
    if (!type) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PDF, JPEG, PNG or WebP files are allowed');
    return this.prisma.$transaction(async (tx) => {
      const f = await this.storeFile(ctx, file, type, 'STAFF_DOCUMENT', tx);
      const d = await tx.staffDocument.create({ data: { staffId: id, title, fileId: f.id, createdBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Staff', entityId: id, after: { document: title, fileName: f.originalName }, reason: `Document uploaded: ${title}` }, tx);
      return { id: d.id, title, fileName: f.originalName };
    });
  }
  async deleteDocument(ctx: AccessContext, id: bigint, docId: bigint) {
    if (!hasPermission(ctx, P.STAFF_MANAGE)) throw forbidden('Only the Headmaster can remove staff documents');
    const d = await this.prisma.staffDocument.findFirst({ where: { id: docId, staffId: id, staff: { schoolId: ctx.schoolId } } });
    if (!d) throw notFound('Document');
    await this.prisma.$transaction(async (tx) => {
      await tx.staffDocument.delete({ where: { id: docId } }); // the file itself stays (audit trail)
      await this.audit.record(ctx, { action: 'DELETE', entityType: 'Staff', entityId: id, before: { document: d.title, fileId: d.fileId }, reason: `Document removed: ${d.title}` }, tx);
    });
    return { removed: true };
  }
  async stream(ctx: AccessContext, id: bigint, what: 'photo' | bigint, res: Response) {
    this.assertView(ctx);
    const s = await this.prisma.staff.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!s) throw notFound('Staff member');
    let fileId: bigint | null = null;
    if (what === 'photo') fileId = s.photoFileId;
    else fileId = (await this.prisma.staffDocument.findFirst({ where: { id: what, staffId: id } }))?.fileId ?? null;
    const f = fileId ? await this.prisma.file.findFirst({ where: { id: fileId, schoolId: ctx.schoolId } }) : null;
    if (!f) throw notFound(what === 'photo' ? 'Photo' : 'Document');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${f.originalName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    this.storage.read(f.storageKey).pipe(res);
    return new StreamMarker();
  }
}

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(ctx: AccessContext, q: z.infer<typeof assignmentQuery>) {
    return this.prisma.teachingAssignment.findMany({
      where: {
        academicYearId: BigInt(q.academicYearId),
        academicYear: { schoolId: ctx.schoolId },
        ...(q.includeEnded === 'true' ? {} : { status: 'ACTIVE' }),
        ...(q.staffId ? { staffId: BigInt(q.staffId) } : {}),
        ...(q.sectionId ? { sectionId: BigInt(q.sectionId) } : {}),
        ...(q.role ? { role: q.role } : {}),
        ...(q.classId || q.mediumId ? { section: { ...(q.classId ? { classId: BigInt(q.classId) } : {}), ...(q.mediumId ? { schoolClass: { mediumId: BigInt(q.mediumId) } } : {}) } } : {}),
      },
      include: assignmentInclude,
      orderBy: [{ status: 'asc' }, { sectionId: 'asc' }, { role: 'asc' }, { validFrom: 'desc' }],
    });
  }

  /** Who changed what and when, for the Assignment History tab. */
  async history(ctx: AccessContext, academicYearId: number) {
    const ids = await this.prisma.teachingAssignment.findMany({ where: { academicYearId: BigInt(academicYearId), academicYear: { schoolId: ctx.schoolId } }, select: { id: true } });
    const logs = await this.prisma.auditLog.findMany({
      where: { schoolId: ctx.schoolId, entityType: 'TeachingAssignment', entityId: { in: ids.map((i) => i.id) } },
      orderBy: { id: 'desc' },
      take: 200,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.userId).filter((v): v is bigint => v != null))] } }, select: { id: true, username: true } });
    const names = new Map(users.map((u) => [String(u.id), u.username]));
    const rows = await this.prisma.teachingAssignment.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.entityId!))] } }, include: assignmentInclude });
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    return logs.map((l) => ({ id: l.id, at: l.createdAt, action: l.action, reason: l.reason, by: l.userId ? names.get(String(l.userId)) ?? null : null, assignment: byId.get(String(l.entityId)) ?? null }));
  }

  async mine(ctx: AccessContext) {
    if (!ctx.staffId) return [];
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    if (!year) return [];
    return this.prisma.teachingAssignment.findMany({ where: { staffId: ctx.staffId, academicYearId: year.id, status: 'ACTIVE' }, include: assignmentInclude });
  }

  private async validate(ctx: AccessContext, input: AssignmentInput) {
    const [section, staff] = await Promise.all([
      this.prisma.section.findFirst({
        where: { id: BigInt(input.sectionId), schoolClass: { academicYearId: BigInt(input.academicYearId), academicYear: { schoolId: ctx.schoolId } } },
        include: { schoolClass: { include: { academicYear: true } } },
      }),
      this.prisma.staff.findFirst({ where: { id: BigInt(input.staffId), schoolId: ctx.schoolId } }),
    ]);
    if (!section) throw notFound('Division in this academic year');
    if (!staff) throw notFound('Staff member');
    if (staff.status !== 'ACTIVE') throw invalid(staff.status === 'PENDING_ASSIGNMENT' ? `${staff.name} is not activated yet (pending assignment by the Headmaster)` : `${staff.name} is inactive`);
    if (staff.employeeType === 'NON_TEACHING' && (input.role === 'SUBJECT_TEACHER' || input.role === 'CLASS_TEACHER')) {
      throw invalid(`${staff.name} is non-teaching staff and cannot be given classes or subjects`);
    }
    if (section.status !== 'ACTIVE') throw invalid(`Division ${section.name} is inactive`);
    if (section.schoolClass.academicYear.status === 'CLOSED') throw invalidState('The academic year is closed');
    if (input.role !== 'SUBJECT_TEACHER' && input.classSubjectId != null) {
      throw invalid('Only subject teachers are assigned to a subject', [{ path: 'classSubjectId', code: 'not_allowed', message: 'Leave subject empty for this role' }]);
    }
    if (input.role === 'SUBJECT_TEACHER') {
      const cs = await this.prisma.classSubject.findFirst({ where: { id: BigInt(input.classSubjectId!), classId: section.classId, status: 'ACTIVE' } });
      if (!cs) throw invalid('This subject is not taught in this class', [{ path: 'classSubjectId', code: 'not_in_class', message: 'Choose a subject of this class' }]);
    }
    return { section, staff };
  }

  async create(ctx: AccessContext, input: AssignmentInput) {
    const { section, staff } = await this.validate(ctx, input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const a = await tx.teachingAssignment.create({
          data: {
            academicYearId: BigInt(input.academicYearId), staffId: staff.id, role: input.role, sectionId: section.id,
            classSubjectId: input.role === 'SUBJECT_TEACHER' ? big(input.classSubjectId) : null,
            validFrom: dateOnly(input.validFrom ?? today())!, createdBy: ctx.userId,
          },
          include: assignmentInclude,
        });
        await this.audit.record(ctx, { action: 'CREATE', entityType: 'TeachingAssignment', entityId: a.id, after: a }, tx);
        return a;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw conflict('DUPLICATE', input.role === 'CLASS_TEACHER'
          ? `Division ${section.name} already has a class teacher. Use "Replace" to change it.`
          : `${staff.name} already has this assignment`);
      }
      throw e;
    }
  }

  async end(ctx: AccessContext, id: bigint, validTo?: string) {
    const before = await this.prisma.teachingAssignment.findFirst({ where: { id, academicYear: { schoolId: ctx.schoolId } } });
    if (!before) throw notFound('Assignment');
    if (before.status !== 'ACTIVE') throw invalidState('This assignment has already ended');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.teachingAssignment.update({ where: { id }, data: { status: 'INACTIVE', validTo: dateOnly(validTo ?? today()), updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'END', entityType: 'TeachingAssignment', entityId: id, before, after }, tx);
      return after;
    });
  }

  /**
   * Hand an assignment to someone else atomically: the old one is ended (kept as history, with the
   * reason) and a new one starts. Records and approvals made under the old assignment stay attributed to
   * the original person; pending workflow tasks move only through the explicit task reassignment (Phase 5).
   */
  async replace(ctx: AccessContext, id: bigint, staffId: number, reason: string) {
    const current = await this.prisma.teachingAssignment.findFirst({ where: { id, academicYear: { schoolId: ctx.schoolId } } });
    if (!current) throw notFound('Assignment');
    if (current.status !== 'ACTIVE') throw invalidState('Only an active assignment can be replaced');
    if (current.staffId === BigInt(staffId)) throw invalid('Choose a different person');
    const input = {
      academicYearId: Number(current.academicYearId), staffId, role: current.role as AssignmentInput['role'],
      sectionId: Number(current.sectionId), classSubjectId: current.classSubjectId == null ? null : Number(current.classSubjectId),
    };
    const { staff } = await this.validate(ctx, input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ended = await tx.teachingAssignment.update({ where: { id }, data: { status: 'INACTIVE', validTo: dateOnly(today()), updatedBy: ctx.userId } });
        await this.audit.record(ctx, { action: 'END', entityType: 'TeachingAssignment', entityId: id, before: current, after: ended, reason }, tx);
        const a = await tx.teachingAssignment.create({
          data: { academicYearId: current.academicYearId, staffId: staff.id, role: current.role, sectionId: current.sectionId, classSubjectId: current.classSubjectId, validFrom: dateOnly(today())!, createdBy: ctx.userId },
          include: assignmentInclude,
        });
        await this.audit.record(ctx, { action: 'CREATE', entityType: 'TeachingAssignment', entityId: a.id, after: a, reason: `Replaces assignment #${id}: ${reason}` }, tx);
        return a;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('DUPLICATE', `${staff.name} already has this assignment`);
      throw e;
    }
  }

  /** Change class teacher atomically: end the current one, start the new one. */
  async setClassTeacher(ctx: AccessContext, sectionId: bigint, staffId: number) {
    const section = await this.prisma.section.findFirst({ where: { id: sectionId, schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: { schoolClass: true } });
    if (!section) throw notFound('Division');
    const input = { academicYearId: Number(section.schoolClass.academicYearId), staffId, role: 'CLASS_TEACHER' as const, sectionId: Number(sectionId) };
    const { staff } = await this.validate(ctx, input);
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.teachingAssignment.findFirst({ where: { sectionId, role: 'CLASS_TEACHER', status: 'ACTIVE' } });
      if (current?.staffId === staff.id) return tx.teachingAssignment.findUniqueOrThrow({ where: { id: current.id }, include: assignmentInclude });
      if (current) {
        const ended = await tx.teachingAssignment.update({ where: { id: current.id }, data: { status: 'INACTIVE', validTo: dateOnly(today()), updatedBy: ctx.userId } });
        await this.audit.record(ctx, { action: 'END', entityType: 'TeachingAssignment', entityId: current.id, before: current, after: ended, reason: 'Class teacher changed' }, tx);
      }
      const a = await tx.teachingAssignment.create({
        data: { academicYearId: section.schoolClass.academicYearId, staffId: staff.id, role: 'CLASS_TEACHER', sectionId, validFrom: dateOnly(today())!, createdBy: ctx.userId },
        include: assignmentInclude,
      });
      await this.audit.record(ctx, { action: 'CREATE', entityType: 'TeachingAssignment', entityId: a.id, after: a }, tx);
      return a;
    });
  }
}

@Controller()
export class StaffController {
  constructor(private readonly staff: StaffService, private readonly assignments: AssignmentsService) {}

  // Staff routes check permissions per field group inside the service (view: staff.read / staff.register / staff.manage).
  @Get('staff')
  list(@Ctx() ctx: AccessContext, @Query(zBody(staffListQuery)) q: z.infer<typeof staffListQuery>) { return this.staff.list(ctx, q); }

  @Get('staff/:id')
  get(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.staff.get(ctx, id); }

  @Post('staff')
  create(@Ctx() ctx: AccessContext, @Body(zBody(staffSchema)) b: StaffInput) { return this.staff.save(ctx, b); }

  @Patch('staff/:id')
  update(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(staffSchema)) b: StaffInput) { return this.staff.save(ctx, b, id); }

  @Post('staff/:id/status') @HttpCode(200) @RequirePermission(P.STAFF_MANAGE)
  status(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(staffStatusSchema)) b: z.infer<typeof staffStatusSchema>) { return this.staff.changeStatus(ctx, id, b); }

  @Post('staff/:id/photo') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES + 1, files: 1 } }))
  photo(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @UploadedFile() file?: Express.Multer.File) { return this.staff.uploadPhoto(ctx, id, file); }

  @Get('staff/:id/photo')
  photoContent(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Res() res: Response) { return this.staff.stream(ctx, id, 'photo', res); }

  @Post('staff/:id/documents') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOC_BYTES + 1, files: 1 } }))
  document(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(docUpload)) b: z.infer<typeof docUpload>, @UploadedFile() file?: Express.Multer.File) {
    return this.staff.uploadDocument(ctx, id, b.title, file);
  }

  @Get('staff/:id/documents/:docId')
  documentContent(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('docId', IdPipe) docId: bigint, @Res() res: Response) { return this.staff.stream(ctx, id, docId, res); }

  @Delete('staff/:id/documents/:docId')
  deleteDocument(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Param('docId', IdPipe) docId: bigint) { return this.staff.deleteDocument(ctx, id, docId); }

  @Get('assignments') @RequirePermission(P.STAFF_READ)
  assignmentList(@Ctx() ctx: AccessContext, @Query(zBody(assignmentQuery)) q: z.infer<typeof assignmentQuery>) { return this.assignments.list(ctx, q); }

  @Get('me/assignments')
  myAssignments(@Ctx() ctx: AccessContext) { return this.assignments.mine(ctx); }

  @Post('assignments') @RequirePermission(P.ASSIGNMENTS_MANAGE)
  assign(@Ctx() ctx: AccessContext, @Body(zBody(assignmentSchema)) b: AssignmentInput) { return this.assignments.create(ctx, b); }

  @Post('assignments/:id/end') @HttpCode(200) @RequirePermission(P.ASSIGNMENTS_MANAGE)
  end(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(endSchema)) b: z.infer<typeof endSchema>) { return this.assignments.end(ctx, id, b.validTo); }

  @Get('assignments/history') @RequirePermission(P.STAFF_READ)
  history(@Ctx() ctx: AccessContext, @Query(zBody(z.object({ academicYearId: z.coerce.number().int().positive() }))) q: { academicYearId: number }) {
    return this.assignments.history(ctx, q.academicYearId);
  }

  @Post('assignments/:id/replace') @HttpCode(200) @RequirePermission(P.ASSIGNMENTS_MANAGE)
  replace(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(replaceSchema)) b: z.infer<typeof replaceSchema>) {
    return this.assignments.replace(ctx, id, b.staffId, b.reason);
  }

  @Post('sections/:id/class-teacher') @HttpCode(200) @RequirePermission(P.ASSIGNMENTS_MANAGE)
  classTeacher(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(classTeacherSchema)) b: z.infer<typeof classTeacherSchema>) {
    return this.assignments.setClassTeacher(ctx, id, b.staffId);
  }
}

@Module({ imports: [PoliciesSequencesModule], controllers: [StaffController], providers: [StaffService, AssignmentsService] })
export class StaffModule {}
