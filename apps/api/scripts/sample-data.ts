/**
 * Loads SAMPLE data for trying the app: logo, terms, classes and divisions for both mediums, subjects and
 * papers, class subject lists, staff, logins for every role, and all academic assignments.
 *
 * Everything goes through the running API (same validation, rules and audit log as the web app). Only one
 * thing is written straight to the database: a temporary loader login is created (and disabled at the end), and demo logins are marked "no forced password change" so you can
 * switch between roles quickly. Never run this against the school's real database.
 *
 *   npm run dev:db            (terminal 1)
 *   npm run dev:api           (terminal 2)
 *   npm run sample-data       (terminal 3, once)
 *
 * Env: API_URL (default http://localhost:3000/api/v1). Your admin login is not used or changed.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client';
import { adapterFromUrl } from '../src/infra/db-adapter';
import { todayIn } from '@cps/shared';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Test-pass-2026'; // set DEMO_PASSWORD for an online copy
const YEAR_START = '2026-06-15'; // assignments start on school re-opening day (report card: 15/6/2026)

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let token = '';

async function call(method: string, url: string, body?: unknown): Promise<J> {
  return callAs(token, method, url, body);
}
async function callAs(tok: string, method: string, url: string, body?: unknown): Promise<J> {
  const isForm = body instanceof FormData;
  const r = await fetch(API + url, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (r.status === 429) {
    // The API allows ~300 requests a minute; wait and retry instead of failing half-way.
    await new Promise((res) => setTimeout(res, 20_000));
    return callAs(tok, method, url, body);
  }
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${json?.detail ?? text}${json?.errors ? ' ' + JSON.stringify(json.errors) : ''}`);
  return json;
}
const get = (u: string) => call('GET', u);
const post = (u: string, b?: unknown) => call('POST', u, b ?? {});

// ---------------------------------------------------------------- sample definitions (all names are fictional)

/** Subject catalogue, one copy per medium. [code, English name, Hindi name, type, parent code?] */
const SUBJECTS: [string, string, string, string, string?][] = [
  ['ENG', 'English', 'अंग्रेज़ी', 'THEORY'],
  ['MAR', 'Marathi', 'मराठी', 'THEORY'],
  ['HIN', 'Hindi', 'हिंदी', 'THEORY'],
  ['MATH', 'Mathematics', 'गणित', 'THEORY'],
  ['ALG', 'Algebra', 'बीजगणित', 'THEORY', 'MATH'],
  ['GEOM', 'Geometry', 'ज्यामिति', 'THEORY', 'MATH'],
  ['EVS', 'Environmental Studies', 'परिसर अध्ययन', 'THEORY'],
  ['GK', 'G.K.', 'सामान्य ज्ञान', 'THEORY'],
  ['STORY', 'Story', 'कहानी', 'THEORY'],
  ['SCI', 'Science', 'विज्ञान', 'THEORY'],
  ['SCI1', 'Science - I', 'विज्ञान - I', 'THEORY', 'SCI'],
  ['SCI2', 'Science - II', 'विज्ञान - II', 'THEORY', 'SCI'],
  ['SOC', 'Social Science', 'सामाजिक विज्ञान', 'THEORY'],
  ['HISPS', 'History & Political Science', 'इतिहास व राज्यशास्त्र', 'THEORY', 'SOC'],
  ['GEOG', 'Geography', 'भूगोल', 'THEORY', 'SOC'],
  ['WE', 'Work Experience', 'कार्यानुभव', 'ACTIVITY'],
  ['ART', 'Art', 'कला', 'ACTIVITY'],
  ['PE', 'Physical Education', 'शारीरिक शिक्षा', 'ACTIVITY'],
  ['WS', 'Water Security', 'जल सुरक्षा', 'ACTIVITY'],
  ['CDRS', 'C.D. & R.S.', 'सी.डी. व आर.एस.', 'ACTIVITY'],
];

/** Which subjects each group of standards studies (as on the school's Greensheet 2025-26). */
const CURRICULUM: { standards: string[]; subjects: string[] }[] = [
  { standards: ['NUR', 'LKG', 'UKG'], subjects: ['ENG', 'HIN', 'MATH', 'ART'] },
  { standards: ['I', 'II'], subjects: ['ENG', 'MAR', 'MATH', 'GK', 'STORY', 'WE', 'ART', 'PE'] },
  { standards: ['III', 'IV'], subjects: ['ENG', 'MAR', 'HIN', 'MATH', 'EVS', 'GK', 'STORY', 'WE', 'ART', 'PE'] },
  { standards: ['V'], subjects: ['ENG', 'MAR', 'HIN', 'MATH', 'EVS', 'WE', 'ART', 'PE'] },
  { standards: ['VI', 'VII', 'VIII'], subjects: ['ENG', 'MAR', 'HIN', 'MATH', 'SCI', 'SOC', 'WE', 'ART', 'PE'] },
  // IX–X: Water Security, C.D. & R.S. and Phy. Edu. are graded but not counted in the total.
  { standards: ['IX', 'X'], subjects: ['ENG', 'MAR', 'HIN', 'MATH', 'SCI', 'SOC', 'WS', 'CDRS', 'PE'] },
];

/** Classes: medium → standard → divisions. */
const CLASSES: Record<string, Record<string, string[]>> = {
  EN: { NUR: ['A'], LKG: ['A'], UKG: ['A'], I: ['A'], II: ['A'], III: ['A'], IV: ['A'], V: ['A'], VI: ['A'], VII: ['A'], VIII: ['A'], IX: ['A'], X: ['A', 'B'] },
  HI: { I: ['A'], II: ['A'], III: ['A'], IV: ['A'], V: ['A'], VI: ['A'], VII: ['A'], VIII: ['A'], IX: ['A'], X: ['A'] },
};

