import { Body, Controller, Get, Injectable, Module, Param, Post, Put, Query, Res } from '@nestjs/common';
import { MARK_PARTS, PERMISSIONS, countedMax, defaultPattern, partStage, patternSchema, progressBucket, type MarkPartKey } from '@cps/shared';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { invalidState } from '../common/crud';
import { forbidden, invalid, notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { StreamMarker } from '../common/serialize';
import { IdPipe, zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';
import { ExamsModule, ExamsService, patternOf } from './exams.module';
import { PoliciesSequencesModule, SequencesService } from './policies-sequences.module';

const P = PERMISSIONS;
const query = z.object({
  sectionId: z.coerce.number().int().positive(),
  classSubjectId: z.coerce.number().int().positive().optional(),
  names: z.enum(['true', 'false']).optional(),
});

const generateSchema = z.object({
  examId: z.coerce.number().int().positive(),
  sectionId: z.coerce.number().int().positive(),
  classSubjectId: z.coerce.number().int().positive().nullable().optional(),
  names: z.boolean().default(false),
  /** Maximum marks confirmed (or changed) by the Headmaster; saved as the class's Mark pattern for this semester. */
  maxima: z.array(z.object({ classSubjectId: z.coerce.number().int().positive(), parts: patternSchema })).max(40).optional(),
});
const maximaSchema = z.object({ parts: patternSchema, names: z.boolean().optional() });
const listQuery = z.object({ examId: z.coerce.number().int().positive().optional(), sectionId: z.coerce.number().int().positive().optional() });
type SheetsData = Awaited<ReturnType<BlankSheetsService['sheets']>>;

/** One column of a blank mark sheet: a mark part (entered out of `max`), or a total. */
export interface SheetColumn { key: string; label: string; max: number; kind: 'PART' | 'TOTAL_A' | 'TOTAL_B' | 'TOTAL'; countAs?: number | null; stage?: 'FE' | 'SE' }

const STEP_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started', OPERATOR: 'Operator entering marks', CORRECTION: 'Back with operator for correction',
  SUBJECT_VERIFY: 'With subject teacher', CLASS_APPROVE: 'With class teacher', HEADMASTER_APPROVE: 'With Headmaster', APPROVED: 'Approved and locked',
};

/**
 * Blank mark sheets: ONE per division, subject and semester. The Headmaster generates it (with the maximum marks of each
 * part, saved as the Mark pattern) and corrects it in place; the division's operator sees it at once, prints it and
 * enters the marks on it, which then go Subject Teacher → Class Teacher → Headmaster.
 */
@Injectable()
export class BlankSheetsService {
  constructor(
    private readonly prisma: PrismaService, private readonly exams: ExamsService,
    private readonly sequences: SequencesService, private readonly audit: AuditService, private readonly scopes: ScopeService,
  ) {}

  /** Headmaster (whole school) or the operator of the division. */
  private async access(ctx: AccessContext, yearId: bigint, sectionId?: bigint) {
    const scope = await this.scopes.resolve(ctx, yearId);
    const manage = scope.all && hasPermission(ctx, P.EXAMS_MANAGE);
    const operatorOf = hasPermission(ctx, P.MARKS_ENTER) ? scope.byRole.OPERATOR : [];
    return { manage, operatorOf, canSee: manage || (sectionId != null && operatorOf.some((x) => x === sectionId)) };
  }

  /** Generate the sheet(s): one per subject; subjects that already have their sheet are skipped (edit those instead). */
  async generate(ctx: AccessContext, input: z.infer<typeof generateSchema>) {
    const section = await this.prisma.section.findFirst({ where: { id: BigInt(input.sectionId), schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, select: { classId: true, schoolClass: { select: { academicYearId: true } } } });
    if (!section) throw notFound('Division');
    if (!(await this.access(ctx, section.schoolClass.academicYearId)).manage) throw forbidden('Only the Headmaster generates blank mark sheets');
    const d = await this.sheets(ctx, BigInt(input.examId), { sectionId: input.sectionId, classSubjectId: input.classSubjectId ?? undefined, names: input.names ? 'true' : 'false' });
    if (!d.sheets.length) throw invalid('No subjects for this class yet');
    const existing = new Set((await this.prisma.blankMarkSheet.findMany({ where: { examId: BigInt(input.examId), sectionId: BigInt(input.sectionId) }, select: { classSubjectId: true } })).map((x) => String(x.classSubjectId)));
    const fresh = d.sheets.filter((x) => !existing.has(String(x.classSubjectId)));
    const skipped = d.sheets.filter((x) => existing.has(String(x.classSubjectId))).map((x) => x.subject);
    if (!fresh.length) throw invalidState(`The blank mark sheet is already generated for ${skipped.join(', ')}. Open it to correct the maximum marks.`);
    const maxima = (input.maxima ?? []).filter((m) => fresh.some((f) => String(f.classSubjectId) === String(m.classSubjectId)));
    if (maxima.length) await this.exams.savePattern(ctx, { classId: Number(section.classId), examIds: [input.examId], items: maxima });
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.numberSequence.upsert({ where: { schoolId_seqKey: { schoolId: ctx.schoolId, seqKey: 'blank_mark_sheet' } }, update: {}, create: { schoolId: ctx.schoolId, seqKey: 'blank_mark_sheet', label: 'Blank mark sheet number', pattern: 'BMS-{00000}', nextValue: BigInt(1) } });
      const out: { id: bigint; sheetNo: string; subject: string }[] = [];
      for (const f of fresh) {
        const sheetNo = await this.sequences.next(tx, ctx.schoolId, 'blank_mark_sheet');
        const row = await tx.blankMarkSheet.create({
          data: { schoolId: ctx.schoolId, sheetNo, examId: BigInt(input.examId), sectionId: BigInt(input.sectionId), classSubjectId: BigInt(f.classSubjectId), withNames: input.names, subjects: f.subject, generatedBy: ctx.userId },
        });
        await this.audit.record(ctx, { action: 'GENERATE', entityType: 'BlankMarkSheet', entityId: row.id, after: { sheetNo, exam: d.exam.name, division: d.division.label, subject: f.subject } }, tx);
        out.push({ id: row.id, sheetNo, subject: f.subject });
      }
      return out;
    });
    return { created, skipped };
  }

  /** The Headmaster corrects the maximum marks of a generated sheet (while the marks are still with the operator). */
  async updateMaxima(ctx: AccessContext, id: bigint, input: z.infer<typeof maximaSchema>) {
    const r = await this.sheetRow(ctx, id);
    if (!(await this.access(ctx, r.section.schoolClass.academicYearId)).manage) throw forbidden('Only the Headmaster changes the maximum marks');
    const sub = await this.submissionOf(r);
    if (sub && (sub.stage !== 'OPERATOR' || sub.status === 'APPROVED')) throw invalidState('The marks of this sheet are already sent for approval or locked. Reopen them before changing the maximum marks.');
    await this.exams.savePattern(ctx, { classId: Number(r.section.classId), examIds: [Number(r.examId)], items: [{ classSubjectId: Number(r.classSubjectId), parts: input.parts }] });
    await this.prisma.$transaction(async (tx) => {
      await tx.blankMarkSheet.update({ where: { id }, data: { updatedAt: new Date(), updatedBy: ctx.userId, ...(input.names != null ? { withNames: input.names } : {}) } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'BlankMarkSheet', entityId: id, after: { parts: input.parts }, reason: 'Maximum marks corrected' }, tx);
    });
    return this.one(ctx, id);
  }

  private async sheetRow(ctx: AccessContext, id: bigint) {
    const r = await this.prisma.blankMarkSheet.findFirst({ where: { id, schoolId: ctx.schoolId }, include: { section: { select: { id: true, classId: true, name: true, schoolClass: { select: { displayName: true, academicYearId: true } } } }, exam: { select: { nameEn: true, academicYear: { select: { name: true } } } } } });
    if (!r || r.classSubjectId == null) throw notFound('Mark sheet');
    return r;
  }

  private submissionOf(r: { examId: bigint; sectionId: bigint; classSubjectId: bigint | null }) {
    return this.prisma.academicSubmission.findFirst({ where: { recordType: 'MARKS', examId: r.examId, sectionId: r.sectionId, classSubjectId: r.classSubjectId }, select: { id: true, stage: true, status: true } });
  }

  /** Generated sheets: all of them for the Headmaster, the operator's own divisions for an operator. With the marks' progress. */
  async list(ctx: AccessContext, q: z.infer<typeof listQuery>) {
    const year = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, isCurrent: true } });
    const a = year ? await this.access(ctx, year.id) : { manage: false, operatorOf: [] as bigint[] };
    if (!a.manage && !a.operatorOf.length) return [];
    const rows = await this.prisma.blankMarkSheet.findMany({
      where: {
        schoolId: ctx.schoolId, classSubjectId: { not: null }, ...(q.examId ? { examId: BigInt(q.examId) } : {}),
        ...(q.sectionId ? { sectionId: BigInt(q.sectionId) } : {}), ...(a.manage ? {} : { sectionId: { in: a.operatorOf } }),
      },
      orderBy: { id: 'desc' }, take: 500,
      include: { exam: { select: { nameEn: true, academicYear: { select: { name: true } } } }, section: { select: { name: true, schoolClass: { select: { displayName: true, medium: { select: { sortOrder: true } }, standard: { select: { levelOrder: true } } } } } } },
    });
    const subs = rows.length ? await this.prisma.academicSubmission.findMany({ where: { recordType: 'MARKS', OR: rows.map((r) => ({ examId: r.examId, sectionId: r.sectionId, classSubjectId: r.classSubjectId })) }, select: { examId: true, sectionId: true, classSubjectId: true, stage: true, status: true } }) : [];
    const subBy = new Map(subs.map((x) => [`${x.examId}:${x.sectionId}:${x.classSubjectId}`, x]));
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.generatedBy))] } }, select: { id: true, username: true, staff: { select: { name: true } } } });
    const names = new Map(users.map((u) => [String(u.id), u.staff?.name ?? u.username]));
    return rows.map((r) => {
      const sub = subBy.get(`${r.examId}:${r.sectionId}:${r.classSubjectId}`) ?? null;
      const bucket = progressBucket(sub);
      return {
        id: r.id, sheetNo: r.sheetNo, generatedAt: r.generatedAt, generatedBy: names.get(String(r.generatedBy)) ?? null, updatedAt: r.updatedAt,
        examId: r.examId, exam: r.exam.nameEn, year: r.exam.academicYear.name, sectionId: r.sectionId, classSubjectId: r.classSubjectId,
        division: `${r.section.schoolClass.displayName} ${r.section.name}`, subject: r.subjects,
        bucket, step: sub?.status === 'RETURNED' ? `Sent back · ${STEP_LABEL[bucket]}` : STEP_LABEL[bucket],
      };
    });
  }

  /** One sheet as it is now (current maximum marks and students), with what this user may do. */
  async one(ctx: AccessContext, id: bigint) {
    const r = await this.sheetRow(ctx, id);
    const a = await this.access(ctx, r.section.schoolClass.academicYearId, r.sectionId);
    if (!a.canSee) throw notFound('Mark sheet');
    const d = await this.sheets(ctx, r.examId, { sectionId: Number(r.sectionId), classSubjectId: Number(r.classSubjectId), names: r.withNames ? 'true' : 'false' });
    const sub = await this.submissionOf(r);
    const by = await this.prisma.user.findUnique({ where: { id: r.generatedBy }, select: { username: true, staff: { select: { name: true } } } });
    const bucket = progressBucket(sub);
    return {
      ...d, id: r.id, sheetNo: r.sheetNo, generatedAt: r.generatedAt, updatedAt: r.updatedAt, generatedBy: by?.staff?.name ?? by?.username ?? null,
      unit: { recordType: 'MARKS', examId: Number(r.examId), sectionId: Number(r.sectionId), classSubjectId: Number(r.classSubjectId) },
      marks: { bucket, step: STEP_LABEL[bucket], returned: sub?.status === 'RETURNED' },
      can: {
        editMaxima: a.manage && (!sub || (sub.stage === 'OPERATOR' && sub.status !== 'APPROVED')),
        enterMarks: a.operatorOf.some((x) => x === r.sectionId),
      },
    };
  }

  async excelOne(ctx: AccessContext, id: bigint, res: Response) {
    const d = await this.one(ctx, id);
    return this.writeExcel(d, res, d.sheetNo);
  }

  async sheets(ctx: AccessContext, examId: bigint, q: z.infer<typeof query>) {
    const exam = await this.prisma.exam.findFirst({ where: { id: examId, academicYear: { schoolId: ctx.schoolId } }, include: { academicYear: true } });
    if (!exam) throw notFound('Exam');
    const section = await this.prisma.section.findFirst({
      where: { id: BigInt(q.sectionId), schoolClass: { academicYear: { schoolId: ctx.schoolId } } },
      include: { schoolClass: { include: { medium: true, standard: true } } },
    });
    if (!section) throw notFound('Division');
    if (section.schoolClass.academicYearId !== exam.academicYearId) throw invalid(`${exam.nameEn} belongs to ${exam.academicYear.name}; choose a division of that year`);
    if (!(await this.access(ctx, exam.academicYearId, section.id)).canSee) throw notFound('Division');
    const generated = new Map((await this.prisma.blankMarkSheet.findMany({ where: { examId, sectionId: section.id }, select: { id: true, sheetNo: true, classSubjectId: true } })).map((g) => [String(g.classSubjectId), { id: g.id, sheetNo: g.sheetNo }]));
    // Every subject of the class: its Mark pattern for this semester, or the school's default if none is set yet.
    const classSubjects = await this.prisma.classSubject.findMany({
      where: { classId: section.classId, status: 'ACTIVE', ...(q.classSubjectId ? { id: BigInt(q.classSubjectId) } : {}) },
      include: { subject: { select: { nameEn: true, code: true, subjectType: true } } },
      orderBy: { displayOrder: 'asc' },
    });
    const esBy = new Map((await this.prisma.examSubject.findMany({ where: { examId, classSubjectId: { in: classSubjects.map((c) => c.id) } } })).map((e) => [String(e.classSubjectId), e]));
    const students = await this.prisma.studentEnrollment.findMany({
      where: { sectionId: section.id, status: 'ACTIVE' },
      select: { rollNo: true, examNo: true, student: { select: { fullName: true } } },
      orderBy: [{ rollNo: { sort: 'asc', nulls: 'last' } }, { student: { fullName: 'asc' } }],
    });
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { name: true, addressLine: true, city: true, logoFileId: true } });
    const std = section.schoolClass.standard;
    return {
      school: { name: school.name, address: [school.addressLine, school.city].filter(Boolean).join(', '), logoFileId: school.logoFileId == null ? null : Number(school.logoFileId) },
      year: exam.academicYear.name,
      exam: { id: exam.id, name: exam.nameEn },
      division: {
        id: section.id, label: `${section.schoolClass.displayName} ${section.name}`, medium: section.schoolClass.medium.nameEn,
        std: std.levelOrder >= 1 ? `Std ${std.nameEn}` : std.nameEn, name: section.name,
      },
      withNames: q.names === 'true',
      students: students.map((s, i) => ({ serialNo: i + 1, rollNo: s.rollNo, examNo: s.examNo, fullName: s.student.fullName })),
      sheets: classSubjects.map((cs) => {
        const e = esBy.get(String(cs.id));
        return { classSubjectId: cs.id, subject: cs.subject.nameEn, generated: generated.get(String(cs.id)) ?? null, columns: this.columns(e ? patternOf(e) : defaultPattern(std.code, cs.subject.code, cs.subject.subjectType)) };
      }),
    };
  }

  private columns(parts: ReturnType<typeof patternOf>): SheetColumn[] {
    const fe = parts.filter((p) => partStage(p.key) === 'FE');
    const se = parts.filter((p) => partStage(p.key) === 'SE');
    const col = (p: (typeof parts)[number]): SheetColumn => ({ key: p.key, label: MARK_PARTS[p.key as MarkPartKey]?.label ?? p.key, max: p.max, countAs: p.countAs ?? null, kind: 'PART', stage: partStage(p.key) as 'FE' | 'SE' });
    const sum = (l: typeof parts) => l.reduce((t, p) => t + countedMax(p), 0);
    const out: SheetColumn[] = [...fe.map(col)];
    if (fe.length) out.push({ key: 'TOTAL_A', label: se.length ? 'Total (A)' : 'Total', max: sum(fe), kind: se.length ? 'TOTAL_A' : 'TOTAL' });
    out.push(...se.map(col));
    if (se.length) out.push({ key: 'TOTAL_B', label: fe.length ? 'Total (B)' : 'Total', max: sum(se), kind: fe.length ? 'TOTAL_B' : 'TOTAL' });
    if (fe.length && se.length) out.push({ key: 'TOTAL', label: 'Total', max: sum(fe) + sum(se), kind: 'TOTAL' });
    return out;
  }

  /** The same sheets as an Excel workbook (one worksheet per subject); totals fill in by formula as marks are typed. */
  async excel(ctx: AccessContext, examId: bigint, q: z.infer<typeof query>, res: Response) {
    const d = await this.sheets(ctx, examId, q);
    if (!d.sheets.length) throw invalid('No subjects with a mark pattern for this class and semester');
    return this.writeExcel(d, res);
  }

  private async writeExcel(d: SheetsData & { sheetNo?: string }, res: Response, sheetNo?: string) {
    const wb = new ExcelJS.Workbook();
    wb.creator = d.school.name;
    const thin = { style: 'thin' as const, color: { argb: 'FF808080' } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };
    const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
    const used = new Set<string>();
    for (const s of d.sheets) {
      let name = s.subject.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Subject';
      while (used.has(name)) name = `${name.slice(0, 26)}_${used.size}`;
      used.add(name);
      const ws = wb.addWorksheet(name, { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
      const lead = d.withNames ? ['Sr. No', 'Exam No', 'Student name'] : ['Sr. No', 'Exam No'];
      const width = lead.length + s.columns.length;
      const title = (row: number, text: string, size: number, bold = true) => {
        ws.mergeCells(row, 1, row, width);
        const c = ws.getCell(row, 1);
        c.value = text;
        c.font = { bold, size };
        c.alignment = { horizontal: 'center' };
      };
      title(1, d.school.name, 14);
      title(2, `Marks for the Academic year ${d.year} · ${d.exam.name}`, 11);
      title(3, `${d.division.medium} · ${d.division.std} · Division ${d.division.name}${sheetNo ? ` · Sheet ${sheetNo}` : ''}`, 10, false);
      // Subject row (yellow)
      ws.mergeCells(4, 1, 4, width);
      const sub = ws.getCell(4, 1);
      sub.value = `Subject: ${s.subject.toUpperCase()}`;
      sub.font = { bold: true, size: 12 };
      sub.alignment = { horizontal: 'center' };
      sub.fill = fill('FFFFF2A8');
      // Column headings and the maximum-marks row (blue)
      const head = ws.getRow(5);
      const max = ws.getRow(6);
      lead.forEach((h, i) => { head.getCell(i + 1).value = h; max.getCell(i + 1).value = i === 0 ? 'Max.' : ''; });
      s.columns.forEach((c, i) => {
        head.getCell(lead.length + i + 1).value = c.countAs ? `${c.label} (${c.max}→${c.countAs})` : c.label;
        max.getCell(lead.length + i + 1).value = c.max;
      });
      for (let i = 1; i <= width; i++) {
        const h = head.getCell(i);
        h.font = { bold: true, size: 9 };
        h.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        h.border = border;
        h.fill = fill(i > lead.length && s.columns[i - lead.length - 1].kind !== 'PART' ? 'FFE5E7EB' : 'FFFFFFFF');
        const m = max.getCell(i);
        m.font = { bold: true, size: 9 };
        m.alignment = { horizontal: 'center' };
        m.border = border;
        m.fill = fill('FFBFDBFE');
      }
      head.height = 30;
      const colLetter = (n: number) => ws.getColumn(n).letter;
      d.students.forEach((st, r) => {
        const row = ws.getRow(7 + r);
        row.getCell(1).value = st.rollNo ?? st.serialNo;
        row.getCell(2).value = st.examNo ?? '';
        if (d.withNames) row.getCell(3).value = st.fullName;
        const at = (key: string) => lead.length + s.columns.findIndex((c) => c.key === key) + 1;
        const partRef = (c: SheetColumn) => {
          const ref = `${colLetter(lead.length + s.columns.indexOf(c) + 1)}${7 + r}`;
          return c.countAs ? `ROUND(N(${ref})*${c.countAs}/${c.max},0)` : `N(${ref})`;
        };
        const fe = s.columns.filter((c) => c.kind === 'PART' && c.stage === 'FE');
        const se = s.columns.filter((c) => c.kind === 'PART' && c.stage === 'SE');
        const filled = (cs: SheetColumn[]) => `COUNT(${cs.map((c) => `${colLetter(lead.length + s.columns.indexOf(c) + 1)}${7 + r}`).join(',')})`;
        const formula = (cs: SheetColumn[]) => `IF(${filled(cs)}=0,"",${cs.map(partRef).join('+')})`;
        for (const c of s.columns) {
          if (c.kind === 'PART') continue;
          const cs = c.kind === 'TOTAL_A' ? fe : c.kind === 'TOTAL_B' ? se : [...fe, ...se];
          if (cs.length) row.getCell(at(c.key)).value = { formula: formula(cs) };
        }
        for (let i = 1; i <= width; i++) {
          const cell = row.getCell(i);
          cell.border = border;
          cell.alignment = { horizontal: i === 3 && d.withNames ? 'left' : 'center' };
          if (i > lead.length && s.columns[i - lead.length - 1].kind !== 'PART') cell.fill = fill('FFF3F4F6');
        }
      });
      ws.getColumn(1).width = 6;
      ws.getColumn(2).width = 11;
      if (d.withNames) ws.getColumn(3).width = 32;
      for (let i = lead.length + 1; i <= width; i++) ws.getColumn(i).width = 9;
      ws.views = [{ state: 'frozen', ySplit: 6, xSplit: lead.length }];
      ws.pageSetup.printTitlesRow = '5:6';
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const file = `${sheetNo ? `${sheetNo}-` : ''}blank-marks-${d.division.label.replace(/\s+/g, '-')}-${d.exam.name.replace(/\s+/g, '-')}`.toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
    return new StreamMarker();
  }
}

@Controller()
export class BlankSheetsController {
  constructor(private readonly svc: BlankSheetsService) {}

  @Post('blank-sheets') @RequirePermission(P.EXAMS_MANAGE)
  generate(@Ctx() ctx: AccessContext, @Body(zBody(generateSchema)) b: z.infer<typeof generateSchema>) { return this.svc.generate(ctx, b); }

  // Read: the Headmaster, or the operator of the division (checked in the service).
  @Get('blank-sheets') @RequirePermission(P.MARKS_READ)
  list(@Ctx() ctx: AccessContext, @Query(zBody(listQuery)) q: z.infer<typeof listQuery>) { return this.svc.list(ctx, q); }

  @Get('blank-sheets/:id.xlsx') @RequirePermission(P.MARKS_READ)
  excelOne(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Res() res: Response) { return this.svc.excelOne(ctx, id, res); }

  @Get('blank-sheets/:id') @RequirePermission(P.MARKS_READ)
  one(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.svc.one(ctx, id); }

  @Put('blank-sheets/:id/maxima') @RequirePermission(P.EXAMS_MANAGE)
  maxima(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Body(zBody(maximaSchema)) b: z.infer<typeof maximaSchema>) { return this.svc.updateMaxima(ctx, id, b); }

  @Get('exams/:id/blank-sheets') @RequirePermission(P.EXAMS_MANAGE)
  sheets(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Query(zBody(query)) q: z.infer<typeof query>) { return this.svc.sheets(ctx, id, q); }

  @Get('exams/:id/blank-sheets.xlsx') @RequirePermission(P.EXAMS_MANAGE)
  excel(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Query(zBody(query)) q: z.infer<typeof query>, @Res() res: Response) { return this.svc.excel(ctx, id, q, res); }
}

@Module({ imports: [ExamsModule, PoliciesSequencesModule], controllers: [BlankSheetsController], providers: [BlankSheetsService] })
export class BlankSheetsModule {}
