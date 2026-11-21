import { z } from 'zod';

/**
 * Fees (one consolidated annual fee per class and academic year, no fee categories).
 *
 * Each student has one LEDGER per academic year:
 *   previous year outstanding  (carried forward from last year's ledger, never added to this year's fee)
 * + current year fee            (the class's annual fee for this year)
 * − concession                  (RTE waiver or a discount given by the Headmaster)
 * + late fee                    (penalties for instalments not paid by their due date)
 * = total payable
 * − total paid                  (valid receipts of this year)
 * = balance                     (becomes next year's "previous year outstanding")
 */
export const PAYMENT_MODES = ['CASH', 'UPI', 'CHEQUE', 'BANK_TRANSFER', 'CARD', 'DD'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = { CASH: 'Cash', UPI: 'UPI / GPay / PhonePe', CHEQUE: 'Cheque', BANK_TRANSFER: 'Bank transfer (NEFT/IMPS)', CARD: 'Card', DD: 'Demand draft' };
/** Modes that need a reference (UTR, cheque no.). */
export const MODES_NEEDING_REFERENCE: PaymentMode[] = ['UPI', 'CHEQUE', 'BANK_TRANSFER', 'DD'];

export const RTE_CONCESSION_REASON = 'RTE admission (fee reimbursed by government)';

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const rupees = (n: number) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export interface LedgerFigures {
  previousOutstanding: number;
  currentYearFee: number;
  concession: number;
  /** Current year fee after concession. */
  currentYearNet: number;
  /** Late fees (penalties) charged this year. */
  penalty: number;
  totalPayable: number;
  paid: number;
  /** How much of what was paid has cleared the previous year's outstanding (it is cleared first). */
  paidTowardsPrevious: number;
  balance: number;
  /** Previous year's outstanding that is still unpaid. */
  previousStillDue: number;
}

/** The ledger arithmetic, shared by the API, the screens and the receipt. */
export function ledgerFigures(l: { previousOutstanding: number; yearFee: number; concession: number; paid: number; penalty?: number }): LedgerFigures {
  const currentYearNet = round2(Math.max(0, l.yearFee - l.concession));
  const penalty = round2(l.penalty ?? 0);
  const totalPayable = round2(l.previousOutstanding + currentYearNet + penalty);
  const paidTowardsPrevious = round2(Math.min(Math.max(0, l.previousOutstanding), l.paid));
  return {
    previousOutstanding: round2(l.previousOutstanding), currentYearFee: round2(l.yearFee), concession: round2(l.concession), currentYearNet, penalty, totalPayable,
    paid: round2(l.paid), paidTowardsPrevious, balance: round2(totalPayable - l.paid), previousStillDue: round2(Math.max(0, l.previousOutstanding - paidTowardsPrevious)),
  };
}

export type LedgerState = 'PAID' | 'PART_PAID' | 'DUE' | 'NO_FEES';
export function ledgerState(f: LedgerFigures): LedgerState {
  if (f.totalPayable <= 0 && f.paid <= 0) return 'NO_FEES';
  if (f.balance <= 0) return 'PAID';
  return f.paid > 0 ? 'PART_PAID' : 'DUE';
}
export const LEDGER_STATE_LABELS: Record<LedgerState, string> = { PAID: 'Fully paid', PART_PAID: 'Part paid', DUE: 'Not paid', NO_FEES: 'No fee set' };

/** Amount in words, Indian system (lakh, crore), as printed on receipts. */
export function amountInWords(n: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? ` ${ones[x % 10]}` : ''}`);
  const three = (x: number) => `${x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' : ''}` : ''}${x % 100 ? two(x % 100) : ''}`;
  const whole = Math.floor(n);
  const paise = Math.round((n - whole) * 100);
  if (whole === 0 && paise === 0) return 'Zero Rupees Only';
  const parts: string[] = [];
  const crore = Math.floor(whole / 1e7);
  const lakh = Math.floor((whole % 1e7) / 1e5);
  const thousand = Math.floor((whole % 1e5) / 1e3);
  const rest = whole % 1000;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return `${parts.join(' ')} Rupees${paise ? ` and ${two(paise)} Paise` : ''} Only`.trim();
}

// ---------- validation ----------
const money = z.coerce.number().positive('Enter an amount more than 0').max(10_000_000);
const moneyOrZero = z.coerce.number().min(0, 'Cannot be negative').max(10_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use date format YYYY-MM-DD');

/** The one annual fee of a class for its academic year. */
export const classFeeSchema = z.object({ amount: moneyOrZero });
export type ClassFeeInput = z.infer<typeof classFeeSchema>;

/** Copy last year's class fees into a new year (classes are matched by medium and standard). */
export const classFeeCopySchema = z.object({
  fromAcademicYearId: z.coerce.number().int().positive(),
  toAcademicYearId: z.coerce.number().int().positive(),
  /** false = only fill classes that have no fee yet. */
  overwrite: z.boolean().default(false),
});
export type ClassFeeCopyInput = z.infer<typeof classFeeCopySchema>;

/** Outstanding from before the school started using the ERP (only on a student's first ledger). */
export const openingBalanceSchema = z.object({ amount: moneyOrZero, reason: z.string().trim().min(3, 'Give a reason, e.g. "Balance from 2025-26 register"').max(200) });

export const paymentSchema = z.object({
  enrollmentId: z.coerce.number().int().positive(),
  paidOn: isoDate,
  amount: money,
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(60).nullable().optional(),
  payerName: z.string().trim().max(150).nullable().optional(),
  remarks: z.string().trim().max(300).nullable().optional(),
  /** The physical receipt book number. Required when the payment date is before today (backdated entry). */
  manualReceiptNo: z.string().trim().max(40).nullable().optional().transform((v) => (v ? v : null)),
}).refine((p) => !MODES_NEEDING_REFERENCE.includes(p.mode) || !!p.reference?.trim(), { path: ['reference'], message: 'Enter the UTR / cheque / transaction number' });
export type PaymentInput = z.infer<typeof paymentSchema>;

/** Headmaster / Super Admin correction of a receipt's details. The amount is changed only by cancel and re-issue. */
export const paymentEditSchema = z.object({
  paidOn: isoDate,
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(60).nullable().optional().transform((v) => (v ? v : null)),
  payerName: z.string().trim().max(150).nullable().optional().transform((v) => (v ? v : null)),
  remarks: z.string().trim().max(300).nullable().optional().transform((v) => (v ? v : null)),
  manualReceiptNo: z.string().trim().max(40).nullable().optional().transform((v) => (v ? v : null)),
  reason: z.string().trim().min(3, 'Give a reason for the correction').max(300),
}).refine((p) => !MODES_NEEDING_REFERENCE.includes(p.mode) || !!p.reference, { path: ['reference'], message: 'Enter the UTR / cheque / transaction number' });
export const paymentReissueSchema = z.object({
  amount: money,
  reason: z.string().trim().min(3, 'Give a reason for the correction').max(300),
});

/** Today's date (YYYY-MM-DD) in the school's own timezone, used to decide whether an entry is backdated. */
export function todayIn(timeZone = 'Asia/Kolkata', at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export const concessionSchema = z.object({
  concession: moneyOrZero,
  reason: z.string().trim().min(3, 'Give a reason for the concession').max(200),
});
export const cancelReceiptSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });

// ---------- fee due dates and late fees ----------
/**
 * Fee due dates: by each date a student must have paid, in total, at least the minimum amounts up to that date
 * (e.g. ₹5,000 by 10 Aug, then ₹4,500 more by 10 Oct = ₹9,500 in all). The annual class fee is set separately and is not
 * changed by these amounts; the last date asks for whatever is left of the year's fee. Parents may pay any amount at any time.
 *  - last year's unpaid balance is due by the first date;
 *  - a discount lowers what is due on the last dates first;
 *  - a student short of the total due by a date is late, and the Headmaster may charge a late fee;
 *  - money counts towards the dates in order; late fees are paid after the fee itself.
 * (In the code a due date is called an "instalment".)
 */
export const INSTALMENT_STATUS_LABELS = { PAID: 'Paid', PART_PAID: 'Part paid', DUE: 'Not due yet', OVERDUE: 'Late' } as const;
export type InstalmentStatus = keyof typeof INSTALMENT_STATUS_LABELS;
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** The due date falls on a working day: a Sunday moves to the Monday after. */
export function workingDueDate(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface InstalmentLine {
  id: number; seq: number; label: string;
  /** The date set by the school, and the working day it falls due (a Sunday moves to Monday). */
  dueDate: string; dueOn: string;
  /** This instalment's part of the year fee, after any discount. */
  amount: number;
  /** Last year's unpaid balance (1st instalment only). */
  previous: number;
  total: number; paid: number; balance: number; status: InstalmentStatus;
  /** Late fee charged for this instalment (active), if any. */
  penalty: number;
}

export function instalmentSchedule(
  plan: { id: number; seq: number; label: string; dueDate: string; amount: number }[],
  l: { previousOutstanding: number; yearFee: number; concession: number; paid: number; penalties?: Record<number, number> },
  today: string,
): { lines: InstalmentLine[]; penaltyTotal: number; penaltyPaid: number; penaltyDue: number } {
  const sorted = [...plan].sort((a, b) => a.seq - b.seq);
  const amounts = sorted.map((p) => round2(Math.max(0, p.amount)));
  // The plan should add up to the year fee; any difference is settled on the last instalments.
  let diff = round2(l.yearFee - amounts.reduce((s, a) => s + a, 0));
  if (diff > 0 && amounts.length) amounts[amounts.length - 1] = round2(amounts[amounts.length - 1] + diff);
  for (let i = amounts.length - 1; i >= 0 && diff < 0; i--) {
    const cut = Math.min(amounts[i], -diff);
    amounts[i] = round2(amounts[i] - cut);
    diff = round2(diff + cut);
  }
  // A discount comes off the last instalment first.
  let disc = round2(Math.min(l.concession, l.yearFee));
  for (let i = amounts.length - 1; i >= 0 && disc > 0; i--) {
    const cut = Math.min(amounts[i], disc);
    amounts[i] = round2(amounts[i] - cut);
    disc = round2(disc - cut);
  }
  let money = round2(l.paid);
  const lines = sorted.map((p, i) => {
    const previous = i === 0 ? round2(Math.max(0, l.previousOutstanding)) : 0;
    const total = round2(amounts[i] + previous);
    const paid = round2(Math.min(total, money));
    money = round2(money - paid);
    const balance = round2(total - paid);
    const dueOn = workingDueDate(p.dueDate);
    const status: InstalmentStatus = balance <= 0 ? 'PAID' : today > dueOn ? 'OVERDUE' : paid > 0 ? 'PART_PAID' : 'DUE';
    return { id: p.id, seq: p.seq, label: p.label, dueDate: p.dueDate, dueOn, amount: amounts[i], previous, total, paid, balance, status, penalty: round2(l.penalties?.[p.id] ?? 0) };
  });
  const penaltyTotal = round2(lines.reduce((s, x) => s + x.penalty, 0));
  const penaltyPaid = round2(Math.min(penaltyTotal, money));
  return { lines, penaltyTotal, penaltyPaid, penaltyDue: round2(penaltyTotal - penaltyPaid) };
}

const instalmentDef = z.object({
  seq: z.coerce.number().int().min(1).max(12),
  label: z.string().trim().min(1, 'Name the due date').max(40),
  dueDate: isoDate,
  /** Minimum to pay by this date, for every class. */
  amount: moneyOrZero,
});
/** The year's due dates, and the classes that have their own minimum (null = the amount for all classes). */
export const instalmentPlanSchema = z.object({
  academicYearId: z.coerce.number().int().positive(),
  instalments: z.array(instalmentDef).max(12),
  classes: z.array(z.object({ classId: z.coerce.number().int().positive(), amounts: z.array(moneyOrZero.nullable()) })).max(200),
}).superRefine((p, ctx) => {
  p.instalments.forEach((x, i) => {
    if (x.seq !== i + 1) ctx.addIssue({ code: 'custom', path: ['instalments', i, 'seq'], message: 'Due dates must be numbered 1, 2, 3 …' });
    if (i > 0 && x.dueDate <= p.instalments[i - 1].dueDate) ctx.addIssue({ code: 'custom', path: ['instalments', i, 'dueDate'], message: 'Each due date must be after the one before' });
  });
  p.classes.forEach((c, i) => {
    if (c.amounts.length !== p.instalments.length) ctx.addIssue({ code: 'custom', path: ['classes', i, 'amounts'], message: 'One amount (or none) per due date' });
  });
});
export type InstalmentPlanInput = z.infer<typeof instalmentPlanSchema>;
export const penaltyApplySchema = z.object({
  amount: money,
  /** Only these students (ledger ids); all the defaulters when left out. */
  ledgerIds: z.array(z.coerce.number().int().positive()).max(5000).optional(),
});
export const penaltyWaiveSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason for removing the late fee').max(300) });

// ---------- admission dropdowns ----------
export const RELIGIONS = ['Hindu', 'Muslim', 'Christian', 'Buddhist', 'Jain', 'Sikh', 'Parsi', 'Other'] as const;
export const MOTHER_TONGUES = ['Hindi', 'Marathi', 'Urdu', 'Gujarati', 'Bhojpuri', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Konkani', 'Punjabi', 'English', 'Other'] as const;
export const NATIONALITIES = ['Indian', 'Nepali', 'Other'] as const;
export const OCCUPATIONS = ['Service (private)', 'Service (government)', 'Business / shop', 'Self-employed', 'Driver', 'Labourer', 'Tailor', 'Electrician / plumber / mechanic', 'Farmer', 'Teacher', 'Homemaker', 'Not working', 'Other'] as const;
export const EDUCATION_LEVELS = ['Not literate', 'Primary (up to 5th)', 'Up to 8th', 'SSC (10th)', 'HSC (12th)', 'Diploma / ITI', 'Graduate', 'Post-graduate', 'Other'] as const;
export const INCOME_RANGES = ['Below ₹1 lakh', '₹1–2.5 lakh', '₹2.5–5 lakh', '₹5–8 lakh', 'Above ₹8 lakh'] as const;
export const TRANSPORT_MODES = ['Walks to school', 'Parent drops', 'School van / bus', 'Private van', 'Public transport'] as const;
/** RPwD Act 2016 categories most often recorded by schools (UDISE+). */
export const CWSN_TYPES = ['Low vision', 'Blindness', 'Hearing impairment', 'Speech and language', 'Locomotor', 'Intellectual disability', 'Specific learning disability', 'Autism spectrum', 'Cerebral palsy', 'Multiple disabilities', 'Other'] as const;
export const ADMISSION_DOCUMENTS = [
  'Birth certificate', 'Aadhaar card (copy)', 'Leaving certificate (LC/TC)', 'Previous mark sheet', 'Passport photos', 'Caste certificate',
  'Address proof', 'Parent Aadhaar (copy)', 'RTE allotment letter', 'Disability certificate', 'Bank passbook (student)', 'Affidavit', 'Other document',
] as const;
/** Scans / photos of documents: images or PDF, up to 5 MB each. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Date in words as written in the General Register and on the Leaving Certificate: "Fifth June Two Thousand Eighteen". */
export function dateInWords(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const ordinals = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth',
    'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth', 'Twenty First', 'Twenty Second', 'Twenty Third', 'Twenty Fourth', 'Twenty Fifth', 'Twenty Sixth',
    'Twenty Seventh', 'Twenty Eighth', 'Twenty Ninth', 'Thirtieth', 'Thirty First'];
  const months = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (!ordinals[d] || !months[m]) return '';
  return `${ordinals[d]} ${months[m]} ${amountInWords(y).replace(/ Rupees Only$/, '')}`;
}