type StaffDef = { code: string; name: string; nameHi?: string; designation: string; username: string; roles: string[] };
const STAFF: StaffDef[] = [
  { code: 'HM01', name: 'Sunita Deshmukh', nameHi: 'सुनीता देशमुख', designation: 'Head Mistress', username: 'headmaster', roles: ['HEADMASTER'] },
  { code: 'EC01', name: 'Rajesh Kulkarni', nameHi: 'राजेश कुलकर्णी', designation: 'Exam Coordinator', username: 'examcoord', roles: ['EXAM_COORDINATOR'] },
  { code: 'OF01', name: 'Meena Pawar', nameHi: 'मीना पवार', designation: 'Office Clerk', username: 'office', roles: ['OFFICE_STAFF'] },
  { code: 'OP01', name: 'Kiran Jadhav', designation: 'Data Entry Operator', username: 'operator1', roles: ['OPERATOR'] },
  { code: 'OP02', name: 'Farhan Qureshi', designation: 'Data Entry Operator', username: 'operator2', roles: ['OPERATOR'] },
  { code: 'OP03', name: 'Pooja Tiwari', nameHi: 'पूजा तिवारी', designation: 'Data Entry Operator', username: 'operator3', roles: ['OPERATOR'] },
  { code: 'OP04', name: 'Santosh Yadav', nameHi: 'संतोष यादव', designation: 'Data Entry Operator', username: 'operator4', roles: ['OPERATOR'] },
  // English medium pre-primary and primary: one teacher per class teaches all its subjects
  ...[
    ['T01', 'Neha Joshi'], ['T02', 'Priya Nair'], ['T03', 'Asha Fernandes'], ['T04', 'Rekha Shinde'],
    ['T05', 'Kavita Patil'], ['T06', 'Snehal More'], ['T07', 'Anjali Gupta'],
  ].map(([code, name], i) => ({ code, name, designation: 'Teacher', username: `teacher${i + 1}`, roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] })),
  // English medium V–X subject teachers
  { code: 'T08', name: 'Bhupendra Singh', designation: 'Teacher (English)', username: 'bsingh', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER', 'ATTENDANCE_TEACHER'] },
  { code: 'T09', name: 'Shabana Shaikh', designation: 'Teacher (English)', username: 'sshaikh', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T10', name: 'Vaishali Gaikwad', designation: 'Teacher (Marathi)', username: 'vgaikwad', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T11', name: 'Ramesh Mishra', designation: 'Teacher (Hindi)', username: 'rmishra', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T12', name: 'Arvind Iyer', designation: 'Teacher (Mathematics)', username: 'aiyer', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T13', name: 'Deepa Menon', designation: 'Teacher (Mathematics)', username: 'dmenon', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T14', name: 'Sanjay Chavan', designation: 'Teacher (Science)', username: 'schavan', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T15', name: 'Nilofer Ansari', designation: 'Teacher (Science)', username: 'nansari', roles: ['SUBJECT_TEACHER'] },
  { code: 'T16', name: 'Prakash Thorat', designation: 'Teacher (Social Science)', username: 'pthorat', roles: ['SUBJECT_TEACHER'] },
  { code: 'T17', name: 'Geeta Rao', designation: 'Teacher (Art & Work Exp.)', username: 'grao', roles: ['SUBJECT_TEACHER'] },
  { code: 'T18', name: 'Vikram Sawant', designation: 'Teacher (Phy. Edu.)', username: 'vsawant', roles: ['SUBJECT_TEACHER'] },
  // Hindi medium
  ...[
    ['T19', 'Usha Pandey', 'उषा पांडे'], ['T20', 'Manoj Dubey', 'मनोज दुबे'], ['T21', 'Savita Verma', 'सविता वर्मा'], ['T22', 'Kamla Prajapati', 'कमला प्रजापति'],
  ].map(([code, name, nameHi], i) => ({ code, name, nameHi, designation: 'Teacher', username: `hteacher${i + 1}`, roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] })),
  { code: 'T23', name: 'Shailesh Tripathi', nameHi: 'शैलेश त्रिपाठी', designation: 'Teacher (Hindi)', username: 'stripathi', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER', 'ATTENDANCE_TEACHER'] },
  { code: 'T24', name: 'Anita Saxena', nameHi: 'अनीता सक्सेना', designation: 'Teacher (English)', username: 'asaxena', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T25', name: 'Dilip Bhosale', nameHi: 'दिलीप भोसले', designation: 'Teacher (Marathi)', username: 'dbhosale', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T26', name: 'Rakesh Chauhan', nameHi: 'राकेश चौहान', designation: 'Teacher (Mathematics)', username: 'rchauhan', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T27', name: 'Sarita Maurya', nameHi: 'सरिता मौर्य', designation: 'Teacher (Science)', username: 'smaurya', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
  { code: 'T28', name: 'Ajay Rajbhar', nameHi: 'अजय राजभर', designation: 'Teacher (Social Science)', username: 'arajbhar', roles: ['SUBJECT_TEACHER', 'CLASS_TEACHER'] },
];

/** Who teaches what. Key "MEDIUM:subject" → standards → staff code. Pre-primary/primary EN and HI I–IV use the class teacher. */
const SUBJECT_TEACHER: Record<string, string | ((std: string, div: string) => string)> = {
  'EN:ENG': (s, d) => (['IX', 'X'].includes(s) && d === 'A' ? 'T08' : 'T09'),
  'EN:MAR': 'T10',
  'EN:HIN': 'T11',
  'EN:MATH': (s) => (['V', 'VI'].includes(s) ? 'T13' : 'T12'),
  'EN:ALG': 'T12',
  'EN:GEOM': 'T13',
  'EN:SCI': 'T14',
  'EN:SCI1': 'T14',
  'EN:SCI2': 'T15',
  'EN:SOC': 'T16',
  'EN:HISPS': 'T16',
  'EN:GEOG': 'T16',
  'EN:EVS': 'T14',
  'EN:WE': 'T17',
  'EN:ART': 'T17',
  'EN:PE': 'T18',
  'EN:GK': 'T17',
  'EN:STORY': 'T09',
  'EN:WS': 'T14',
  'EN:CDRS': 'T18',
  'HI:HIN': 'T23',
  'HI:ENG': 'T24',
  'HI:MAR': 'T25',
  'HI:MATH': 'T26',
  'HI:ALG': 'T26',
  'HI:GEOM': 'T26',
  'HI:SCI': 'T27',
  'HI:SCI1': 'T27',
  'HI:SCI2': 'T27',
  'HI:SOC': 'T28',
  'HI:HISPS': 'T28',
  'HI:GEOG': 'T28',
  'HI:EVS': 'T27',
  'HI:WE': 'T17',
  'HI:ART': 'T17',
  'HI:PE': 'T18',
  'HI:GK': 'T17',
  'HI:STORY': 'T24',
  'HI:WS': 'T27',
  'HI:CDRS': 'T18',
};
const CLASS_TEACHER: Record<string, string> = {
  'EN-NUR-A': 'T01', 'EN-LKG-A': 'T02', 'EN-UKG-A': 'T03', 'EN-I-A': 'T04', 'EN-II-A': 'T05', 'EN-III-A': 'T06', 'EN-IV-A': 'T07',
  'EN-V-A': 'T13', 'EN-VI-A': 'T11', 'EN-VII-A': 'T10', 'EN-VIII-A': 'T14', 'EN-IX-A': 'T12', 'EN-X-A': 'T08', 'EN-X-B': 'T09',
  'HI-I-A': 'T19', 'HI-II-A': 'T20', 'HI-III-A': 'T21', 'HI-IV-A': 'T22',
  'HI-V-A': 'T25', 'HI-VI-A': 'T24', 'HI-VII-A': 'T28', 'HI-VIII-A': 'T27', 'HI-IX-A': 'T26', 'HI-X-A': 'T23',
};
const PRIMARY_SELF_TAUGHT = ['NUR', 'LKG', 'UKG', 'I', 'II', 'III', 'IV'];
const OPERATOR_FOR = (medium: string, std: string) =>
  medium === 'EN' ? (PRIMARY_SELF_TAUGHT.includes(std) ? 'OP01' : 'OP02') : ['I', 'II', 'III', 'IV', 'V'].includes(std) ? 'OP03' : 'OP04';
/** Attendance verifier on a few divisions (optional stage, shows the role in use). */
const ATTENDANCE_VERIFIER: Record<string, string> = { 'EN-X-A': 'T08', 'EN-X-B': 'T08', 'HI-X-A': 'T23' };

// ---------------------------------------------------------------- run

async function main() {
  console.log(`Loading sample data through ${API}`);
  await signInLoader();

  const existing: J[] = await get('/classes');
  if (existing.length === 0) await loadSetup();
  else console.log('• classes, staff and assignments already exist: keeping them');

  await loadStudents(); // fills only divisions that have no students yet
  // The academic step acts as each demo teacher, so their first-login password change must be skipped first.
  await markDemoLoginsReady(STAFF.map((s) => s.username), false);
  if (!(await get('/exams')).length) await loadAcademicWork();
  else console.log('• exams already exist: keeping marks and attendance as they are');
  if (!(await get('/fees/class-fees')).classes.some((c: J) => c.amount != null)) await loadFees();
  if (!(await get('/expenses?pageSize=1')).meta.total) await loadExpenses();
  if (!(await get('/students/admissions/pending')).length) await loadPendingAdmissions();
  else console.log('• fees already set up: keeping them');

  await markDemoLoginsReady(STAFF.map((s) => s.username));
  console.log('\nSample data ready. Open the web app and sign in, e.g. headmaster / bsingh / operator1 with', DEMO_PASSWORD);
}

async function loadSetup() {
  const year = (await get('/academic-years')).find((y: J) => y.isCurrent);
  const mediums: J[] = await get('/mediums');
  const standards: J[] = await get('/standards');
  const roles: J[] = await get('/roles');
  const medium = (code: string) => mediums.find((m) => m.code === code)!;
  const standard = (code: string) => standards.find((s) => s.code === code)!;
  const role = (code: string) => roles.find((r) => r.code === code)!;

  // 1. School profile + logo
  const school = await get('/school');
  await call('PATCH', '/school', {
    name: school.name, nameHi: 'चिल्ड्रन पब्लिक स्कूल', motto: school.motto, addressLine: school.addressLine, city: school.city,
    state: school.state, pincode: school.pincode, board: school.board, principalTitle: school.principalTitle,
    principalName: 'Sunita Deshmukh (sample)', phone: school.phone, email: school.email, website: school.website,
    udiseCode: school.udiseCode, registrationNo: school.registrationNo,
  });
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path.join(__dirname, 'sample', 'logo.png'))], { type: 'image/png' }), 'logo.png');
  await post('/school/logo', form);
  console.log('✓ school profile and logo');

  // 2. Terms (UT1/UT2/Semester exams come in Phase 3; terms are the two semesters)
  await post(`/academic-years/${year.id}/terms`, { code: 'SEM1', nameEn: 'Semester I', nameHi: 'प्रथम सत्र', startDate: '2026-06-01', endDate: '2026-10-31', sequence: 1 });
  await post(`/academic-years/${year.id}/terms`, { code: 'SEM2', nameEn: 'Semester II', nameHi: 'द्वितीय सत्र', startDate: '2026-11-01', endDate: '2027-04-30', sequence: 2 });
  console.log('✓ terms: Semester I, Semester II');

  // 3. Subjects (both mediums)
  const subjectId = new Map<string, number>(); // "EN:ALG" → id
  for (const m of ['EN', 'HI']) {
    for (const [code, nameEn, nameHi, subjectType, parent] of SUBJECTS) {
      const s = await post('/subjects', {
        mediumId: medium(m).id, code, nameEn, nameHi, subjectType,
        parentSubjectId: parent ? subjectId.get(`${m}:${parent}`) : null,
      });
      subjectId.set(`${m}:${code}`, s.id);
    }
  }
  console.log(`✓ ${subjectId.size} subjects and papers`);

  // 4. Staff
  const staffId = new Map<string, number>();
  for (const [i, s] of STAFF.entries()) {
    const st = await post('/staff', {
      employeeCode: s.code, name: s.name, nameHi: s.nameHi ?? null, designation: s.designation,
      mobile: `98200${String(10001 + i).padStart(5, '0')}`, joiningDate: `20${String(10 + (i % 14)).padStart(2, '0')}-06-01`,
      employmentType: s.designation.startsWith('Data Entry') ? 'CONTRACT' : 'PERMANENT',
      gender: /a$|i$/i.test(s.name.split(' ')[0]) ? 'FEMALE' : 'MALE', dob: `19${70 + (i % 25)}-0${1 + (i % 9)}-1${i % 9}`,
      addressLine: `Flat ${101 + i}, Goregaon (W), Mumbai`,
      employeeType: /Teacher|Head|Coordinator/.test(s.designation) ? 'TEACHING' : 'NON_TEACHING',
      department: /Head|Coordinator/.test(s.designation) ? 'Administration' : /Office|Data Entry/.test(s.designation) ? 'Administration' : i % 2 ? 'Secondary' : 'Primary',
      qualification: /Teacher/.test(s.designation) ? (i % 3 ? 'B.A., B.Ed.' : 'M.Sc., B.Ed.') : /Head/.test(s.designation) ? 'M.A., M.Ed.' : 'B.Com.',
      monthlySalary: /Head/.test(s.designation) ? 65000 : /Coordinator/.test(s.designation) ? 45000 : /Teacher/.test(s.designation) ? 32000 + (i % 5) * 2000 : /Office/.test(s.designation) ? 22000 : 15000,
      salaryMode: 'BANK_TRANSFER', bankName: 'State Bank of India', bankAccountNo: `3021${String(4500000 + i * 137).padStart(8, '0')}`, bankIfsc: 'SBIN0001234', bankAccountHolder: s.name,
    });
    staffId.set(s.code, st.id);
  }
  console.log(`✓ ${staffId.size} staff`);

  // 5. Classes, divisions, class subjects, assignments
  let assignments = 0;
  const assign = async (body: J) => {
    assignments++;
    return post('/assignments', { academicYearId: year.id, validFrom: YEAR_START, ...body });
  };
  let replaceTarget: J | undefined;
  for (const [m, stds] of Object.entries(CLASSES)) {
    for (const [stdCode, divisions] of Object.entries(stds)) {
      const cls = await post('/classes', { academicYearId: year.id, mediumId: medium(m).id, standardId: standard(stdCode).id });
      const curriculum = CURRICULUM.find((c) => c.standards.includes(stdCode))!.subjects;
      const classSubjects: J[] = await call('PUT', `/classes/${cls.id}/subjects`, {
        items: curriculum.map((code, i) => ({
          subjectId: subjectId.get(`${m}:${code}`), defaultMaxMarks: 100, defaultPassMarks: 35, displayOrder: i + 1,
          includeInTotal: !(['IX', 'X'].includes(stdCode) && ['WS', 'CDRS', 'PE'].includes(code)),
        })),
      });
      for (const div of divisions) {
        const sec = await post(`/classes/${cls.id}/sections`, { name: div, capacity: 60, room: `${m === 'EN' ? 'E' : 'H'}-${stdCode}${div}` });
        const key = `${m}-${stdCode}-${div}`;
        const ct = CLASS_TEACHER[key];
        await assign({ staffId: staffId.get(ct), role: 'CLASS_TEACHER', sectionId: sec.id });
        await assign({ staffId: staffId.get(OPERATOR_FOR(m, stdCode)), role: 'OPERATOR', sectionId: sec.id });
        if (ATTENDANCE_VERIFIER[key]) await assign({ staffId: staffId.get(ATTENDANCE_VERIFIER[key]), role: 'ATTENDANCE_VERIFIER', sectionId: sec.id });
        for (const cs of classSubjects) {
          const code = cs.subject.code as string;
          const selfTaught = PRIMARY_SELF_TAUGHT.includes(stdCode) && !['ART', 'WE', 'PE'].includes(code);
          const rule = SUBJECT_TEACHER[`${m}:${code}`];
          const teacher = selfTaught ? ct : typeof rule === 'function' ? rule(stdCode, div) : rule;
          if (!teacher || !staffId.has(teacher)) throw new Error(`No teacher set for ${m}:${code} in ${key}`);
          const a = await assign({ staffId: staffId.get(teacher), role: 'SUBJECT_TEACHER', sectionId: sec.id, classSubjectId: cs.id });
          if (key === 'EN-IX-A' && code === 'ENG') replaceTarget = a;
        }
      }
    }
  }
  console.log(`✓ ${Object.values(CLASSES).reduce((n, s) => n + Object.keys(s).length, 0)} classes, ${assignments} assignments`);

  // A mid-year change, so Assignment History has something to show.
  if (replaceTarget) {
    await post(`/assignments/${replaceTarget.id}/replace`, { staffId: staffId.get('T09'), reason: 'Sample: timetable change after Semester I' });
    console.log('✓ one replacement recorded (EN IX-A English: B. Singh → S. Shaikh)');
  }

  // 6. Logins for every staff member. Role scope: management roles see the whole school,
  //    teachers and operators see only the divisions/subjects they are assigned to.
  for (const s of STAFF) {
    await post('/users', {
      username: s.username, staffId: staffId.get(s.code), temporaryPassword: DEMO_PASSWORD,
      roles: s.roles.map((r) => ({ roleId: role(r).id, scopeType: role(r).defaultScope })),
    });
  }
  console.log(`✓ ${STAFF.length} logins (password for all: ${DEMO_PASSWORD})`);
}

