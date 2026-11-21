import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Put, Query } from '@nestjs/common';
import {
  ERROR_CODES, gradeFor, GREENSHEET_RESULT_LABELS, type GreensheetResult, monthLabel, monthsBetween, PERMISSIONS, progressBucket, PROGRESS_LABELS, remarksSchema, REPORT_TERMS,
  type ReportTerm, grNoLabel } from '@cps/shared';
import { z } from 'zod';
import { AuditService } from '../common/audit';
import { invalidState } from '../common/crud';
import { AccessContext, Ctx, hasPermission, RequirePermission } from '../common/auth';
import { AppError, forbidden, notFound, outOfScope } from '../common/errors';
import { ResolvedScope, ScopeService } from '../common/scope';
import { IdPipe, zBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { PoliciesSequencesModule, PoliciesService } from './policies-sequences.module';
import { unitKeyOf } from './workflow.module';

const P = PERMISSIONS;
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;

const sectionInclude = {
  schoolClass: { include: { medium: true, standard: true, academicYear: { include: { terms: { orderBy: { sequence: 'asc' as const } } } }, gradingSystem: { include: { bands: true } } } },
} as const;

/**
 * Report cards (docs/07 "report-card gate"). An official card is generated ONLY when, for the student's division,
 * every subject's marks of the semester exam(s) AND every month's attendance are approved by Subject Teacher →
 * Class Teacher → Headmaster. The card is a frozen snapshot, so later corrections never change an issued card.
 * Anyone allowed to see the marks can open a DRAFT preview, clearly marked as not approved.
 */
@Injectable()
export class ReportCardsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly scopes: ScopeService, private readonly policies: PoliciesService) {}

  private async section(ctx: AccessContext, sectionId: bigint) {
    const s = await this.prisma.section.findFirst({ where: { id: sectionId, schoolClass: { academicYear: { schoolId: ctx.schoolId } } }, include: sectionInclude });
    if (!s) throw notFound('Division');
    return s;
  }
  private access(ctx: AccessContext, scope: ResolvedScope, sectionId: bigint) {
    const has = (r: keyof ResolvedScope['byRole']) => scope.byRole[r].some((x) => x === sectionId);
    const view = scope.all || has('OPERATOR') || has('CLASS_TEACHER') || scope.subjectPairs.some((p) => p.sectionId === sectionId);
    return {
      view: view && (hasPermission(ctx, P.MARKS_READ) || hasPermission(ctx, P.REPORTCARDS_GENERATE)),
      // The class teacher and the Headmaster make the report cards and write the remarks; the Headmaster publishes.
      generate: hasPermission(ctx, P.REPORTCARDS_GENERATE) && (scope.all || has('CLASS_TEACHER')),
      publish: hasPermission(ctx, P.REPORTCARDS_PUBLISH) && scope.all,
      remarks: hasPermission(ctx, P.REMARKS_ENTER) && (scope.all || has('CLASS_TEACHER')),
    };
  }

  /** Exams and months a report card needs. */
  private async sources(section: Awaited<ReturnType<ReportCardsService['section']>>, term: ReportTerm) {
    const year = section.schoolClass.academicYear;
    const terms = term === 'TERM1' ? ['TERM1'] : ['TERM1', 'TERM2'];
    const exams = await this.prisma.exam.findMany({ where: { academicYearId: year.id, reportTerm: { in: terms }, status: 'ACTIVE' }, orderBy: { sequence: 'asc' } });
    const t1 = year.terms.find((t) => t.sequence === 1);
    const t2 = year.terms.find((t) => t.sequence === 2);
    const end = term === 'TERM1' ? (t1?.endDate ?? year.endDate) : (t2?.endDate ?? year.endDate);
    const months = monthsBetween(year.startDate.toISOString(), end.toISOString()).filter((m) => !m.endsWith('-05')); // May is vacation
    const termOfMonth = (m: string) => (t1 && m <= t1.endDate.toISOString().slice(0, 7) ? 1 : 2);
    return { year, exams, months, termOfMonth };
  }

  /** What is still missing before official cards can be generated for this division. */
  async gate(ctx: AccessContext, sectionId: bigint, term: ReportTerm) {
    const section = await this.section(ctx, sectionId);
    const { exams, months } = await this.sources(section, term);
    const missing: { kind: 'EXAM' | 'MARKS' | 'ATTENDANCE'; label: string; status: string; unit?: object }[] = [];
    if (!exams.length) missing.push({ kind: 'EXAM', label: term === 'TERM1' ? 'No Semester I exam is set up' : 'Semester I and II exams are not both set up', status: 'Ask the exam coordinator' });
    if (term === 'FINAL' && exams.filter((e) => e.reportTerm === 'TERM2').length === 0 && exams.length) missing.push({ kind: 'EXAM', label: 'No Semester II exam is set up', status: 'Ask the exam coordinator' });
    const es = await this.prisma.examSubject.findMany({
      where: { examId: { in: exams.map((e) => e.id) }, classSubject: { classId: section.classId, status: 'ACTIVE' } },
      include: { classSubject: { include: { subject: { select: { nameEn: true } } } } },
    });
    const keys = [
      ...es.map((e) => unitKeyOf({ recordType: 'MARKS', examId: Number(e.examId), sectionId: Number(sectionId), classSubjectId: Number(e.classSubjectId) })),
      ...months.map((m) => unitKeyOf({ recordType: 'ATTENDANCE', sectionId: Number(sectionId), period: m })),
    ];
    const subs = new Map((await this.prisma.academicSubmission.findMany({ where: { unitKey: { in: keys } } })).map((s) => [s.unitKey, s]));
    for (const e of es) {
      const unit = { recordType: 'MARKS' as const, examId: Number(e.examId), sectionId: Number(sectionId), classSubjectId: Number(e.classSubjectId) };
      const b = progressBucket(subs.get(unitKeyOf(unit)));
      if (b !== 'APPROVED') missing.push({ kind: 'MARKS', label: `${exams.find((x) => x.id === e.examId)?.nameEn} · ${e.classSubject.subject.nameEn}`, status: PROGRESS_LABELS[b], unit });
    }
    for (const m of months) {
      const unit = { recordType: 'ATTENDANCE' as const, sectionId: Number(sectionId), period: m };
      const b = progressBucket(subs.get(unitKeyOf(unit)));
      if (b !== 'APPROVED') missing.push({ kind: 'ATTENDANCE', label: `Attendance · ${monthLabel(m)}`, status: PROGRESS_LABELS[b], unit });
    }
    const required = es.length + months.length;
    return { ready: missing.length === 0, required, approved: required - missing.filter((x) => x.kind !== 'EXAM').length, missing };
  }

  // ------------------------------------------------------------------ calculation

  private async compute(ctx: AccessContext, enrollmentId: bigint, term: ReportTerm) {
    const enr = await this.prisma.studentEnrollment.findFirst({
      where: { id: enrollmentId, student: { schoolId: ctx.schoolId } },
      include: { student: true, section: { include: sectionInclude } },
    });
    if (!enr) throw notFound('Student');
    const section = enr.section;
    const { year, exams, months, termOfMonth } = await this.sources(section, term);
    const cls = section.schoolClass;
    const pol = Object.fromEntries((await this.policies.effective(ctx, { academicYearId: Number(year.id), mediumId: Number(cls.mediumId), standardId: Number(cls.standardId), classId: Number(cls.id) })).map((p) => [p.key, p.value]));
    const passSubject = Number(pol['result.pass_percent_subject'] ?? 35);
    const passOverall = Number(pol['result.pass_percent_overall'] ?? 35);
    const lowAttendance = Number(pol['attendance.low_threshold_percent'] ?? 75);
    const rounding = String(pol['result.aggregate_rounding'] ?? 'HALF_UP_INT');
    const roundAgg = (n: number) => (rounding === 'HALF_UP_INT' ? Math.floor(n + 0.5) : rounding === 'TWO_DECIMALS' ? round2(n) : n);
    const fallbackBands = await this.prisma.gradeBand.findMany({ where: { gradingSystem: { schoolId: ctx.schoolId, status: 'ACTIVE' } }, orderBy: { sortOrder: 'asc' } });
    const bands = (cls.gradingSystem?.bands ?? fallbackBands).map((b) => ({ grade: b.grade, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent), isPass: b.isPass }));
    const grade = (pct: number | null) => (pct == null ? null : gradeFor(pct, bands)?.grade ?? null);

    const classSubjects = await this.prisma.classSubject.findMany({ where: { classId: cls.id, status: 'ACTIVE' }, include: { subject: true }, orderBy: { displayOrder: 'asc' } });
    const es = await this.prisma.examSubject.findMany({ where: { examId: { in: exams.map((e) => e.id) }, classSubjectId: { in: classSubjects.map((c) => c.id) } } });
    const marks = await this.prisma.mark.findMany({ where: { enrollmentId, examId: { in: exams.map((e) => e.id) } } });
    const esKey = new Map(es.map((e) => [`${e.examId}:${e.classSubjectId}`, e]));
    const mKey = new Map(marks.map((m) => [`${m.examId}:${m.classSubjectId}`, m]));

    let incomplete = false;
    const subjects = classSubjects.filter((cs) => exams.some((e) => esKey.has(`${e.id}:${cs.id}`))).map((cs) => {
      const cols = exams.map((e) => {
        const x = esKey.get(`${e.id}:${cs.id}`);
        if (!x) return null;
        const m = mKey.get(`${e.id}:${cs.id}`);
        const max = Number(x.max1) + (num(x.max2) ?? 0);
        const absent = !!m?.absent;
        if (!m || absent) incomplete = incomplete || !m || pol['marks.absent_policy'] === 'SHOW_AB_INCOMPLETE';
        const total = m && !absent ? (num(m.marks1) ?? 0) + (num(m.marks2) ?? 0) : absent && pol['marks.absent_policy'] === 'ZERO' ? 0 : null;
        const pct = total == null ? null : (total / max) * 100;
        return { examId: Number(e.id), m1: m && !absent ? num(m.marks1) : null, m2: m && !absent ? num(m.marks2) : null, absent, total, max, hasM2: x.max2 != null, grade: grade(pct), pct };
      });
      const valid = cols.filter((c) => c && c.pct != null) as { pct: number }[];
      // Average column (final card): the mean percentage, shown out of 100 like the school's card.
      const avg = valid.length === cols.filter(Boolean).length && valid.length ? roundAgg(valid.reduce((t, c) => t + c.pct, 0) / valid.length) : null;
      const finalPct = term === 'FINAL' ? avg : (cols[0]?.pct ?? null);
      return { classSubjectId: Number(cs.id), name: cs.subject.nameEn, nameHi: cs.subject.nameHi, includeInTotal: cs.includeInTotal, cols, average: term === 'FINAL' ? { total: avg, max: 100, grade: grade(avg) } : null, passed: finalPct != null && finalPct >= passSubject };
    });

    const inTotal = subjects.filter((s) => s.includeInTotal);
    const examTotals = exams.map((e, i) => {
      const cs = inTotal.map((s) => s.cols[i]).filter(Boolean) as { total: number | null; max: number; m1: number | null; m2: number | null }[];
      const total = cs.reduce((t, c) => t + (c.total ?? 0), 0);
      const max = cs.reduce((t, c) => t + c.max, 0);
      return { examId: Number(e.id), m1: cs.reduce((t, c) => t + (c.m1 ?? 0), 0), m2: cs.reduce((t, c) => t + (c.m2 ?? 0), 0), total, max, grade: grade(max ? (total / max) * 100 : null) };
    });
    const avgTotal = term === 'FINAL' ? inTotal.reduce((t, s) => t + (s.average?.total ?? 0), 0) : null;
    const grandTotal = term === 'FINAL' ? avgTotal! : examTotals[0]?.total ?? 0;
    const grandMax = term === 'FINAL' ? inTotal.length * 100 : examTotals[0]?.max ?? 0;
    const percentage = grandMax ? round2((grandTotal / grandMax) * 100) : 0;

    // Attendance month by month (report-card attendance mode: MONTHLY).
    const att = await this.prisma.attendanceMonthly.findMany({ where: { enrollmentId, period: { in: months } }, include: { submission: { select: { workingDays: true } } } });
    const attBy = new Map(att.map((a) => [a.period, a]));
    const attendance = months.map((m) => {
      const a = attBy.get(m);
      return { period: m, label: monthLabel(m), term: termOfMonth(m), working: num(a?.submission.workingDays) ?? null, present: num(a?.presentDays) ?? null };
    });
    const sum = (list: typeof attendance) => ({ working: list.reduce((t, a) => t + (a.working ?? 0), 0), present: list.reduce((t, a) => t + (a.present ?? 0), 0) });
    const attTotal = sum(attendance);
    const attPct = attTotal.working ? round2((attTotal.present / attTotal.working) * 100) : null;

    const remark = await this.prisma.studentRemark.findUnique({ where: { enrollmentId_term: { enrollmentId, term } } });
    // Final card: the Headmaster's decision on the approved Greensheet is the result (PASS / PROMOTED / Re-Exam / Detained).
    const gsDecision = term === 'FINAL'
      ? await this.prisma.greensheetResult.findFirst({ where: { enrollmentId, enrollment: { section: { greensheet: { status: 'APPROVED' } } } } })
      : null;
    const passed = !incomplete && subjects.filter((s) => s.includeInTotal).every((s) => s.passed) && percentage >= passOverall;
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId } });
    // School re-opening date: the start of the next academic year (Settings → Academic years).
    const nextYear = await this.prisma.academicYear.findFirst({ where: { schoolId: ctx.schoolId, startDate: { gt: year.startDate } }, orderBy: { startDate: 'asc' } });
    return {
      term, generatedFor: { enrollmentId: Number(enr.id), studentId: Number(enr.studentId) },
      school: { name: school.name, nameHi: school.nameHi, motto: school.motto, address: [school.addressLine, school.city, school.pincode].filter(Boolean).join(', '), logoFileId: school.logoFileId == null ? null : Number(school.logoFileId), principalTitle: school.principalTitle ?? 'Headmaster', principalName: school.principalName },
      student: { fullName: enr.student.fullName, fullNameHi: enr.student.fullNameHi, studentCode: enr.student.studentCode, grNo: grNoLabel(enr.student), examNo: enr.examNo, rollNo: enr.rollNo, dob: enr.student.dob, gender: enr.student.gender },
      class: { medium: cls.medium.nameEn, mediumCode: cls.medium.code, standard: cls.standard.nameEn, standardCode: cls.standard.code, division: section.name, year: year.name },
      exams: exams.map((e) => ({ id: Number(e.id), code: e.code, name: e.nameEn, kind: e.kind })),
      subjects, examTotals, average: term === 'FINAL' ? { total: avgTotal, max: grandMax, grade: grade(percentage) } : null,
      attendance, attendanceTerms: [1, 2].map((t) => ({ term: t, ...sum(attendance.filter((a) => a.term === t)) })).filter((t) => attendance.some((a) => a.term === t.term)),
      attendanceTotal: { ...attTotal, percent: attPct, low: attPct != null && attPct < lowAttendance },
      percentage, overallGrade: grade(percentage), result: gsDecision?.result ? GREENSHEET_RESULT_LABELS[gsDecision.result as GreensheetResult] : incomplete ? 'INCOMPLETE' : passed ? 'PASS' : 'FAIL',
      remarks: { progress: remark?.progress ?? null, conduct: remark?.conduct ?? null, remark: remark?.remark ?? null },
      reopeningDate: nextYear?.startDate ?? null,
      bands,
    };
  }

  // ------------------------------------------------------------------ division page

  async division(ctx: AccessContext, sectionId: bigint, term: ReportTerm) {
    const section = await this.section(ctx, sectionId);
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    const a = this.access(ctx, scope, sectionId);
    if (!a.view) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'This division is not in your classes');
    const gate = await this.gate(ctx, sectionId, term);
    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { sectionId, status: 'ACTIVE' },
      include: { student: { select: { id: true, fullName: true, fullNameHi: true } }, reportCards: { where: { term } }, remarks: { where: { term } } },
      orderBy: [{ rollNo: 'asc' }],
    });
    return {
      section: { id: section.id, name: section.name, schoolClass: { displayName: section.schoolClass.displayName, medium: section.schoolClass.medium.nameEn } },
      term, gate, can: { ...a, generate: a.generate && gate.ready },
      students: enrollments.map((e) => ({
        enrollmentId: e.id, rollNo: e.rollNo, examNo: e.examNo, student: e.student,
        card: e.reportCards[0] ? { id: e.reportCards[0].id, status: e.reportCards[0].status, generatedAt: e.reportCards[0].generatedAt, publishedAt: e.reportCards[0].publishedAt } : null,
        remarks: e.remarks[0] ? { progress: e.remarks[0].progress, conduct: e.remarks[0].conduct, remark: e.remarks[0].remark } : null,
      })),
    };
  }

  async generate(ctx: AccessContext, sectionId: bigint, term: ReportTerm, enrollmentIds?: number[]) {
    const section = await this.section(ctx, sectionId);
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!this.access(ctx, scope, sectionId).generate) throw outOfScope('Only the class teacher or the Headmaster can generate report cards for this division');
    if (term !== 'FINAL') throw invalidState(ANNUAL_ONLY);
    const gate = await this.gate(ctx, sectionId, term);
    if (!gate.ready) {
      throw new AppError(409, ERROR_CODES.INVALID_STATE, `Report cards cannot be generated yet: ${gate.missing.length} item${gate.missing.length > 1 ? 's are' : ' is'} not approved by the Subject Teacher, Class Teacher and Headmaster.`,
        gate.missing.slice(0, 20).map((m) => ({ path: m.kind, code: 'not_approved', message: `${m.label}: ${m.status}` })));
    }
    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { sectionId, status: 'ACTIVE', ...(enrollmentIds?.length ? { id: { in: enrollmentIds.map(BigInt) } } : {}) },
      include: { reportCards: { where: { term } } },
    });
    let generated = 0;
    let skipped = 0;
    for (const e of enrollments) {
      if (e.reportCards[0]?.status === 'PUBLISHED') { skipped++; continue; } // issued cards never change
      const snapshot = await this.compute(ctx, e.id, term);
      await this.prisma.$transaction(async (tx) => {
        const card = await tx.reportCard.upsert({
          where: { enrollmentId_term: { enrollmentId: e.id, term } },
          update: { snapshot: snapshot as unknown as Prisma.InputJsonValue, generatedBy: ctx.userId, generatedAt: new Date(), version: { increment: 1 } },
          create: { enrollmentId: e.id, term, snapshot: snapshot as unknown as Prisma.InputJsonValue, generatedBy: ctx.userId, generatedAt: new Date() },
        });
        await this.audit.record(ctx, { action: 'GENERATE', entityType: 'ReportCard', entityId: card.id, after: { term, enrollmentId: e.id, result: snapshot.result, percentage: snapshot.percentage } }, tx);
      });
      generated++;
    }
    return { generated, skippedPublished: skipped };
  }

  async publish(ctx: AccessContext, sectionId: bigint, term: ReportTerm) {
    const section = await this.section(ctx, sectionId);
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!this.access(ctx, scope, sectionId).publish) throw forbidden('Only the Headmaster can publish report cards');
    if (term !== 'FINAL') throw invalidState(ANNUAL_ONLY);
    const r = await this.prisma.reportCard.updateMany({
      where: { term, status: 'GENERATED', enrollment: { sectionId, status: 'ACTIVE' } },
      data: { status: 'PUBLISHED', publishedBy: ctx.userId, publishedAt: new Date() },
    });
    await this.audit.record(ctx, { action: 'PUBLISH', entityType: 'ReportCard', entityId: sectionId, after: { term, cards: r.count } });
    return { published: r.count };
  }

  async card(ctx: AccessContext, id: bigint) {
    const c = await this.prisma.reportCard.findFirst({ where: { id, enrollment: { student: { schoolId: ctx.schoolId } } }, include: { enrollment: true } });
    if (!c) throw notFound('Report card');
    const scope = await this.scopes.resolve(ctx, c.enrollment.academicYearId);
    if (!this.access(ctx, scope, c.enrollment.sectionId).view) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'Report card not found in your classes');
    return { id: c.id, status: c.status, term: c.term, generatedAt: c.generatedAt, publishedAt: c.publishedAt, official: true, snapshot: c.snapshot };
  }

  /** Live calculation, clearly marked DRAFT / NOT APPROVED. Never stored. */
  async preview(ctx: AccessContext, enrollmentId: bigint, term: ReportTerm) {
    const e = await this.prisma.studentEnrollment.findFirst({ where: { id: enrollmentId, student: { schoolId: ctx.schoolId } } });
    if (!e) throw notFound('Student');
    const scope = await this.scopes.resolve(ctx, e.academicYearId);
    if (!this.access(ctx, scope, e.sectionId).view) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'Student not found in your classes');
    const gate = await this.gate(ctx, e.sectionId, term);
    return { id: null, status: 'DRAFT', term, official: false, gate, snapshot: await this.compute(ctx, enrollmentId, term) };
  }

  async saveRemarks(ctx: AccessContext, sectionId: bigint, input: z.infer<typeof remarksSchema>) {
    const section = await this.section(ctx, sectionId);
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!this.access(ctx, scope, sectionId).remarks) throw outOfScope('Only the class teacher of this division or the Headmaster can enter remarks');
    const valid = new Set((await this.prisma.studentEnrollment.findMany({ where: { sectionId }, select: { id: true } })).map((e) => String(e.id)));
    await this.prisma.$transaction(async (tx) => {
      for (const i of input.items) {
        if (!valid.has(String(i.enrollmentId))) throw notFound('Student in this division');
        const data = { progress: i.progress || null, conduct: i.conduct || null, remark: i.remark || null, updatedBy: ctx.userId };
        await tx.studentRemark.upsert({ where: { enrollmentId_term: { enrollmentId: BigInt(i.enrollmentId), term: input.term } }, update: data, create: { ...data, enrollmentId: BigInt(i.enrollmentId), term: input.term } });
      }
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'Remarks', entityId: sectionId, after: { term: input.term, students: input.items.length } }, tx);
    });
    return { saved: input.items.length };
  }

  /** Consolidated marksheet of one exam for a division (the school's UT signature sheet). */
  async marksheet(ctx: AccessContext, examId: bigint, sectionId: bigint) {
    const section = await this.section(ctx, sectionId);
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!this.access(ctx, scope, sectionId).view) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'This division is not in your classes');
    const exam = await this.prisma.exam.findFirst({ where: { id: examId, academicYearId: section.schoolClass.academicYearId } });
    if (!exam) throw notFound('Exam');
    const es = await this.prisma.examSubject.findMany({
      where: { examId, classSubject: { classId: section.classId, status: 'ACTIVE' } },
      include: { classSubject: { include: { subject: { select: { nameEn: true, shortName: true } } } } }, orderBy: { classSubject: { displayOrder: 'asc' } },
    });
    const subs = await this.prisma.academicSubmission.findMany({ where: { examId, sectionId } });
    const marks = await this.prisma.mark.findMany({ where: { examId, enrollment: { sectionId } } });
    const enrollments = await this.prisma.studentEnrollment.findMany({ where: { sectionId, status: 'ACTIVE' }, include: { student: { select: { fullName: true } } }, orderBy: { rollNo: 'asc' } });
    const mk = new Map(marks.map((m) => [`${m.enrollmentId}:${m.classSubjectId}`, m]));
    const maxTotal = es.reduce((t, e) => t + Number(e.max1) + (num(e.max2) ?? 0), 0);
    return {
      exam: { id: exam.id, code: exam.code, nameEn: exam.nameEn, kind: exam.kind },
      section: { id: section.id, name: section.name, displayName: section.schoolClass.displayName },
      subjects: es.map((e) => {
        const sub = subs.find((s) => s.classSubjectId === e.classSubjectId);
        return { classSubjectId: e.classSubjectId, name: e.classSubject.subject.shortName ?? e.classSubject.subject.nameEn, max: Number(e.max1) + (num(e.max2) ?? 0), bucket: progressBucket(sub) };
      }),
      maxTotal,
      rows: enrollments.map((en) => {
        const cells = es.map((e) => {
          const m = mk.get(`${en.id}:${e.classSubjectId}`);
          return m ? (m.absent ? 'AB' : (num(m.marks1) ?? 0) + (num(m.marks2) ?? 0)) : null;
        });
        const total = cells.reduce<number>((t, c) => t + (typeof c === 'number' ? c : 0), 0);
        return { enrollmentId: en.id, rollNo: en.rollNo, examNo: en.examNo, name: en.student.fullName, cells, total, percent: maxTotal ? round2((total / maxTotal) * 100) : 0 };
      }),
    };
  }
}

