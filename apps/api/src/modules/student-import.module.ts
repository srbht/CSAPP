/// <reference types="multer" />
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ERROR_CODES, GREENSHEET_RESULT_LABELS, grNoLabel, PERMISSIONS, studentSchema } from '@cps/shared';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { AppError, forbidden, invalid, notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { IdPipe, zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';
import { PoliciesSequencesModule } from './policies-sequences.module';
import { GreensheetModule, GreensheetService } from './greensheet.module';
import { StudentsModule, StudentsService } from './students.module';

const P = PERMISSIONS;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_ROWS = 500;

// ======================================================================= Excel import

/** Header texts the school's sheets use (and common variants), mapped to fields. */
const COLUMNS: [RegExp, string][] = [
  [/^(sr\.?\s*no\.?|s\.?\s*no\.?|sr)$/i, 'srNo'],
  [/exam\s*no/i, 'examNo'],
  [/^g\.?\s*r\.?\s*(no\.?)?$|gr\s*no|general\s*register/i, 'grNo'],
  [/school\s*uid|^uid$|student\s*id/i, 'schoolUid'],
  [/full\s*name|name\s*of\s*(the\s*)?student|student\s*name|^name$/i, 'fullName'],
  [/birth|d\.?\s*o\.?\s*b/i, 'dob'],
  [/gender|^sex$/i, 'gender'],
  [/phone|mobile|contact/i, 'phone'],
  [/roll/i, 'rollNo'],
  [/address/i, 'address'],
];

export interface ImportRow {
  rowNo: number; fullName: string; grNo: string | null; examNo: string | null; schoolUid: string | null; dob: string | null;
  gender: 'MALE' | 'FEMALE' | null; phone: string | null; rollNo: number | null; address: string | null;
  /** "TEMP" in the GR column: the new GR No is awaited. */
  grNoTemp: boolean;
  /** "--" in place of the surname. */
  noSurname: boolean;
}

/** Google-Sheets exports store formulas (IMPORTRANGE): always use the cached result, never evaluate. */
export function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
    return '';
  }
  return String(v).trim();
}
function cellDate(v: ExcelJS.CellValue): string | null {
  const raw = v && typeof v === 'object' && !(v instanceof Date) && 'result' in v ? (v as { result?: ExcelJS.CellValue }).result : v;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') return new Date(Date.UTC(1899, 11, 30) + raw * 86400000).toISOString().slice(0, 10); // Excel serial date
  const s = cellText(raw ?? null);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy (Indian order)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s ? 'INVALID' : null;
}
const gender = (s: string) => (/^(m|male|boy|b)$/i.test(s) ? 'MALE' : /^(f|female|girl|g)$/i.test(s) ? 'FEMALE' : null);

/** SURNAME FIRST FATHER… MOTHER, the order the school records names in ("-- FIRST FATHER… MOTHER" without a surname). */
export function splitName(full: string, noSurname = false) {
  const t = full.split(/\s+/).filter(Boolean);
  if (noSurname) {
    if (t.length < 3) return { surname: null, firstName: t[0] ?? null, fatherName: t[1] ?? null, motherName: null };
    return { surname: null, firstName: t[0], fatherName: t.slice(1, -1).join(' '), motherName: t[t.length - 1] };
  }
  if (t.length < 2) return { surname: null, firstName: t[0] ?? null, fatherName: null, motherName: null };
  if (t.length === 2) return { surname: t[0], firstName: t[1], fatherName: null, motherName: null };
  if (t.length === 3) return { surname: t[0], firstName: t[1], fatherName: t[2], motherName: null };
  return { surname: t[0], firstName: t[1], fatherName: t.slice(2, -1).join(' '), motherName: t[t.length - 1] };
}

const commitSchema = z.object({
  sectionId: z.coerce.number().int().positive(),
  rows: z.array(z.object({
    rowNo: z.coerce.number().int(),
    fullName: z.string().trim().min(1).max(250),
    grNo: z.string().trim().max(30).nullable().optional(),
    examNo: z.string().trim().max(20).nullable().optional(),
    schoolUid: z.string().trim().max(40).nullable().optional(),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    gender: z.enum(['MALE', 'FEMALE']),
    phone: z.string().regex(/^[6-9]\d{9}$/).nullable().optional(),
    rollNo: z.coerce.number().int().min(1).max(999).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    grNoTemp: z.boolean().optional(),
    noSurname: z.boolean().optional(),
  })).min(1).max(MAX_ROWS),
});