// ---------------------------------------------------------------- sample students (all names are made up)

/** Small deterministic random generator so every run produces the same sample school. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Pair = [string, string]; // [English, Hindi]
const SURNAMES: Pair[] = [
  ['SHARMA', 'शर्मा'], ['YADAV', 'यादव'], ['GUPTA', 'गुप्ता'], ['SINGH', 'सिंह'], ['MISHRA', 'मिश्रा'], ['PATIL', 'पाटिल'],
  ['JADHAV', 'जाधव'], ['SHAIKH', 'शेख'], ['ANSARI', 'अंसारी'], ['VERMA', 'वर्मा'], ['PANDEY', 'पांडे'], ['TIWARI', 'तिवारी'],
  ['MAURYA', 'मौर्य'], ['PRAJAPATI', 'प्रजापति'], ['GAUD', 'गौड़'], ['KHAN', 'खान'], ['CHAUHAN', 'चौहान'], ['MORE', 'मोरे'],
  ['PAWAR', 'पवार'], ['DUBEY', 'दुबे'], ['SAROJ', 'सरोज'], ['KADAM', 'कदम'], ['RAJBHAR', 'राजभर'], ['VISHWAKARMA', 'विश्वकर्मा'],
];
const BOYS: Pair[] = [
  ['AARAV', 'आरव'], ['VIHAAN', 'विहान'], ['ARJUN', 'अर्जुन'], ['AYAAN', 'अयान'], ['KRISHNA', 'कृष्णा'], ['ROHAN', 'रोहन'],
  ['SAHIL', 'साहिल'], ['ADITYA', 'आदित्य'], ['ANKIT', 'अंकित'], ['HARSH', 'हर्ष'], ['PRINCE', 'प्रिंस'], ['RAYAN', 'रेयान'],
  ['SHIVAM', 'शिवम'], ['YASH', 'यश'], ['OM', 'ओम'], ['ZAID', 'ज़ैद'], ['RITIK', 'रितिक'], ['DEV', 'देव'], ['SURAJ', 'सूरज'], ['AMAN', 'अमन'],
];
const GIRLS: Pair[] = [
  ['ANANYA', 'अनन्या'], ['DIYA', 'दिया'], ['SAANVI', 'सान्वी'], ['PRIYA', 'प्रिया'], ['KAJAL', 'काजल'], ['SNEHA', 'स्नेहा'],
  ['AYESHA', 'आयशा'], ['KHUSHI', 'खुशी'], ['NEHA', 'नेहा'], ['POOJA', 'पूजा'], ['RIYA', 'रिया'], ['SIMRAN', 'सिमरन'],
  ['TANVI', 'तन्वी'], ['ZOYA', 'ज़ोया'], ['ANJALI', 'अंजलि'], ['SAKSHI', 'साक्षी'], ['MUSKAN', 'मुस्कान'], ['ARADHYA', 'आराध्या'], ['NIDHI', 'निधि'], ['SONAL', 'सोनल'],
];
const FATHERS: Pair[] = [
  ['RAJESH', 'राजेश'], ['SURESH', 'सुरेश'], ['RAMESH', 'रमेश'], ['ANIL', 'अनिल'], ['SANJAY', 'संजय'], ['MOHAMMED', 'मोहम्मद'],
  ['VIJAY', 'विजय'], ['DINESH', 'दिनेश'], ['ASHOK', 'अशोक'], ['IRFAN', 'इरफ़ान'], ['MANOJ', 'मनोज'], ['SANTOSH', 'संतोष'],
  ['PRAKASH', 'प्रकाश'], ['RAJU', 'राजू'], ['SUNIL', 'सुनील'], ['ARVIND', 'अरविंद'],
];
const MOTHERS: Pair[] = [
  ['SUNITA', 'सुनीता'], ['REKHA', 'रेखा'], ['ANITA', 'अनीता'], ['POONAM', 'पूनम'], ['SHABNAM', 'शबनम'], ['MEENA', 'मीना'],
  ['KAVITA', 'कविता'], ['RUKSANA', 'रुखसाना'], ['SANGEETA', 'संगीता'], ['USHA', 'उषा'], ['MAMTA', 'ममता'], ['SEEMA', 'सीमा'],
  ['ASHA', 'आशा'], ['NITU', 'नीतू'], ['GEETA', 'गीता'], ['REENA', 'रीना'],
];
const OCCUPATIONS = ['Driver', 'Shopkeeper', 'Tailor', 'Electrician', 'Private job', 'Carpenter', 'Plumber', 'Auto rickshaw', 'Mechanic', 'Business', 'Painter', 'Security guard'];
const LANES = ['Bhagat Singh Nagar No. 2', 'Rajaram Galli', 'Motilal Nagar', 'Jawahar Nagar', 'Teen Dongri', 'Bangur Nagar', 'Piramal Nagar', 'Unnat Nagar'];
const MUSLIM_SURNAMES = new Set(['SHAIKH', 'ANSARI', 'KHAN']);
const MUSLIM_NAMES = new Set(['AYAAN', 'RAYAN', 'ZAID', 'AYESHA', 'ZOYA', 'MUSKAN', 'MOHAMMED', 'IRFAN', 'SHABNAM', 'RUKSANA']);

async function loadStudents() {
  const classes: J[] = await get('/classes');
  // The Headmaster enters GR numbers; the sample register continues the school's numbers in the 1000s.
  let nextGr = 1101;
  const rand = rng(2026);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const mobile = () => `${pick(['9', '8', '7'])}${String(Math.floor(rand() * 1e9)).padStart(9, '0')}`;
  const sameCulture = (p: Pair, muslim: boolean) => MUSLIM_NAMES.has(p[0]) === muslim;
  let total = 0;
  let toTransfer: J | undefined;
  for (const cls of classes) {
    const level = cls.standard.levelOrder as number;
    const hindi = cls.medium.code === 'HI';
    for (const sec of cls.sections) {
      const n = (level <= 0 ? 16 : 20) + Math.floor(rand() * 10);
      const already = (await get(`/students?sectionId=${sec.id}&pageSize=1&status=ALL`)).meta.total;
      if (already > 0) {
        total += already;
        await post(`/sections/${sec.id}/renumber`); // a resumed run may have stopped half-way through this division
        continue;
      }
      for (let i = 0; i < n; i++) {
        const girl = rand() < 0.48;
        const sur = pick(SURNAMES);
        const muslim = MUSLIM_SURNAMES.has(sur[0]);
        const first = pick((girl ? GIRLS : BOYS).filter((p) => sameCulture(p, muslim)));
        const father = pick(FATHERS.filter((p) => sameCulture(p, muslim)));
        const mother = pick(MOTHERS.filter((p) => sameCulture(p, muslim)));
        const birthYear = 2020 - level;
        const dob = `${birthYear}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`;
        const joinedYear = Math.max(2026 - Math.floor(rand() * (Math.max(level, 0) + 3)), birthYear + 3);
        const created = await post('/students', {
          student: {
            fullName: `${sur[0]} ${first[0]} ${father[0]} ${mother[0]}`, grNo: `SE-${nextGr++}`,
            fullNameHi: hindi ? `${sur[1]} ${first[1]} ${father[1]} ${mother[1]}` : null,
            surname: sur[0], firstName: first[0], fatherName: father[0], motherName: mother[0],
            gender: girl ? 'FEMALE' : 'MALE', dob,
            birthPlace: rand() < 0.7 ? 'Mumbai' : pick(['Varanasi', 'Jaunpur', 'Azamgarh', 'Pune', 'Gorakhpur', 'Patna']),
            motherTongue: hindi ? 'Hindi' : pick(['Hindi', 'Marathi', 'Urdu', 'Hindi', 'Gujarati']),
            bloodGroup: rand() < 0.6 ? pick(['A+', 'B+', 'O+', 'AB+', 'O-', 'B-']) : null,
            religion: muslim ? 'Muslim' : rand() < 0.08 ? pick(['Buddhist', 'Christian']) : 'Hindu',
            category: rand() < 0.75 ? pick(['OPEN', 'OBC', 'OBC', 'SC', 'ST', 'NT-B', 'SBC']) : null,
            addressLine: `Room ${1 + Math.floor(rand() * 60)}, ${pick(LANES)}, Goregaon (West)`, city: 'Mumbai', pincode: '400104',
            admissionDate: `${joinedYear}-06-${String(10 + Math.floor(rand() * 15)).padStart(2, '0')}`,
            previousSchool: joinedYear === 2026 && level > 0 ? pick(['BMC School, Goregaon', 'Saraswati Vidyalaya', 'Village school (U.P.)']) : null,
            guardians: [
              { relation: 'FATHER', name: `${father[0]} ${sur[0]}`, nameHi: hindi ? `${father[1]} ${sur[1]}` : null, mobile: mobile(), occupation: pick(OCCUPATIONS), isPrimary: true },
              { relation: 'MOTHER', name: `${mother[0]} ${sur[0]}`, nameHi: hindi ? `${mother[1]} ${sur[1]}` : null, mobile: rand() < 0.7 ? mobile() : null, occupation: rand() < 0.7 ? 'Homemaker' : pick(OCCUPATIONS), isPrimary: false },
            ],
          },
          enrollment: { sectionId: sec.id, joinedOn: YEAR_START },
        });
        total++;
        if (cls.code === 'EN-IX' && !toTransfer) toTransfer = created;
      }
      await post(`/sections/${sec.id}/renumber`); // roll numbers in alphabetical order, as the school does
      process.stdout.write(`\r✓ students: ${total}`);
    }
  }
  console.log(` in ${classes.reduce((n, c) => n + c.sections.length, 0)} divisions (roll numbers arranged alphabetically)`);

  // One student who left mid-year, so status history has an example.
  if (toTransfer) {
    await post(`/students/${toTransfer.id}/status`, { status: 'TRANSFERRED', effectiveDate: '2026-10-05', reason: 'Sample: family moved to Pune, TC issued' });
    console.log(`✓ one transferred student (${toTransfer.fullName}, ENGLISH-IX)`);
  }
}

const LOADER = 'sample-loader';

/**
 * Creates a temporary Super Admin login used only by this script, so your own admin password is never
 * needed or changed. It is disabled again at the end (it stays visible in Users and the audit log, which
 * shows exactly what the loader created).
 */
