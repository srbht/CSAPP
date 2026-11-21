/**
 * SAMPLE "last year" (2025-26) for trying promotion and class-list generation. Run AFTER `npm run sample-data`.
 *
 *  - Creates 2025-26 (if missing) with ENGLISH-UKG A, ENGLISH-IV A and HINDI-VII A: same subjects and teachers as this
 *    year, 8 fictional students each (admitted and confirmed, with GR numbers).
 *  - Class lists prepared by the office and confirmed by the class teacher → Exam Nos E-S-001…, E-4-001…, H-7-001….
 *  - Both semesters' marks and every month's attendance go through Operator → Subject Teacher → Class Teacher →
 *    Headmaster; the Headmaster decides the results (one Re-Exam, one Detained per class) and approves the Greensheets.
 *  - In 2026-27 the classes these students move into (ENGLISH-I, ENGLISH-V, HINDI-VIII) are put back to "class list
 *    being prepared" without Exam Nos, so the whole cycle can be tried: promote → verify → class list → Exam Nos.
 *
 * Promotion itself is NOT done here: try it in the app (office prepares, Headmaster verifies).
 * Everything goes through the running API, like sample-data.ts (temporary loader login, demo tokens for teachers);
 * only the 2026-27 reset is written straight to the database. Never run this against the school's real database.
 *
 *   npm run sample-last-year -w @cps/api
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '../src/generated/prisma/client';
import { adapterFromUrl } from '../src/infra/db-adapter';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const LOADER = 'sample-loader';
const LAST = { name: '2025-26', startDate: '2025-06-15', endDate: '2026-04-30' };
/** [medium code, standard code, standard of next year] */
const DEMO: [string, string, string][] = [['EN', 'UKG', 'I'], ['EN', 'IV', 'V'], ['HI', 'VII', 'VIII']];
const NAMES: Record<string, [string, 'MALE' | 'FEMALE'][]> = {
  UKG: [['PAWAR AARUSH SACHIN MEGHA', 'MALE'], ['SHAIKH INAYA SALIM RUBINA', 'FEMALE'], ['YADAV KABIR ANIL SEEMA', 'MALE'], ['MORE ANVI SANDEEP PUJA', 'FEMALE'],
    ['GUPTA REYANSH VINOD KAVITA', 'MALE'], ['KADAM MIRA SUNIL ASHA', 'FEMALE'], ['SINGH VIVAAN RAKESH NEHA', 'MALE'], ['DESAI KIARA AMOL SWATI', 'FEMALE']],
  IV: [['JADHAV OM PRAKASH SUREKHA', 'MALE'], ['KHAN ALIZA IMRAN SANA', 'FEMALE'], ['PATIL ATHARV MAHESH VANDANA', 'MALE'], ['MISHRA SIYA ALOK RITU', 'FEMALE'],
    ['CHAVAN ARJUN DEEPAK SHITAL', 'MALE'], ['VERMA ISHA MANOJ ANJALI', 'FEMALE'], ['GAIKWAD SHAURYA NITIN MANISHA', 'MALE'], ['NAIK PRIYA GANESH SARIKA', 'FEMALE']],
  VII: [['TIWARI ADITYA RAMESH SUNITA', 'MALE'], ['ANSARI MAHEK ASLAM NASREEN', 'FEMALE'], ['PANDEY HARSH VIJAY POONAM', 'MALE'], ['SHARMA RIYA DINESH MAMTA', 'FEMALE'],
    ['DUBEY AYUSH SANJAY REKHA', 'MALE'], ['YADAV NANDINI SURESH GEETA', 'FEMALE'], ['GUPTA KUNAL RAJESH ANITA', 'MALE'], ['SINGH TANVI MUKESH KIRAN', 'FEMALE']],
};

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let token = '';
async function callAs(tok: string, method: string, url: string, body?: unknown): Promise<J> {
  const r = await fetch(API + url, { method, headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 429) { await new Promise((res) => setTimeout(res, 20_000)); return callAs(tok, method, url, body); }
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${json?.detail ?? text}`);
  return json;
}
const get = (u: string) => callAs(token, 'GET', u);
const post = (u: string, b?: unknown) => callAs(token, 'POST', u, b ?? {});
const put = (u: string, b: unknown) => callAs(token, 'PUT', u, b);

function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

async function signInLoader(prisma: PrismaClient) {
  const password = `Loader-${randomBytes(9).toString('base64url')}1`;
  const school = await prisma.school.findFirstOrThrow({ where: { code: process.env.SCHOOL_CODE ?? 'CPS' } });
  const superRole = await prisma.role.findUniqueOrThrow({ where: { schoolId_code: { schoolId: school.id, code: 'SUPER_ADMIN' } } });
  const passwordHash = await hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
  const existing = await prisma.user.findFirst({ where: { schoolId: school.id, username: LOADER } });
  if (existing) await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE', mustChangePassword: false } });
  else await prisma.user.create({ data: { schoolId: school.id, username: LOADER, passwordHash, mustChangePassword: false, roles: { create: { roleId: superRole.id, scopeType: 'SCHOOL' } } } });
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: LOADER, password }) });
  if (!r.ok) throw new Error(`Could not sign in the sample loader (${r.status}). Is the API running on ${API}?`);
  token = (await r.json()).accessToken;
}

async function main() {
  const url = process.env.DATABASE_URL;
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!url || !secret) throw new Error('DATABASE_URL and JWT_ACCESS_SECRET must be set in apps/api/.env');
  const prisma = new PrismaClient({ adapter: adapterFromUrl(url) });
  try {
    await signInLoader(prisma);
    const years: J[] = await get('/academic-years');
    const current = years.find((y) => y.isCurrent);
    if (years.some((y) => y.name === LAST.name)) { console.log(`• ${LAST.name} already exists: nothing to do`); return; }
    const year = await post('/academic-years', LAST);
    await post(`/academic-years/${year.id}/terms`, { code: 'SEM1', nameEn: 'Semester I', startDate: '2025-06-15', endDate: '2025-10-31', sequence: 1 });
    await post(`/academic-years/${year.id}/terms`, { code: 'SEM2', nameEn: 'Semester II', startDate: '2025-11-01', endDate: '2026-04-30', sequence: 2 });
    console.log(`✓ academic year ${LAST.name} (Semester I and II)`);

    // Teachers act with their own (demo) tokens, as in sample-data.ts.
    const me = await get('/me');
    const users: J[] = (await get('/users?pageSize=100')).data;
    const tokenFor = new Map<number, string>();
    for (const u of users) if (u.staffId && u.status === 'ACTIVE') tokenFor.set(u.staffId, jwt.sign({ sub: String(u.id), sch: String(me.school.id) }, secret, { algorithm: 'HS256', expiresIn: '2h' }));
    const as = (staffId: number) => {
      const t = tokenFor.get(staffId);
      if (!t) throw new Error(`No login for staff ${staffId}`);
      return { get: (u: string) => callAs(t, 'GET', u), put: (u: string, b: unknown) => callAs(t, 'PUT', u, b), post: (u: string, b?: unknown) => callAs(t, 'POST', u, b ?? {}) };
    };
    const hm = as(users.find((u) => u.username === 'headmaster').staffId);

    // ---------------------------------------------------------------- classes, subjects, teachers (copied from 2026-27)
    const mediums: J[] = await get('/mediums');
    const standards: J[] = await get('/standards');
    const now: J[] = await get(`/classes?academicYearId=${current.id}`);
    const made: { cls: J; sec: J; std: string; next: string; medium: string }[] = [];
    let gr = 801;
    for (const [m, std, next] of DEMO) {
      const src = now.find((c) => c.medium.code === m && c.standard.code === std);
      if (!src) throw new Error(`${m} ${std} does not exist in ${current.name}`);
      const cls = await post('/classes', { academicYearId: year.id, mediumId: mediums.find((x) => x.code === m).id, standardId: standards.find((x) => x.code === std).id });
      const srcSubjects: J[] = (await get(`/classes/${src.id}/subjects`)).filter((s: J) => s.status === 'ACTIVE');
      const subjects: J[] = await put(`/classes/${cls.id}/subjects`, {
        items: srcSubjects.map((s) => ({ subjectId: s.subjectId ?? s.subject.id, includeInTotal: s.includeInTotal, defaultMaxMarks: s.defaultMaxMarks ?? 100, defaultPassMarks: s.defaultPassMarks ?? 35, displayOrder: s.displayOrder })),
      });
      const sec = await post(`/classes/${cls.id}/sections`, { name: 'A', capacity: 60 });
      const srcSec = src.sections.find((s: J) => s.name === 'A');
      const assignments: J[] = await get(`/assignments?academicYearId=${current.id}&sectionId=${srcSec.id}`);
      const subjectOf = new Map(srcSubjects.map((s) => [s.id, s.subjectId ?? s.subject.id]));
      for (const a of assignments.filter((x) => !x.status || x.status === 'ACTIVE')) {
        const csId = a.classSubjectId ? subjects.find((s) => (s.subjectId ?? s.subject.id) === subjectOf.get(a.classSubjectId))?.id : undefined;
        if (a.classSubjectId && !csId) continue;
        await post('/assignments', { academicYearId: year.id, validFrom: LAST.startDate, staffId: a.staffId, role: a.role, sectionId: sec.id, ...(csId ? { classSubjectId: csId } : {}) });
      }
      for (const [i, [name, gender]] of NAMES[std].entries()) {
        const [surname, first, father, mother] = name.split(' ');
        const birthYear = 2020 - (std === 'UKG' ? 0 : std === 'IV' ? 4 : 7) - 1;
        await post('/students', {
          student: {
            fullName: name, surname, firstName: first, fatherName: father, motherName: mother, gender, grNo: `SE-0${gr++}`,
            dob: `${birthYear}-${String((i % 12) + 1).padStart(2, '0')}-${String(5 + i).padStart(2, '0')}`, admissionDate: '2025-06-16', birthPlace: 'Mumbai',
            guardians: [{ relation: 'FATHER', name: `${father.charAt(0)}${father.slice(1).toLowerCase()} ${surname.charAt(0)}${surname.slice(1).toLowerCase()}`, mobile: `98200${String(70000 + gr * 7).slice(-5)}`, isPrimary: true }],
          },
          enrollment: { sectionId: sec.id, joinedOn: '2025-06-16' },
        });
      }
      made.push({ cls, sec, std, next, medium: m });
      console.log(`✓ ${cls.displayName} A (${LAST.name}): subjects, teachers and 8 students`);
    }

    // ---------------------------------------------------------------- class lists → Exam Nos
    const allAssign: J[] = await get(`/assignments?academicYearId=${year.id}`);
    const by = (role: string, sectionId: number, cs?: number) => allAssign.find((a) => a.role === role && a.sectionId === sectionId && (cs === undefined || a.classSubjectId === cs))?.staffId as number;
    for (const d of made) {
      await post(`/sections/${d.sec.id}/renumber`);
      await post(`/sections/${d.sec.id}/list/ready`);
      await as(by('CLASS_TEACHER', d.sec.id)).post(`/sections/${d.sec.id}/list/confirm`);
      await hm.post(`/sections/${d.sec.id}/list/finalize`);
      const r = await hm.post(`/sections/${d.sec.id}/exam-nos`);
      console.log(`✓ ${d.cls.displayName} A: class list confirmed by the class teacher, finalized by the Headmaster, ${r.generated} Exam Nos`);
    }

    // ---------------------------------------------------------------- exams, marks, attendance (all approved)
    const exams = [
      await post(`/exams?academicYearId=${year.id}`, { code: 'SEM1', nameEn: 'Semester I', reportTerm: 'TERM1', sequence: 1 }),
      await post(`/exams?academicYearId=${year.id}`, { code: 'SEM2', nameEn: 'Semester II', reportTerm: 'TERM2', sequence: 2 }),
    ];
    const rand = rng(2025);
    const skillOf = new Map<number, number>();
    async function approveChain(unit: J, rowsFor: (rows: J[]) => J[], ppl: { op: number; first: number; ct: number }, extra: J = {}) {
      const op = as(ppl.op);
      const q = `/sheets?${new URLSearchParams(Object.entries(unit).map(([k, v]) => [k, String(v)])).toString()}`;
      const view = await op.get(q);
      await op.put('/sheets', { unit, rows: rowsFor(view.rows), ...extra });
      const sub = (await op.get(q)).submission;
      await op.post(`/submissions/${sub.id}/submit`);
      await as(ppl.first).post(`/submissions/${sub.id}/verify`);
      if ((await op.get(q)).submission.stage === 'CLASS_APPROVE') await as(ppl.ct).post(`/submissions/${sub.id}/verify`);
      await hm.post(`/submissions/${sub.id}/verify`);
    }
    const working: Record<string, number> = { '2025-06': 14, '2025-07': 25, '2025-08': 23, '2025-09': 22, '2025-10': 18, '2025-11': 20, '2025-12': 23, '2026-01': 24, '2026-02': 22, '2026-03': 23, '2026-04': 12 };
    for (const d of made) {
      const op = by('OPERATOR', d.sec.id);
      const ct = by('CLASS_TEACHER', d.sec.id);
      const av = by('ATTENDANCE_VERIFIER', d.sec.id) ?? ct;
      const roster: J[] = (await get(`/students?sectionId=${d.sec.id}&academicYearId=${year.id}&pageSize=50`)).data;
      // Roll 7 is weak in two subjects (Re-Exam), roll 8 weak everywhere (Detained); the rest pass.
      for (const s of roster) skillOf.set(s.enrollmentId, s.rollNo === 8 ? 0.2 : s.rollNo === 7 ? 0.42 : 0.55 + rand() * 0.4);
      const score = (eid: number, max: number, weakHere = false) => {
        const sk = weakHere ? 0.18 : skillOf.get(eid)!;
        return Math.max(0, Math.min(max, Math.round(max * Math.min(1, Math.max(0, sk + (rand() - 0.5) * 0.12)))));
      };
      for (const [m, wd] of Object.entries(working)) {
        await approveChain({ recordType: 'ATTENDANCE', sectionId: d.sec.id, period: m },
          (rows) => rows.map((r: J) => ({ enrollmentId: r.enrollmentId, presentDays: Math.max(0, wd - Math.floor(rand() * 3)) })), { op, first: av, ct }, { workingDays: wd });
      }
      let sheets = 0;
      for (const ex of exams) {
        const subjects: J[] = await get(`/exams/${ex.id}/subjects?classId=${d.cls.id}`);
        for (const [k, es] of subjects.entries()) {
          const roll7weak = k < 2; // first two subjects
          await approveChain({ recordType: 'MARKS', examId: ex.id, sectionId: d.sec.id, classSubjectId: es.classSubjectId },
            (rows) => rows.map((r: J) => ({ enrollmentId: r.enrollmentId, parts: Object.fromEntries(es.parts.map((p: J) => [p.key, score(r.enrollmentId, Number(p.max), r.rollNo === 7 && roll7weak)])) })),
            { op, first: by('SUBJECT_TEACHER', d.sec.id, es.classSubjectId) ?? ct, ct });
          sheets++;
        }
      }
      console.log(`✓ ${d.cls.displayName} A: attendance Jun–Apr and ${sheets} mark sheets approved by the Headmaster`);

      // ---------------------------------------------------------------- Greensheet: Headmaster decides and approves
      const gs = await hm.get(`/greensheet/${d.sec.id}`);
      const items = gs.students.filter((s: J) => !s.left).map((s: J) => ({
        enrollmentId: s.enrollmentId, grace: {}, remark: null,
        result: s.rollNo === 8 ? 'DETAINED' : s.rollNo === 7 ? 'RE_EXAM' : s.suggested === 'RE_EXAM' ? 'PROMOTED' : 'PASS',
      }));
      await hm.put(`/greensheet/${d.sec.id}/results`, { items });
      await hm.post(`/greensheet/${d.sec.id}/approve`);
      console.log(`✓ ${d.cls.displayName} A: Greensheet decided (6 pass, 1 re-exam, 1 detained) and approved`);
    }

    // ---------------------------------------------------------------- 2026-27: target classes back to "being prepared"
    const targets = now.filter((c) => made.some((d) => d.medium === c.medium.code && d.next === c.standard.code));
    for (const c of targets) {
      await prisma.studentEnrollment.updateMany({ where: { classId: BigInt(c.id) }, data: { examNo: null } });
      await prisma.schoolClass.update({ where: { id: BigInt(c.id) }, data: { examNosAt: null } });
      await prisma.section.updateMany({ where: { classId: BigInt(c.id) }, data: { listStatus: 'DRAFT', listReadyAt: null, listReadyBy: null, listConfirmedAt: null, listConfirmedBy: null, listNote: null } });
    }
    console.log(`✓ ${current.name}: ${targets.map((c) => c.displayName).join(', ')} put back to "class list being prepared" (Exam Nos cleared)`);
    console.log(`\nReady. Switch the year to ${LAST.name} (top bar), then Promotion → ${LAST.name} → a class. Office prepares, headmaster verifies.`);
  } finally {
    await prisma.user.updateMany({ where: { username: LOADER }, data: { status: 'DISABLED' } });
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