@Injectable()
export class StudentImportService {
  constructor(private readonly prisma: PrismaService, private readonly students: StudentsService) {}

  async parse(buffer: Buffer) {
    if (buffer.subarray(0, 4).toString('binary') !== 'PK\u0003\u0004') throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Upload an Excel file (.xlsx). Save Google Sheets as "Microsoft Excel (.xlsx)".');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, 'This Excel file could not be read. Open it in Excel or Google Sheets and save it again as .xlsx.');
    }
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
    if (!ws) throw invalid('The file has no data');

    // Find the header row (the school's sheets have titles in rows 1–6).
    let headerRow = 0;
    const map: Record<string, number> = {};
    for (let r = 1; r <= Math.min(40, ws.rowCount) && !headerRow; r++) {
      const row = ws.getRow(r);
      const found: Record<string, number> = {};
      row.eachCell({ includeEmpty: false }, (c, col) => {
        const t = cellText(c.value);
        const hit = COLUMNS.find(([re]) => re.test(t));
        if (hit && !(hit[1] in found)) found[hit[1]] = col;
      });
      if ('fullName' in found) { headerRow = r; Object.assign(map, found); }
    }
    if (!headerRow) throw invalid('Could not find a "Full Name" (or "Name of Student") column in the first 40 rows');