async function signInLoader() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set in apps/api/.env');
  const password = `Loader-${randomBytes(9).toString('base64url')}1`;
  const prisma = new PrismaClient({ adapter: adapterFromUrl(url) });
  try {
    const school = await prisma.school.findFirstOrThrow({ where: { code: process.env.SCHOOL_CODE ?? 'CPS' } });
    const superRole = await prisma.role.findUniqueOrThrow({ where: { schoolId_code: { schoolId: school.id, code: 'SUPER_ADMIN' } } });
    const passwordHash = await hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
    const existing = await prisma.user.findFirst({ where: { schoolId: school.id, username: LOADER } });
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE', mustChangePassword: false } });
    } else {
      await prisma.user.create({
        data: { schoolId: school.id, username: LOADER, passwordHash, mustChangePassword: false, roles: { create: { roleId: superRole.id, scopeType: 'SCHOOL' } } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: LOADER, password }) });
  if (r.status === 429) throw new Error('Too many sign-in attempts. Wait one minute and run again.');
  if (!r.ok) throw new Error(`Could not sign in the sample loader (${r.status}). Is the API running on ${API}?`);
  token = (await r.json()).accessToken;
}

/** Demo only: skip the first-login password change so roles can be switched quickly. */
async function markDemoLoginsReady(usernames: string[], disableLoader = true) {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const prisma = new PrismaClient({ adapter: adapterFromUrl(url) });
  try {
    await prisma.user.updateMany({ where: { username: { in: usernames } }, data: { mustChangePassword: false } });
    if (disableLoader) await prisma.user.updateMany({ where: { username: LOADER }, data: { status: 'DISABLED' } });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('\n✗', e.message ?? e);
  process.exit(1);
});

