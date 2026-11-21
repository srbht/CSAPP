import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/** What every report produces. The same structure is shown on screen, exported to Excel / PDF and printed. */
export type ColType = 'text' | 'money' | 'number' | 'date' | 'percent';
export interface Column { key: string; label: string; type?: ColType }
export type Row = Record<string, string | number | null>;
export interface SummaryItem { label: string; value: number | string; type?: ColType }
export interface ReportTable { title: string; columns: Column[]; rows: Row[]; totals?: Row; /** Rows (by first-column text) printed in bold, e.g. Total, Grand Total. */ emphasis?: string[] }
export interface ReportResult {
  title: string;
  school: string;
  generatedAt: string;
  filters: { label: string; value: string }[];
  summary: SummaryItem[];
  /** The main table: searchable, sortable and paged on screen; complete in exports. */
  columns: Column[];
  rows: Row[];
  totals?: Row;
  /** Extra small tables (School at a glance). */
  tables?: ReportTable[];
  /** On screen only: show the extra tables above the main table. Print, PDF and Excel always put them at the bottom. */
  tablesFirst?: boolean;
  notes?: string[];
}

const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10).split('-').reverse().join('/') : v);

/** Text for a cell in PDF (the standard PDF fonts have no ₹ sign, so money is written "Rs"). */
function cellText(v: string | number | null | undefined, type: ColType = 'text', pdf = false): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return pdf ? inr(Number(v)) : `₹${inr(Number(v))}`;
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  if (type === 'percent') return `${Number(v).toFixed(1)}%`;
  if (type === 'date') return dmy(String(v));
  return String(v);
}