    // "Medium : HINDI   Standard : X" above the header.
    let medium: string | null = null;
    let standard: string | null = null;
    for (let r = 1; r < headerRow; r++) {
      const cells: string[] = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (c) => { cells.push(cellText(c.value)); });
      cells.forEach((t, i) => {
        if (/medium/i.test(t)) medium = cells[i + 1] ?? t.replace(/.*medium\s*:?\s*/i, '');
        if (/standard|std\.?|class/i.test(t) && !/classwise/i.test(t)) standard = cells[i + 1] ?? null;
      });
    }

    const rows: (ImportRow & { errors: string[]; warnings: string[]; split: ReturnType<typeof splitName> })[] = [];
    let blanks = 0;
    for (let r = headerRow + 1; r <= ws.rowCount && blanks < 5; r++) {
      const row = ws.getRow(r);
      const get = (k: string) => (map[k] ? cellText(row.getCell(map[k]).value) : '');
      const rawName = get('fullName').replace(/\s+/g, ' ').trim().toUpperCase();
      const noSurname = /^-{1,3}\s*/.test(rawName);
      const name = rawName.replace(/^-{1,3}\s*/, '');
      if (!name) { blanks++; continue; }
      blanks = 0;
      if (rows.length >= MAX_ROWS) throw invalid(`The file has more than ${MAX_ROWS} students. Import one class at a time.`);
      const errors: string[] = [];
      const warnings: string[] = [];
      const dobRaw = map.dob ? cellDate(row.getCell(map.dob).value) : null;
      if (dobRaw === 'INVALID') warnings.push(`Birth date "${get('dob')}" not understood; left empty`);
      const g = gender(get('gender'));
      if (!g) errors.push(get('gender') ? `Gender "${get('gender')}" not understood (use M/F, Male/Female)` : 'Gender is missing');
      const phoneDigits = get('phone').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
      const phone = /^[6-9]\d{9}$/.test(phoneDigits) ? phoneDigits : null;
      if (get('phone') && !phone) warnings.push(`Phone "${get('phone')}" is not a valid mobile number; left empty`);
      const roll = Number(get('rollNo'));
      const gr = get('grNo').toUpperCase();
      const grNoTemp = gr === 'TEMP';
      rows.push({
        rowNo: r, fullName: name, grNo: grNoTemp ? null : gr || null, grNoTemp, noSurname, examNo: get('examNo').toUpperCase() || null, schoolUid: get('schoolUid') || null,
        dob: dobRaw && dobRaw !== 'INVALID' ? dobRaw : null, gender: g, phone, rollNo: Number.isInteger(roll) && roll > 0 ? roll : null, address: get('address') || null,
        errors, warnings, split: splitName(name, noSurname),
      });
    }
    return { headerRow, columns: Object.keys(map), detected: { medium, standard }, rows };
  }

  async preview(ctx: AccessContext, file: Express.Multer.File | undefined, sectionId?: number) {
    if (!hasPermission(ctx, P.STUDENTS_WRITE)) throw forbidden('Only office staff can import students');
    if (!file) throw invalid('Choose the Excel file to upload');
    if (file.size > MAX_FILE) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The file must be 5 MB or smaller');
    const parsed = await this.parse(file.buffer);
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    if (!year) throw notFound('Current academic year');

    // Duplicates inside the file and against students already in the system.
    const grs = parsed.rows.map((r) => r.grNo).filter(Boolean) as string[];
    const existingGr = new Set((await this.prisma.student.findMany({ where: { schoolId: ctx.schoolId, grNo: { in: grs } }, select: { grNo: true } })).map((s) => s.grNo));
    const exams = parsed.rows.map((r) => r.examNo).filter(Boolean) as string[];
    const existingExam = new Set((await this.prisma.studentEnrollment.findMany({ where: { academicYearId: year.id, examNo: { in: exams } }, select: { examNo: true } })).map((e) => e.examNo));
    const seenGr = new Map<string, number>();
    const seenExam = new Map<string, number>();
    for (const r of parsed.rows) {
      if (r.grNo) {
        if (existingGr.has(r.grNo)) r.errors.push(`GR No ${r.grNo} is already in the system (student already imported?)`);
        if (seenGr.has(r.grNo)) r.errors.push(`GR No ${r.grNo} appears twice in the file (row ${seenGr.get(r.grNo)})`);
        seenGr.set(r.grNo, r.rowNo);
      }
      if (r.examNo) {
        if (existingExam.has(r.examNo)) r.errors.push(`Exam No ${r.examNo} is already used this year`);
        if (seenExam.has(r.examNo)) r.errors.push(`Exam No ${r.examNo} appears twice in the file`);
        seenExam.set(r.examNo, r.rowNo);
      }
    }
    // Suggest the division from "Medium / Standard" in the sheet.
    const det = parsed.detected as { medium: string | null; standard: string | null };
    const medCode = det.medium ? (/hindi/i.test(det.medium) ? 'HI' : /english/i.test(det.medium) ? 'EN' : null) : null;
    const sections = await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: year.id, status: 'ACTIVE', ...(medCode ? { medium: { code: medCode } } : {}), ...(det.standard ? { standard: { code: det.standard.trim().toUpperCase() } } : {}) } },
      select: { id: true, name: true, schoolClass: { select: { displayName: true } }, _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
    });
    const ok = parsed.rows.filter((r) => !r.errors.length).length;
    return {
      fileName: file.originalname, headerRow: parsed.headerRow, columns: parsed.columns, detected: det,
      suggestedSections: sections.map((s) => ({ id: s.id, label: `${s.schoolClass.displayName} ${s.name}`, students: s._count.enrollments })),
      selectedSectionId: sectionId ?? (sections.length === 1 ? sections[0].id : null),
      summary: { total: parsed.rows.length, ready: ok, withErrors: parsed.rows.length - ok, withWarnings: parsed.rows.filter((r) => r.warnings.length).length },
      rows: parsed.rows,
    };
  }

  /** All-or-nothing: either every row is admitted or none (a half-imported class is worse than none). */
  async commit(ctx: AccessContext, input: z.infer<typeof commitSchema>) {
    const section = await this.students.admissionSection(ctx, input.sectionId);
    const created = await this.prisma.$transaction(async (tx) => {
      let n = 0;
      for (const r of input.rows) {
        const split = splitName(r.fullName, r.noSurname);
        const fatherGuardian = r.phone ? [{ relation: 'FATHER' as const, name: split.fatherName ? `${split.fatherName} ${split.surname ?? ''}`.trim() : 'Parent', mobile: r.phone, isPrimary: true }] : [];
        const grNo = r.grNoTemp ? null : r.grNo ?? null;
        const student = studentSchema.safeParse({
          fullName: r.fullName, gender: r.gender, dob: r.dob ?? null, grNo, schoolUid: r.schoolUid ?? null, addressLine: r.address ?? null,
          ...split, guardians: fatherGuardian,
        });
        if (!student.success) throw invalid(`Row ${r.rowNo}: ${student.error.issues[0].message}`, [{ path: `rows.${r.rowNo}`, code: 'invalid', message: student.error.issues[0].message }]);
        try {
          const admitted = await this.students.admitInTx(tx, ctx, section, { student: student.data, enrollment: { sectionId: input.sectionId, rollNo: r.rollNo ?? null, examNo: r.examNo ?? null, joinedOn: null } }, `Imported from Excel (row ${r.rowNo})`);
          if (r.grNoTemp) await tx.student.update({ where: { id: BigInt(admitted.id) }, data: { grNoTemp: true } });
        } catch (e) {
          if (e instanceof AppError) throw new AppError(e.getStatus(), ERROR_CODES.VALIDATION_FAILED, `Row ${r.rowNo} (${r.fullName}): ${(e.getResponse() as { detail?: string }).detail ?? e.message}. Nothing was imported.`);
          throw e;
        }
        n++;
      }
      return n;
    }, { timeout: 120_000 });
    return { created, section: `${section.schoolClass.displayName} ${section.name}` };
  }
}