// ---------------------------------------------------------------- sample exams, marks, attendance and approvals

/**
 * Every step is done through the API by the person whose job it is (operator → subject teacher → class teacher
 * → Headmaster), so the workflow rules are applied exactly as in real use. To avoid the sign-in limit, the script
 * signs short-lived tokens for the demo users with the API's own secret (local demo only).
 */
async function loadAcademicWork() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set in apps/api/.env');
  const year = (await get('/academic-years')).find((y: J) => y.isCurrent);
  const users: J[] = (await get('/users?pageSize=100')).data;
  const me = await get('/me');
  const tokenFor = new Map<number, string>(); // staffId → token
  for (const u of users) if (u.staffId && u.status === 'ACTIVE') tokenFor.set(u.staffId, jwt.sign({ sub: String(u.id), sch: String(me.school.id) }, secret, { algorithm: 'HS256', expiresIn: '2h' }));
  const hmUser = users.find((u) => u.username === 'headmaster');
  const as = (staffId: number) => {
    const t = tokenFor.get(staffId);
    if (!t) throw new Error(`No login for staff ${staffId}`);
    return { get: (u: string) => callAs(t, 'GET', u), put: (u: string, b: unknown) => callAs(t, 'PUT', u, b), post: (u: string, b?: unknown) => callAs(t, 'POST', u, b ?? {}) };
  };
  const hm = as(hmUser.staffId);

  // Who does what in each division (current assignments).
  const assignments: J[] = await get(`/assignments?academicYearId=${year.id}`);
  const by = (role: string, sectionId: number, cs?: number) => assignments.find((a) => a.role === role && a.sectionId === sectionId && (cs === undefined || a.classSubjectId === cs))?.staffId as number | undefined;

  const exams = [
    { code: 'SEM1', nameEn: 'Semester I', kind: 'SEMESTER', reportTerm: 'TERM1', sequence: 1, marksDueDate: '2026-10-25' },
    { code: 'SEM2', nameEn: 'Semester II', kind: 'SEMESTER', reportTerm: 'TERM2', sequence: 2, marksDueDate: '2027-04-10' },
  ];
  const created: Record<string, J> = {};
  for (const e of exams) created[e.code] = await post('/exams', e);
  console.log('✓ exams: Semester I (FE-I + SE-I) and Semester II (FE-II + SE-II), with the Greensheet mark pattern of every class');

  const classes: J[] = await get('/classes');
  const rand = rng(77);
  const ability = new Map<number, number>(); // enrollmentId → 0..1
  const skill = (id: number) => {
    if (!ability.has(id)) ability.set(id, Math.min(0.97, Math.max(0.22, 0.66 + (rand() + rand() + rand() - 1.5) * 0.32)));
    return ability.get(id)!;
  };
  const score = (id: number, max: number) => Math.max(0, Math.min(max, Math.round(max * Math.min(1, Math.max(0, skill(id) + (rand() - 0.5) * 0.25)))));

  type Plan = 'APPROVED' | 'HEADMASTER' | 'CLASS' | 'SUBJECT' | 'CORRECTION' | 'DRAFT' | 'NONE';
  /** Moves one sheet to the planned stage, each step by the right person. */
  async function run(unit: J, rowsFor: (rows: J[]) => J[], plan: Plan, people: { operator?: number; first?: number; ct?: number }, extra: J = {}) {
    if (plan === 'NONE' || !people.operator) return 'NONE';
    const op = as(people.operator);
    const q = `/sheets?${new URLSearchParams(Object.entries(unit).map(([k, v]) => [k, String(v)])).toString()}`;
    const view = await op.get(q);
    await op.put('/sheets', { unit, rows: rowsFor(view.rows), ...extra });
    if (plan === 'DRAFT') return plan;
    const sub = (await op.get(q)).submission;
    await op.post(`/submissions/${sub.id}/submit`);
    if (plan === 'SUBJECT' || !people.first) return plan;
    if (plan === 'CORRECTION') {
      const rows = (await op.get(q)).rows;
      const pick = rows.slice(0, 2).map((r: J) => r.enrollmentId);
      await as(people.first).post(`/submissions/${sub.id}/reject`, { reason: 'Sample: please re-check these marks against the answer sheets', enrollmentIds: pick });
      return plan;
    }
    await as(people.first).post(`/submissions/${sub.id}/verify`);
    const after = (await op.get(q)).submission;
    if (plan === 'CLASS') return plan;
    if (after.stage === 'CLASS_APPROVE') {
      if (!people.ct) return 'CLASS';
      await as(people.ct).post(`/submissions/${sub.id}/verify`);
    }
    if (plan === 'HEADMASTER') return plan;
    await hm.post(`/submissions/${sub.id}/verify`);
    return 'APPROVED';
  }

  // Attendance: June–October. Working days per month (school re-opened 15 June; Diwali break in October).
  const working: Record<string, number> = { '2026-06': 14, '2026-07': 25, '2026-08': 23, '2026-09': 22, '2026-10': 19 };
  const attendancePlan = (i: number, m: string): Plan => (m !== '2026-10' ? 'APPROVED' : (['APPROVED', 'APPROVED', 'APPROVED', 'HEADMASTER', 'CLASS', 'SUBJECT', 'DRAFT'] as Plan[])[i % 7]);
  let n = 0;
  for (const cls of classes) {
    for (const sec of cls.sections) {
      const op = by('OPERATOR', sec.id);
      const ct = by('CLASS_TEACHER', sec.id);
      const av = by('ATTENDANCE_VERIFIER', sec.id) ?? ct;
      const idx = n++;
      const readyForCards = (cls.code === 'EN-X' && sec.name === 'A') || cls.code === 'HI-X';
      for (const m of Object.keys(working)) {
        const wd = working[m];
        await run({ recordType: 'ATTENDANCE', sectionId: sec.id, period: m },
          (rows) => rows.map((r: J) => ({ enrollmentId: r.enrollmentId, presentDays: Math.max(0, wd - Math.floor((1 - skill(r.enrollmentId)) * rand() * (skill(r.enrollmentId) < 0.35 ? 10 : 4))) })),
          readyForCards ? 'APPROVED' : attendancePlan(idx, m), { operator: op, first: av, ct }, { workingDays: wd });
      }
      process.stdout.write(`\r✓ attendance Jun–Oct: ${n} divisions`);
    }
  }
  console.log(' (October still moving through the approvals in some divisions)');

  // Marks, part by part (OBS, Oral, … Written, Oral). Semester I: ENGLISH-X A and HINDI-X A fully approved (report
  // cards can be generated there); the rest spread over every stage, including a few sent back for correction.
  // Semester II is entered for ENGLISH-I A, ENGLISH-X A and HINDI-X A so their Greensheet shows a whole year.
  const partsFor = (id: number, pattern: J[]) => Object.fromEntries(pattern.map((p: J) => [p.key, score(id, Number(p.max))]));
  const semPlans: Plan[] = ['APPROVED', 'APPROVED', 'HEADMASTER', 'CLASS', 'SUBJECT', 'CORRECTION', 'DRAFT', 'APPROVED', 'NONE'];
  let sheets = 0;
  n = 0;
  for (const cls of classes) {
    for (const sec of cls.sections) {
      const op = by('OPERATOR', sec.id);
      const ct = by('CLASS_TEACHER', sec.id);
      const fullyApproved = (cls.code === 'EN-X' && sec.name === 'A') || cls.code === 'HI-X';
      const divIdx = n++;
      const wholeYear = fullyApproved || (cls.code === 'EN-I' && sec.name === 'A');
      for (const ex of wholeYear ? ['SEM1', 'SEM2'] : ['SEM1']) {
        const subjects: J[] = await get(`/exams/${created[ex].id}/subjects?classId=${cls.id}`);
        for (const [k, es] of subjects.entries()) {
          const plan: Plan = fullyApproved ? 'APPROVED' : ex === 'SEM2' ? 'DRAFT' : semPlans[(divIdx + k) % semPlans.length];
          await run({ recordType: 'MARKS', examId: created[ex].id, sectionId: sec.id, classSubjectId: es.classSubjectId },
            (rows) => rows.map((r: J) => (rand() < 0.01 && !fullyApproved
              ? { enrollmentId: r.enrollmentId, absent: true }
              : { enrollmentId: r.enrollmentId, parts: partsFor(r.enrollmentId, es.parts) })),
            plan, { operator: op, first: by('SUBJECT_TEACHER', sec.id, es.classSubjectId), ct });
          sheets++;
        }
      }
      process.stdout.write(`\r✓ marks: ${sheets} subject sheets (Semester I; Semester II in three divisions)`);
    }
  }
  console.log('');

  // Semester I report cards for ENGLISH-X A (generated by its operator, not yet published by the Headmaster).
  const xa = classes.find((c) => c.code === 'EN-X')?.sections.find((s: J) => s.name === 'A');
  if (xa) {
    const ct = by('CLASS_TEACHER', xa.id)!;
    const list = await as(ct).get(`/report-cards/division/${xa.id}?term=TERM1`);
    const words = ['VERY GOOD', 'GOOD', 'SATISFACTORY', 'GOOD', 'EXCELLENT'];
    await as(ct).put(`/report-cards/division/${xa.id}/remarks`, {
      term: 'TERM1', items: list.students.map((s: J, i: number) => ({ enrollmentId: s.enrollmentId, progress: words[i % 5], conduct: i % 4 ? 'GOOD' : 'VERY GOOD', remark: i % 3 ? 'Regular and attentive in class.' : 'Should practise mathematics every day.' })),
    });
    const r = await as(by('OPERATOR', xa.id)!).post(`/report-cards/division/${xa.id}/generate`, { term: 'TERM1' });
    console.log(`✓ Semester I report cards generated for ENGLISH-X A (${r.generated}); HINDI-X A is approved and ready to generate`);
  }
}