// ------------------------------------------------------------------ Excel
export async function toExcel(r: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = r.school;
  wb.created = new Date();
  const ws = wb.addWorksheet(r.title.slice(0, 31), { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const width = Math.max(r.columns.length, ...(r.tables ?? []).map((t) => t.columns.length), 2);
  const line = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) => {
    const row = ws.addRow([text]);
    ws.mergeCells(row.number, 1, row.number, width);
    row.getCell(1).font = { bold: opts.bold, size: opts.size ?? 10, color: opts.color ? { argb: opts.color } : undefined };
  };
  line(r.school, { bold: true, size: 14 });
  line(r.title, { bold: true, size: 12 });
  line(`Generated on ${r.generatedAt}`, { color: 'FF555555' });
  for (const f of r.filters) line(`${f.label}: ${f.value}`, { color: 'FF333333' });
  ws.addRow([]);
  if (r.summary.length) {
    for (const s of r.summary) {
      const row = ws.addRow([s.label, s.type === 'money' ? Number(s.value) : s.value]);
      row.getCell(1).font = { bold: true };
      if (s.type === 'money') row.getCell(2).numFmt = '₹#,##,##0.00';
    }
    ws.addRow([]);
  }
  const table = (columns: Column[], rows: Row[], totals?: Row, title?: string, emphasis: string[] = []) => {
    if (title) line(title, { bold: true, size: 11 });
    const head = ws.addRow(columns.map((c) => c.label));
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      c.alignment = { vertical: 'middle', wrapText: true };
      c.border = { bottom: { style: 'thin' } };
    });
    const put = (r0: Row, bold = false) => {
      const row = ws.addRow(columns.map((c) => {
        const v = r0[c.key];
        if (v === null || v === undefined || v === '') return null;
        if (c.type === 'money' || c.type === 'number' || c.type === 'percent') return Number(v);
        if (c.type === 'date') return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
        return String(v);
      }));
      columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if (c.type === 'money') cell.numFmt = '#,##,##0.00';
        if (c.type === 'date') cell.numFmt = 'dd/mm/yyyy';
        if (c.type === 'percent') cell.numFmt = '0.0"%"';
        if (bold) cell.font = { bold: true };
      });
    };
    for (const r0 of rows) put(r0, emphasis.includes(String(r0[columns[0].key] ?? '')));
    if (totals) put(totals, true);
    ws.addRow([]);
  };
  table(r.columns, r.rows, r.totals);
  for (const t of r.tables ?? []) table(t.columns, t.rows, t.totals, t.title, t.emphasis);
  for (const n of r.notes ?? []) line(n, { color: 'FF555555' });
  // Column widths from the content.
  for (let i = 1; i <= width; i++) {
    let w = 10;
    ws.getColumn(i).eachCell({ includeEmpty: false }, (c) => {
      if (c.isMerged) return;
      const t = c.value instanceof Date ? 10 : String(c.value ?? '').length;
      w = Math.max(w, Math.min(45, t + 2));
    });
    ws.getColumn(i).width = w;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ------------------------------------------------------------------ PDF
export function toPdf(r: ReportResult): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: r.title, Author: r.school } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 16;

    doc.font('Helvetica-Bold').fontSize(14).text(r.school, { align: 'center' });
    doc.fontSize(12).text(r.title, { align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Generated on ${r.generatedAt}`, { align: 'center' });
    doc.moveDown(0.4).fillColor('#000');
    if (r.filters.length) doc.fontSize(8).text(`Filters: ${r.filters.map((f) => `${f.label}: ${f.value}`).join('  |  ')}`, { width: usable });
    doc.moveDown(0.4);
    if (r.summary.length) {
      doc.font('Helvetica-Bold').fontSize(9).text('Summary', { continued: false });
      doc.font('Helvetica').fontSize(8.5).text(r.summary.map((s) => `${s.label}: ${s.type === 'money' ? `Rs ${cellText(s.value, 'money', true)}` : cellText(s.value, s.type ?? 'number', true)}`).join('    '), { width: usable });
      doc.moveDown(0.6);
    }

    const table = (columns: Column[], rows: Row[], totals?: Row, title?: string, emphasis: string[] = []) => {
      if (title) {
        // Keep a small table on one page instead of splitting it after a row or two.
        const est = 30 + (rows.length + 2) * 16;
        if (doc.y > bottom() - 40 || (rows.length <= 12 && doc.y + est > bottom())) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10).text(title, left, doc.y);
        doc.moveDown(0.3);
      }
      // Width by content (header + a sample of rows), scaled to the page.
      const sample = rows.slice(0, 200);
      const want = columns.map((c) => Math.max(c.label.length * 0.9, ...sample.map((x) => cellText(x[c.key], c.type, true).length), 4));
      const total = want.reduce((t, w) => t + w, 0);
      const widths = want.map((w) => (w / total) * usable);
      const fs = columns.length > 10 ? 6.8 : 7.8;
      const headLabels = columns.map((c) => (c.type === 'money' ? `${c.label} (Rs)` : c.label));
      const drawRow = (vals: string[], opts: { head?: boolean; bold?: boolean; shade?: boolean }) => {
        const font = () => doc.font(opts.head || opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
        font();
        const h = Math.max(...vals.map((v, i) => doc.heightOfString(v, { width: widths[i] - 6 }))) + 6;
        if (doc.y + h > bottom()) {
          doc.addPage();
          if (!opts.head) drawRow(headLabels, { head: true }); // repeat the column headings on every page
          font();
        }
        const y = doc.y;
        if (opts.head) doc.rect(left, y, usable, h).fill('#1e3a8a');
        else if (opts.shade) doc.rect(left, y, usable, h).fill('#f3f4f6');
        else if (opts.bold) doc.rect(left, y, usable, h).fill('#e5e7eb');
        doc.fillColor(opts.head ? '#fff' : '#000');
        let x = left;
        vals.forEach((v, i) => {
          const c = columns[i];
          const right = c.type === 'money' || c.type === 'number' || c.type === 'percent'; // headings line up with their numbers
          doc.text(v, x + 3, y + 3, { width: widths[i] - 6, align: right ? 'right' : 'left' });
          x += widths[i];
        });
        doc.fillColor('#000');
        doc.y = y + h;
        doc.x = left;
      };
      drawRow(headLabels, { head: true });
      rows.forEach((row, i) => drawRow(columns.map((c) => cellText(row[c.key], c.type, true)), { shade: i % 2 === 1, bold: emphasis.includes(String(row[columns[0].key] ?? '')) }));
      if (totals) drawRow(columns.map((c) => cellText(totals[c.key], c.type, true)), { bold: true });
      if (!rows.length) doc.font('Helvetica').fontSize(8).text('No records match these filters.', left, doc.y + 4);
      doc.moveDown(0.8);
    };
    table(r.columns, r.rows, r.totals);
    for (const t of r.tables ?? []) table(t.columns, t.rows, t.totals, t.title, t.emphasis);
    for (const n of r.notes ?? []) doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(n, left, doc.y, { width: usable });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would make PDFKit start a new page, so lift the margin while writing the footer.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor('#777').text(`${r.title} · Page ${i + 1} of ${range.count}`, left, doc.page.height - keep + 8, { width: usable, align: 'right', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}