// ======================================================================= Promotion to the next year

const DECISIONS = ['PROMOTE', 'DETAIN', 'PASS_OUT', 'SKIP'] as const;
type Decision = (typeof DECISIONS)[number];
const promoteSchema = z.object({
  fromSectionId: z.coerce.number().int().positive(),
  toSectionId: z.coerce.number().int().positive().nullable().optional(),
  detainSectionId: z.coerce.number().int().positive().nullable().optional(),
  items: z.array(z.object({ enrollmentId: z.coerce.number().int().positive(), decision: z.enum(DECISIONS) })).min(1).max(200),
});
type PromoteInput = z.infer<typeof promoteSchema>;
const decideSchema = z.object({ note: z.string().trim().max(300).nullish().transform((v) => v || null) });
/** Promoted into these standards, a student is entered in another General Register: the GR No becomes TEMP. */
const NEW_REGISTER_LEVELS = [1, 5];

@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scopes: ScopeService,
    private readonly students: StudentsService, private readonly greensheet: GreensheetService,
  ) {}

  private async from(ctx: AccessContext, sectionId: bigint) {
    const s = await this.prisma.section.findFirst({ where: { id: sectionId, schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: { schoolClass: { include: { academicYear: true, standard: true, medium: true } } } });
    if (!s) throw notFound('Division');
    return s;
  }

  /** Prepare: Headmaster, office or the division's operator. Verify (apply): Headmaster. */
  private async can(ctx: AccessContext, sectionId: bigint, yearId: bigint) {
    const scope = await this.scopes.resolve(ctx, yearId);
    const verify = scope.all && hasPermission(ctx, P.STUDENTS_PROMOTE);
    const prepare = verify || (scope.all && hasPermission(ctx, P.STUDENTS_WRITE)) || scope.byRole.OPERATOR.some((x) => x === sectionId);
    return { prepare, verify };
  }

  /** Divisions in the NEXT academic year where students of this division can go, with each student's result. */
  async options(ctx: AccessContext, sectionId: bigint) {
    const s = await this.from(ctx, sectionId);
    const can = await this.can(ctx, sectionId, s.schoolClass.academicYearId);
    if (!can.prepare) throw forbidden('The Headmaster, the office or the division\'s operator prepares the promotion');
    const next = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, startDate: { gt: s.schoolClass.academicYear.startDate } }, orderBy: { startDate: 'asc' } });
    const isLast = !(await this.prisma.standard.findFirst({ where: { schoolId: ctx.schoolId, levelOrder: { gt: s.schoolClass.standard.levelOrder }, status: 'ACTIVE' } }));
    const sections = next ? await this.prisma.section.findMany({
      where: { status: 'ACTIVE', schoolClass: { academicYearId: next.id, mediumId: s.schoolClass.mediumId } },
      include: { schoolClass: { include: { standard: true } } },
    }) : [];
    const lvl = s.schoolClass.standard.levelOrder;
    const label = (x: (typeof sections)[number]) => ({ id: x.id, label: `${x.schoolClass.displayName} ${x.name}`, newRegister: NEW_REGISTER_LEVELS.includes(x.schoolClass.standard.levelOrder) });
    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { sectionId, status: { in: ['ACTIVE', 'PROMOTED', 'DETAINED', 'COMPLETED'] } },
      include: { student: { select: { id: true, fullName: true, studentCode: true, grNo: true, grNoTemp: true } }, reportCards: { where: { term: 'FINAL' }, select: { snapshot: true, status: true } } },
      orderBy: [{ rollNo: 'asc' }, { student: { fullName: 'asc' } }],
    });
    // Results and percentages from the Greensheet (the Headmaster's decisions once it is approved).
    let sheet: Awaited<ReturnType<GreensheetService['sheet']>> | null = null;
    try { sheet = await this.greensheet.sheet(ctx, sectionId, true); } catch { sheet = null; }
    const gsRow = new Map((sheet?.students ?? []).map((r) => [String(r.enrollmentId), r]));
    const pending = await this.prisma.promotionRequest.findFirst({ where: { fromSectionId: sectionId, status: 'PENDING' }, orderBy: { id: 'desc' } });
    const last = await this.prisma.promotionRequest.findFirst({ where: { fromSectionId: sectionId, status: { in: ['REJECTED'] } }, orderBy: { id: 'desc' } });
    const names = await this.userNames([pending?.requestedBy, last?.decidedBy]);
    return {
      from: { id: s.id, label: `${s.schoolClass.displayName} ${s.name}`, year: s.schoolClass.academicYear.name, medium: s.schoolClass.medium.nameEn },
      nextYear: next ? { id: next.id, name: next.name } : null,
      isLastStandard: isLast,
      greensheet: sheet ? { status: sheet.status } : null,
      can: { prepare: can.prepare && !pending, verify: can.verify },
      pending: pending ? { id: pending.id, items: pending.items, toSectionId: pending.toSectionId, detainSectionId: pending.detainSectionId, requestedBy: names.get(String(pending.requestedBy)) ?? null, requestedAt: pending.requestedAt } : null,
      lastRejected: last && !pending ? { note: last.note, decidedBy: names.get(String(last.decidedBy)) ?? null, decidedAt: last.decidedAt } : null,
      promoteTo: sections.filter((x) => x.schoolClass.standard.levelOrder > lvl).sort((a, b) => a.schoolClass.standard.levelOrder - b.schoolClass.standard.levelOrder).filter((x, _, arr) => x.schoolClass.standard.levelOrder === arr[0].schoolClass.standard.levelOrder).map(label),
      detainIn: sections.filter((x) => x.schoolClass.standard.levelOrder === lvl).map(label),
      students: enrollments.map((e) => {
        const g = gsRow.get(String(e.id));
        const card = (e.reportCards[0]?.snapshot as { result?: string } | undefined)?.result ?? null;
        const result = g?.result ?? null;
        // Passed / promoted → next class; failed (detained) → same standard; re-exam → wait for the re-exam result.
        const suggested: Decision = result === 'DETAINED' ? 'DETAIN' : result === 'RE_EXAM' ? 'SKIP'
          : result ? (isLast ? 'PASS_OUT' : 'PROMOTE') : card === 'FAIL' ? 'DETAIN' : isLast ? 'PASS_OUT' : 'PROMOTE';
        return {
          enrollmentId: e.id, serialNo: e.rollNo, rollNo: e.rollNo, examNo: e.examNo, status: e.status,
          student: { id: e.student.id, fullName: e.student.fullName, studentCode: e.student.studentCode, grNo: grNoLabel(e.student) },
          result, resultLabel: result ? GREENSHEET_RESULT_LABELS[result] : card, percentage: g?.percentage ?? null, suggested,
        };
      }),
    };
  }

  private async userNames(ids: (bigint | null | undefined)[]) {
    const list = ids.filter((x): x is bigint => x != null);
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, username: true, staff: { select: { name: true } } } }) : [];
    return new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
  }

  /** Check the chosen divisions and students against what this division allows. */
  private async validate(ctx: AccessContext, input: PromoteInput) {
    const from = await this.from(ctx, BigInt(input.fromSectionId));
    const opts = await this.options(ctx, from.id);
    const target = (id: number | null | undefined, list: { id: bigint }[], what: string) => {
      if (!id) return null;
      if (!list.some((x) => Number(x.id) === id)) throw invalid(`The chosen ${what} division is not valid for ${opts.from.label}`);
      return id;
    };
    const toId = target(input.toSectionId, opts.promoteTo, 'next-standard');
    const detainId = target(input.detainSectionId, opts.detainIn, 'same-standard');
    if (input.items.some((i) => i.decision === 'PROMOTE') && !toId) throw invalid('Choose the division to promote into (create next year\'s classes first)');
    if (input.items.some((i) => i.decision === 'DETAIN') && !detainId) throw invalid('Choose the division for students who repeat the standard');
    if (!input.items.some((i) => i.decision !== 'SKIP')) throw invalid('Choose at least one student to promote, keep back or pass out');
    const valid = new Set(opts.students.filter((s) => s.status === 'ACTIVE').map((s) => Number(s.enrollmentId)));
    for (const it of input.items) if (it.decision !== 'SKIP' && !valid.has(it.enrollmentId)) throw invalidState('A selected student was already promoted or is no longer studying in this division');
    return { from, opts, toId, detainId };
  }

  /**
   * Prepared by the office or an operator → waits for the Headmaster. Prepared by the Headmaster → applied at once.
   * Students left as "wait" (e.g. re-exam) stay in the division and can be promoted later on their own.
   */
  async promote(ctx: AccessContext, input: PromoteInput) {
    const { from, opts, toId, detainId } = await this.validate(ctx, input);
    const can = await this.can(ctx, from.id, from.schoolClass.academicYearId);
    if (can.verify) return { status: 'APPROVED', ...(await this.apply(ctx, from, opts.from.label, toId, detainId, input.items)) };
    if (await this.prisma.promotionRequest.findFirst({ where: { fromSectionId: from.id, status: 'PENDING' } })) throw invalidState('A promotion for this division is already waiting for the Headmaster');
    const items = input.items.filter((i) => i.decision !== 'SKIP');
    const r = await this.prisma.$transaction(async (tx) => {
      const req = await tx.promotionRequest.create({ data: { schoolId: ctx.schoolId, fromSectionId: from.id, toSectionId: toId ? BigInt(toId) : null, detainSectionId: detainId ? BigInt(detainId) : null, items, requestedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'PROMOTE_REQUEST', entityType: 'Section', entityId: from.id, after: { requestId: req.id, students: items.length } }, tx);
      return req;
    });
    return { status: 'PENDING', requestId: r.id, students: items.length };
  }

  /** Promotions waiting for the Headmaster. */
  async requests(ctx: AccessContext) {
    const rows = await this.prisma.promotionRequest.findMany({
      where: { schoolId: ctx.schoolId, status: 'PENDING' }, orderBy: { requestedAt: 'asc' },
      include: { fromSection: { select: { id: true, name: true, schoolClass: { select: { displayName: true } } } } },
    });
    const names = await this.userNames(rows.map((r) => r.requestedBy));
    return rows.map((r) => ({
      id: r.id, sectionId: r.fromSection.id, label: `${r.fromSection.schoolClass.displayName} ${r.fromSection.name}`, students: (r.items as unknown[]).length,
      requestedBy: names.get(String(r.requestedBy)) ?? null, requestedAt: r.requestedAt,
    }));
  }

  private async request(ctx: AccessContext, id: bigint) {
    const r = await this.prisma.promotionRequest.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!r) throw notFound('Promotion');
    if (r.status !== 'PENDING') throw invalidState('This promotion was already decided');
    const from = await this.from(ctx, r.fromSectionId);
    const can = await this.can(ctx, from.id, from.schoolClass.academicYearId);
    return { r, from, can };
  }

  /** The Headmaster verifies: the prepared promotion is applied as it was sent. */
  async approveRequest(ctx: AccessContext, id: bigint) {
    const { r, from, can } = await this.request(ctx, id);
    if (!can.verify) throw forbidden('Only the Headmaster verifies promotions');
    const items = r.items as { enrollmentId: number; decision: Decision }[];
    const input = { fromSectionId: Number(from.id), toSectionId: r.toSectionId ? Number(r.toSectionId) : null, detainSectionId: r.detainSectionId ? Number(r.detainSectionId) : null, items };
    const v = await this.validate(ctx, input);
    const counts = await this.apply(ctx, from, v.opts.from.label, v.toId, v.detainId, items, id);
    return { status: 'APPROVED', ...counts };
  }

  /** The Headmaster sends it back (with a note); the office / operator can prepare it again. Withdrawn by the preparer. */
  async rejectRequest(ctx: AccessContext, id: bigint, note: string | null) {
    const { r, can } = await this.request(ctx, id);
    const own = r.requestedBy === ctx.userId;
    if (!can.verify && !own) throw forbidden('Only the Headmaster verifies promotions');
    const status = can.verify ? 'REJECTED' : 'WITHDRAWN';
    await this.prisma.$transaction(async (tx) => {
      await tx.promotionRequest.update({ where: { id }, data: { status, decidedBy: ctx.userId, decidedAt: new Date(), note } });
      await this.audit.record(ctx, { action: status === 'REJECTED' ? 'REJECT' : 'WITHDRAW', entityType: 'PromotionRequest', entityId: id, reason: note ?? undefined }, tx);
    });
    return { status };
  }

  private async apply(ctx: AccessContext, from: Awaited<ReturnType<PromotionService['from']>>, label: string, toId: number | null, detainId: number | null, items: { enrollmentId: number; decision: Decision }[], requestId?: bigint) {
    const counts = { PROMOTE: 0, DETAIN: 0, PASS_OUT: 0, SKIP: 0, tempGr: 0 };
    await this.prisma.$transaction(async (tx) => {
      for (const it of items) {
        if (it.decision === 'SKIP') { counts.SKIP++; continue; }
        const old = await tx.studentEnrollment.findUniqueOrThrow({ where: { id: BigInt(it.enrollmentId) } });
        if (old.status !== 'ACTIVE') throw invalidState('A selected student was already promoted or is no longer studying in this division');
        if (it.decision === 'PASS_OUT') {
          await tx.studentEnrollment.update({ where: { id: old.id }, data: { status: 'COMPLETED', finalResult: 'PASS', updatedBy: ctx.userId } });
          await tx.student.update({ where: { id: old.studentId }, data: { status: 'PASSED_OUT', updatedBy: ctx.userId } });
          await tx.studentStatusHistory.create({ data: { studentId: old.studentId, fromStatus: 'ACTIVE', toStatus: 'PASSED_OUT', effectiveDate: from.schoolClass.academicYear.endDate, reason: `Completed ${label}`, createdBy: ctx.userId } });
        } else {
          const sectionId = it.decision === 'PROMOTE' ? toId! : detainId!;
          const section = await tx.section.findUniqueOrThrow({ where: { id: BigInt(sectionId) }, include: { schoolClass: { include: { academicYear: true, medium: true, standard: true } } } });
          await tx.studentEnrollment.update({ where: { id: old.id }, data: { status: it.decision === 'PROMOTE' ? 'PROMOTED' : 'DETAINED', finalResult: it.decision === 'PROMOTE' ? 'PASS' : 'DETAINED', updatedBy: ctx.userId } });
          if (it.decision === 'PROMOTE' && NEW_REGISTER_LEVELS.includes(section.schoolClass.standard.levelOrder)) {
            // Std I (primary) and Std V (secondary) keep their own General Register: a new GR No is entered later.
            const st = await tx.student.findUniqueOrThrow({ where: { id: old.studentId }, select: { grNo: true } });
            await tx.student.update({ where: { id: old.studentId }, data: { grNo: null, grNoTemp: true, updatedBy: ctx.userId } });
            await tx.studentStatusHistory.create({ data: { studentId: old.studentId, fromStatus: 'ACTIVE', toStatus: 'ACTIVE', effectiveDate: section.schoolClass.academicYear.startDate, reason: `Promoted to ${section.schoolClass.displayName}: new GR No to be entered${st.grNo ? ` (previous GR No ${st.grNo})` : ''}`, createdBy: ctx.userId } });
            counts.tempGr++;
          }
          await this.students.writeEnrollment(tx, ctx, old.studentId, section, { sectionId, rollNo: null, examNo: null, joinedOn: section.schoolClass.academicYear.startDate.toISOString().slice(0, 10) });
        }
        counts[it.decision]++;
      }
      if (requestId) await tx.promotionRequest.update({ where: { id: requestId }, data: { status: 'APPROVED', decidedBy: ctx.userId, decidedAt: new Date(), result: counts } });
      await this.audit.record(ctx, { action: 'PROMOTE', entityType: 'Section', entityId: from.id, after: { ...counts, toSectionId: toId, detainSectionId: detainId, requestId: requestId ?? null } }, tx);
    }, { timeout: 120_000 });
    return counts;
  }

  /** Copy classes, divisions and subject lists into an empty new year. */
  async prepareYear(ctx: AccessContext, targetYearId: bigint) {
    if (!hasPermission(ctx, P.ACADEMICS_MANAGE)) throw forbidden('You cannot set up classes');
    const target = await this.prisma.academicYear.findFirst({ where: { id: targetYearId, schoolId: ctx.schoolId } });
    if (!target) throw notFound('Academic year');
    if (await this.prisma.schoolClass.count({ where: { academicYearId: target.id } })) throw invalidState(`${target.name} already has classes`);
    const source = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, startDate: { lt: target.startDate } }, orderBy: { startDate: 'desc' } });
    if (!source) throw invalidState('There is no earlier year to copy from');
    const classes = await this.prisma.schoolClass.findMany({ where: { academicYearId: source.id, status: 'ACTIVE' }, include: { sections: { where: { status: 'ACTIVE' } }, classSubjects: { where: { status: 'ACTIVE' } }, medium: true } });
    await this.prisma.$transaction(async (tx) => {
      for (const c of classes) {
        const nc = await tx.schoolClass.create({ data: { academicYearId: target.id, mediumId: c.mediumId, standardId: c.standardId, code: c.code, displayName: c.displayName, gradingSystemId: c.gradingSystemId, createdBy: ctx.userId } });
        if (c.sections.length) await tx.section.createMany({ data: c.sections.map((s) => ({ classId: nc.id, name: s.name, capacity: s.capacity, room: s.room, createdBy: ctx.userId })) });
        if (c.classSubjects.length) {
          await tx.classSubject.createMany({
            data: c.classSubjects.map((cs) => ({ classId: nc.id, subjectId: cs.subjectId, isOptional: cs.isOptional, optionalGroup: cs.optionalGroup, includeInTotal: cs.includeInTotal, defaultMaxMarks: cs.defaultMaxMarks, defaultPassMarks: cs.defaultPassMarks, gradingSystemId: cs.gradingSystemId, reportRollup: cs.reportRollup, displayOrder: cs.displayOrder, createdBy: ctx.userId })),
          });
        }
      }
      // Exam Nos start again (EX001 …) when each class list of the new year is confirmed.
      await this.audit.record(ctx, { action: 'COPY_STRUCTURE', entityType: 'AcademicYear', entityId: target.id, after: { from: source.name, classes: classes.length } }, tx);
    }, { timeout: 120_000 });
    return { copiedClasses: classes.length, from: source.name, to: target.name };
  }
}