// ---------------------------------------------------------------- sample fees (made-up amounts)

/** Tuition every month, exam fee each semester, computer and development fee once a year; part payments as in real life. */
async function loadFees() {
  const secret = process.env.JWT_ACCESS_SECRET!;
  const users: J[] = (await get('/users?pageSize=100')).data;
  const me = await get('/me');
  const mint = (username: string) => {
    const u = users.find((x) => x.username === username);
    const t = jwt.sign({ sub: String(u.id), sch: String(me.school.id) }, secret, { algorithm: 'HS256', expiresIn: '2h' });
    return { post: (url: string, b?: unknown) => callAs(t, 'POST', url, b ?? {}), patch: (url: string, b: unknown) => callAs(t, 'PATCH', url, b), get: (url: string) => callAs(t, 'GET', url) };
  };
  const clerk = mint('office');
  const hm = mint('headmaster');
  const year = (await get('/academic-years')).find((y: J) => y.isCurrent);

  // One consolidated annual fee per class (no fee categories).
  const classes: J[] = await get('/classes');
  for (const c of classes) {
    const lvl = c.standard.levelOrder as number;
    const amount = lvl <= 0 ? 6000 : lvl <= 4 ? 7500 : lvl <= 8 ? 9000 : 11000;
    await call('PUT', `/fees/class-fees/${c.id}`, { amount });
  }
  console.log(`✓ annual fee set for ${classes.length} classes (₹6,000 Nursery … ₹11,000 Std IX–X); every student's ledger updated`);

  const register: J[] = [];
  for (let p = 1; ; p++) {
    const r = await get(`/fees/register?pageSize=200&page=${p}`);
    register.push(...r.data);
    if (register.length >= r.meta.total) break;
  }
  const rand = rng(91);
  // The school moves to the ERP mid-year: some families still owe money from last year's paper register.
  let openings = 0;
  for (const [i, s] of register.entries()) {
    if (i % 7 !== 3 || s.isRte) continue;
    const a = await clerk.get(`/fees/students/${s.studentId}`);
    await hm.patch(`/fees/ledgers/${a.ledgerId}/opening`, { amount: [1500, 2250, 3000, 4500][i % 4], reason: 'Unpaid balance from the 2025-26 fee register' });
    openings++;
  }
  console.log(`✓ previous year outstanding entered for ${openings} students (from last year's register)`);

  // Payments June → today: many pay in parts; previous-year dues are cleared first.
  const y0 = Number(year.name.slice(0, 4));
  const today = new Date().toISOString().slice(0, 10);
  const dates = ['06-18', '07-12', '08-09', '09-14', '10-11', '11-05', '11-10'].map((d) => `${y0}-${d}`).filter((d) => d <= today);
  let receipts = 0;
  let amountTotal = 0;
  let manualNo = 0;
  for (const [i, s] of register.entries()) {
    if (i % 37 === 5 && !s.isRte) {
      const a = await clerk.get(`/fees/students/${s.studentId}`);
      await hm.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: Math.round(a.ledger.currentYearFee * 0.25), reason: 'Sibling studying in the school (25 %)' });
    }
    const a = await clerk.get(`/fees/students/${s.studentId}`);
    let balance = a.ledger.balance as number;
    if (balance <= 0) continue;
    const kind = rand();
    for (const [k, date] of dates.entries()) {
      // Roughly what a family that "keeps up" would have paid by this date (11 school months).
      const share = Math.min(1, (k + 1) / 6);
      const target = a.ledger.previousOutstanding + a.ledger.currentYearNet * share;
      const paidSoFar = a.ledger.totalPayable - balance;
      let pay = 0;
      if (kind < 0.5) pay = target - paidSoFar; // keeps up
      else if (kind < 0.82) pay = rand() < 0.6 ? Math.round(((target - paidSoFar) * (0.4 + rand() * 0.5)) / 50) * 50 : 0; // part payments
      else if (kind < 0.93) pay = k === 0 ? 2000 : 0; // paid once at the start
      pay = Math.round(Math.min(pay, balance));
      if (pay < 50) continue;
      const mode = rand() < 0.55 ? 'CASH' : rand() < 0.8 ? 'UPI' : 'CHEQUE';
      await clerk.post('/fees/payments', {
        enrollmentId: s.enrollmentId, paidOn: date, amount: pay, mode,
        reference: mode === 'UPI' ? `UTR${Math.floor(1e11 + rand() * 9e11)}` : mode === 'CHEQUE' ? String(100000 + Math.floor(rand() * 899999)) : null,
        payerName: s.contact?.name ?? null,
        // Entered from the paper receipt book: the book's number is kept next to the system receipt number.
        manualReceiptNo: date < todayIn('Asia/Kolkata') ? `RB-${String(++manualNo).padStart(5, '0')}` : null,
      });
      balance -= pay;
      receipts++;
      amountTotal += pay;
    }
    if (i % 25 === 0) process.stdout.write(`\r✓ fee receipts: ${receipts}`);
  }
  console.log(`\r✓ fee receipts: ${receipts} (₹${amountTotal.toLocaleString('en-IN')}), mostly cash and UPI, many part payments`);
  // One bounced cheque, cancelled by the Headmaster with a reason.
  const cheque = (await clerk.get('/fees/payments?mode=CHEQUE&pageSize=1')).data[0];
  if (cheque) {
    await hm.post(`/fees/payments/${cheque.id}/cancel`, { reason: 'Sample: cheque returned by the bank (insufficient funds)' });
    console.log(`✓ one cancelled receipt (${cheque.receiptNo}, cheque bounced): the balance came back`);
  }
}