/** The report card (mark sheet) is made once a year, after both semesters. */
const ANNUAL_ONLY = 'The report card is made once a year, after both semesters';
const termQuery = z.object({ term: z.enum(REPORT_TERMS).default('FINAL') });
const generateSchema = z.object({ term: z.enum(REPORT_TERMS), enrollmentIds: z.array(z.coerce.number().int().positive()).max(200).optional() });
const previewQuery = z.object({ enrollmentId: z.coerce.number().int().positive(), term: z.enum(REPORT_TERMS).default('FINAL') });
const marksheetQuery = z.object({ examId: z.coerce.number().int().positive(), sectionId: z.coerce.number().int().positive() });

@Controller()
export class ReportCardsController {
  constructor(private readonly rc: ReportCardsService) {}

  @Get('report-cards/division/:sectionId') @RequirePermission(P.MARKS_READ)
  division(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint, @Query(zBody(termQuery)) q: z.infer<typeof termQuery>) { return this.rc.division(ctx, id, q.term); }

  @Post('report-cards/division/:sectionId/generate') @HttpCode(200) @RequirePermission(P.REPORTCARDS_GENERATE)
  generate(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint, @Body(zBody(generateSchema)) b: z.infer<typeof generateSchema>) { return this.rc.generate(ctx, id, b.term, b.enrollmentIds); }