const previewQuery = z.object({ sectionId: z.coerce.number().int().positive().optional() });

@Controller()
export class StudentImportController {
  constructor(private readonly imports: StudentImportService, private readonly promotion: PromotionService) {}

  @Post('students/import/preview') @HttpCode(200) @RequirePermission(P.STUDENTS_WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE + 1, files: 1 } }))
  preview(@Ctx() ctx: AccessContext, @Query(zBody(previewQuery)) q: z.infer<typeof previewQuery>, @UploadedFile() file?: Express.Multer.File) { return this.imports.preview(ctx, file, q.sectionId); }

  @Post('students/import/commit') @HttpCode(200) @RequirePermission(P.STUDENTS_WRITE)
  commit(@Ctx() ctx: AccessContext, @Body(zBody(commitSchema)) b: z.infer<typeof commitSchema>) { return this.imports.commit(ctx, b); }

  @Get('promotions/requests') @RequirePermission(P.STUDENTS_PROMOTE)
  requests(@Ctx() ctx: AccessContext) { return this.promotion.requests(ctx); }

  @Post('promotions/requests/:id/approve') @HttpCode(200) @RequirePermission(P.STUDENTS_PROMOTE)
  approveRequest(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.promotion.approveRequest(ctx, id); }

  @Post('promotions/requests/:id/reject') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  rejectRequest(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(decideSchema)) b: { note: string | null }) { return this.promotion.rejectRequest(ctx, id, b.note); }

  @Get('promotions/:sectionId') @RequirePermission(P.STUDENTS_READ)
  options(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint) { return this.promotion.options(ctx, id); }

  @Post('promotions') @HttpCode(200) @RequirePermission(P.STUDENTS_READ)
  promote(@Ctx() ctx: AccessContext, @Body(zBody(promoteSchema)) b: z.infer<typeof promoteSchema>) { return this.promotion.promote(ctx, b); }

  @Post('academic-years/:id/copy-structure') @HttpCode(200) @RequirePermission(P.ACADEMICS_MANAGE)
  prepare(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.promotion.prepareYear(ctx, id); }
}

@Module({ imports: [StudentsModule, PoliciesSequencesModule, GreensheetModule], controllers: [StudentImportController], providers: [StudentImportService, PromotionService] })
export class StudentImportModule {}