// ---------------------------------------------------------------- sample expenses and vouchers

/** A few months of school expenses entered by the office, approved (or rejected) by the Headmaster, and salaries. */
async function loadExpenses() {
  const secret = process.env.JWT_ACCESS_SECRET!;
  const users: J[] = (await get('/users?pageSize=100')).data;
  const me = await get('/me');
  const mint = (username: string) => {
    const u = users.find((x) => x.username === username);
    const t = jwt.sign({ sub: String(u.id), sch: String(me.school.id) }, secret, { algorithm: 'HS256', expiresIn: '2h' });
    return { post: (url: string, b?: unknown) => callAs(t, 'POST', url, b ?? {}), get: (url: string) => callAs(t, 'GET', url) };
  };
  const clerk = mint('office');
  const hm = mint('headmaster');
  const cats: J[] = await hm.get('/expense-categories');
  const cat = (code: string) => cats.find((c) => c.code === code).id;
  const year = (await get('/academic-years')).find((y: J) => y.isCurrent);
  const y0 = Number(year.name.slice(0, 4));
  const today = todayIn('Asia/Kolkata');
  const months = [6, 7, 8, 9, 10].filter((m) => `${y0}-${String(m).padStart(2, '0')}-28` <= today);
  const rand = rng(17);
  let n = 0;
  let approved = 0;
  for (const m of months) {
    const d = (day: number) => `${y0}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entries = [
      { categoryId: cat('ELECTRICITY'), title: `Electricity bill ${m}/${y0}`, description: 'Monthly electricity bill for the school building', paidTo: 'Adani Electricity Mumbai Ltd', amount: 7800 + Math.round(rand() * 2400), mode: 'UPI', reference: `UTR${Math.floor(1e11 + rand() * 9e11)}`, billNo: `AEML/${m}/${1000 + m}`, expenseDate: d(12) },
      { categoryId: cat('WATER'), title: `Water bill ${m}/${y0}`, description: 'BMC water charges', paidTo: 'Brihanmumbai Municipal Corporation', amount: 1450, mode: 'CASH', expenseDate: d(14) },
      { categoryId: cat('INTERNET_PHONE'), title: 'Broadband and landline', description: 'Office internet and telephone', paidTo: 'Airtel', amount: 1999, mode: 'UPI', reference: `UTR${Math.floor(1e11 + rand() * 9e11)}`, expenseDate: d(5) },
      { categoryId: cat('STATIONERY'), title: 'Chalk, registers and printer paper', description: 'Monthly stationery for classrooms and office', paidTo: 'Shree Stationers', amount: 2200 + Math.round(rand() * 1800), mode: 'CASH', billNo: `SS-${300 + m}`, expenseDate: d(8) },
      { categoryId: cat('CLEANING'), title: 'Cleaning material', description: 'Phenyl, brooms, soap', paidTo: 'Gupta Traders', amount: 1200 + Math.round(rand() * 600), mode: 'CASH', expenseDate: d(10) },
      ...(m === 8 ? [{ categoryId: cat('EVENTS'), title: 'Independence Day function', description: 'Flag, sweets, decoration and sound system', paidTo: 'Various vendors', amount: 9500, mode: 'CASH', expenseDate: d(16) }] : []),
      ...(m === 7 ? [{ categoryId: cat('MAINTENANCE'), title: 'Monsoon roof repair', description: 'Waterproofing of the terrace above Std IX', paidTo: 'Sai Construction', amount: 18500, mode: 'CHEQUE', reference: '000231', billNo: 'SC/2026/44', expenseDate: d(20) }] : []),
    ];
    for (const e of entries) {
      const v = await clerk.post('/expenses', e);
      n++;
      if (m === months[months.length - 1] && n % 3 === 0) continue; // the latest month: some still waiting for approval
      if (n === 4) { await hm.post(`/expenses/${v.id}/reject`, { reason: 'Bill amount does not match the invoice; please re-enter' }); continue; }
      await hm.post(`/expenses/${v.id}/approve`);
      approved++;
    }
  }
  // Salaries for the staff with a monthly salary (paid by the Headmaster's office), the last month only partly.
  const staff: J[] = (await hm.get('/staff?status=ACTIVE&pageSize=100')).data.filter((s: J) => s.monthlySalary);
  let salaries = 0;
  for (const m of months) {
    for (const s of staff) {
      const last = m === months[months.length - 1];
      const amount = last && salaries % 4 === 0 ? Math.round(s.monthlySalary / 2) : s.monthlySalary;
      const v = await hm.post('/expenses', {
        categoryId: cat('STAFF_SALARY'), title: `Salary ${m}/${y0}`, description: `Salary for ${s.name}`, paidTo: s.name, amount, mode: 'BANK_TRANSFER',
        reference: `NEFT${y0}${String(m).padStart(2, '0')}${String(s.id).padStart(4, '0')}`, expenseDate: `${y0}-${String(m + 1 > 12 ? 12 : m + 1).padStart(2, '0')}-01` <= today ? `${y0}-${String(m + 1).padStart(2, '0')}-01` : today,
        staffId: s.id, salaryMonth: m, salaryYear: y0,
      });
      if (!last) await hm.post(`/expenses/${v.id}/approve`);
      salaries++;
    }
  }
  console.log(`✓ expenses: ${n} vouchers entered by the office (${approved} approved, 1 rejected, some pending), ${salaries} salary vouchers`);
}

/** A few admissions entered by the office this week, waiting for the Headmaster's approval. */
async function loadPendingAdmissions() {
  const secret = process.env.JWT_ACCESS_SECRET!;
  const users: J[] = (await get('/users?pageSize=100')).data;
  const me = await get('/me');
  const u = users.find((x) => x.username === 'office');
  const t = jwt.sign({ sub: String(u.id), sch: String(me.school.id) }, secret, { algorithm: 'HS256', expiresIn: '2h' });
  const sections: J[] = (await get('/students/overview')).sections;
  const pick = (code: string, std: string) => sections.find((x) => x.schoolClass.medium.code === code && x.schoolClass.standard.code === std) ?? sections[0];
  const kids = [
    { fullName: 'DESAI AARAV NILESH PRIYA', gender: 'MALE', dob: '2021-03-14', sec: pick('EN', 'NUR'), father: 'Nilesh Desai', mobile: '9820311111' },
    { fullName: 'KHAN SARA ASIF NAZNEEN', gender: 'FEMALE', dob: '2017-11-02', sec: pick('HI', 'III'), father: 'Asif Khan', mobile: '9820322222', isRte: true },
    { fullName: 'PATEL DHRUV MAHESH KINJAL', gender: 'MALE', dob: '2014-07-21', sec: pick('EN', 'VI'), father: 'Mahesh Patel', mobile: '9820333333', previousSchool: 'Shree Vidya Mandir, Malad' },
  ];
  for (const k of kids) {
    await callAs(t, 'POST', '/students', {
      student: { fullName: k.fullName, gender: k.gender, dob: k.dob, isRte: !!k.isRte, previousSchool: k.previousSchool ?? null, addressLine: 'Goregaon (W), Mumbai', guardians: [{ relation: 'FATHER', name: k.father, mobile: k.mobile, isPrimary: true }] },
      enrollment: { sectionId: k.sec.sectionId },
    });
  }
  console.log(`✓ ${kids.length} new admissions entered by the office, waiting for the Headmaster's approval`);
}
