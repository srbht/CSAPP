/// <reference types="multer" />
import { Controller, HttpCode, Injectable, Module, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ERROR_CODES, MARK_PARTS, type MarkPartKey, PERMISSIONS, unitKeySchema, type UnitKey } from '@cps/shared';
import ExcelJS from 'exceljs';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { AppError, forbidden, invalid } from '../common/errors';
import { zBody } from '../common/validation';
import { cellText } from './student-import.module';
import { WorkflowModule, WorkflowService } from './workflow.module';

const MAX_FILE = 5 * 1024 * 1024;

/** Lower-case letters and digits only, without "(15→10)" or "/15": "Home Work (25→10)" → "homework". */
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\/\s*\d+.*$/, '').replace(/[^a-z0-9]/g, '');
const ABSENT = /^(ab|a|absent)$/i;
const YES = /^(y|yes|1|true|ab|a|absent|x|✓|✔)$/i;

/** A simple CSV reader: commas or semicolons, "quoted, cells", a leading BOM. */
function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

export interface FilledRow { enrollmentId: number; rollNo: number | null; examNo: string | null; fullName: string; fileRow: number; parts: Record<string, string>; absent: boolean }

@Injectable()
export class MarksImportService {
  constructor(private readonly wf: WorkflowService) {}

  /** Reads the grid of an Excel or CSV file: the worksheet for this subject when the workbook has one per subject. */
  private async grid(file: Express.Multer.File, subject: string): Promise<{ cells: string[][]; sheetName: string | null }> {
    const isZip = file.buffer.subarray(0, 4).toString('binary') === 'PK\u0003\u0004';
    if (!isZip) {
      if (/\.(xls|pdf|jpe?g|png)$/i.test(file.originalname)) {
        throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Upload an Excel file (.xlsx) or a CSV file. Old .xls files: open in Excel and save as .xlsx.');
      }
      return { cells: parseCsv(file.buffer.toString('utf8')), sheetName: null };
    }
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, 'This Excel file could not be read. Open it in Excel or Google Sheets and save it again as .xlsx.');
    }
    const withData = wb.worksheets.filter((w) => w.actualRowCount > 0);
    if (!withData.length) throw invalid('The file has no data');
    const s = norm(subject);
    const top = (w: ExcelJS.Worksheet) => {
      const t: string[] = [];
      for (let r = 1; r <= Math.min(6, w.rowCount); r++) w.getRow(r).eachCell((c) => { t.push(cellText(c.value)); });
      return norm(t.join(' '));
    };
    const ws = withData.find((w) => norm(w.name) === s) ?? withData.find((w) => top(w).includes(s)) ?? withData[0];
    const cells: string[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const out: string[] = [];
      for (let c = 1; c <= Math.max(row.cellCount, 1); c++) out.push(cellText(row.getCell(c).value).trim());
      cells.push(out);
    }
    return { cells, sheetName: ws.name };
  }

  /**
   * Reads marks from an Excel / CSV file for a mark sheet with the operator. Nothing is saved: the marks are returned
   * matched to the students (by Exam No, else Roll No, else name) so they fill the sheet on screen for checking.
   */
  async preview(ctx: AccessContext, unit: UnitKey, file: Express.Multer.File | undefined) {
    if (unit.recordType !== 'MARKS') throw invalid('Only marks can be filled from a file');
    if (!file) throw invalid('Choose the Excel or CSV file');
    if (file.size > MAX_FILE) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The file must be 5 MB or smaller');
    const sheet = await this.wf.view(ctx, unit);
    if (!sheet.can.edit) throw forbidden('Marks can be filled only by the operator while the sheet is with the operator');
    const pattern = sheet.unit.pattern ?? [];
    const subject = sheet.unit.classSubject?.subject.nameEn ?? '';
    const { cells, sheetName } = await this.grid(file, subject);

    // The header row: the first row naming at least one mark column and a way to know the student.
    const isExam = (t: string) => /^examno|^examnumber|^seatno/.test(norm(t));
    const isRoll = (t: string) => /^roll|^srno|^sno|^serialno|^sr$/.test(norm(t));
    const isName = (t: string) => /name/.test(norm(t));
    const partNames = (key: string) => {
      const meta = MARK_PARTS[key as MarkPartKey];
      return [key, meta?.label ?? key, meta?.long ?? key].map(norm);
    };
    let headerAt = -1;
    for (let r = 0; r < Math.min(cells.length, 40) && headerAt < 0; r++) {
      const row = cells[r];
      const hasId = row.some((t) => isExam(t) || isRoll(t) || isName(t));
      const hasPart = row.some((t) => pattern.some((p) => partNames(p.key).includes(norm(t))));
      if (hasId && hasPart) headerAt = r;
    }
    if (headerAt < 0) {
      throw invalid(`Could not find the column headings. The file needs a column "Exam No" (or "Roll No" / "Name") and the mark columns: ${pattern.map((p) => MARK_PARTS[p.key as MarkPartKey]?.label ?? p.key).join(', ')}.`);
    }
    const head = cells[headerAt];
    const used = new Set<number>();
    const find = (test: (t: string) => boolean) => { const i = head.findIndex((t, j) => !used.has(j) && test(t)); if (i >= 0) used.add(i); return i; };
    const examCol = find(isExam);
    const rollCol = find(isRoll);
    const nameCol = find(isName);
    const absentCol = find((t) => /^absent$|^ab$/.test(norm(t)));
    // Mark columns in pattern order, so "Oral" (Formative) and "Oral" (Summative) map left to right.
    const partCols = pattern.map((p) => ({ key: p.key, label: MARK_PARTS[p.key as MarkPartKey]?.label ?? p.key, max: p.max, col: find((t) => partNames(p.key).includes(norm(t))) }));
    if (!partCols.some((p) => p.col >= 0)) throw invalid('None of the mark columns of this subject were found in the file');

    const byExam = new Map(sheet.rows.filter((r) => r.examNo).map((r) => [norm(r.examNo!), r]));
    const byRoll = new Map(sheet.rows.filter((r) => r.rollNo != null).map((r) => [String(r.rollNo), r]));
    const byName = new Map(sheet.rows.map((r) => [norm(r.student.fullName), r]));
    const rows: FilledRow[] = [];
    const issues: string[] = [];
    const seen = new Map<string, number>();
    for (let r = headerAt + 1; r < cells.length; r++) {
      const row = cells[r];
      const at = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
      if (/^max/i.test(at(0)) || /^max/i.test(at(rollCol))) continue; // the blue "Max." row of the blank sheet
      const values = partCols.filter((p) => p.col >= 0 && at(p.col) !== '');
      // Absent for the whole subject: the Absent column, or AB in every mark column. AB in some columns: those parts only.
      const absent = (absentCol >= 0 && YES.test(at(absentCol))) || (values.length > 0 && values.length === partCols.filter((p) => p.col >= 0).length && values.every((p) => ABSENT.test(at(p.col))));
      if (!values.length && !absent) continue;
      const fileRow = r + 1;
      const exam = at(examCol);
      const roll = at(rollCol).replace(/\.0+$/, '');
      const name = at(nameCol);
      const st = (exam && byExam.get(norm(exam))) || (roll && byRoll.get(roll)) || (name && byName.get(norm(name))) || null;
      const who = [exam && `Exam No ${exam}`, roll && `Roll ${roll}`, name].filter(Boolean).join(', ') || 'no Exam No, Roll No or name';
      if (!st) { issues.push(`Row ${fileRow} (${who}): no such student in this division`); continue; }
      const key = String(st.enrollmentId);
      if (seen.has(key)) { issues.push(`Row ${fileRow}: ${st.student.fullName} is also on row ${seen.get(key)}; the later row is used`); const i = rows.findIndex((x) => String(x.enrollmentId) === key); if (i >= 0) rows.splice(i, 1); }
      seen.set(key, fileRow);
      const parts: Record<string, string> = {};
      if (!absent) {
        for (const p of values) {
          const raw = at(p.col).replace(',', '.');
          if (ABSENT.test(raw)) { parts[p.key] = 'AB'; continue; }
          if (/^c$/i.test(raw.trim())) { parts[p.key] = 'C'; continue; } // copying: counts as 0
          const n = Number(raw);
          if (Number.isNaN(n)) { issues.push(`Row ${fileRow} (${st.student.fullName}): ${p.label} "${raw}" is not a number; left empty`); continue; }
          if (n < 0 || n > p.max) issues.push(`Row ${fileRow} (${st.student.fullName}): ${p.label} ${raw} is more than the maximum ${p.max}`);
          parts[p.key] = raw;
        }
      }
      rows.push({ enrollmentId: Number(st.enrollmentId), rollNo: st.rollNo, examNo: st.examNo, fullName: st.student.fullName, fileRow, parts, absent });
    }
    const filled = new Set(rows.map((r) => r.enrollmentId));
    const missing = sheet.rows.filter((r) => r.enrollmentStatus === 'ACTIVE' && !filled.has(Number(r.enrollmentId)));
    return {
      fileName: file.originalname, sheetName,
      matchedBy: examCol >= 0 ? 'Exam No' : rollCol >= 0 ? 'Roll No' : 'name',
      columns: partCols.map((p) => ({ key: p.key, label: p.label, found: p.col >= 0 })),
      rows, issues,
      missing: missing.map((r) => ({ rollNo: r.rollNo, examNo: r.examNo, fullName: r.student.fullName })),
    };
  }
}

@Controller()
export class MarksImportController {
  constructor(private readonly svc: MarksImportService) {}

  /** Unit in the query (as GET /sheets), the file as multipart "file". */
  @Post('sheets/import') @HttpCode(200) @RequirePermission(PERMISSIONS.MARKS_ENTER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE + 1, files: 1 } }))
  preview(@Ctx() ctx: AccessContext, @Query(zBody(unitKeySchema)) q: UnitKey, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.svc.preview(ctx, q, file);
  }
}

@Module({ imports: [WorkflowModule], controllers: [MarksImportController], providers: [MarksImportService] })
export class MarksImportModule {}