  @Post('report-cards/division/:sectionId/publish') @HttpCode(200) @RequirePermission(P.REPORTCARDS_PUBLISH)
  publish(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint, @Body(zBody(termQuery)) b: z.infer<typeof termQuery>) { return this.rc.publish(ctx, id, b.term); }

  @Put('report-cards/division/:sectionId/remarks') @RequirePermission(P.REMARKS_ENTER)
  remarks(@Ctx() ctx: AccessContext, @Param('sectionId', IdPipe) id: bigint, @Body(zBody(remarksSchema)) b: z.infer<typeof remarksSchema>) { return this.rc.saveRemarks(ctx, id, b); }

  @Get('report-cards/preview') @RequirePermission(P.MARKS_READ)
  preview(@Ctx() ctx: AccessContext, @Query(zBody(previewQuery)) q: z.infer<typeof previewQuery>) { return this.rc.preview(ctx, BigInt(q.enrollmentId), q.term); }

  @Get('report-cards/:id') @RequirePermission(P.MARKS_READ)
  card(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint) { return this.rc.card(ctx, id); }

  @Get('marksheet') @RequirePermission(P.MARKS_READ)
  marksheet(@Ctx() ctx: AccessContext, @Query(zBody(marksheetQuery)) q: z.infer<typeof marksheetQuery>) { return this.rc.marksheet(ctx, BigInt(q.examId), BigInt(q.sectionId)); }
}

@Module({ imports: [PoliciesSequencesModule], controllers: [ReportCardsController], providers: [ReportCardsService], exports: [ReportCardsService] })
export class ReportCardsModule {}
