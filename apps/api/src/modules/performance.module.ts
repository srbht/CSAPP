import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { partCode, PERMISSIONS } from '@cps/shared';
import { z } from 'zod';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { notFound } from '../common/errors';
import { ScopeService } from '../common/scope';
import { zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';
import { patternOf } from './exams.module';

const P = PERMISSIONS;
/** A subject is passed with at least this share of its maximum (the school's 35 %). */
const PASS_PERCENT = 35;

/**
 * The four performance reports of a year, in order. A unit test is the OBT column of its semester sheet (counted once
 * the Headmaster approves the unit test); a semester report is the Written column (counted once the whole semester
 * sheet has the Headmaster's final approval).
 */
export const PERFORMANCE_REPORTS = [
  { key: 'UT1', term: 'TERM1', part: 'OBT', title: '1st Unit Test', short: 'UT 1' },
  { key: 'SEM1', term: 'TERM1', part: 'WRITTEN', title: 'Semester I', short: 'Sem I' },
  { key: 'UT2', term: 'TERM2', part: 'OBT', title: '2nd Unit Test', short: 'UT 2' },
  { key: 'SEM2', term: 'TERM2', part: 'WRITTEN', title: 'Semester II', short: 'Sem II' },
] as const;
type ReportDef = (typeof PERFORMANCE_REPORTS)[number];

const query = z.object({
  report: z.enum(['UT1', 'SEM1', 'UT2', 'SEM2']).default('UT1'),
  sectionId: z.coerce.number().int().positive(),
});

type Cell = number | 'AB' | 'C' | null;
const round2 = (n: number) => Math.round(n * 100) / 100;
const value = (c: Cell) => (typeof c === 'number' ? c : c ? 0 : null); // AB and C count as 0

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService, private readonly scopes: ScopeService) {}

  /** One report's columns for a division: the subjects with that part, their maximum, approval and every student's mark. */
  private async column(def: ReportDef, section: { id: bigint; classId: bigint; schoolClass: { academicYearId: bigint } }, enrollmentIds: bigint[]) {
    const exam = await this.prisma.exam.findFirst({ where: { academicYearId: section.schoolClass.academicYearId, reportTerm: def.term, status: { not: 'ARCHIVED' } } });
    if (!exam) return null;
    // Activity subjects (Art, PT, Work Experience, Art & Craft) have no written exam: never in the performance report.
    const classSubjects = await this.prisma.classSubject.findMany({
      where: { classId: section.classId, status: 'ACTIVE', subject: { subjectType: { not: 'ACTIVITY' } } },
      include: { subject: { select: { nameEn: true, shortName: true } } },
      orderBy: { displayOrder: 'asc' },
    });
    const es = new Map((await this.prisma.examSubject.findMany({ where: { examId: exam.id, classSubjectId: { in: classSubjects.map((c) => c.id) } } })).map((e) => [String(e.classSubjectId), e]));
    const subs = new Map((await this.prisma.academicSubmission.findMany({ where: { examId: exam.id, sectionId: section.id, recordType: 'MARKS' } })).map((s) => [String(s.classSubjectId), s]));
    const teachers = new Map((await this.prisma.teachingAssignment.findMany({ where: { sectionId: section.id, role: 'SUBJECT_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } }))
      .map((t) => [String(t.classSubjectId), t.staff.name]));
    const subjects = classSubjects.flatMap((cs) => {
      const e = es.get(String(cs.id));
      const part = e ? patternOf(e).find((p) => p.key === def.part) : null;
      if (!part) return [];
      const sub = subs.get(String(cs.id));
      const unitTestLocked = Array.isArray(sub?.lockedParts) && (sub!.lockedParts as string[]).includes('OBT');
      const approved = sub?.status === 'APPROVED' || (def.part === 'OBT' && unitTestLocked);
      return [{
        classSubjectId: cs.id, name: cs.subject.nameEn, short: cs.subject.shortName || cs.subject.nameEn, max: part.max, inTotal: cs.includeInTotal,
        teacher: teachers.get(String(cs.id)) ?? null, approved, submissionId: sub?.id ?? null,
      }];
    });
    const approvedSubs = subjects.filter((s) => s.approved && s.submissionId);
    const marks = approvedSubs.length && enrollmentIds.length
      ? await this.prisma.mark.findMany({ where: { submissionId: { in: approvedSubs.map((s) => s.submissionId!) }, enrollmentId: { in: enrollmentIds } }, select: { submissionId: true, enrollmentId: true, parts: true, absent: true } })
      : [];
    const subOf = new Map(approvedSubs.map((s) => [String(s.submissionId), String(s.classSubjectId)]));
    const cells = new Map<string, Cell>();
    for (const m of marks) {
      const raw = m.absent ? 'AB' : (m.parts as Record<string, unknown> | null)?.[def.part];
      const code = partCode(raw);
      cells.set(`${m.enrollmentId}:${subOf.get(String(m.submissionId))}`, code ?? (raw == null || raw === '' ? null : Number(raw)));
    }
    const counted = approvedSubs.filter((s) => s.inTotal);
    const maxTotal = counted.reduce((t, s) => t + s.max, 0);
    /** A student's marks, total and % over the approved subjects (null when nothing is approved / entered). */
    const result = (enrollmentId: bigint) => {
      const m = Object.fromEntries(subjects.map((s) => [String(s.classSubjectId), s.approved ? (cells.get(`${enrollmentId}:${s.classSubjectId}`) ?? null) : null])) as Record<string, Cell>;
      const any = counted.some((s) => m[String(s.classSubjectId)] != null);
      const total = counted.reduce((t, s) => t + (value(m[String(s.classSubjectId)]) ?? 0), 0);
      return { marks: m, total: any ? total : null, percent: any && maxTotal ? round2((total / maxTotal) * 100) : null };
    };
    return { exam, subjects, maxTotal, complete: subjects.length > 0 && approvedSubs.length === subjects.length, result };
  }

  async report(ctx: AccessContext, q: z.infer<typeof query>) {
    const section = await this.prisma.section.findFirst({
      where: { id: BigInt(q.sectionId), schoolClass: { academicYear: { schoolId: ctx.schoolId } } },
      include: { schoolClass: { include: { medium: true, standard: true, academicYear: true } } },
    });
    if (!section) throw notFound('Division');
    const scope = await this.scopes.resolve(ctx, section.schoolClass.academicYearId);
    if (!scope.all && !scope.sectionIds.some((s) => s === section.id)) throw notFound('Division');
    const def = PERFORMANCE_REPORTS.find((r) => r.key === q.report)!;

    const enrollments = await this.prisma.studentEnrollment.findMany({
      where: { sectionId: section.id, status: { in: ['ACTIVE', 'TRANSFERRED_OUT', 'WITHDRAWN'] } },
      include: { student: { select: { fullName: true, gender: true, studentCode: true } } },
      orderBy: [{ rollNo: { sort: 'asc', nulls: 'last' } }, { student: { fullName: 'asc' } }],
    });
    const active = enrollments.filter((e) => e.status === 'ACTIVE');
    const leftCount = enrollments.length - active.length;
    const ids = active.map((e) => e.id);

    const col = await this.column(def, section, ids);
    if (!col) throw notFound(`${def.term === 'TERM1' ? 'Semester I' : 'Semester II'} (set it up under Exams first)`);
    // Earlier reports of the year: each student's % in them, to follow the progress.
    type Result = NonNullable<Awaited<ReturnType<PerformanceService['column']>>>['result'];
    const earlier: { key: string; title: string; short: string; available: boolean; result: Result | null }[] = [];
    for (const d of PERFORMANCE_REPORTS.slice(0, PERFORMANCE_REPORTS.findIndex((r) => r.key === def.key))) {
      const c = await this.column(d, section, ids);
      earlier.push({ key: d.key, title: d.title, short: d.short, available: !!c && c.subjects.some((s) => s.approved), result: c?.result ?? null });
    }

    const students = active.map((e, i) => {
      const r = col.result(e.id);
      return {
        enrollmentId: e.id, serialNo: i + 1, rollNo: e.rollNo, examNo: e.examNo, studentCode: e.student.studentCode, fullName: e.student.fullName, gender: e.student.gender,
        ...r, rank: null as number | null,
        history: earlier.map((h) => ({ key: h.key, percent: h.result ? h.result(e.id).percent : null })),
      };
    });
    // Rank in the class by total (equal totals share a rank), only once every subject is approved.
    if (col.complete) {
      const sorted = [...students].filter((s) => s.total != null).sort((a, b) => b.total! - a.total!);
      sorted.forEach((s, i) => { s.rank = i > 0 && sorted[i - 1].total === s.total ? sorted[i - 1].rank : i + 1; });
    }
    const summary = col.subjects.map((s) => {
      const vals = students.map((st) => st.marks[String(s.classSubjectId)]);
      const appeared = vals.filter((v): v is number | 'C' => v != null && v !== 'AB');
      const nums = appeared.map((v) => value(v)!) as number[];
      const passed = nums.filter((v) => (v / s.max) * 100 >= PASS_PERCENT).length;
      return {
        classSubjectId: s.classSubjectId,
        onRoll: active.length,
        absentLeft: vals.filter((v) => v === 'AB').length + leftCount,
        appeared: s.approved ? appeared.length : null,
        passed: s.approved ? passed : null,
        failed: s.approved ? appeared.length - passed : null,
        passPercent: s.approved && appeared.length ? round2((passed / appeared.length) * 100) : null,
        highest: s.approved && nums.length ? Math.max(...nums) : null,
        average: s.approved && nums.length ? round2(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
      };
    });
    const withPct = students.filter((s) => s.percent != null);
    const classTeacher = await this.prisma.teachingAssignment.findFirst({ where: { sectionId: section.id, role: 'CLASS_TEACHER', status: 'ACTIVE' }, include: { staff: { select: { name: true } } } });
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId }, select: { name: true, addressLine: true, city: true } });
    return {
      school: { name: school.name, address: [school.addressLine, school.city].filter(Boolean).join(', ') },
      year: section.schoolClass.academicYear.name,
      report: { key: def.key, title: def.title, short: def.short, part: def.part, examName: col.exam.nameEn, heading: `${def.title}${def.part === 'WRITTEN' ? ' (Written)' : ''} Marks for the year ${section.schoolClass.academicYear.name}` },
      earlier: earlier.map(({ result: _r, ...h }) => h),
      division: { id: section.id, label: `${section.schoolClass.displayName}-${section.name}`, medium: section.schoolClass.medium.nameEn, name: section.name, classTeacher: classTeacher?.staff.name ?? null },
      passPercent: PASS_PERCENT,
      subjects: col.subjects.map(({ submissionId: _s, ...s }) => s),
      pending: col.subjects.filter((s) => !s.approved).map((s) => s.name),
      complete: col.complete,
      maxTotal: col.maxTotal,
      students,
      summary,
      classAverage: withPct.length ? round2(withPct.reduce((t, s) => t + s.percent!, 0) / withPct.length) : null,
    };
  }
}

@Controller()
export class PerformanceController {
  constructor(private readonly svc: PerformanceService) {}

  @Get('performance/report') @RequirePermission(P.MARKS_READ)
  report(@Ctx() ctx: AccessContext, @Query(zBody(query)) q: z.infer<typeof query>) { return this.svc.report(ctx, q); }
}

@Module({ controllers: [PerformanceController], providers: [PerformanceService] })
export class PerformanceModule {}
