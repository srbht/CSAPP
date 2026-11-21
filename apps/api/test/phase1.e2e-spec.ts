import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '../src/generated/prisma/client';
import { ADMIN, api, as, bootstrap, login } from './helpers';

/** Unique GR numbers for admissions by the Headmaster / admin (the GR No is never generated). */
let grSeq = 0;
const nextGr = () => `GR-${++grSeq}`;

/**
 * Phase 1 acceptance (docs/06): admin configures EN-X-A with the Std X papers; a subject teacher
 * sees only their assignments; unauthorized API calls are refused by the server.
 */
describe('Phase 1 — foundation', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let admin: ReturnType<typeof as>;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ({ app, prisma } = await bootstrap());
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  // ------------------------------------------------------------------ health & auth
  describe('auth', () => {
    it('health endpoints are public', async () => {
      await api(app).get('/health').expect(200, { status: 'ok' });
      await api(app).get('/ready').expect(200);
    });

    it('rejects anonymous API calls with problem details', async () => {
      const res = await api(app).get('/api/v1/school').expect(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    });

    it('rejects a wrong password without revealing whether the user exists', async () => {
      const a = await api(app).post('/api/v1/auth/login').send({ login: ADMIN.username, password: 'wrong-pass1' }).expect(401);
      const b = await api(app).post('/api/v1/auth/login').send({ login: 'nobody', password: 'wrong-pass1' }).expect(401);
      expect(a.body.detail).toBe(b.body.detail);
    });

    it('validates the login body (422 with field errors)', async () => {
      const res = await api(app).post('/api/v1/auth/login').send({ login: '' }).expect(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['login', 'password']));
    });

    it('forces a password change on first login, then allows access', async () => {
      const first = await login(app, ADMIN.username, ADMIN.initial);
      expect(first.body.mustChangePassword).toBe(true);
      const tmp = as(app, first.token);
      await tmp.get('/school').expect(403).expect((r) => expect(r.body.code).toBe('PASSWORD_CHANGE_REQUIRED'));
      await tmp.get('/me').expect(200);
      await tmp.post('/auth/change-password', { currentPassword: 'bad', newPassword: ADMIN.password, confirmPassword: ADMIN.password }).expect(422);
      await tmp.post('/auth/change-password', { currentPassword: ADMIN.initial, newPassword: 'short', confirmPassword: 'short' }).expect(422);
      await tmp.post('/auth/change-password', { currentPassword: ADMIN.initial, newPassword: ADMIN.password, confirmPassword: ADMIN.password }).expect(204);
      const second = await login(app, ADMIN.username, ADMIN.password);
      expect(second.body.mustChangePassword).toBe(false);
      admin = as(app, second.token);
      const me = await admin.get('/me').expect(200);
      // Super Admin administers the system but has no academic approval authority by default.
      expect(me.body.permissions).toContain('users.manage');
      expect(me.body.permissions).not.toContain('marks.approve');
      expect(me.body.permissions).not.toContain('reportcards.publish');
      expect(me.body.school.name).toBe('Children Public School');
      expect(me.body).not.toHaveProperty('passwordHash');
    });

    it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
      const s = await login(app, ADMIN.username, ADMIN.password);
      const cookie1 = s.cookie.find((c) => c.startsWith('cps_rt='))!.split(';')[0];
      expect(s.cookie.join(';')).toMatch(/HttpOnly/i);
      const r1 = await api(app).post('/api/v1/auth/refresh').set('Cookie', cookie1).expect(200);
      const cookie2 = (r1.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('cps_rt='))!.split(';')[0];
      expect(cookie2).not.toBe(cookie1);
      // Reusing the rotated token = theft signal → whole family revoked, including cookie2.
      await api(app).post('/api/v1/auth/refresh').set('Cookie', cookie1).expect(401);
      await api(app).post('/api/v1/auth/refresh').set('Cookie', cookie2).expect(401);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'REFRESH_TOKEN_REUSE' } });
      expect(audit).not.toBeNull();
    });

    it('logout revokes the refresh token', async () => {
      const s = await login(app, ADMIN.username, ADMIN.password);
      const cookie = s.cookie.find((c) => c.startsWith('cps_rt='))!.split(';')[0];
      await api(app).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
      await api(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    });
  });

  // ------------------------------------------------------------------ school & year setup
  describe('school setup', () => {
    it('reads the seeded profile and updates it with an audit diff', async () => {
      const s = await admin.get('/school').expect(200);
      expect(s.body).toMatchObject({ pincode: '400104', motto: 'तमसो मा ज्योतिर्गमय' });
      await admin.patch('/school', { ...s.body, pincode: '4001' }).expect(422);
      const u = await admin.patch('/school', { ...s.body, principalName: 'Test Principal', nameHi: 'चिल्ड्रन पब्लिक स्कूल' }).expect(200);
      expect(u.body.nameHi).toBe('चिल्ड्रन पब्लिक स्कूल');
      const log = await prisma.auditLog.findFirst({ where: { entityType: 'School', action: 'UPDATE' }, orderBy: { id: 'desc' } });
      expect(log?.afterData).toMatchObject({ principalName: 'Test Principal' });
      expect(Object.keys(log!.afterData as object)).not.toContain('addressLine'); // only changed fields
    });

    it('accepts PNG logos and rejects non-images by content, not file name', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
      await admin.upload('/school/logo', 'file', Buffer.from('<script>alert(1)</script>'), 'logo.png').expect(415);
      const ok = await admin.upload('/school/logo', 'file', png, 'logo.png').expect(200);
      const file = await admin.get(`/files/${ok.body.logoFileId}/content`).expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
    });

    it('has the seeded current year, mediums, standards and CCE grading', async () => {
      const years = await admin.get('/academic-years').expect(200);
      const y = years.body.find((x: { name: string }) => x.name === '2026-27');
      expect(y).toMatchObject({ isCurrent: true, status: 'ACTIVE' });
      ids.year = y.id;
      const mediums = await admin.get('/mediums').expect(200);
      ids.en = mediums.body.find((m: { code: string }) => m.code === 'EN').id;
      ids.hi = mediums.body.find((m: { code: string }) => m.code === 'HI').id;
      const standards = await admin.get('/standards').expect(200);
      ids.stdX = standards.body.find((s: { code: string }) => s.code === 'X').id;
      ids.stdVIII = standards.body.find((s: { code: string }) => s.code === 'VIII').id;
      const grading = await admin.get('/grading-systems').expect(200);
      expect(grading.body[0].bands.map((b: { grade: string }) => b.grade)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E1', 'E2']);
      ids.cce = grading.body[0].id;
    });

    it('validates terms: inside the year and not overlapping', async () => {
      const sem1 = { code: 'SEM1', nameEn: 'Semester I', nameHi: 'प्रथम सत्र', startDate: '2026-06-01', endDate: '2026-10-31', sequence: 1 };
      await admin.post(`/academic-years/${ids.year}/terms`, sem1).expect(201);
      await admin.post(`/academic-years/${ids.year}/terms`, { ...sem1, code: 'X1', startDate: '2026-10-01', endDate: '2026-12-01', sequence: 2 }).expect(422);
      await admin.post(`/academic-years/${ids.year}/terms`, { ...sem1, code: 'X2', startDate: '2027-04-01', endDate: '2027-06-01', sequence: 2 }).expect(422);
      await admin.post(`/academic-years/${ids.year}/terms`, { code: 'SEM2', nameEn: 'Semester II', startDate: '2026-11-01', endDate: '2027-04-30', sequence: 2 }).expect(201);
      await admin.post(`/academic-years/${ids.year}/terms`, { ...sem1, startDate: '2026-06-01', endDate: '2026-06-02' }).expect(422);
    });

    it('allows only one current year and protects closing', async () => {
      const next = await admin.post('/academic-years', { name: '2027-28', startDate: '2027-06-01', endDate: '2028-04-30', weeklyOffDays: [0] }).expect(201);
      await admin.post('/academic-years', { name: '2027-28', startDate: '2027-06-01', endDate: '2028-04-30' }).expect(409);
      await admin.post(`/academic-years/${ids.year}/close`).expect(409); // current year cannot be closed
      await admin.post(`/academic-years/${next.body.id}/set-current`).expect(200);
      const years = await admin.get('/academic-years').expect(200);
      expect(years.body.filter((y: { isCurrent: boolean }) => y.isCurrent)).toHaveLength(1);
      await admin.post(`/academic-years/${ids.year}/set-current`).expect(200); // switch back
      // DB-level guarantee as well (functional unique index)
      await expect(prisma.academicYear.update({ where: { id: BigInt(next.body.id) }, data: { isCurrent: true } })).rejects.toThrow();
    });

    it('medium codes are unique', async () => {
      await admin.post('/mediums', { code: 'EN', nameEn: 'Duplicate' }).expect(409);
    });
  });

  // ------------------------------------------------------------------ classes & subjects
  describe('classes and subjects (Std X papers from the school marksheet)', () => {
    const papers = [
      ['ENG', 'English', 'अंग्रेज़ी'], ['MAR', 'Marathi', 'मराठी'], ['HIN', 'Hindi', 'हिंदी'],
    ];

    it('creates class ENGLISH-X with division A, and rejects duplicates', async () => {
      const c = await admin.post('/classes', { academicYearId: ids.year, mediumId: ids.en, standardId: ids.stdX, gradingSystemId: ids.cce }).expect(201);
      expect(c.body).toMatchObject({ code: 'EN-X', displayName: 'ENGLISH-X' });
      ids.enX = c.body.id;
      await admin.post('/classes', { academicYearId: ids.year, mediumId: ids.en, standardId: ids.stdX }).expect(409);
      const a = await admin.post(`/classes/${ids.enX}/sections`, { name: 'a', capacity: 60 }).expect(201);
      expect(a.body.name).toBe('A');
      ids.enXA = a.body.id;
      await admin.post(`/classes/${ids.enX}/sections`, { name: 'A' }).expect(409);
      ids.enXB = (await admin.post(`/classes/${ids.enX}/sections`, { name: 'B' }).expect(201)).body.id;
      const hiX = await admin.post('/classes', { academicYearId: ids.year, mediumId: ids.hi, standardId: ids.stdX }).expect(201);
      expect(hiX.body.displayName).toBe('HINDI-X');
      ids.hiX = hiX.body.id;
    });

    it('creates subjects with papers (Mathematics → Algebra, Geometry) and validates the hierarchy', async () => {
      for (const [code, nameEn, nameHi] of papers) {
        ids[code] = (await admin.post('/subjects', { mediumId: ids.en, code, nameEn, nameHi, subjectType: 'THEORY' }).expect(201)).body.id;
      }
      ids.MATH = (await admin.post('/subjects', { mediumId: ids.en, code: 'MATH', nameEn: 'Mathematics', subjectType: 'THEORY' }).expect(201)).body.id;
      ids.ALG = (await admin.post('/subjects', { mediumId: ids.en, code: 'ALG', nameEn: 'Algebra', shortName: 'Algebra', subjectType: 'THEORY', parentSubjectId: ids.MATH }).expect(201)).body.id;
      ids.GEOM = (await admin.post('/subjects', { mediumId: ids.en, code: 'GEOM', nameEn: 'Geometry', shortName: 'Geom.', subjectType: 'THEORY', parentSubjectId: ids.MATH }).expect(201)).body.id;
      // a paper cannot have papers
      await admin.post('/subjects', { mediumId: ids.en, code: 'BAD', nameEn: 'Bad', subjectType: 'THEORY', parentSubjectId: ids.ALG }).expect(422);
      // parent must be the same medium
      ids.HI_HINDI = (await admin.post('/subjects', { mediumId: ids.hi, code: 'HIN', nameEn: 'Hindi', nameHi: 'हिंदी', subjectType: 'THEORY' }).expect(201)).body.id;
      await admin.post('/subjects', { mediumId: ids.hi, code: 'ALG', nameEn: 'Algebra', subjectType: 'THEORY', parentSubjectId: ids.MATH }).expect(422);
      // same code allowed in another medium; duplicate in same medium rejected
      await admin.post('/subjects', { mediumId: ids.en, code: 'ENG', nameEn: 'English again', subjectType: 'THEORY' }).expect(409);
    });

    it('keeps mediums independent: a Hindi-medium subject cannot be added to an English-medium class', async () => {
      const res = await admin.put(`/classes/${ids.enX}/subjects`, { items: [{ subjectId: ids.HI_HINDI }] }).expect(422);
      expect(res.body.errors[0].code).toBe('medium_mismatch');
    });

    it('saves the class subject list and deactivates (not deletes) removed subjects', async () => {
      const items = ['ENG', 'MAR', 'HIN', 'ALG', 'GEOM'].map((k, i) => ({ subjectId: ids[k], defaultMaxMarks: 20, defaultPassMarks: 7, displayOrder: i }));
      const saved = await admin.put(`/classes/${ids.enX}/subjects`, { items }).expect(200);
      expect(saved.body).toHaveLength(5);
      ids.csENG = saved.body.find((c: { subjectId: number }) => c.subjectId === ids.ENG).id;
      ids.csALG = saved.body.find((c: { subjectId: number }) => c.subjectId === ids.ALG).id;
      await admin.put(`/classes/${ids.enX}/subjects`, { items: [{ subjectId: ids.ENG, defaultMaxMarks: 20, defaultPassMarks: 30 }] }).expect(422); // pass > max
      const fewer = await admin.put(`/classes/${ids.enX}/subjects`, { items: items.filter((i) => i.subjectId !== ids.MAR) }).expect(200);
      expect(fewer.body.find((c: { subjectId: number }) => c.subjectId === ids.MAR).status).toBe('INACTIVE');
      await admin.put(`/classes/${ids.enX}/subjects`, { items }).expect(200); // reactivated
    });

    it('rejects invalid grade bands', async () => {
      const res = await admin.post('/grading-systems', { name: 'Broken', bands: [
        { grade: 'A', minPercent: 50, maxPercent: 100, isPass: true },
        { grade: 'B', minPercent: 0, maxPercent: 60, isPass: false },
      ] }).expect(422);
      expect(res.body.errors[0].message).toMatch(/overlap/);
    });
  });

  // ------------------------------------------------------------------ policies & sequences
  describe('policies and sequences', () => {
    it('validates values and resolves the most specific scope', async () => {
      await admin.put('/policies', { policyKey: 'result.pass_percent_subject', value: 150 }).expect(422);
      await admin.put('/policies', { policyKey: 'nope', value: 1 }).expect(422);
      await admin.put('/policies', { policyKey: 'result.pass_percent_subject', value: 40, mediumId: ids.hi }).expect(200);
      const en = await admin.get(`/policies/effective?mediumId=${ids.en}`).expect(200);
      const hi = await admin.get(`/policies/effective?mediumId=${ids.hi}`).expect(200);
      const pick = (r: { body: { key: string; value: unknown; source: string }[] }) => r.body.find((p) => p.key === 'result.pass_percent_subject');
      expect(pick(en)).toMatchObject({ value: 35, source: 'DEFAULT' });
      expect(pick(hi)).toMatchObject({ value: 40, source: 'STORED' });
      expect(en.body.find((p: { key: string }) => p.key === 'reportcard.attendance_mode').value).toBe('MONTHLY');
    });

    it('allocates unique numbers under concurrency', async () => {
      const { SequencesService } = await import('../src/modules/policies-sequences.module');
      const svc = app.get(SequencesService);
      const school = await prisma.school.findFirstOrThrow();
      await prisma.numberSequence.create({ data: { schoolId: school.id, seqKey: 'test_series', label: 'Test', pattern: 'T{000}', nextValue: 1 } });
      const nums = await Promise.all(
        Array.from({ length: 15 }, () => prisma.$transaction((tx) => svc.next(tx, school.id, 'test_series'))),
      );
      expect(new Set(nums).size).toBe(15);
      expect(nums.sort()[0]).toBe('T001');
    });

    it('rejects sequence patterns without a placeholder', async () => {
      const list = await admin.get('/sequences').expect(200);
      expect(list.body.find((s: { seqKey: string }) => s.seqKey === 'gr_no')).toBeUndefined(); // GR numbers are typed in, not generated
      const sid = list.body.find((s: { seqKey: string }) => s.seqKey === 'student_code');
      await admin.patch(`/sequences/${sid.id}`, { pattern: '{MEDIUM}{YEAR}', nextValue: 1 }).expect(422);
      const ok = await admin.patch(`/sequences/${sid.id}`, { pattern: '{MEDIUM}{YEAR}{00000000}', nextValue: 1 }).expect(200);
      expect(ok.body.preview).toMatch(/^ENG\d{4}00000001$/);
    });
  });

  // ------------------------------------------------------------------ staff, users, scope
  describe('staff, assignments, users and permissions', () => {
    let teacher: ReturnType<typeof as>;
    let schoolAdmin: ReturnType<typeof as>;
    const roleId: Record<string, number> = {};

    it('creates staff, validates mobile numbers and unique employee IDs', async () => {
      await admin.post('/staff', { employeeCode: 'T001', name: 'B. Singh', mobile: '12345' }).expect(422);
      const s = await admin.post('/staff', { employeeCode: 't001', name: 'B. Singh', mobile: '+91 98200 12345', designation: 'Teacher' }).expect(201);
      expect(s.body).toMatchObject({ employeeCode: 'T001', mobile: '9820012345' });
      ids.singh = s.body.id;
      ids.other = (await admin.post('/staff', { employeeCode: 'T002', name: 'A. Patil' }).expect(201)).body.id;
      await admin.post('/staff', { employeeCode: 'T001', name: 'Dup' }).expect(409);
      const list = await admin.get('/staff?q=Singh').expect(200);
      expect(list.body.meta.total).toBe(1);
    });

    it('assigns a subject teacher (subject must belong to the class) and one class teacher per division', async () => {
      await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.singh, role: 'SUBJECT_TEACHER', sectionId: ids.enXA }).expect(422);
      const hiSubject = await admin.put(`/classes/${ids.hiX}/subjects`, { items: [{ subjectId: ids.HI_HINDI }] }).expect(200);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.singh, role: 'SUBJECT_TEACHER', sectionId: ids.enXA, classSubjectId: hiSubject.body[0].id }).expect(422);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.singh, role: 'SUBJECT_TEACHER', sectionId: ids.enXA, classSubjectId: ids.csENG }).expect(201);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.singh, role: 'SUBJECT_TEACHER', sectionId: ids.enXA, classSubjectId: ids.csENG }).expect(409);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.singh, role: 'CLASS_TEACHER', sectionId: ids.enXA }).expect(201);
      const dup = await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.other, role: 'CLASS_TEACHER', sectionId: ids.enXA }).expect(409);
      expect(dup.body.detail).toMatch(/already has a class teacher/);
      // Change class teacher keeps history
      await admin.post(`/sections/${ids.enXB}/class-teacher`, { staffId: ids.other }).expect(200);
      await admin.post(`/sections/${ids.enXB}/class-teacher`, { staffId: ids.singh }).expect(200);
      const hist = await admin.get(`/assignments?academicYearId=${ids.year}&sectionId=${ids.enXB}&includeEnded=true`).expect(200);
      expect(hist.body.map((a: { status: string }) => a.status).sort()).toEqual(['ACTIVE', 'INACTIVE']);
      const classes = await admin.get(`/classes?academicYearId=${ids.year}&mediumId=${ids.en}`).expect(200);
      expect(classes.body[0].sections.find((s: { id: number }) => s.id === ids.enXA).classTeacher.name).toBe('B. Singh');
    });

    it('creates a teacher login with ASSIGNED scope (needs a linked staff member)', async () => {
      const roles = await admin.get('/roles').expect(200);
      for (const r of roles.body) roleId[r.code] = r.id;
      await admin.post('/users', { username: 'nostaff', temporaryPassword: 'Teacher-pass1', roles: [{ roleId: roleId.SUBJECT_TEACHER, scopeType: 'ASSIGNED' }] }).expect(422);
      const u = await admin.post('/users', {
        username: 'bsingh', mobile: '9820012345', staffId: ids.singh, temporaryPassword: 'Teacher-pass1',
        roles: [{ roleId: roleId.SUBJECT_TEACHER, scopeType: 'ASSIGNED' }, { roleId: roleId.CLASS_TEACHER, scopeType: 'ASSIGNED' }],
      }).expect(201);
      expect(u.body).not.toHaveProperty('passwordHash');
      await admin.post('/users', { username: 'bsingh2', staffId: ids.singh, temporaryPassword: 'Teacher-pass1', roles: [{ roleId: roleId.OFFICE_STAFF }] }).expect(422);
      // teacher can log in with mobile number too
      const t = await login(app, '9820012345', 'Teacher-pass1');
      const tmp = as(app, t.token);
      await tmp.post('/auth/change-password', { currentPassword: 'Teacher-pass1', newPassword: 'Teacher-pass2', confirmPassword: 'Teacher-pass2' }).expect(204);
      teacher = as(app, (await login(app, 'bsingh', 'Teacher-pass2')).token);
    });

    it('teacher sees only their own assignments and divisions', async () => {
      const mine = await teacher.get('/me/assignments').expect(200);
      expect(mine.body.every((a: { staff: { id: number } }) => a.staff.id === ids.singh)).toBe(true);
      const me = await teacher.get('/me').expect(200);
      expect(me.body.scope.all).toBe(false);
      expect(me.body.scope.sectionIds.sort()).toEqual([ids.enXA, ids.enXB].sort());
      const classes = await teacher.get(`/classes?academicYearId=${ids.year}&mine=true`).expect(200);
      expect(classes.body.map((c: { id: number }) => c.id)).toEqual([ids.enX]); // not HINDI-X
    });

    it('server refuses teacher calls outside their permissions', async () => {
      await teacher.post('/classes', { academicYearId: ids.year, mediumId: ids.en, standardId: ids.stdVIII }).expect(403);
      await teacher.get('/users').expect(403);
      await teacher.get('/staff').expect(403);
      await teacher.patch('/school', {}).expect(403);
      await teacher.get('/audit-logs').expect(403);
      await teacher.put('/policies', { policyKey: 'result.pass_percent_subject', value: 10 }).expect(403);
      await teacher.post('/assignments', { academicYearId: ids.year, staffId: ids.singh, role: 'CLASS_TEACHER', sectionId: ids.enXB }).expect(403);
    });

    it('prevents privilege escalation by a School Admin', async () => {
      await admin.post('/users', { username: 'office1', temporaryPassword: 'Office-pass1', roles: [{ roleId: roleId.SCHOOL_ADMIN, scopeType: 'SCHOOL' }] }).expect(201);
      const s = await login(app, 'office1', 'Office-pass1');
      await as(app, s.token).post('/auth/change-password', { currentPassword: 'Office-pass1', newPassword: 'Office-pass2', confirmPassword: 'Office-pass2' }).expect(204);
      schoolAdmin = as(app, (await login(app, 'office1', 'Office-pass2')).token);
      await schoolAdmin.post('/users', { username: 'evil', temporaryPassword: 'Evil-pass1', roles: [{ roleId: roleId.SUPER_ADMIN }] }).expect(403);
      // Headmaster includes marks.approve which School Admin does not hold
      await schoolAdmin.post('/users', { username: 'evil2', temporaryPassword: 'Evil-pass1', roles: [{ roleId: roleId.HEADMASTER }] }).expect(403);
      await schoolAdmin.post('/users', { username: 'clerk', temporaryPassword: 'Clerk-pass1', roles: [{ roleId: roleId.OFFICE_STAFF }] }).expect(201);
      await schoolAdmin.patch(`/roles/${roleId.OFFICE_STAFF}`, { name: 'x', permissions: [] }).expect(403); // no roles.manage
    });

    it('super admin can edit roles; changes apply immediately; Super Admin role is locked', async () => {
      const roles = await admin.get('/roles').expect(200);
      const st = roles.body.find((r: { code: string }) => r.code === 'SUBJECT_TEACHER');
      await admin.patch(`/roles/${roleId.SUPER_ADMIN}`, { name: 'x', permissions: [] }).expect(409);
      await admin.patch(`/roles/${st.id}`, { name: st.name, permissions: [...st.permissions, 'staff.read'] }).expect(200);
      await teacher.get('/staff').expect(200); // same token, new permission effective now
      await admin.patch(`/roles/${st.id}`, { name: st.name, permissions: st.permissions }).expect(200);
      await teacher.get('/staff').expect(403);
      await admin.patch(`/roles/${st.id}`, { name: st.name, permissions: ['not.a.permission'] }).expect(422);
    });

    it('disabling a user blocks access immediately; nobody can change their own roles', async () => {
      const users = await admin.get('/users?q=bsingh').expect(200);
      const u = users.body.data[0];
      const roles = u.roles.map((r: { roleId: number; scopeType: string; scopeId: number | null }) => ({ roleId: r.roleId, scopeType: r.scopeType, scopeId: r.scopeId }));
      await admin.patch(`/users/${u.id}`, { status: 'DISABLED', staffId: ids.singh, mobile: u.mobile, roles }).expect(200);
      await teacher.get('/me').expect(401);
      await admin.patch(`/users/${u.id}`, { status: 'ACTIVE', staffId: ids.singh, mobile: u.mobile, roles }).expect(200);
      const me = await admin.get('/me').expect(200);
      // Nobody can change their own roles (a Super Admin cannot give themselves approval authority)
      await admin.patch(`/users/${me.body.id}`, { status: 'ACTIVE', roles: [{ roleId: roleId.SUPER_ADMIN }, { roleId: roleId.HEADMASTER }] }).expect(403);
      await admin.patch(`/users/${me.body.id}`, { status: 'ACTIVE', roles: [{ roleId: roleId.SCHOOL_ADMIN }] }).expect(403);
    });

    it('locks an account after 10 failed logins and lets an admin unlock it', async () => {
      for (let i = 0; i < 10; i++) await api(app).post('/api/v1/auth/login').send({ login: 'clerk', password: 'wrong-pass1' }).expect(401);
      await api(app).post('/api/v1/auth/login').send({ login: 'clerk', password: 'Clerk-pass1' }).expect(423);
      const clerk = (await admin.get('/users?q=clerk').expect(200)).body.data[0];
      await admin.post(`/users/${clerk.id}/unlock`).expect(204);
      await login(app, 'clerk', 'Clerk-pass1');
    });

    it('records an audit trail viewable by authorised users', async () => {
      const logs = await admin.get('/audit-logs?entityType=TeachingAssignment&pageSize=50').expect(200);
      expect(logs.body.meta.total).toBeGreaterThanOrEqual(4);
      expect(logs.body.data[0]).toHaveProperty('username');
      const facets = await admin.get('/audit-logs/facets').expect(200);
      expect(facets.body.actions).toEqual(expect.arrayContaining(['CREATE', 'UPDATE', 'LOGIN', 'LOGIN_FAILED', 'ACCOUNT_LOCKED']));
    });

    it('dashboard setup counts come from the database', async () => {
      const d = await admin.get('/dashboard/setup').expect(200);
      expect(d.body.currentYear.name).toBe('2026-27');
      expect(d.body.counts.classes).toBe(await prisma.schoolClass.count({ where: { academicYearId: BigInt(ids.year), status: 'ACTIVE' } }));
      // EN-X A and B both have class teachers; HINDI-X has no divisions yet; HINDI-X has no subjects gap = 0 (Hindi added above)
      expect(d.body.gaps.sectionsWithoutClassTeacher).toBe(0);
      expect(d.body.counts.sections).toBe(2);
      // EN-X A has an English teacher only: 2 divisions × 5 subjects − 1 = 9 slots without a teacher
      expect(d.body.gaps.subjectSlotsWithoutTeacher).toBe(9);
    });
  });
  // ------------------------------------------------------------------ operators & headmaster (docs/07)
  describe('operators, headmaster and academic assignments', () => {
    const roleId: Record<string, number> = {};
    let headmaster: ReturnType<typeof as>;
    let op1: ReturnType<typeof as>;
    const staffIds: Record<string, number> = {};

    async function staffUser(code: string, name: string, role: string, password = 'Strong-pass1') {
      staffIds[code] = (await admin.post('/staff', { employeeCode: code, name }).expect(201)).body.id;
      await admin
        .post('/users', { username: code.toLowerCase(), staffId: staffIds[code], temporaryPassword: password, roles: [{ roleId: roleId[role], scopeType: role === 'HEADMASTER' ? 'SCHOOL' : 'ASSIGNED' }] })
        .expect(201);
      const first = await login(app, code.toLowerCase(), password);
      await as(app, first.token).post('/auth/change-password', { currentPassword: password, newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
      return as(app, (await login(app, code.toLowerCase(), 'Changed-pass2')).token);
    }

    beforeAll(async () => {
      const roles = await admin.get('/roles').expect(200);
      for (const r of roles.body) roleId[r.code] = r.id;
      ids.hiXA = (await admin.post(`/classes/${ids.hiX}/sections`, { name: 'A' }).expect(201)).body.id;
    });

    it('a School Admin can create Operator logins (data entry is not a sensitive power)', async () => {
      const s = await login(app, 'office1', 'Office-pass2');
      staffIds.OP0 = (await admin.post('/staff', { employeeCode: 'OP0', name: 'Operator Zero' }).expect(201)).body.id;
      await as(app, s.token)
        .post('/users', { username: 'op0', staffId: staffIds.OP0, temporaryPassword: 'Strong-pass1', roles: [{ roleId: roleId.OPERATOR, scopeType: 'ASSIGNED' }] })
        .expect(201);
    });

    it('Super Admin creates the Headmaster, who controls assignments but not user administration', async () => {
      headmaster = await staffUser('HM1', 'Head Mistress', 'HEADMASTER');
      const me = await headmaster.get('/me').expect(200);
      expect(me.body.permissions).toEqual(expect.arrayContaining(['marks.approve', 'reportcards.publish', 'assignments.manage', 'reports.schoolwide']));
      expect(me.body.scope.all).toBe(true);
      await headmaster.get('/users').expect(403);
      await headmaster.get(`/assignments?academicYearId=${ids.year}`).expect(200);
    });

    it('Headmaster assigns several operators to one division and one operator to several divisions (across mediums)', async () => {
      op1 = await staffUser('OP1', 'Operator One', 'OPERATOR');
      await staffUser('OP2', 'Operator Two', 'OPERATOR');
      const base = { academicYearId: ids.year, role: 'OPERATOR' };
      await headmaster.post('/assignments', { ...base, staffId: staffIds.OP1, sectionId: ids.enXA }).expect(201);
      await headmaster.post('/assignments', { ...base, staffId: staffIds.OP2, sectionId: ids.enXA }).expect(201); // 2nd operator, same division
      await headmaster.post('/assignments', { ...base, staffId: staffIds.OP1, sectionId: ids.hiXA }).expect(201); // other medium
      await headmaster.post('/assignments', { ...base, staffId: staffIds.OP1, sectionId: ids.enXA }).expect(409); // exact duplicate
      await headmaster.post('/assignments', { ...base, staffId: staffIds.OP1, sectionId: ids.enXB, classSubjectId: ids.csENG }).expect(422); // operators have no subject
      const list = await headmaster.get(`/assignments?academicYearId=${ids.year}&role=OPERATOR&sectionId=${ids.enXA}`).expect(200);
      expect(list.body.map((a: { staff: { name: string } }) => a.staff.name).sort()).toEqual(['Operator One', 'Operator Two']);
      const hindiOnly = await headmaster.get(`/assignments?academicYearId=${ids.year}&role=OPERATOR&mediumId=${ids.hi}`).expect(200);
      expect(hindiOnly.body).toHaveLength(1);
    });

    it('an Operator sees only assigned divisions, with role-specific scope, and cannot verify or manage', async () => {
      const me = await op1.get('/me').expect(200);
      expect(me.body.scope.all).toBe(false);
      expect([...me.body.scope.byRole.OPERATOR].sort()).toEqual([ids.enXA, ids.hiXA].sort());
      expect(me.body.scope.byRole.SUBJECT_TEACHER).toEqual([]);
      for (const p of ['marks.verify.subject', 'marks.verify.class', 'marks.approve', 'reportcards.publish']) expect(me.body.permissions).not.toContain(p);
      const classes = await op1.get(`/classes?academicYearId=${ids.year}&mine=true`).expect(200);
      expect(classes.body.map((c: { id: number }) => c.id).sort()).toEqual([ids.enX, ids.hiX].sort());
      expect(classes.body.find((c: { id: number }) => c.id === ids.enX).sections.map((s: { id: number }) => s.id)).toEqual([ids.enXA]); // not X-B
      await op1.post('/assignments', { academicYearId: ids.year, role: 'OPERATOR', staffId: staffIds.OP1, sectionId: ids.enXB }).expect(403);
      await op1.get('/staff').expect(403);
      await op1.get(`/assignments?academicYearId=${ids.year}`).expect(403);
    });

    it('scope checks are per role: an operator assignment does not authorise subject verification', async () => {
      const { ScopeService } = await import('../src/common/scope');
      const { loadAccessContext } = await import('../src/common/auth');
      const { PrismaService } = await import('../src/infra/prisma.service');
      const svc = app.get(ScopeService);
      const user = await prisma.user.findFirstOrThrow({ where: { username: 'op1' } });
      const ctx = (await loadAccessContext(app.get(PrismaService), user.id, { headers: {} } as never))!;
      const scope = await svc.resolve(ctx, BigInt(ids.year));
      expect(() => svc.assertAssigned(scope, 'OPERATOR', BigInt(ids.enXA))).not.toThrow();
      expect(() => svc.assertAssigned(scope, 'OPERATOR', BigInt(ids.enXB))).toThrow();
      expect(() => svc.assertAssigned(scope, 'SUBJECT_TEACHER', BigInt(ids.enXA), BigInt(ids.csENG))).toThrow();
    });

    it('Headmaster replaces an operator; history keeps who, when and why', async () => {
      await staffUser('OP3', 'Operator Three', 'OPERATOR');
      const cur = (await headmaster.get(`/assignments?academicYearId=${ids.year}&role=OPERATOR&staffId=${staffIds.OP2}`).expect(200)).body[0];
      await headmaster.post(`/assignments/${cur.id}/replace`, { staffId: staffIds.OP3 }).expect(422); // reason mandatory
      const r = await headmaster.post(`/assignments/${cur.id}/replace`, { staffId: staffIds.OP3, reason: 'Operator Two on leave' }).expect(200);
      expect(r.body.staff.name).toBe('Operator Three');
      const all = await headmaster.get(`/assignments?academicYearId=${ids.year}&role=OPERATOR&sectionId=${ids.enXA}&includeEnded=true`).expect(200);
      expect(all.body.find((a: { id: number }) => a.id === cur.id).status).toBe('INACTIVE');
      const hist = await headmaster.get(`/assignments/history?academicYearId=${ids.year}`).expect(200);
      const ended = hist.body.find((h: { action: string; assignment: { id: number } | null }) => h.action === 'END' && h.assignment?.id === cur.id);
      expect(ended).toMatchObject({ reason: 'Operator Two on leave', by: 'hm1' });
    });

    it('the DB itself rejects unknown assignment roles', async () => {
      await expect(
        prisma.teachingAssignment.create({ data: { academicYearId: BigInt(ids.year), staffId: BigInt(staffIds.OP1), role: 'PRINCIPAL', sectionId: BigInt(ids.enXB), validFrom: new Date() } }),
      ).rejects.toThrow();
    });
  });
  // ------------------------------------------------------------------ Phase 2: students and who may see them
  describe('students: admission and visibility', () => {
    let classTeacher: ReturnType<typeof as>;
    let operator: ReturnType<typeof as>;
    const sid: Record<string, number> = {};
    let grNo = '';
    const father = (mobile: string) => ({ relation: 'FATHER', name: 'Rajesh Sharma', mobile, occupation: 'Driver', isPrimary: true });
    const student = (fullName: string, extra: object = {}) => ({
      grNo: nextGr(), fullName, gender: 'FEMALE', dob: '2011-05-04', addressLine: 'Room 4, Rajaram Galli', category: 'OBC', religion: 'Hindu', guardians: [father('9820099999')], ...extra,
    });

    beforeAll(async () => {
      const roles = await admin.get('/roles').expect(200);
      const roleId = Object.fromEntries(roles.body.map((r: { code: string; id: number }) => [r.code, r.id]));
      const ct = (await admin.post('/staff', { employeeCode: 'CT9', name: 'Usha Pandey' }).expect(201)).body.id;
      await admin.post(`/sections/${ids.hiXA}/class-teacher`, { staffId: ct }).expect(200);
      await admin.post('/users', { username: 'ct9', staffId: ct, temporaryPassword: 'Strong-pass1', roles: [{ roleId: roleId.CLASS_TEACHER, scopeType: 'ASSIGNED' }] }).expect(201);
      const first = await login(app, 'ct9', 'Strong-pass1');
      await as(app, first.token).post('/auth/change-password', { currentPassword: 'Strong-pass1', newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
      classTeacher = as(app, (await login(app, 'ct9', 'Changed-pass2')).token);
      operator = as(app, (await login(app, 'op1', 'Changed-pass2')).token); // operator of EN-X-A and HI-X-A
    });

    it('admits a student with GR No, exam no (per medium) and roll no allocated automatically', async () => {
      const r = await admin.post('/students', { student: student('SHARMA PRIYA RAJESH SUNITA', { previousSchoolYear: '2025-26' }), enrollment: { sectionId: ids.enXA, joinedOn: '2026-06-15' } }).expect(201);
      sid.enA = r.body.id;
      grNo = r.body.grNo;
      expect(r.body.studentCode).toBe('ENG202600000001'); // medium + year + running number
      expect(r.body.previousSchoolYear).toBe('2025-26');
      expect(r.body.admissionFormNo).toBe('AF-2026-00001'); // form number, from Number Formats
      expect(r.body.grNo).toMatch(/^GR-\d+$/); // typed in by the Headmaster, never generated
      expect(r.body.enrollments[0]).toMatchObject({ examNo: null, rollNo: 1, status: 'ACTIVE' }); // Exam No after the class list is confirmed
      expect(r.body.statusHistory[0]).toMatchObject({ toStatus: 'ACTIVE' });
      const hi = await admin.post('/students', { student: student('YADAV ANKIT SURESH REKHA', { gender: 'MALE', fullNameHi: 'यादव अंकित सुरेश रेखा' }), enrollment: { sectionId: ids.hiXA } }).expect(201);
      expect(hi.body.studentCode).toBe('HIN202600000002'); // one running number for the school
      sid.hiA = hi.body.id;
      expect(hi.body.enrollments[0].examNo).toBeNull();
    });

    it('rejects a duplicate GR No, a taken roll no and missing required fields', async () => {
      await admin.post('/students', { student: student('GUPTA NEHA', { grNo }), enrollment: { sectionId: ids.enXA } }).expect(409);
      const roll = await admin.post('/students', { student: student('GUPTA NEHA'), enrollment: { sectionId: ids.enXA, rollNo: 1 } }).expect(409);
      expect(roll.body.errors[0].path).toBe('enrollment.rollNo');
      const bad = await admin.post('/students', { student: { grNo: nextGr(), fullName: 'NO GENDER' }, enrollment: { sectionId: ids.enXA } }).expect(422);
      expect(bad.body.errors.map((e: { path: string }) => e.path)).toContain('student.gender');
    });

    it('the class teacher sees full details of their own class only, without caste/category', async () => {
      const list = await classTeacher.get('/students').expect(200);
      expect(list.body.data.map((s: { id: number }) => s.id)).toEqual([sid.hiA]);
      expect(list.body.data[0].primaryContact.mobile).toBe('9820099999');
      const p = await classTeacher.get(`/students/${sid.hiA}`).expect(200);
      expect(p.body.access).toMatchObject({ contact: true, sensitive: false, edit: false });
      expect(p.body.dob).toBeTruthy();
      expect(p.body.guardians[0].mobile).toBe('9820099999');
      expect(p.body.category).toBeNull();
      expect(p.body.religion).toBeNull();
      await classTeacher.get(`/students/${sid.enA}`).expect(404); // another class: not even its existence
      const tampered = await classTeacher.get(`/students?sectionId=${ids.enXA}`).expect(200);
      expect(tampered.body.meta.total).toBe(0);
      await classTeacher.patch(`/students/${sid.hiA}`, student('CHANGED')).expect(403);
    });

    it('an operator sees basic details of assigned divisions but no contact details, and cannot admit', async () => {
      const list = await operator.get('/students').expect(200);
      expect(list.body.data.map((s: { id: number }) => s.id).sort()).toEqual([sid.enA, sid.hiA].sort());
      expect(list.body.data.every((s: { primaryContact: unknown; dob: unknown }) => s.primaryContact === null && s.dob === null)).toBe(true);
      const p = await operator.get(`/students/${sid.enA}`).expect(200);
      expect(p.body.access.contact).toBe(false);
      expect(p.body.guardians[0]).toMatchObject({ name: 'Rajesh Sharma', mobile: null, occupation: null });
      expect(p.body.addressLine).toBeNull();
      await operator.post('/students', { student: student('NEW KID'), enrollment: { sectionId: ids.enXA } }).expect(403);
      await operator.get(`/students/${sid.enA}/photo`).expect(404); // no photo yet, but access itself is allowed
    });

    it('school-wide staff with sensitive permission see everything; the overview counts each division', async () => {
      const p = await admin.get(`/students/${sid.enA}`).expect(200);
      expect(p.body.access).toMatchObject({ contact: true, sensitive: true, edit: true });
      expect(p.body.category).toBe('OBC');
      const ov = await admin.get('/students/overview').expect(200);
      expect(ov.body.totals.students).toBe(2);
      expect(ov.body.sections.find((s: { sectionId: number }) => s.sectionId === ids.hiXA).classTeacher.name).toBe('Usha Pandey');
      const mine = await classTeacher.get('/students/overview').expect(200);
      expect(mine.body.sections.map((s: { sectionId: number }) => s.sectionId)).toEqual([ids.hiXA]);
      expect(mine.body.sections[0].myRoles).toEqual(['CLASS_TEACHER']);
    });

    it('editing updates parents in place; renumbering orders the division A–Z', async () => {
      const u = await admin.patch(`/students/${sid.enA}`, student('SHARMA PRIYA RAJESH SUNITA', { guardians: [father('9820011111'), { relation: 'MOTHER', name: 'Sunita Sharma' }] })).expect(200);
      expect(u.body.guardians).toHaveLength(2);
      expect(u.body.guardians.find((g: { relation: string }) => g.relation === 'FATHER').guardian.mobile).toBe('9820011111');
      await admin.post('/students', { student: student('ANSARI ZOYA IRFAN SHABNAM'), enrollment: { sectionId: ids.enXA } }).expect(201);
      await admin.post(`/sections/${ids.enXA}/renumber`).expect(200);
      const list = await admin.get(`/students?sectionId=${ids.enXA}`).expect(200);
      expect(list.body.data.map((s: { fullName: string; rollNo: number }) => `${s.rollNo} ${s.fullName.split(' ')[0]}`)).toEqual(['1 ANSARI', '2 SHARMA']);
    });

    it('class list: prepared by the operator, roll numbers checked by the class teacher, finalized by the Headmaster, then Exam Nos H-10-001…', async () => {
      await admin.post(`/sections/${ids.hiXA}/renumber`).expect(200);
      const st = await classTeacher.get(`/sections/${ids.hiXA}/list`).expect(200);
      expect(st.body).toMatchObject({ status: 'DRAFT', examPrefix: 'H-10', can: { ready: false, confirm: false } });
      await classTeacher.post(`/sections/${ids.hiXA}/list/ready`).expect(403); // the class teacher only confirms
      await operator.post(`/sections/${ids.hiXA}/list/ready`).expect(200);
      await operator.post(`/sections/${ids.hiXA}/renumber`).expect(403); // with the class teacher now
      await operator.post(`/sections/${ids.hiXA}/list/confirm`).expect(403);
      await classTeacher.post(`/sections/${ids.hiXA}/list/return`, { note: 'Check the spelling of roll 2' }).expect(200);
      expect((await operator.get(`/sections/${ids.hiXA}/list`).expect(200)).body).toMatchObject({ status: 'DRAFT', note: 'Check the spelling of roll 2' });
      await operator.post(`/sections/${ids.hiXA}/list/ready`).expect(200);
      // The class teacher may change roll numbers until confirming.
      const before = (await classTeacher.get(`/students?sectionId=${ids.hiXA}`).expect(200)).body.data as { enrollmentId: number; rollNo: number }[];
      const swapped = before.map((x, i) => ({ enrollmentId: x.enrollmentId, rollNo: before.length > 1 && i < 2 ? 2 - i : x.rollNo }));
      await classTeacher.put(`/sections/${ids.hiXA}/roll-numbers`, { items: [{ enrollmentId: before[0].enrollmentId, rollNo: 1 }, { enrollmentId: before[0].enrollmentId, rollNo: 1 }] }).expect(422); // duplicates
      await operator.put(`/sections/${ids.hiXA}/roll-numbers`, { items: swapped }).expect(403); // with the class teacher now
      await classTeacher.put(`/sections/${ids.hiXA}/roll-numbers`, { items: swapped }).expect(200);
      const c = await classTeacher.post(`/sections/${ids.hiXA}/list/confirm`).expect(200);
      expect(c.body).toMatchObject({ listStatus: 'CONFIRMED' });
      await classTeacher.put(`/sections/${ids.hiXA}/roll-numbers`, { items: before.map((x) => ({ enrollmentId: x.enrollmentId, rollNo: x.rollNo })) }).expect(409); // locked
      await admin.post(`/sections/${ids.hiXA}/exam-nos`).expect(409); // not final yet
      await classTeacher.post(`/sections/${ids.hiXA}/list/finalize`).expect(403); // the Headmaster finalizes
      await admin.post(`/sections/${ids.hiXA}/list/return`, { note: 'Recheck' }).expect(200); // back to the class teacher
      expect((await classTeacher.get(`/sections/${ids.hiXA}/list`).expect(200)).body).toMatchObject({ status: 'READY', can: { editRolls: true, confirm: true } });
      // "Waiting for you" on Home: the class teacher sees the list to confirm, then the Headmaster the list to finalize.
      const keys = async (who: ReturnType<typeof as>) => ((await who.get('/dashboard/todo').expect(200)).body.items as { key: string }[]).map((i) => i.key);
      expect(await keys(classTeacher)).toContain(`cl-confirm-${ids.hiXA}`);
      await classTeacher.post(`/sections/${ids.hiXA}/list/confirm`).expect(200);
      expect(await keys(classTeacher)).not.toContain(`cl-confirm-${ids.hiXA}`);
      expect(await keys(admin)).toContain(`cl-final-${ids.hiXA}`);
      await admin.post(`/sections/${ids.hiXA}/list/finalize`).expect(200);
      expect(await keys(admin)).toContain(`exam-${ids.hiX}`);
      const overview = (await admin.get('/class-lists').expect(200)).body.rows as { sectionId: number; step: string; mine: boolean }[];
      expect(overview.find((r) => r.sectionId === ids.hiXA)).toMatchObject({ step: 'GENERATE', mine: true });
      expect((await admin.get(`/sections/${ids.hiXA}/list`).expect(200)).body).toMatchObject({ status: 'FINAL', can: { generate: true } });
      const g = await admin.post(`/sections/${ids.hiXA}/exam-nos`).expect(200);
      await admin.post(`/sections/${ids.hiXA}/exam-nos`).expect(409); // once
      const list = await admin.get(`/students?sectionId=${ids.hiXA}`).expect(200);
      const nos = list.body.data.map((x: { rollNo: number; examNo: string }) => `${x.rollNo}:${x.examNo}`);
      expect(nos[0]).toBe('1:H-10-001'); // roll number 1 → 001
      expect(g.body.generated).toBe(list.body.data.length);
      // A student admitted afterwards takes the next number.
      const late = await admin.post('/students', { student: student('YADAV ZEBA SURESH REKHA'), enrollment: { sectionId: ids.hiXA } }).expect(201);
      expect(late.body.enrollments[0].examNo).toBe(`H-10-${String(list.body.data.length + 1).padStart(3, '0')}`);
    });

    it('leaving the school needs a reason, closes the enrollment and drops the student from the default list', async () => {
      await admin.post(`/students/${sid.enA}/status`, { status: 'TRANSFERRED', effectiveDate: '2026-10-05' }).expect(422); // no reason
      await admin.post(`/students/${sid.enA}/status`, { status: 'TRANSFERRED', effectiveDate: '2026-06-01', reason: 'x left' }).expect(422); // before joining
      await admin.post(`/students/${sid.enA}/status`, { status: 'TRANSFERRED', effectiveDate: '2026-10-05', reason: 'Moved to Pune' }).expect(200);
      const p = await admin.get(`/students/${sid.enA}`).expect(200);
      expect(p.body.current).toMatchObject({ status: 'TRANSFERRED_OUT', leftOn: '2026-10-05T00:00:00.000Z' });
      expect(p.body.statusHistory[0]).toMatchObject({ fromStatus: 'ACTIVE', toStatus: 'TRANSFERRED', reason: 'Moved to Pune' });
      const active = await admin.get(`/students?sectionId=${ids.enXA}`).expect(200);
      expect(active.body.data.map((s: { id: number }) => s.id)).not.toContain(sid.enA);
      const all = await admin.get(`/students?sectionId=${ids.enXA}&status=ALL`).expect(200);
      expect(all.body.data.map((s: { id: number }) => s.id)).toContain(sid.enA);
    });

    it('admission extras: PEN, health, emergency, bank details are stored; siblings are found by parent mobile', async () => {
      const r = await admin.post('/students', {
        student: student('SHARMA ROHAN RAJESH SUNITA', {
          gender: 'MALE', dob: '2013-08-21', motherName: 'Sunita', guardians: [father('9820077777')], pen: '21345678901', identificationMarks: 'Mole on left cheek',
          heightCm: '128', weightKg: '27.5', medicalNotes: 'Asthma', emergencyName: 'Ramesh Sharma', emergencyRelation: 'Uncle', emergencyMobile: '9820066666',
          isBpl: true, isMinority: false, bankAccountNo: '123456789012', bankIfsc: 'sbin0001234', bankName: 'SBI Goregaon',
        }),
        enrollment: { sectionId: ids.hiXA },
      }).expect(201);
      sid.rohan = r.body.id;
      expect(r.body).toMatchObject({ pen: '21345678901', heightCm: 128, weightKg: 27.5, bankIfsc: 'SBIN0001234', isBpl: true, medicalNotes: 'Asthma' });
      await admin.post('/students', { student: student('X', { bankIfsc: 'BAD' }), enrollment: { sectionId: ids.hiXA } }).expect(422);
      const sis = await admin.post('/students', { student: student('SHARMA ANU RAJESH SUNITA', { guardians: [father('9820077777')] }), enrollment: { sectionId: ids.hiXA } }).expect(201);
      const p = await admin.get(`/students/${sid.rohan}`).expect(200);
      expect(p.body.siblings.map((x: { id: number }) => x.id)).toEqual([sis.body.id]);
      // The class teacher sees health and emergency details but not bank / BPL.
      const ct = await classTeacher.get(`/students/${sid.rohan}`).expect(200);
      expect(ct.body).toMatchObject({ medicalNotes: 'Asthma', emergencyMobile: '9820066666', bankAccountNo: null, isBpl: null });
    });

    it('warns about a possible duplicate: same name, or same date of birth and mother', async () => {
      const byName = await admin.get('/students/duplicates?fullName=sharma  rohan rajesh sunita').expect(200);
      expect(byName.body.map((d: { id: number }) => d.id)).toEqual([sid.rohan]);
      expect(byName.body[0].reasons).toContain('same name');
      const byDob = await admin.get('/students/duplicates?fullName=SHARMA ROHAN&dob=2013-08-21&motherName=sunita').expect(200);
      expect(byDob.body[0]).toMatchObject({ id: sid.rohan, reasons: ['same date of birth', "same mother's name"] });
      expect((await admin.get(`/students/duplicates?fullName=SHARMA ROHAN RAJESH SUNITA&excludeId=${sid.rohan}`).expect(200)).body).toEqual([]);
      expect((await admin.get('/students/duplicates?fullName=NOBODY HERE').expect(200)).body).toEqual([]);
      await classTeacher.get('/students/duplicates?fullName=SHARMA').expect(403);
    });

    it('uploads scans of documents (PDF or image), ticks them as received, and shows them only to contact-level users', async () => {
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
      await admin.upload(`/students/${sid.rohan}/documents`, 'file', pdf, 'birth.pdf').field('docType', 'Not a document').expect(422);
      await admin.upload(`/students/${sid.rohan}/documents`, 'file', Buffer.from('MZ fake exe'), 'virus.pdf').field('docType', 'Birth certificate').expect(415);
      const up = await admin.upload(`/students/${sid.rohan}/documents`, 'file', pdf, 'birth.pdf').field('docType', 'Birth certificate').expect(200);
      expect(up.body).toMatchObject({ docType: 'Birth certificate', fileName: 'birth.pdf', mimeType: 'application/pdf' });
      const p = await admin.get(`/students/${sid.rohan}`).expect(200);
      expect(p.body.documents).toContain('Birth certificate');
      expect(p.body.documentFiles).toHaveLength(1);
      const file = await admin.get(`/students/${sid.rohan}/documents/${up.body.id}`).expect(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      await classTeacher.get(`/students/${sid.rohan}/documents/${up.body.id}`).expect(200);
      const op = await operator.get(`/students/${sid.rohan}`).expect(200);
      expect(op.body.documentFiles).toEqual([]);
      await operator.get(`/students/${sid.rohan}/documents/${up.body.id}`).expect(403);
      await classTeacher.delete(`/students/${sid.rohan}/documents/${up.body.id}`).expect(403);
      await admin.delete(`/students/${sid.rohan}/documents/${up.body.id}`).expect(200);
      expect((await admin.get(`/students/${sid.rohan}`).expect(200)).body.documentFiles).toEqual([]);
    });

    it('office staff without sensitive access can edit a student without wiping caste, bank or family income', async () => {
      const roles = await admin.get('/roles').expect(200);
      const officeRole = roles.body.find((r: { code: string }) => r.code === 'OFFICE_STAFF').id;
      await admin.post('/users', { username: 'clerk0', temporaryPassword: 'Strong-pass1', roles: [{ roleId: officeRole, scopeType: 'SCHOOL' }] }).expect(201);
      const first = await login(app, 'clerk0', 'Strong-pass1');
      await as(app, first.token).post('/auth/change-password', { currentPassword: 'Strong-pass1', newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
      const clerk = as(app, (await login(app, 'clerk0', 'Changed-pass2')).token);
      // Office staff see Staff Management (to register staff) but not who-teaches-what or school setup.
      await clerk.get('/staff').expect(200);
      await clerk.get('/assignments').expect(403);
      await clerk.get('/policies').expect(403);
      await clerk.get('/sequences').expect(403);
      await admin.patch(`/students/${sid.rohan}`, student('SHARMA ROHAN RAJESH SUNITA', { gender: 'MALE', bankAccountNo: '123456789012', isBpl: true, guardians: [{ ...father('9820077777'), annualIncome: 'Below ₹1 lakh' }] })).expect(200);
      const seen = await clerk.get(`/students/${sid.rohan}`).expect(200);
      expect(seen.body).toMatchObject({ category: null, bankAccountNo: null });
      // A confirmed student is locked for the office: only the Headmaster edits; the office may only add the GR No.
      expect(seen.body.access).toMatchObject({ edit: false, editGrNo: true, editEnrollment: true });
      await clerk.patch(`/students/${sid.rohan}`, { fullName: 'SHARMA ROHAN RAJESH SUNITA', gender: 'MALE', medicalNotes: 'Asthma; carries inhaler', guardians: [father('9820077777')] }).expect(403);
      const gr = await clerk.patch(`/students/${sid.rohan}/gr-no`, { grNo: 'se-9999' }).expect(200);
      expect(gr.body.grNo).toBe('SE-9999');
      const after = await admin.get(`/students/${sid.rohan}`).expect(200);
      expect(after.body).toMatchObject({ category: 'OBC', religion: 'Hindu', bankAccountNo: '123456789012', isBpl: true });
      expect(after.body.guardians[0].annualIncome).toBe('Below ₹1 lakh');
    });

    it('the database itself rejects invalid gender and Aadhaar values', async () => {
      await expect(prisma.student.update({ where: { id: BigInt(sid.hiA) }, data: { gender: 'X' } })).rejects.toThrow();
      await expect(prisma.student.update({ where: { id: BigInt(sid.hiA) }, data: { aadhaarLast4: '12a4' } })).rejects.toThrow();
    });
  });
  // ------------------------------------------------------------------ Phase 3–6: exams, approvals, report cards
  describe('marks and attendance approval workflow, and the report-card gate', () => {
    let op: ReturnType<typeof as>; // operator of EN-X-A
    let st: ReturnType<typeof as>; // Algebra subject teacher (also operator of EN-X-B)
    let ct: ReturnType<typeof as>; // B. Singh: class teacher of EN-X-A, English subject teacher
    let hm: ReturnType<typeof as>;
    let examId = 0;
    const unit = (classSubjectId: number, section = ids.enXA, exam = examId) => ({ recordType: 'MARKS', examId: exam, sectionId: section, classSubjectId });
    const q = (u: object) => `/sheets?${new URLSearchParams(Object.entries(u).map(([k, v]) => [k, String(v)])).toString()}`;
    const sheet = async (who: ReturnType<typeof as>, u: object, status = 200) => (await who.get(q(u)).expect(status)).body;
    let enr: number[] = [];

    beforeAll(async () => {
      const roles = await admin.get('/roles').expect(200);
      const roleId = Object.fromEntries(roles.body.map((r: { code: string; id: number }) => [r.code, r.id]));
      const mt = (await admin.post('/staff', { employeeCode: 'MT1', name: 'Arvind Iyer' }).expect(201)).body.id;
      ids.mt = mt;
      await admin.post('/assignments', { academicYearId: ids.year, staffId: mt, role: 'SUBJECT_TEACHER', sectionId: ids.enXA, classSubjectId: ids.csALG }).expect(201);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: mt, role: 'SUBJECT_TEACHER', sectionId: ids.enXB, classSubjectId: ids.csALG }).expect(201);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: mt, role: 'OPERATOR', sectionId: ids.enXB }).expect(201);
      await admin.post('/users', { username: 'mt1', staffId: mt, temporaryPassword: 'Strong-pass1', roles: [{ roleId: roleId.SUBJECT_TEACHER, scopeType: 'ASSIGNED' }, { roleId: roleId.OPERATOR, scopeType: 'ASSIGNED' }] }).expect(201);
      const first = await login(app, 'mt1', 'Strong-pass1');
      await as(app, first.token).post('/auth/change-password', { currentPassword: 'Strong-pass1', newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
      st = as(app, (await login(app, 'mt1', 'Changed-pass2')).token);
      op = as(app, (await login(app, 'op1', 'Changed-pass2')).token);
      ct = as(app, (await login(app, 'bsingh', 'Teacher-pass2')).token);
      hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
      for (const n of ['GUPTA NEHA ANIL REKHA', 'YADAV ROHAN SURESH ASHA']) {
        await admin.post('/students', { student: { grNo: nextGr(), fullName: n, gender: 'FEMALE' }, enrollment: { sectionId: ids.enXA, joinedOn: '2026-06-15' } }).expect(201);
      }
      await admin.post('/students', { student: { grNo: nextGr(), fullName: 'PATIL OM RAJU MEENA', gender: 'MALE' }, enrollment: { sectionId: ids.enXB, joinedOn: '2026-06-15' } }).expect(201);
    });

    it('creating a semester gives every class subject its Greensheet mark pattern (X maths: HW 10 + MCQ 40→10, Written 80)', async () => {
      const sem = await admin.post('/exams', { code: 'sem1', nameEn: 'Semester I', reportTerm: 'TERM1', sequence: 1 }).expect(201);
      examId = sem.body.id;
      expect(sem.body.code).toBe('SEM1');
      await admin.post('/exams', { code: 'UT1', nameEn: 'Unit Test 1', kind: 'UNIT_TEST', sequence: 2 }).expect(422); // unit tests are gone
      await admin.post('/exams', { code: 'SEM1B', nameEn: 'Again', reportTerm: 'TERM1', sequence: 3 }).expect(422); // Semester I exists
      await admin.post('/exams', { code: 'SEM1', nameEn: 'Again', reportTerm: 'TERM2', sequence: 3 }).expect(409);
      const subs = await admin.get(`/exams/${examId}/subjects?classId=${ids.enX}`).expect(200);
      const alg = subs.body.find((s: { classSubjectId: number }) => s.classSubjectId === ids.csALG);
      expect([alg.max1, alg.max2]).toEqual([20, 80]);
      expect(alg.parts).toEqual([{ key: 'HOMEWORK', max: 10 }, { key: 'MCQ', max: 40, countAs: 10 }, { key: 'WRITTEN', max: 80 }]);
      const eng = subs.body.find((s: { classSubject: { subject: { code: string } } }) => s.classSubject.subject.code === 'ENG');
      expect(eng.parts.map((p: { key: string }) => p.key)).toEqual(['ORAL', 'HOMEWORK', 'WRITTEN']);
      await op.post('/exams', { code: 'X', nameEn: 'X', reportTerm: 'TERM2', sequence: 9 }).expect(403);
    });

    it('blank mark sheets: subject row, mark parts with maximum marks from the pattern, a row per student; Excel too', async () => {
      const r = await hm.get(`/exams/${examId}/blank-sheets?sectionId=${ids.enXA}&classSubjectId=${ids.csALG}`).expect(200);
      expect(r.body.sheets).toHaveLength(1);
      expect(r.body.sheets[0].columns.map((c: { label: string; max: number }) => `${c.label}:${c.max}`)).toEqual(['Home Work:10', 'MCQ:40', 'Total (A):20', 'Written:80', 'Total (B):80', 'Total:100']);
      expect(r.body.students.length).toBeGreaterThan(0);
      expect(r.body.students[0]).toHaveProperty('examNo');
      const all = await hm.get(`/exams/${examId}/blank-sheets?sectionId=${ids.enXA}`).expect(200);
      expect(all.body.sheets.length).toBeGreaterThan(1); // every subject of the class
      const x = await hm.get(`/exams/${examId}/blank-sheets.xlsx?sectionId=${ids.enXA}&names=true`).expect(200);
      expect(x.headers['content-type']).toContain('spreadsheetml');
      await op.get(`/exams/${examId}/blank-sheets?sectionId=${ids.enXA}`).expect(403);
      // Generate: the Headmaster confirms / changes the maximum marks (saved as the Mark pattern). One sheet per subject.
      const pat = await hm.get(`/exams/pattern?classId=${ids.enX}`).expect(200);
      const geom = pat.body.subjects.find((x: { code: string }) => x.code === 'GEOM');
      const g = await hm.post('/blank-sheets', { examId, sectionId: ids.enXA, classSubjectId: geom.classSubjectId, names: true, maxima: [{ classSubjectId: geom.classSubjectId, parts: [{ key: 'ORAL', max: 20 }, { key: 'WRITTEN', max: 80 }] }] }).expect(201);
      expect(g.body.created).toHaveLength(1);
      expect(g.body.created[0].sheetNo).toMatch(/^BMS-\d{5}$/);
      const sheetId = g.body.created[0].id;
      await hm.post('/blank-sheets', { examId, sectionId: ids.enXA, classSubjectId: geom.classSubjectId }).expect(409); // only one sheet: correct it instead
      await op.post('/blank-sheets', { examId, sectionId: ids.enXA }).expect(403);
      const reg = (await hm.get('/blank-sheets').expect(200)).body;
      expect(reg[0]).toMatchObject({ id: sheetId, subject: 'Geometry', step: 'Not started' });
      // The division's operator sees it at once (and can print it), but cannot change the maximum marks.
      expect((await op.get('/blank-sheets').expect(200)).body.map((x: { id: number }) => x.id)).toContain(sheetId);
      const asOp = (await op.get(`/blank-sheets/${sheetId}`).expect(200)).body;
      expect(asOp.can).toMatchObject({ editMaxima: false, enterMarks: true });
      await op.put(`/blank-sheets/${sheetId}/maxima`, { parts: [{ key: 'WRITTEN', max: 100 }] }).expect(403);
      expect((await op.get(`/blank-sheets/${sheetId}.xlsx`).expect(200)).headers['content-type']).toContain('spreadsheetml');
      // The Headmaster corrects the same sheet: back to the default pattern.
      const fixed = await hm.put(`/blank-sheets/${sheetId}/maxima`, { parts: geom.defaultParts }).expect(200);
      expect(fixed.body.sheets[0].columns.map((c: { key: string }) => c.key)).toEqual(['HOMEWORK', 'MCQ', 'TOTAL_A', 'WRITTEN', 'TOTAL_B', 'TOTAL']);
      expect(fixed.body.withNames).toBe(true);
    });

    it('the Headmaster can change a class pattern while no marks are submitted', async () => {
      const pat = await hm.get(`/exams/pattern?classId=${ids.enX}`).expect(200);
      const geom = pat.body.subjects.find((s: { code: string }) => s.code === 'GEOM');
      expect(geom.exams[0].parts.map((p: { key: string }) => p.key)).toEqual(['HOMEWORK', 'MCQ', 'WRITTEN']);
      await op.put('/exams/pattern', { classId: ids.enX, examIds: [examId], items: [{ classSubjectId: geom.classSubjectId, parts: [{ key: 'WRITTEN', max: 100 }] }] }).expect(403);
      const saved = await hm.put('/exams/pattern', { classId: ids.enX, examIds: [examId], items: [{ classSubjectId: geom.classSubjectId, parts: [{ key: 'ORAL', max: 20 }, { key: 'WRITTEN', max: 80 }] }] }).expect(200);
      expect(saved.body.subjects.find((s: { code: string }) => s.code === 'GEOM').exams[0].parts).toEqual([{ key: 'ORAL', max: 20, countAs: null }, { key: 'WRITTEN', max: 80, countAs: null }]);
      await hm.put('/exams/pattern', { classId: ids.enX, examIds: [examId], items: [{ classSubjectId: geom.classSubjectId, parts: [{ key: 'ORAL', max: 20 }, { key: 'ORAL', max: 10 }] }] }).expect(422);
      await hm.put('/exams/pattern', { classId: ids.enX, examIds: [examId], items: [{ classSubjectId: geom.classSubjectId, parts: geom.defaultParts }] }).expect(200);
    });

    it('operator enters marks; the server checks maximum marks and completeness before submission', async () => {
      // Marks are entered only on a blank mark sheet generated by the Headmaster.
      expect((await sheet(op, unit(ids.csALG))).can.edit).toBe(false);
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [] }).expect(409);
      for (const sec of [ids.enXA, ids.enXB, ids.hiXA]) await hm.post('/blank-sheets', { examId, sectionId: sec }).expect(201);
      const s = await sheet(op, unit(ids.csALG));
      expect(s.submission).toBeNull();
      expect(s.can.edit).toBe(true);
      enr = s.rows.map((r: { enrollmentId: number }) => r.enrollmentId);
      expect(enr.length).toBe(3);

      // Fill from a file: the blank sheet's own Excel, typed in and uploaded. Nothing is saved by the upload.
      const blank = (await op.get('/blank-sheets').expect(200)).body.find((x: { id: number }) => x.id === s.blankSheet.id);
      expect(blank).toBeTruthy();
      const bin = await op.get(`/blank-sheets/${s.blankSheet.id}.xlsx`).buffer(true)
        .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bin.body);
      const ws = wb.worksheets[0];
      const heads = Array.from(ws.getRow(5).values as unknown[], (v) => String(v ?? ''));
      const colOf = (label: string) => heads.findIndex((h) => h.startsWith(label));
      ws.getRow(7).getCell(colOf('Home Work')).value = 9;
      ws.getRow(7).getCell(colOf('MCQ')).value = 28;
      ws.getRow(7).getCell(colOf('Written')).value = 60;
      ws.getRow(8).getCell(colOf('Home Work')).value = 'x5';
      ws.getRow(8).getCell(colOf('Written')).value = 95; // more than 80: reported, still filled in (shown in red)
      ws.getRow(9).getCell(colOf('Written')).value = 'AB';
      const xfile = Buffer.from(await wb.xlsx.writeBuffer());
      const q = `recordType=MARKS&examId=${examId}&sectionId=${ids.enXA}&classSubjectId=${ids.csALG}`;
      const pv = (await op.upload(`/sheets/import?${q}`, 'file', xfile, 'filled.xlsx').expect(200)).body;
      expect(pv.rows).toHaveLength(3);
      expect(pv.rows[0]).toMatchObject({ enrollmentId: s.rows[0].enrollmentId, absent: false, parts: { HOMEWORK: '9', MCQ: '28', WRITTEN: '60' } });
      expect(pv.rows[1].parts).toEqual({ WRITTEN: '95' });
      expect(pv.rows[2]).toMatchObject({ absent: false, parts: { WRITTEN: 'AB' } }); // absent for that part only
      expect(pv.issues.join(' | ')).toMatch(/"x5" is not a number/);
      expect(pv.issues.join(' | ')).toMatch(/95 is more than the maximum 80/);
      expect((await sheet(op, unit(ids.csALG))).submission).toBeNull(); // not saved
      // A CSV of your own: matched by roll number, unknown rows reported.
      const roll = s.rows[1].rollNo;
      const csv = Buffer.from(`Roll No,Name,Home Work,MCQ,Written\n${roll},x,5,20,30\n999,Nobody,1,1,1\n`);
      const pc = (await op.upload(`/sheets/import?${q}`, 'file', csv, 'marks.csv').expect(200)).body;
      expect(pc).toMatchObject({ matchedBy: 'Roll No', rows: [{ enrollmentId: s.rows[1].enrollmentId, parts: { HOMEWORK: '5', MCQ: '20', WRITTEN: '30' } }] });
      expect(pc.issues[0]).toMatch(/Roll 999.*no such student/);
      await op.upload(`/sheets/import?${q}`, 'file', Buffer.from('Hello,World\n1,2\n'), 'x.csv').expect(422); // no headings
      await st.upload(`/sheets/import?${q}`, 'file', csv, 'marks.csv').expect(403); // only the operator fills marks

      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[0], parts: { HOMEWORK: 8, MCQ: 30, WRITTEN: 81 } }] }).expect(422); // Written > 80
      // AB (absent for one part) and C (copying) are kept on the sheet and count as 0, like any other mark.
      const ab = await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[0], parts: { HOMEWORK: 9, MCQ: 'ab', WRITTEN: ' c ' } }] }).expect(200);
      expect(ab.body.rows[0]).toMatchObject({ absent: false, parts: { HOMEWORK: 9, MCQ: 'AB', WRITTEN: 'C' }, marks1: 9, marks2: 0 });
      const saved = await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[0], parts: { HOMEWORK: 9, MCQ: 28, WRITTEN: 60 }, version: ab.body.rows[0].version }] }).expect(200);
      expect(saved.body.rows[0]).toMatchObject({ marks1: 16, marks2: 60 }); // 9 + 28/40→7 ; 60
      const sub = saved.body.submission;
      ids.subALG = sub.id;
      const missing = await op.post(`/submissions/${sub.id}/submit`).expect(422);
      expect(missing.body.detail).toMatch(/no marks at all for 2 students/);
      // Says which box is empty (here: only the Written exam is missing for one student).
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[1], parts: { HOMEWORK: 5, MCQ: 20 } }] }).expect(200);
      const part = await op.post(`/submissions/${sub.id}/submit`).expect(422);
      expect(part.body.detail).toMatch(/Written is empty for 1 student \(roll \d+\); no marks at all for 1 student/);
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[1], parts: { HOMEWORK: 5, MCQ: 20, WRITTEN: 30 } }, { enrollmentId: enr[2], absent: true }] }).expect(200);
      const r = await op.post(`/submissions/${sub.id}/submit`).expect(200);
      expect(r.body).toMatchObject({ stage: 'SUBJECT_VERIFY', status: 'SUBMITTED' });
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[0], parts: { HOMEWORK: 1, MCQ: 1, WRITTEN: 1 } }] }).expect(409); // locked while in review
    });

    it('only the assigned subject teacher can verify; operator, other subject teacher and Super Admin cannot', async () => {
      await op.post(`/submissions/${ids.subALG}/verify`).expect(403);
      await ct.post(`/submissions/${ids.subALG}/verify`).expect(403); // English teacher, not Algebra
      await admin.post(`/submissions/${ids.subALG}/verify`).expect(403); // Super Admin: no approval rights
      await hm.post(`/submissions/${ids.subALG}/verify`).expect(403); // Headmaster cannot skip the subject teacher
      const v = await sheet(st, unit(ids.csALG));
      expect(v.can.review).toBe(true);
      expect(v.rows.filter((r: { needsReview: boolean }) => r.needsReview)).toHaveLength(3);
    });

    it('subject teacher sends the WHOLE sheet back to the operator with the students to correct highlighted', async () => {
      await st.post(`/submissions/${ids.subALG}/reject`, { reason: 'x' }).expect(422); // note required
      const r = await st.post(`/submissions/${ids.subALG}/reject`, { reason: 'Roll 1 marks look wrong', enrollmentIds: [enr[0]] }).expect(200);
      expect(r.body).toMatchObject({ stage: 'OPERATOR', status: 'CORRECTION_REQUIRED', revision: 2, returnedFrom: 'SUBJECT_VERIFY' });
      const s = await sheet(op, unit(ids.csALG));
      const row = (i: number) => s.rows.find((x: { enrollmentId: number }) => x.enrollmentId === enr[i]);
      expect(row(0)).toMatchObject({ rowStatus: 'REJECTED', rejectReason: 'Roll 1 marks look wrong', rejectedStage: 'SUBJECT_VERIFY' });
      expect(row(1)).toMatchObject({ rowStatus: 'PENDING', rejectReason: null });
      expect(s.can.editRowsLimited).toBe(false); // the whole sheet is open again
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[0], parts: { HOMEWORK: 10, MCQ: 32, WRITTEN: 63 } }] }).expect(200);
      await op.post(`/submissions/${ids.subALG}/submit`).expect(200);
      const back = await sheet(st, unit(ids.csALG));
      expect(back.rows.filter((x: { needsReview: boolean }) => x.needsReview)).toHaveLength(3); // checked again as a whole
      const v = await st.post(`/submissions/${ids.subALG}/verify`).expect(200);
      expect(v.body.stage).toBe('CLASS_APPROVE');
    });

    it('rejection goes back one step at a time; a returned sheet can be sent further down or back up with a note', async () => {
      await st.post(`/submissions/${ids.subALG}/verify`).expect(403); // with the class teacher now
      // Class teacher → subject teacher (not straight to the operator).
      const c1 = await ct.post(`/submissions/${ids.subALG}/reject`, { reason: 'Roll 2 total does not match the answer sheet', enrollmentIds: [enr[1]] }).expect(200);
      expect(c1.body).toMatchObject({ stage: 'SUBJECT_VERIFY', status: 'RETURNED', returnedFrom: 'CLASS_APPROVE' });
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[1], parts: { HOMEWORK: 6, MCQ: 24, WRITTEN: 35 } }] }).expect(409); // not with the operator
      const atSt = await sheet(st, unit(ids.csALG));
      expect(atSt.can).toMatchObject({ sendDown: true, returnUp: true, lowerStep: 'OPERATOR', upperStep: 'CLASS_APPROVE', review: false });
      await st.post(`/submissions/${ids.subALG}/verify`).expect(409); // decide: down or up
      // The subject teacher disagrees: back up to the class teacher with a note.
      await st.post(`/submissions/${ids.subALG}/return-up`, { reason: 'x' }).expect(422);
      const up = await st.post(`/submissions/${ids.subALG}/return-up`, { reason: 'Checked against the answer sheet: 6 + 24 + 35 is right' }).expect(200);
      expect(up.body).toMatchObject({ stage: 'CLASS_APPROVE', status: 'SUBMITTED' });
      expect((await ct.post(`/submissions/${ids.subALG}/verify`).expect(200)).body.stage).toBe('HEADMASTER_APPROVE');
      // Headmaster → class teacher → subject teacher → operator.
      const h = await hm.post(`/submissions/${ids.subALG}/reject`, { reason: 'Roll 2 Written must be rechecked', enrollmentIds: [enr[1]] }).expect(200);
      expect(h.body).toMatchObject({ stage: 'CLASS_APPROVE', status: 'RETURNED', returnedFrom: 'HEADMASTER_APPROVE' });
      expect((await hm.get('/workflow/tasks').expect(200)).body.items.map((i: { submissionId: number }) => i.submissionId)).not.toContain(ids.subALG);
      expect((await ct.get('/workflow/tasks').expect(200)).body.items.map((i: { submissionId: number }) => i.submissionId)).toContain(ids.subALG);
      expect((await ct.post(`/submissions/${ids.subALG}/reject`, { reason: 'Headmaster asks to recheck roll 2' }).expect(200)).body).toMatchObject({ stage: 'SUBJECT_VERIFY', status: 'RETURNED' });
      expect((await st.post(`/submissions/${ids.subALG}/reject`, { reason: 'Please re-enter roll 2 from the answer sheet' }).expect(200)).body).toMatchObject({ stage: 'OPERATOR', status: 'CORRECTION_REQUIRED' });
      const atOp = await sheet(op, unit(ids.csALG));
      expect(atOp.rows.find((x: { enrollmentId: number }) => x.enrollmentId === enr[1])).toMatchObject({ rowStatus: 'REJECTED' }); // still highlighted
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[1], parts: { HOMEWORK: 6, MCQ: 24, WRITTEN: 35 } }] }).expect(200);
      expect((await op.post(`/submissions/${ids.subALG}/submit`).expect(200)).body.stage).toBe('SUBJECT_VERIFY'); // every step again
      await st.post(`/submissions/${ids.subALG}/verify`).expect(200);
      await ct.post(`/submissions/${ids.subALG}/verify`).expect(200);
      const done = await hm.post(`/submissions/${ids.subALG}/verify`).expect(200);
      expect(done.body).toMatchObject({ stage: 'DONE', status: 'APPROVED' });
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[0], parts: { HOMEWORK: 1, MCQ: 1, WRITTEN: 1 } }] }).expect(409); // locked
      const hist = await sheet(hm, unit(ids.csALG));
      expect(hist.history.map((x: { action: string }) => x.action).reverse()).toEqual([
        'SUBMIT', 'SEND_BACK', 'RESUBMIT', 'VERIFY', 'SEND_BACK', 'RETURN_UP', 'APPROVE', 'SEND_BACK', 'SEND_BACK', 'SEND_BACK', 'RESUBMIT', 'VERIFY', 'APPROVE', 'APPROVE',
      ]);
    });

    it('nobody can verify data they entered themselves, whatever roles they hold', async () => {
      const u = unit(ids.csALG, ids.enXB);
      const s = await sheet(st, u);
      await st.put('/sheets', { unit: u, rows: s.rows.map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, parts: { HOMEWORK: 7, MCQ: 28, WRITTEN: 50 } })) }).expect(200);
      const sub = (await sheet(st, u)).submission;
      await st.post(`/submissions/${sub.id}/submit`).expect(200);
      const v = await sheet(st, u);
      expect(v.can).toMatchObject({ review: false, ownWorkBlocked: true });
      const r = await st.post(`/submissions/${sub.id}/verify`).expect(403);
      expect(r.body.detail).toMatch(/You entered this data/);
    });

    it('only the Headmaster can reopen approved marks, with a reason; the rows re-run every stage', async () => {
      await op.post(`/submissions/${ids.subALG}/reopen`, { reason: 'Re-check' }).expect(403);
      await hm.post(`/submissions/${ids.subALG}/reopen`, { reason: 'Parent complaint about roll 3', enrollmentIds: [enr[2]] }).expect(200);
      await op.put('/sheets', { unit: unit(ids.csALG), rows: [{ enrollmentId: enr[2], parts: { HOMEWORK: 3, MCQ: 12, WRITTEN: 20 } }] }).expect(200);
      expect((await op.post(`/submissions/${ids.subALG}/submit`).expect(200)).body.stage).toBe('SUBJECT_VERIFY');
      for (const who of [st, ct, hm]) await who.post(`/submissions/${ids.subALG}/verify`).expect(200);
      expect((await sheet(hm, unit(ids.csALG))).submission.status).toBe('APPROVED');
    });

    it('attendance: operator enters a month, the class teacher (no verifier assigned) checks it, the Headmaster approves', async () => {
      const u = { recordType: 'ATTENDANCE', sectionId: ids.enXA, period: '2026-06' };
      const s = await sheet(op, u);
      await op.put('/sheets', { unit: u, rows: s.rows.map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, presentDays: 20 })) }).expect(422); // working days missing
      await op.put('/sheets', { unit: u, workingDays: 22, rows: [{ enrollmentId: enr[0], presentDays: 23 }] }).expect(422); // more than working days
      await op.put('/sheets', { unit: u, workingDays: 22, rows: s.rows.map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, presentDays: 20 })) }).expect(200);
      const sub = (await sheet(op, u)).submission;
      await op.post(`/submissions/${sub.id}/submit`).expect(200);
      const v = await ct.post(`/submissions/${sub.id}/verify`).expect(200);
      expect(v.body.stage).toBe('HEADMASTER_APPROVE'); // class teacher's check counts for both stages
      await admin.post(`/submissions/${sub.id}/verify`).expect(403);
      expect((await hm.post(`/submissions/${sub.id}/verify`).expect(200)).body.status).toBe('APPROVED');
      await op.get(q({ recordType: 'ATTENDANCE', sectionId: ids.enXA, period: '2027-07' })).expect(422); // outside the year
    });

    it('the annual report card cannot be generated until both semesters and every month are approved; a draft preview is marked as such', async () => {
      const d = await op.get(`/report-cards/division/${ids.enXA}`).expect(200); // the annual card (FINAL) by default
      expect(d.body.term).toBe('FINAL');
      expect(d.body.gate.ready).toBe(false);
      expect(d.body.can.generate).toBe(false);
      expect(d.body.gate.missing.map((m: { label: string }) => m.label)).toEqual(expect.arrayContaining(['Semester I · English', 'Attendance · Jul 2026', 'No Semester II exam is set up']));
      await op.post(`/report-cards/division/${ids.enXA}/generate`, { term: 'FINAL' }).expect(403); // operators do not make report cards
      const g = await ct.post(`/report-cards/division/${ids.enXA}/generate`, { term: 'FINAL' }).expect(409);
      expect(g.body.detail).toMatch(/not approved by the Subject Teacher, Class Teacher and Headmaster/);
      expect((await ct.post(`/report-cards/division/${ids.enXA}/generate`, { term: 'TERM1' }).expect(409)).body.detail).toMatch(/once a year, after both semesters/);
      const p = await op.get(`/report-cards/preview?enrollmentId=${enr[0]}`).expect(200);
      expect(p.body).toMatchObject({ official: false, status: 'DRAFT', term: 'FINAL' });
      await op.get(`/report-cards/division/${ids.hiXA}`).expect(200); // op1 also operates HI-X-A
      await st.get(`/report-cards/division/${ids.hiXA}`).expect(404); // not his division
    });

    it('with Semester I approved the annual card still waits for Semester II; remarks are free text by the class teacher', async () => {
      // Approve every remaining subject (assign a subject teacher where missing) and every month of Semester I.
      const subs = await admin.get(`/exams/${examId}/subjects?classId=${ids.enX}`).expect(200);
      for (const es of subs.body) {
        const u = unit(es.classSubjectId);
        let s = await sheet(op, u);
        if (s.submission?.status === 'APPROVED') continue;
        const assigned = await admin.get(`/assignments?academicYearId=${ids.year}&sectionId=${ids.enXA}&role=SUBJECT_TEACHER`).expect(200);
        if (!assigned.body.some((a: { classSubjectId: number }) => a.classSubjectId === es.classSubjectId)) {
          await admin.post('/assignments', { academicYearId: ids.year, staffId: ids.mt, role: 'SUBJECT_TEACHER', sectionId: ids.enXA, classSubjectId: es.classSubjectId }).expect(201);
        }
        await op.put('/sheets', { unit: u, rows: s.rows.map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, parts: Object.fromEntries(es.parts.map((p: { key: string; max: number }) => [p.key, p.max - 2])) })) }).expect(200);
        s = await sheet(op, u);
        await op.post(`/submissions/${s.submission.id}/submit`).expect(200);
        const teacher = assigned.body.find((a: { classSubjectId: number; staff: { id: number } }) => a.classSubjectId === es.classSubjectId)?.staff.id === ids.singh ? ct : st;
        for (const who of [teacher, ct, hm]) await who.post(`/submissions/${s.submission.id}/verify`).expect(200);
      }
      for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) {
        const u = { recordType: 'ATTENDANCE', sectionId: ids.enXA, period: m };
        const s = await sheet(op, u);
        await op.put('/sheets', { unit: u, workingDays: 24, rows: s.rows.map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, presentDays: 22 })) }).expect(200);
        const sub = (await sheet(op, u)).submission;
        await op.post(`/submissions/${sub.id}/submit`).expect(200);
        await ct.post(`/submissions/${sub.id}/verify`).expect(200);
        await hm.post(`/submissions/${sub.id}/verify`).expect(200);
      }
      // Semester I is approved, but the annual card waits for Semester II.
      const d = await op.get(`/report-cards/division/${ids.enXA}`).expect(200);
      expect(d.body.gate.ready).toBe(false);
      expect(d.body.gate.missing.map((m: { label: string }) => m.label)).toContain('No Semester II exam is set up');
      expect(d.body.gate.missing.some((m: { label: string }) => /Semester I ·/.test(m.label))).toBe(false);
      // Remarks are free text, by the class teacher (or the Headmaster); not by the operator.
      await ct.put(`/report-cards/division/${ids.enXA}/remarks`, { term: 'FINAL', items: [{ enrollmentId: enr[0], progress: 'Satisfactory', conduct: 'Good', remark: 'Regular and attentive' }] }).expect(200);
      await op.put(`/report-cards/division/${ids.enXA}/remarks`, { term: 'FINAL', items: [{ enrollmentId: enr[0], progress: 'x' }] }).expect(403);
      await op.post(`/report-cards/division/${ids.enXA}/publish`, { term: 'FINAL' }).expect(403);
      await hm.post(`/report-cards/division/${ids.enXA}/publish`, { term: 'TERM1' }).expect(409);
      const snap = (await ct.get(`/report-cards/preview?enrollmentId=${enr[0]}`).expect(200)).body.snapshot;
      expect(snap.remarks).toMatchObject({ progress: 'Satisfactory', conduct: 'Good', remark: 'Regular and attentive' });
      expect(snap.attendanceTotal.working).toBeGreaterThanOrEqual(22 + 4 * 24);
      const alg = snap.subjects.find((x: { classSubjectId: number }) => x.classSubjectId === ids.csALG);
      expect(alg.cols[0]).toMatchObject({ m1: 18, m2: 63, total: 81, max: 100, grade: 'A2' }); // 10 + 32/40→8 ; 63
      expect(snap).toHaveProperty('reopeningDate');
    });

    it('everyone sees approval progress per division within their own scope', async () => {
      const all = await hm.get(`/workflow/summary?recordType=MARKS&examId=${examId}`).expect(200);
      expect(all.body.scopeAll).toBe(true);
      const xa = all.body.divisions.find((d: { sectionId: number }) => d.sectionId === ids.enXA);
      expect(xa.buckets.APPROVED).toBe(xa.total);
      const xb = all.body.divisions.find((d: { sectionId: number }) => d.sectionId === ids.enXB);
      expect(xb.buckets.SUBJECT_VERIFY).toBe(1);
      const mine = await op.get(`/workflow/summary?recordType=MARKS&examId=${examId}`).expect(200);
      expect(mine.body.divisions.map((d: { sectionId: number }) => d.sectionId).sort()).toEqual([ids.enXA, ids.hiXA].sort());
      const att = await hm.get('/workflow/summary?recordType=ATTENDANCE&period=2026-06').expect(200);
      expect(att.body.divisions.find((d: { sectionId: number }) => d.sectionId === ids.enXA).buckets.APPROVED).toBe(1);
      const tasks = await st.get('/workflow/tasks').expect(200);
      expect(tasks.body.review).toBe(0); // the only sheet waiting for him is his own entry
    });

    it('Greensheet: totals, grades, Boys/Girls summary; only the Headmaster decides results and approval waits for every sheet', async () => {
      const gs = (await ct.get(`/greensheet/${ids.enXA}`).expect(200)).body;
      expect(gs.section.label).toBe('English-10-A');
      expect(gs.exams[0]).toMatchObject({ reportTerm: 'TERM1' });
      expect(gs.exams[1]).toBeNull();
      const s0 = gs.students.find((x: { enrollmentId: number }) => x.enrollmentId === enr[0]);
      const algRow = s0.rows.find((r: { classSubjectId: number }) => r.classSubjectId === ids.csALG);
      expect(algRow.sem[0]).toMatchObject({ fe: 18, se: 63, total: 81, grade: 'A2', parts: { HOMEWORK: 10, MCQ: 32, WRITTEN: 63 } });
      expect(algRow.average).toBeNull(); // Semester II not entered yet
      expect(gs.summary.students.total).toBe(gs.students.length);
      expect(gs.summary.appeared.total).toBe(gs.summary.students.total - gs.summary.left.total - gs.summary.absent.total);
      expect(gs.columns.fe).toEqual(expect.arrayContaining(['HOMEWORK', 'MCQ']));
      expect(gs.can).toMatchObject({ decide: false, approve: false });
      await op.put(`/greensheet/${ids.enXA}/results`, { items: [{ enrollmentId: enr[0], result: 'PASS' }] }).expect(403);
      await st.get(`/greensheet/${ids.enXA}`).expect(404); // subject teacher only: not his division's register
      const hmView = (await hm.get(`/greensheet/${ids.enXA}`).expect(200)).body;
      expect(hmView.can).toMatchObject({ decide: true, approve: false });
      expect(hmView.gate.missing.some((m: { label: string }) => /Semester II/.test(m.label))).toBe(true);
      const saved = await hm.put(`/greensheet/${ids.enXA}/results`, { items: [{ enrollmentId: enr[0], result: 'PROMOTED', grace: { [ids.csALG]: 2 }, remark: 'Grace in Algebra' }] }).expect(200);
      const d0 = saved.body.students.find((x: { enrollmentId: number }) => x.enrollmentId === enr[0]);
      expect(d0.decision).toMatchObject({ result: 'PROMOTED', grace: { [ids.csALG]: 2 } });
      await hm.post(`/greensheet/${ids.enXA}/approve`).expect(409);
      const list = await hm.get('/greensheet').expect(200);
      expect(list.body.divisions.find((d: { sectionId: number }) => d.sectionId === ids.enXA)).toMatchObject({ status: 'DRAFT' });
    });

    it('the database refuses an impossible workflow state', async () => {
      await expect(prisma.academicSubmission.update({ where: { id: BigInt(ids.subALG) }, data: { stage: 'SKIPPED' } })).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------------ Excel import and promotion
  describe('student import from the school Excel layout, and promotion', () => {
    async function schoolSheet(rows: (string | number | Date | null)[][]) {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Classwise Student List');
      ws.addRow(['Children Public School']);
      ws.addRow(['Rajaram Galli, Bhagat Singh Nagar No.2,']);
      ws.addRow(['Classwise Student List']);
      ws.addRow(['Medium  :', null, 'HINDI', 'Standard :', 'X']);
      ws.addRow(['Boys :', null, 1, 'Girls :', 2]);
      ws.addRow([]);
      ws.addRow(['Sr. No.', 'Exam No', 'GR No.', 'School UID', 'Full Name', 'Birth Date', 'Gender', 'Phone']);
      for (const r of rows) ws.addRow(r);
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    it('detects the header row, medium and standard, and flags problems before anything is saved', async () => {
      const file = await schoolSheet([
        [1, 'H2001', 'SE-9001', 'HIN2026001', 'BENVANSHI KOMAL RAJU REKHA DEVI', new Date('2011-03-14'), 'F', 9820012345],
        [2, 'H2002', 'SE-9002', null, 'SAROJ ANKIT RAMESH SUNITA', '05/08/2011', 'Male', '98200 54321'],
        [3, 'H2003', 'SE-9002', null, 'DUBEY PRIYA', null, 'X', 'abc'],
      ]);
      const r = await admin.upload('/students/import/preview', 'file', file, 'list.xlsx').expect(200);
      expect(r.body.headerRow).toBe(7);
      expect(r.body.detected).toEqual({ medium: 'HINDI', standard: 'X' });
      expect(r.body.selectedSectionId).toBe(ids.hiXA);
      const [a, b, c] = r.body.rows;
      expect(a).toMatchObject({ fullName: 'BENVANSHI KOMAL RAJU REKHA DEVI', dob: '2011-03-14', gender: 'FEMALE', phone: '9820012345', errors: [] });
      expect(a.split).toEqual({ surname: 'BENVANSHI', firstName: 'KOMAL', fatherName: 'RAJU REKHA', motherName: 'DEVI' });
      expect(b).toMatchObject({ dob: '2011-08-05', gender: 'MALE', phone: '9820054321' });
      expect(c.errors.join(' ')).toMatch(/appears twice/);
      expect(c.errors.join(' ')).toMatch(/Gender "X"/);
      expect(c.warnings.join(' ')).toMatch(/not a valid mobile/);
      await admin.upload('/students/import/preview', 'file', Buffer.from('not excel'), 'x.xlsx').expect(415);
      await op.upload('/students/import/preview', 'file', file, 'x.xlsx').expect(403); // operators cannot import
    });

    it('imports all rows in one go, or none if any row is invalid', async () => {
      const good = { rowNo: 8, fullName: 'BENVANSHI KOMAL RAJU REKHA DEVI', grNo: 'SE-9001', examNo: 'H2001', dob: '2011-03-14', gender: 'FEMALE', phone: '9820012345' };
      const dupe = { rowNo: 9, fullName: 'SAROJ ANKIT RAMESH SUNITA', grNo: 'SE-9001', gender: 'MALE' };
      const before = (await admin.get(`/students?sectionId=${ids.hiXA}`).expect(200)).body.meta.total;
      const bad = await admin.post('/students/import/commit', { sectionId: ids.hiXA, rows: [good, dupe] }).expect(409);
      expect(bad.body.detail).toMatch(/Row 9.*Nothing was imported/);
      expect((await admin.get(`/students?sectionId=${ids.hiXA}`).expect(200)).body.meta.total).toBe(before);
      const ok = await admin.post('/students/import/commit', { sectionId: ids.hiXA, rows: [good, { ...dupe, grNo: 'SE-9002' }] }).expect(200);
      expect(ok.body.created).toBe(2);
      const list = await admin.get(`/students?sectionId=${ids.hiXA}&q=BENVANSHI`).expect(200);
      const p = await admin.get(`/students/${list.body.data[0].id}`).expect(200);
      expect(p.body).toMatchObject({ grNo: 'SE-9001', surname: 'BENVANSHI', fatherName: 'RAJU REKHA' });
      expect(p.body.guardians[0]).toMatchObject({ relation: 'FATHER', name: 'RAJU REKHA BENVANSHI', mobile: '9820012345' });
      expect(p.body.current.examNo).toBe('H2001');
    });

    it('reads the school list conventions: "TEMP" GR No and "--" for a student without a surname', async () => {
      const file = await schoolSheet([
        [1, null, 'TEMP', 'HIN2026009', '-- SANA ABBAS SHANSHAH BANO', '25/11/2011', 'F', 9967616607],
        [2, null, 'TEMP', 'HIN2026010', 'CHAUHAN IVAAN GAYA PRASAD SITA', '19/08/2011', 'M', 9987824430],
      ]);
      const r = await admin.upload('/students/import/preview', 'file', file, 'list.xlsx').expect(200);
      const [a, b] = r.body.rows;
      expect(a).toMatchObject({ fullName: 'SANA ABBAS SHANSHAH BANO', grNo: null, grNoTemp: true, noSurname: true, errors: [] });
      expect(a.split).toEqual({ surname: null, firstName: 'SANA', fatherName: 'ABBAS SHANSHAH', motherName: 'BANO' });
      expect(b).toMatchObject({ grNo: null, grNoTemp: true, noSurname: false, errors: [] }); // two TEMP rows are not duplicates
      const rows = r.body.rows.map(({ errors: _e, warnings: _w, split: _s, ...x }: Record<string, unknown>) => x);
      expect((await admin.post('/students/import/commit', { sectionId: ids.hiXA, rows }).expect(200)).body.created).toBe(2);
      const list = await admin.get(`/students?sectionId=${ids.hiXA}&q=SANA ABBAS`).expect(200);
      const p = await admin.get(`/students/${list.body.data[0].id}`).expect(200);
      expect(p.body).toMatchObject({ grNo: null, grNoTemp: true, surname: null, firstName: 'SANA', fatherName: 'ABBAS SHANSHAH' });
    });

    it('next year: copy the class structure, then the Headmaster promotes, detains or passes out students', async () => {
      const years = await admin.get('/academic-years').expect(200);
      const ny = years.body.find((y: { name: string }) => y.name === '2027-28') ?? (await admin.post('/academic-years', { name: '2027-28', startDate: '2027-06-01', endDate: '2028-04-30' }).expect(201)).body;
      const copy = await admin.post(`/academic-years/${ny.id}/copy-structure`).expect(200);
      expect(copy.body.copiedClasses).toBeGreaterThan(0);
      await admin.post(`/academic-years/${ny.id}/copy-structure`).expect(409);
      const opts = await hm.get(`/promotions/${ids.hiXA}`).expect(200);
      expect(opts.body.nextYear.name).toBe('2027-28');
      expect(opts.body.isLastStandard).toBe(true); // Std X: pass out
      const active = opts.body.students.filter((s: { status: string }) => s.status === 'ACTIVE');
      const r = await hm.post('/promotions', {
        fromSectionId: ids.hiXA, detainSectionId: opts.body.detainIn[0].id,
        items: active.map((s: { enrollmentId: number }, i: number) => ({ enrollmentId: s.enrollmentId, decision: i === 0 ? 'DETAIN' : 'PASS_OUT' })),
      }).expect(200);
      expect(r.body).toMatchObject({ status: 'APPROVED', DETAIN: 1, PASS_OUT: active.length - 1 }); // the Headmaster's own promotion applies at once
      await hm.post('/promotions', { fromSectionId: ids.hiXA, detainSectionId: opts.body.detainIn[0].id, items: [{ enrollmentId: active[0].enrollmentId, decision: 'DETAIN' }] }).expect(409); // already done
      const detained = await admin.get(`/students/${active[0].student.id}`).expect(200);
      expect(detained.body.enrollments.map((e: { academicYear: { name: string }; status: string }) => `${e.academicYear.name}:${e.status}`)).toEqual(['2027-28:ACTIVE', '2026-27:DETAINED']);
      await op.post('/promotions', { fromSectionId: ids.hiXA, items: [{ enrollmentId: 1, decision: 'SKIP' }] }).expect(422); // nothing chosen
    });
    let op: ReturnType<typeof as>;
    let hm: ReturnType<typeof as>;
    beforeAll(async () => {
      op = as(app, (await login(app, 'op1', 'Changed-pass2')).token);
      hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
    });
  });
  // ------------------------------------------------------------------ Fees: plans, part payments, balances
  describe('fees: one annual fee per class, a ledger per student and year, carry-forward', () => {
    let office: ReturnType<typeof as>;
    let hm: ReturnType<typeof as>;
    let studentId = 0;
    let enrollmentId = 0;
    let firstReceipt = 0;
    const acct = async (yearId?: number) => (await admin.get(`/fees/students/${studentId}${yearId ? `?academicYearId=${yearId}` : ''}`).expect(200)).body;

    beforeAll(async () => {
      const roles = await admin.get('/roles').expect(200);
      const officeRole = roles.body.find((r: { code: string }) => r.code === 'OFFICE_STAFF').id;
      await admin.post('/users', { username: 'clerk1', temporaryPassword: 'Strong-pass1', roles: [{ roleId: officeRole, scopeType: 'SCHOOL' }] }).expect(201);
      const first = await login(app, 'clerk1', 'Strong-pass1');
      await as(app, first.token).post('/auth/change-password', { currentPassword: 'Strong-pass1', newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
      office = as(app, (await login(app, 'clerk1', 'Changed-pass2')).token); // Office Staff: collects, no concessions or cancellations
      hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
    });

    it('sets one annual fee per class; there are no fee categories', async () => {
      const list = await admin.get('/fees/class-fees').expect(200);
      expect(list.body.classes.find((c: { classId: number }) => c.classId === ids.enX).amount).toBeNull();
      await office.put(`/fees/class-fees/${ids.enX}`, { amount: 10000 }).expect(403); // office collects, does not set fees
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: -5 }).expect(422);
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: 10000 }).expect(200);
      const again = await admin.get('/fees/class-fees').expect(200);
      expect(again.body.classes.find((c: { classId: number }) => c.classId === ids.enX).amount).toBe(10000);
      await admin.get('/fees/heads').expect(404); // fee heads no longer exist
    });

    it('a newly admitted student gets a ledger with the class fee at once; RTE admissions pay nothing for the year', async () => {
      const s = await admin.post('/students', { student: { grNo: nextGr(), fullName: 'KHAN ZAID IRFAN SHABNAM', gender: 'MALE' }, enrollment: { sectionId: ids.enXA, joinedOn: '2026-06-15' } }).expect(201);
      studentId = s.body.id;
      const a = await acct();
      enrollmentId = a.enrollmentId;
      expect(a.ledger).toMatchObject({ previousOutstanding: 0, currentYearFee: 10000, concession: 0, totalPayable: 10000, paid: 0, balance: 10000, state: 'DUE', isFirstYear: true, canCollect: true });
      const rte = await admin.post('/students', { student: { grNo: nextGr(), fullName: 'MORE PRIYA ANIL ASHA', gender: 'FEMALE', isRte: true }, enrollment: { sectionId: ids.enXA, joinedOn: '2026-06-15' } }).expect(201);
      const r = (await admin.get(`/fees/students/${rte.body.id}`).expect(200)).body;
      expect(r.ledger).toMatchObject({ currentYearFee: 10000, concession: 10000, totalPayable: 0, balance: 0 });
    });

    it('an opening balance from before the ERP is "previous year outstanding", kept apart from this year\'s fee', async () => {
      const a = await acct();
      await office.patch(`/fees/ledgers/${a.ledgerId}/opening`, { amount: 1500, reason: 'From the 2025-26 register' }).expect(403);
      await admin.patch(`/fees/ledgers/${a.ledgerId}/opening`, { amount: 1500 }).expect(422); // reason needed
      await admin.patch(`/fees/ledgers/${a.ledgerId}/opening`, { amount: 1500, reason: 'From the 2025-26 register' }).expect(200);
      expect((await acct()).ledger).toMatchObject({ previousOutstanding: 1500, currentYearFee: 10000, totalPayable: 11500, balance: 11500, openingReason: 'From the 2025-26 register' });
    });

    it('a part payment clears the previous year first; the receipt shows the ledger and only today\'s amount', async () => {
      await office.post('/fees/payments', { enrollmentId, paidOn: '2026-07-01', amount: 20000, mode: 'CASH' }).expect(422); // more than balance
      await office.post('/fees/payments', { enrollmentId, paidOn: '2026-07-01', amount: 200, mode: 'UPI' }).expect(422); // UTR required
      await office.post('/fees/payments', { enrollmentId, paidOn: '2099-01-01', amount: 200, mode: 'CASH' }).expect(422); // future date
      const r = await office.post('/fees/payments', { enrollmentId, paidOn: '2026-07-01', amount: 4000, mode: 'CASH', payerName: 'Irfan Khan', manualReceiptNo: 'BK-0001' }).expect(201);
      firstReceipt = r.body.id;
      expect(r.body.receiptNo).toMatch(/^FR\/2026-27\/\d{5}$/);
      expect(r.body).toMatchObject({ amount: 4000, amountInWords: 'Four Thousand Rupees Only', mode: 'CASH' });
      expect(r.body.ledger).toEqual({ previousOutstanding: 1500, currentYearFee: 10000, concession: 0, currentYearNet: 10000, penalty: 0, totalPayable: 11500, paidBefore: 0, paidToday: 4000, totalPaid: 4000, balanceAfter: 7500 });
      expect(r.body.student).toMatchObject({ fullName: 'KHAN ZAID IRFAN SHABNAM', year: '2026-27' });
      expect(r.body.student.grNo).toBeTruthy(); // admission number
      const second = await office.post('/fees/payments', { enrollmentId, paidOn: '2026-08-01', amount: 1000, mode: 'CHEQUE', reference: '004512', manualReceiptNo: 'BK-0002' }).expect(201);
      // The second receipt shows what was paid before it, and only its own 1,000 as paid today.
      expect(second.body.ledger).toMatchObject({ paidBefore: 4000, paidToday: 1000, totalPaid: 5000, balanceAfter: 6500 });
      const a = await acct();
      expect(a.ledger).toMatchObject({ paid: 5000, paidTowardsPrevious: 1500, previousStillDue: 0, balance: 6500, state: 'PART_PAID' });
      // Reprinting the first receipt still shows the figures of that day.
      expect((await admin.get(`/fees/payments/${firstReceipt}`).expect(200)).body.ledger).toMatchObject({ paidToday: 4000, balanceAfter: 7500 });
    });

    it('a concession (Headmaster, with reason) reduces this year\'s fee; it cannot exceed the fee', async () => {
      const a = await acct();
      await office.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: 1000, reason: 'Sibling' }).expect(403);
      await admin.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: 1000, reason: 'Sibling' }).expect(403); // only the Headmaster
      expect((await admin.get(`/fees/students/${a.student.id}`).expect(200)).body.ledger.canDiscount).toBe(false);
      expect((await hm.get(`/fees/students/${a.student.id}`).expect(200)).body.ledger.canDiscount).toBe(true);
      await hm.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: 1000 }).expect(422);
      await hm.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: 10001, reason: 'Too much' }).expect(422);
      await hm.patch(`/fees/ledgers/${a.ledgerId}/concession`, { concession: 1000, reason: 'Sibling discount' }).expect(200);
      expect((await acct()).ledger).toMatchObject({ concession: 1000, currentYearNet: 9000, totalPayable: 10500, balance: 5500 });
    });

    it('a class fee cannot drop below what a student has already paid', async () => {
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: 1000 }).expect(409); // Zaid paid 3,500 towards this year
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: 10000 }).expect(200);
    });

    it('fee due dates: a minimum to pay by each date (in total); the class fee is not changed; late fees by the Headmaster, removed with a reason', async () => {
      const today = (require('@cps/shared') as typeof import('@cps/shared')).todayIn('Asia/Kolkata');
      const dates = ['2026-08-10', '2026-10-10', '2026-12-10', '2027-02-10'];
      const instalments = dates.map((dueDate, i) => ({ seq: i + 1, label: `${['1st', '2nd', '3rd', '4th'][i]} due date`, dueDate, amount: i === 0 ? 5000 : 4500 }));
      // The same minimums for all classes; Std X has its own.
      const plan = { academicYearId: ids.year, instalments, classes: [{ classId: ids.enX, amounts: [4000, 2000, 2000, 2000] }] };
      await office.put('/fees/instalments', plan).expect(403);
      await admin.put('/fees/instalments', { ...plan, instalments: [...instalments.slice(0, 3), { ...instalments[3], dueDate: '2026-11-01' }] }).expect(422); // dates in order
      await admin.put('/fees/instalments', { ...plan, classes: [{ classId: ids.enX, amounts: [4000, 2000] }] }).expect(422);
      await admin.put('/fees/instalments', plan).expect(200);
      const view = (await admin.get('/fees/instalments').expect(200)).body;
      expect(view.instalments.map((i: { label: string; amount: number }) => `${i.label}:${i.amount}`)).toEqual(instalments.map((i) => `${i.label}:${i.amount}`));
      expect(view.classes.find((c: { classId: number }) => c.classId === ids.enX)).toMatchObject({ classFee: 10000, amounts: [4000, 2000, 2000, 2000] });
      expect(view.classes.find((c: { classId: number }) => c.classId !== ids.enX).amounts).toBeNull(); // uses the amounts for all classes
      // Zaid: last year 1,500 due by the 1st date; the 1,000 discount comes off the last date; 5,000 paid.
      let a = await acct();
      expect(a.ledger.currentYearFee).toBe(10000); // the class fee is not changed by the due dates
      expect(a.instalments.lines.map((l: { amount: number; previous: number; paid: number }) => [l.amount, l.previous, l.paid])).toEqual([[4000, 1500, 5000], [2000, 0, 0], [2000, 0, 0], [1000, 0, 0]]);
      if (today > '2026-08-10') {
        expect(a.instalments.lines[0].status).toBe('OVERDUE');
        const first = view.instalments[0].id;
        const d = (await admin.get(`/fees/instalments/${first}/defaulters`).expect(200)).body;
        const zaid = d.rows.find((r: { studentId: number }) => r.studentId === studentId);
        expect(zaid).toMatchObject({ balance: 500, penalty: null });
        expect(d.rows.some((r: { fullName: string }) => /MORE PRIYA/.test(r.fullName))).toBe(false); // RTE: never charged
        await admin.post(`/fees/instalments/${first}/penalty`, { amount: 100, ledgerIds: [zaid.ledgerId] }).expect(403); // Headmaster only
        const pen = await hm.post(`/fees/instalments/${first}/penalty`, { amount: 100, ledgerIds: [zaid.ledgerId] }).expect(200);
        expect(pen.body).toMatchObject({ charged: 1, total: 100 });
        await hm.post(`/fees/instalments/${first}/penalty`, { amount: 100, ledgerIds: [zaid.ledgerId] }).expect(409); // once per date
        a = await acct();
        expect(a.ledger).toMatchObject({ penalty: 100, balance: 5600 });
        expect(a.penalties).toEqual([expect.objectContaining({ amount: 100, status: 'ACTIVE', instalment: '1st due date' })]);
        await admin.post(`/fees/penalties/${a.penalties[0].id}/waive`, { reason: 'Genuine reason' }).expect(403);
        await hm.post(`/fees/penalties/${a.penalties[0].id}/waive`, { reason: 'x' }).expect(422);
        await hm.post(`/fees/penalties/${a.penalties[0].id}/waive`, { reason: 'Parent was in hospital' }).expect(200);
        a = await acct();
        expect(a.ledger).toMatchObject({ penalty: 0, balance: 5500 });
        expect(a.penalties[0]).toMatchObject({ status: 'WAIVED', waiveReason: 'Parent was in hospital' });
        // Charged again (only when picked), then removed for everyone at once.
        await hm.post(`/fees/instalments/${first}/penalty`, { amount: 150 }).expect((r) => expect([200, 409]).toContain(r.status)); // others only (409 when there are none): Zaid's removed late fee is not charged again
        expect((await acct()).ledger.penalty).toBe(0);
        await hm.post(`/fees/instalments/${first}/penalty`, { amount: 150, ledgerIds: [zaid.ledgerId] }).expect(200);
        expect((await acct()).ledger).toMatchObject({ penalty: 150, balance: 5650 });
        await admin.post(`/fees/instalments/${first}/penalty/waive-all`, { reason: 'Date extended' }).expect(403);
        const all = await hm.post(`/fees/instalments/${first}/penalty/waive-all`, { reason: 'Date extended' }).expect(200);
        expect(all.body.removed).toBeGreaterThanOrEqual(1);
        expect((await acct()).ledger).toMatchObject({ penalty: 0, balance: 5500 });
        await hm.post(`/fees/instalments/${first}/penalty/waive-all`, { reason: 'Date extended' }).expect(409);
      }
      // Without its own amounts Std X uses the amounts for all classes (5,000 / 4,500 …); the last dates ask only for what is left of its 10,000 fee.
      await admin.put('/fees/instalments', { ...plan, classes: [] }).expect(200);
      a = await acct();
      expect(a.instalments.lines.map((l: { total: number }) => l.total)).toEqual([6500, 4000, 0, 0]);
      expect((await admin.get('/fees/class-fees').expect(200)).body.classes.find((c: { classId: number }) => c.classId === ids.enX).amount).toBe(10000);
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: 10000 }).expect(200); // the class fee is still set on its own
    });

    it('next year: the unpaid balance is carried forward as previous year outstanding, never added to the new fee', async () => {
      const years = (await admin.get('/academic-years').expect(200)).body;
      const cur = years.find((y: { name: string }) => y.name === '2026-27');
      const ny = years.find((y: { name: string }) => y.name === '2027-28');
      // Copy this year's class fees into the new year, then change one class without touching the old year.
      await office.post('/fees/class-fees/copy', { fromAcademicYearId: cur.id, toAcademicYearId: ny.id }).expect(403);
      const copy = await admin.post('/fees/class-fees/copy', { fromAcademicYearId: cur.id, toAcademicYearId: ny.id }).expect(200);
      expect(copy.body.copied).toBeGreaterThan(0);
      const nextFees = (await admin.get(`/fees/class-fees?academicYearId=${ny.id}`).expect(200)).body;
      const nextX = nextFees.classes.find((c: { displayName: string; mediumCode: string }) => c.mediumCode === 'EN' && c.displayName === 'ENGLISH-X');
      expect(nextX).toMatchObject({ amount: 10000, previousYearAmount: 10000 });
      await admin.put(`/fees/class-fees/${nextX.classId}`, { amount: 12000 }).expect(200);
      expect((await admin.get('/fees/class-fees').expect(200)).body.classes.find((c: { classId: number }) => c.classId === ids.enX).amount).toBe(10000); // history kept

      // Zaid is detained in Std X for 2027-28.
      const opts = await hm.get(`/promotions/${ids.enXA}`).expect(200);
      const me = opts.body.students.find((s: { student: { id: number } }) => s.student.id === studentId);
      expect(me).toMatchObject({ examNo: null, student: { studentCode: expect.any(String) } });
      const req = await office.post('/promotions', { fromSectionId: ids.enXA, detainSectionId: opts.body.detainIn[0].id, items: [{ enrollmentId: me.enrollmentId, decision: 'DETAIN' }] }).expect(200);
      expect(req.body).toMatchObject({ status: 'PENDING', students: 1 });
      await office.post('/promotions', { fromSectionId: ids.enXA, detainSectionId: opts.body.detainIn[0].id, items: [{ enrollmentId: me.enrollmentId, decision: 'DETAIN' }] }).expect(409); // one at a time
      const waiting = (await hm.get('/dashboard/overview').expect(200)).body.approvals.promotions;
      expect(waiting.items.map((x: { id: number }) => x.id)).toContain(req.body.requestId);
      await office.post(`/promotions/requests/${req.body.requestId}/approve`).expect(403);
      expect((await acct(ny.id).catch(() => null))).toBeNull(); // nothing applied yet
      const ok = await hm.post(`/promotions/requests/${req.body.requestId}/approve`).expect(200);
      expect(ok.body).toMatchObject({ status: 'APPROVED', DETAIN: 1 });
      await hm.post(`/promotions/requests/${req.body.requestId}/approve`).expect(409);

      const next = await acct(ny.id);
      expect(next.ledger).toMatchObject({ previousOutstanding: 5500, currentYearFee: 12000, concession: 0, totalPayable: 17500, paid: 0, balance: 17500, isFirstYear: false, previousYear: '2026-27', canCollect: true });
      const old = await acct(cur.id);
      expect(old.ledger).toMatchObject({ currentYearFee: 10000, concession: 1000, paid: 5000, balance: 5500, canCollect: false, carriedTo: '2027-28' }); // unchanged
      expect(next.history.map((h: { year: { name: string }; balance: number }) => `${h.year.name}:${h.balance}`)).toEqual(['2026-27:5500', '2027-28:17500']);

      // Money is now taken on the new year's ledger only; it pays the carried-forward amount first.
      await office.post('/fees/payments', { enrollmentId, paidOn: '2026-10-01', amount: 500, mode: 'CASH', manualReceiptNo: 'BK-0003' }).expect(409);
      await admin.patch(`/fees/ledgers/${next.ledgerId}/opening`, { amount: 0, reason: 'Trying to overwrite' }).expect(409); // carried forward, not typed
      const p = await office.post('/fees/payments', { enrollmentId: next.enrollmentId, paidOn: (require('@cps/shared') as typeof import('@cps/shared')).todayIn('Asia/Kolkata'), amount: 6000, mode: 'CASH' }).expect(201);
      expect(p.body.ledger).toMatchObject({ previousOutstanding: 5500, currentYearFee: 12000, totalPayable: 17500, paidToday: 6000, balanceAfter: 11500 });
      expect((await acct(ny.id)).ledger).toMatchObject({ paidTowardsPrevious: 5500, previousStillDue: 0, balance: 11500 });
    });

    it('cancelling an old receipt puts the money back on that year, and the carried-forward amount follows', async () => {
      await office.post(`/fees/payments/${firstReceipt}/cancel`, { reason: 'Wrong student' }).expect(403);
      await hm.post(`/fees/payments/${firstReceipt}/cancel`, { reason: 'x' }).expect(422);
      await hm.post(`/fees/payments/${firstReceipt}/cancel`, { reason: 'Entered for the wrong student' }).expect(200);
      await hm.post(`/fees/payments/${firstReceipt}/cancel`, { reason: 'again please' }).expect(409);
      const years = (await admin.get('/academic-years').expect(200)).body;
      const cur = years.find((y: { name: string }) => y.name === '2026-27');
      const ny = years.find((y: { name: string }) => y.name === '2027-28');
      const old = await acct(cur.id);
      expect(old.ledger).toMatchObject({ paid: 1000, balance: 9500 });
      expect(old.payments.find((p: { id: number }) => p.id === firstReceipt)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Entered for the wrong student' });
      expect((await acct(ny.id)).ledger).toMatchObject({ previousOutstanding: 9500, totalPayable: 21500, paid: 6000, balance: 15500 });
    });

    it('register, collection report and summary add up; teachers cannot see fees', async () => {
      const reg = await admin.get(`/fees/register?sectionId=${ids.enXA}&status=BALANCE&sort=balance`).expect(200);
      expect(reg.body.data.length).toBeGreaterThan(0);
      expect(reg.body.data[0].ledger.balance).toBeGreaterThanOrEqual(reg.body.data[reg.body.data.length - 1].ledger.balance);
      const pay = await admin.get('/fees/payments?from=2026-06-01&to=2026-12-31').expect(200);
      expect(pay.body.totals).toMatchObject({ amount: 1000, receipts: 1, cancelled: 1 });
      const sum = await admin.get('/fees/summary').expect(200);
      expect(sum.body.totals.paid).toBe(1000);
      expect(sum.body.byClass.find((c: { classId: number }) => c.classId === ids.enX).students).toBeGreaterThan(0);
      const teacher = as(app, (await login(app, 'bsingh', 'Teacher-pass2')).token);
      await teacher.get('/fees/summary').expect(403);
      await teacher.get(`/fees/students/${studentId}`).expect(403);
    });

    it('amount in words uses lakh and crore', async () => {
      const { amountInWords } = await import('@cps/shared');
      expect(amountInWords(125050)).toBe('One Lakh Twenty Five Thousand Fifty Rupees Only');
      expect(amountInWords(10000000.5)).toBe('One Crore Rupees and Fifty Paise Only');
    });
  });

  describe('reports: fee reports keep previous and current year apart; student reports follow scope', () => {
    it('day-wise collection lists valid receipts with the previous / current split and totals', async () => {
      const r = await admin.get('/reports/day-wise-collection?from=2026-06-01&to=2026-12-31').expect(200);
      expect(r.body.title).toBe('Day-wise Fees Collection Report');
      expect(r.body.filters).toEqual(expect.arrayContaining([{ label: 'Academic year', value: '2026-27' }, { label: 'From', value: '01/06/2026' }]));
      // Only the 1,000 cheque receipt is still valid in 2026-27 (the 4,000 one was cancelled). It was paid after the opening balance was cleared.
      expect(r.body.meta.total).toBe(1);
      expect(r.body.rows[0]).toMatchObject({ previousCollected: 0, currentCollected: 1000, total: 1000, mode: 'Cheque', studentName: 'KHAN ZAID IRFAN SHABNAM' });
      const s = Object.fromEntries(r.body.summary.map((x: { label: string; value: number }) => [x.label, x.value]));
      expect(s).toMatchObject({ 'Total receipts': 1, 'Cash collection': 0, 'Total collection': 1000 });
      // Collection summary (shown first): one row per medium, one column per mode, then Total, Expense and Grand Total.
      const t = r.body.tables[0];
      expect(r.body.tablesFirst).toBe(true);
      expect(t.rows.map((x: { name: string }) => x.name)).toEqual(['English Medium', 'Hindi Medium', 'Total', 'Expense (approved)', 'Grand Total']);
      expect(t.rows[1]).toMatchObject({ CASH: 0, UPI: 0, CHEQUE: 0, total: 0 }); // a medium with no collection is still shown
      expect(t.rows[2]).toMatchObject({ CHEQUE: 1000, CASH: 0, total: 1000 });
      expect(t.rows[4]).toMatchObject({ CHEQUE: 1000, total: 1000 });
      // The 2027-28 receipt cleared the carried-forward balance first.
      const years = (await admin.get('/academic-years').expect(200)).body;
      const ny = years.find((y: { name: string }) => y.name === '2027-28');
      const next = await admin.get(`/reports/day-wise-collection?academicYearId=${ny.id}&from=2026-01-01&to=2027-12-31`).expect(200);
      expect(next.body.rows[0]).toMatchObject({ previousCollected: 5500, currentCollected: 500, total: 6000 });
      expect(next.body.totals).toMatchObject({ previousCollected: 5500, currentCollected: 500, total: 6000 });
      await admin.get('/reports/day-wise-collection?from=2026-12-01&to=2026-06-01').expect(422);
    });

    it('class-wise collection and pending fees add up', async () => {
      const c = await admin.get(`/reports/class-wise-collection?classIds=${ids.enX}&from=2026-06-01&to=2026-12-31`).expect(200);
      expect(c.body.rows).toHaveLength(1);
      expect(c.body.rows[0]).toMatchObject({ className: 'ENGLISH-X', currentCollected: 1000, previousCollected: 0 });
      const p = await admin.get(`/reports/pending-fees?classIds=${ids.enX}`).expect(200);
      expect(p.body.totals.pending).toBe(c.body.rows[0].outstanding);
      const noPrev = await admin.get(`/reports/pending-fees?classIds=${ids.enX}&includePrevious=false`).expect(200);
      expect(noPrev.body.columns.map((x: { key: string }) => x.key)).not.toContain('previousDue');
      const ranged = await admin.get(`/reports/pending-fees?classIds=${ids.enX}&minAmount=999999`).expect(200);
      expect(ranged.body.meta.total).toBe(0);
    });

    it('student lists: search, sort, paging, numbering, gender totals', async () => {
      const all = await admin.get('/reports/class-wise-students?status=ALL&pageSize=2').expect(200);
      expect(all.body.rows).toHaveLength(2);
      expect(all.body.rows.map((r: { srNo: number }) => r.srNo)).toEqual([1, 2]);
      const total = all.body.meta.total;
      const sum = Object.fromEntries(all.body.summary.map((x: { label: string; value: number }) => [x.label, x.value]));
      expect(sum['Male students'] + sum['Female students'] + sum['Other students']).toBe(total);
      const found = await admin.get('/reports/class-wise-students?status=ALL&q=khan zaid').expect(200);
      expect(found.body.rows.map((r: { studentName: string }) => r.studentName)).toContain('KHAN ZAID IRFAN SHABNAM');
      const sorted = await admin.get('/reports/gender-wise-students?status=ALL&sort=studentName&dir=desc&pageSize=500').expect(200);
      const names = sorted.body.rows.map((r: { studentName: string }) => r.studentName);
      expect(names).toEqual([...names].sort((a: string, b: string) => b.localeCompare(a, 'en', { numeric: true })));
      const glance = await admin.get('/reports/school-at-a-glance').expect(200);
      expect(glance.body.tables.map((t: { title: string }) => t.title)).toEqual(['Gender-wise distribution', 'Active vs inactive', 'Section-wise strength']);
      expect(glance.body.totals.total).toBe(glance.body.summary[0].value);
    });

    it('exports Excel and PDF with the whole report', async () => {
      const x = await admin.get('/reports/pending-fees/export?format=xlsx').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(x.headers['content-type']).toContain('spreadsheetml');
      expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const pdf = await admin.get('/reports/school-at-a-glance/export?format=pdf').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await admin.get('/reports/nope').expect(404);
    });

    it('teachers cannot open fee reports; their student reports show only their classes', async () => {
      const teacher = as(app, (await login(app, 'ct9', 'Changed-pass2')).token); // class teacher of HI-X-A
      await teacher.get('/reports/day-wise-collection').expect(403);
      await teacher.get('/reports/pending-fees/export?format=xlsx').expect(403);
      const list = await teacher.get('/reports/class-wise-students?status=ALL&pageSize=500').expect(200);
      expect(new Set(list.body.rows.map((r: { className: string; section: string }) => `${r.className} ${r.section}`))).toEqual(new Set(['HINDI-X A']));
    });
  });

  describe('office: staff registration, expenses and vouchers, backdated receipts', () => {
    let office: ReturnType<typeof as>;
    let hm: ReturnType<typeof as>;
    let staffId = 0;
    let voucherId = 0;
    const { todayIn } = require('@cps/shared') as typeof import('@cps/shared');
    const today = todayIn('Asia/Kolkata');
    const yesterday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
    const person = { name: 'Lata Mhatre', gender: 'FEMALE', dob: '1990-04-12', mobile: '9876543210', addressLine: 'Room 12, Shastri Nagar, Goregaon (W)' };

    beforeAll(async () => {
      const roles = await admin.get('/roles').expect(200);
      const officeRole = roles.body.find((r: { code: string }) => r.code === 'OFFICE_STAFF').id;
      await admin.post('/users', { username: 'clerk2', temporaryPassword: 'Strong-pass1', roles: [{ roleId: officeRole, scopeType: 'SCHOOL' }] }).expect(201);
      const first = await login(app, 'clerk2', 'Strong-pass1');
      await as(app, first.token).post('/auth/change-password', { currentPassword: 'Strong-pass1', newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
      office = as(app, (await login(app, 'clerk2', 'Changed-pass2')).token);
      hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
    });

    it('the office registers staff with personal details only; the record waits for the Headmaster', async () => {
      await office.post('/staff', { ...person, dob: '' }).expect(422); // date of birth is required for a registration
      await office.post('/staff', { ...person, designation: 'Teacher' }).expect(403);
      await office.post('/staff', { ...person, monthlySalary: 20000 }).expect(403);
      const r = await office.post('/staff', person).expect(201);
      staffId = r.body.id;
      expect(r.body).toMatchObject({ status: 'PENDING_ASSIGNMENT', designation: null });
      expect(r.body.employeeCode).toMatch(/^STF\d{4}$/);
      await office.patch(`/staff/${staffId}`, { ...person, altMobile: '9876500000' }).expect(200);
      await office.patch(`/staff/${staffId}`, { ...person, department: 'Primary' }).expect(403);
      await office.patch(`/staff/${staffId}`, { ...person, status: 'ACTIVE' }).expect(403);
      await office.post(`/staff/${staffId}/status`, { status: 'ACTIVE', reason: 'Joining' }).expect(403);
      const seen = await office.get(`/staff/${staffId}`).expect(200);
      expect(seen.body).toMatchObject({ altMobile: '9876500000', canSeeSalary: false, history: null });
      expect((await office.get('/staff?status=PENDING_ASSIGNMENT').expect(200)).body.data.map((s: { id: number }) => s.id)).toContain(staffId);
      await office.get('/assignments?academicYearId=1').expect(403); // "Who teaches what" stays hidden from the office
    });

    it('the Headmaster assigns employment and salary, then activates; history is kept', async () => {
      await hm.post(`/staff/${staffId}/status`, { status: 'ACTIVE', reason: 'Joined' }).expect(422); // assignments missing
      const r = await hm.patch(`/staff/${staffId}`, {
        ...person, employeeType: 'NON_TEACHING', designation: 'Accountant', department: 'Accounts', qualification: 'B.Com', joiningDate: '2026-11-01',
        employmentType: 'PERMANENT', monthlySalary: 20000, salaryMode: 'BANK_TRANSFER', bankName: 'SBI', bankAccountNo: '123456789012', bankIfsc: 'SBIN0001234',
      }).expect(200);
      expect(r.body).toMatchObject({ designation: 'Accountant', monthlySalary: 20000, status: 'PENDING_ASSIGNMENT' });
      await hm.post(`/staff/${staffId}/status`, { status: 'ACTIVE', reason: 'Joined on 1 November' }).expect(200);
      const p = await hm.get(`/staff/${staffId}`).expect(200);
      expect(p.body.status).toBe('ACTIVE');
      expect(p.body.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['CREATE', 'UPDATE', 'STATUS']));
      expect((await office.get(`/staff/${staffId}`).expect(200)).body.monthlySalary).toBeNull(); // salary hidden from the office
      // Non-teaching staff cannot be given subjects.
      const years = (await admin.get('/academic-years').expect(200)).body;
      const cur = years.find((y: { isCurrent: boolean }) => y.isCurrent);
      const cs = (await admin.get(`/classes/${ids.enX}/subjects`).expect(200)).body[0];
      await hm.post('/assignments', { academicYearId: cur.id, staffId, role: 'SUBJECT_TEACHER', sectionId: ids.enXA, classSubjectId: cs.id }).expect(422);
    });

    it('expenses: the office enters a voucher, only the Headmaster approves, only Super Admin cancels an approved one', async () => {
      const cats = (await office.get('/expense-categories').expect(200)).body;
      expect(cats).toHaveLength(12);
      const electricity = cats.find((c: { code: string }) => c.code === 'ELECTRICITY');
      expect(cats.find((c: { code: string }) => c.code === 'STAFF_SALARY').usable).toBe(false); // salary needs salary access
      const body = { expenseDate: today, categoryId: electricity.id, title: 'MSEB bill October', description: 'Electricity for October', paidTo: 'Adani Electricity', amount: 8450, mode: 'UPI' };
      await office.post('/expenses', body).expect(422); // UPI needs a reference
      const v = await office.post('/expenses', { ...body, reference: 'UTR123456789' }).expect(201);
      voucherId = v.body.id;
      expect(v.body).toMatchObject({ status: 'PENDING', amount: 8450 });
      expect(v.body.voucherNo).toMatch(/^EXP-\d{6}$/);
      const pdf = await office.get(`/expenses/${voucherId}/voucher.pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await office.upload(`/expenses/${voucherId}/attachments`, 'file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'bill.pdf').expect(200);
      await office.post(`/expenses/${voucherId}/approve`).expect(403);
      await office.post(`/expenses/${voucherId}/reject`, { reason: 'Wrong' }).expect(403);
      await hm.post(`/expenses/${voucherId}/approve`).expect(200);
      await hm.post(`/expenses/${voucherId}/approve`).expect(409);
      await office.patch(`/expenses/${voucherId}`, { ...body, reference: 'X1', amount: 1 }).expect(403);
      await office.post(`/expenses/${voucherId}/cancel`, { reason: 'Oops' }).expect(403);
      await hm.post(`/expenses/${voucherId}/cancel`, { reason: 'Oops' }).expect(403); // approved: Super Admin only
      // A second voucher by someone else is not visible to the office.
      const other = await hm.post('/expenses', { ...body, title: 'Water bill', reference: 'UTR9', categoryId: cats.find((c: { code: string }) => c.code === 'WATER').id, amount: 1200 }).expect(201);
      const mine = (await office.get('/expenses').expect(200)).body;
      expect(mine.data.map((e: { id: number }) => e.id)).toEqual([voucherId]);
      await office.get(`/expenses/${other.body.id}`).expect(404);
      await hm.post(`/expenses/${other.body.id}/reject`, { reason: 'Duplicate of the society bill' }).expect(200);
      const cancel = await admin.post(`/expenses/${voucherId}/cancel`, { reason: 'Bill paid twice; reversed' });
      expect(cancel.status).toBe(200);
      // Re-approve flow for the reports: a fresh voucher, approved.
      const v2 = await office.post('/expenses', { ...body, reference: 'UTR22', amount: 5000 }).expect(201);
      await hm.post(`/expenses/${v2.body.id}/approve`).expect(200);
    });

    it('salary vouchers: authorised users only, partial payments, no accidental second payment, never above the salary', async () => {
      const cats = (await hm.get('/expense-categories').expect(200)).body;
      const salary = cats.find((c: { code: string }) => c.code === 'STAFF_SALARY');
      const base = { expenseDate: today, categoryId: salary.id, title: 'Salary', description: 'Salary for October', paidTo: 'Lata Mhatre', mode: 'BANK_TRANSFER', reference: 'NEFT1', staffId, salaryMonth: 10, salaryYear: 2026 };
      await office.post('/expenses', { ...base, amount: 1000 }).expect(403);
      const first = await hm.post('/expenses', { ...base, amount: 15000 }).expect(201);
      expect(first.body).toMatchObject({ monthlySalary: 20000, salaryMonth: 10 });
      await hm.post('/expenses', { ...base, amount: 5000 }).expect(409); // second payment needs confirmation
      await hm.post('/expenses', { ...base, amount: 6000, confirmAdditional: true }).expect(422); // only 5,000 left
      await hm.post('/expenses', { ...base, amount: 5000, confirmAdditional: true }).expect(201);
      await hm.post('/expenses', { ...base, amount: 1, confirmAdditional: true }).expect(409); // fully paid
      const st = (await hm.get(`/expenses/salary-status?staffId=${staffId}&month=10&year=2026`).expect(200)).body;
      expect(st).toMatchObject({ monthlySalary: 20000, paid: 20000, remaining: 0 });
      await hm.post(`/expenses/${first.body.id}/approve`).expect(200);
      await office.get(`/expenses/salary-status?staffId=${staffId}&month=10&year=2026`).expect(403);
    });

    it('backdated fee collection needs a unique manual receipt number; both numbers are kept', async () => {
      const s = await admin.post('/students', { student: { grNo: nextGr(), fullName: 'PATIL OM SANJAY SNEHA', gender: 'MALE' }, enrollment: { sectionId: ids.enXA, joinedOn: '2026-06-15' } }).expect(201);
      const enrollmentId = (await admin.get(`/fees/students/${s.body.id}`).expect(200)).body.enrollmentId;
      const r0 = await office.post('/fees/payments', { enrollmentId, paidOn: yesterday, amount: 1000, mode: 'CASH' }).expect(422);
      expect(r0.body.errors[0].path).toBe('manualReceiptNo');
      const r1 = await office.post('/fees/payments', { enrollmentId, paidOn: yesterday, amount: 1000, mode: 'CASH', manualReceiptNo: 'MAN-1025' }).expect(201);
      expect(r1.body).toMatchObject({ manualReceiptNo: 'MAN-1025', isBackdated: true });
      expect(r1.body.receiptNo).toMatch(/^FR\//); // the system number is always generated
      await office.post('/fees/payments', { enrollmentId, paidOn: yesterday, amount: 500, mode: 'CASH', manualReceiptNo: 'MAN-1025' }).expect(409);
      const r2 = await office.post('/fees/payments', { enrollmentId, paidOn: today, amount: 500, mode: 'CASH' }).expect(201);
      expect(r2.body).toMatchObject({ manualReceiptNo: null, isBackdated: false });
      // The office cannot change, cancel or reverse a submitted receipt.
      await office.patch(`/fees/payments/${r1.body.id}`, { paidOn: yesterday, mode: 'UPI', reference: 'U1', manualReceiptNo: 'MAN-1025', reason: 'Was UPI' }).expect(403);
      await office.post(`/fees/payments/${r1.body.id}/reissue`, { amount: 900, reason: 'Wrong amount' }).expect(403);
      await office.post(`/fees/payments/${r1.body.id}/cancel`, { reason: 'Wrong' }).expect(403);
      // The Headmaster corrects details (with a reason) and the amount (cancel + re-issue, same manual number).
      await hm.patch(`/fees/payments/${r1.body.id}`, { paidOn: yesterday, mode: 'UPI', reference: 'UTR777', manualReceiptNo: 'MAN-1025' }).expect(422); // reason required
      const e = await hm.patch(`/fees/payments/${r1.body.id}`, { paidOn: yesterday, mode: 'UPI', reference: 'UTR777', manualReceiptNo: 'MAN-1025', reason: 'Parent paid by UPI, not cash' }).expect(200);
      expect(e.body).toMatchObject({ mode: 'UPI', receiptNo: r1.body.receiptNo });
      const fixed = await hm.post(`/fees/payments/${r1.body.id}/reissue`, { amount: 900, reason: 'Parent paid 900, not 1,000' }).expect(200);
      expect(fixed.body).toMatchObject({ amount: 900, manualReceiptNo: 'MAN-1025', isBackdated: true, status: 'VALID' });
      expect(fixed.body.receiptNo).not.toBe(r1.body.receiptNo);
      expect((await hm.get(`/fees/payments/${r1.body.id}`).expect(200)).body.status).toBe('CANCELLED');
      const logs = (await admin.get(`/audit-logs?entityType=FeePayment&pageSize=100`).expect(200)).body.data;
      expect(logs.find((l: { entityId: number; action: string }) => l.entityId === r1.body.id && l.action === 'UPDATE').reason).toBe('Parent paid by UPI, not cash');
    });

    it('office reports: backdated receipts, expenses and the income & expense summary; access by role', async () => {
      const b = await hm.get(`/reports/backdated-fees?from=2026-06-01&to=${today}`).expect(200);
      expect(b.body.rows.map((r: { manualNo: string }) => r.manualNo)).toEqual(expect.arrayContaining(['MAN-1025']));
      await office.get('/reports/backdated-fees').expect(403);
      await office.get('/reports/income-expense').expect(403);
      await office.get('/reports/day-wise-expenses').expect(403);
      expect((await office.get('/reports/staff-list').expect(200)).body.meta.total).toBeGreaterThan(0);
      await office.get('/reports/staff-salary').expect(403);
      const cw = await hm.get(`/reports/category-wise-expenses?from=2026-06-01&to=${today}`).expect(200);
      const elec = cw.body.rows.find((r: { category: string }) => r.category === 'Electricity Bill');
      expect(elec).toMatchObject({ approved: 5000, cancelled: 8450 }); // the cancelled (reversed) voucher is not counted as approved
      const ie = await hm.get(`/reports/income-expense?from=2026-06-01&to=${today}`).expect(200);
      const s = Object.fromEntries(ie.body.summary.map((x: { label: string; value: number }) => [x.label, x.value]));
      expect(s['Total approved expenses']).toBe(5000 + 15000); // electricity + the approved salary part; pending not counted
      expect(s['Net balance']).toBe(s['Total income'] - s['Total approved expenses']);
      // The day-wise collection summary deducts approved expenses by payment mode (UPI electricity bill: 5,000).
      const dw = await hm.get(`/reports/day-wise-collection?from=${today}&to=${today}`).expect(200);
      const grid = Object.fromEntries(dw.body.tables[0].rows.map((x: { name: string }) => [x.name, x]));
      expect(grid['Expense (approved)'].UPI).toBe(5000);
      expect(grid['Grand Total'].UPI).toBe(grid.Total.UPI - 5000);
      expect(grid['Grand Total'].total).toBe(grid.Total.total - grid['Expense (approved)'].total);
      const sal = await hm.get(`/reports/salary-expenses?from=2026-06-01&to=${today}`).expect(200);
      expect(sal.body.rows.map((r: { remaining: number }) => r.remaining)).toEqual([0, 0]);
    });

    it('a new admission by the office is Provisional: fees can be collected; the Headmaster confirms (GR No, roll no)', async () => {
      const body = (name: string) => ({ student: { fullName: name, gender: 'FEMALE' }, enrollment: { sectionId: ids.enXA } });
      const a = await office.post('/students', body('JADHAV SNEHA RAVI SUNITA')).expect(201);
      expect(a.body).toMatchObject({ status: 'PENDING_APPROVAL' });
      expect(a.body.grNo).toBeNull(); // no GR No until it is entered
      expect(a.body.admissionFormNo).toMatch(/^AF-2026-\d{5}$/);
      expect(a.body.enrollments[0]).toMatchObject({ status: 'PENDING_APPROVAL', rollNo: null, examNo: null });
      // Listed as Provisional for the office and Headmaster; not among confirmed students or in teachers' class lists.
      expect((await office.get(`/students?sectionId=${ids.enXA}&q=JADHAV SNEHA`).expect(200)).body.data[0]).toMatchObject({ status: 'PENDING_APPROVAL' });
      expect((await hm.get(`/students?sectionId=${ids.enXA}&status=ACTIVE&q=JADHAV SNEHA`).expect(200)).body.meta.total).toBe(0);
      expect((await hm.get(`/students?status=PENDING_APPROVAL&q=JADHAV SNEHA`).expect(200)).body.meta.total).toBe(1);
      // The fee ledger is open at once: the office collects while the admission is provisional.
      const pa = (await office.get(`/fees/students/${a.body.id}`).expect(200)).body;
      expect(pa.student.provisional).toBe(true);
      expect(pa.ledger).toMatchObject({ currentYearFee: 10000, balance: 10000, canCollect: true });
      const rc = await office.post('/fees/payments', { enrollmentId: pa.enrollmentId, paidOn: today, amount: 2500, mode: 'CASH' }).expect(201);
      expect(rc.body.student.provisional).toBe(true);
      const dash = (await hm.get('/dashboard/overview').expect(200)).body;
      expect(dash.approvals.admissions.items.map((x: { id: number }) => x.id)).toContain(a.body.id);
      expect(dash.approvals.vouchers.count).toBeGreaterThanOrEqual(0);
      expect((await office.get('/dashboard/overview').expect(200)).body.approvals).toEqual({}); // office approves nothing
      await office.post(`/students/${a.body.id}/admission/approve`, { grNo: 'SE-7001' }).expect(403);
      await office.post('/students', { student: { fullName: 'PAWAR OM', gender: 'MALE', grNo: 'SE-7002' }, enrollment: { sectionId: ids.enXA } }).expect(409); // GR No comes after confirmation
      // While provisional the office edits every section, reserved details included.
      expect((await office.get(`/students/${a.body.id}`).expect(200)).body.access).toMatchObject({ edit: true, sensitive: true, editGrNo: false });
      await office.patch(`/students/${a.body.id}`, { fullName: 'JADHAV SNEHA RAVI SUNITA', gender: 'FEMALE', category: 'OBC', religion: 'Hindu' }).expect(200);
      await office.patch(`/students/${a.body.id}/gr-no`, { grNo: 'SE-7009' }).expect(409); // not before confirmation
      // The Headmaster sends it back for correction; the office corrects and sends it again.
      await office.post(`/students/${a.body.id}/admission/return`, { reason: 'Wrong date of birth' }).expect(403);
      const ret = await hm.post(`/students/${a.body.id}/admission/return`, { reason: 'Date of birth does not match the birth certificate' }).expect(200);
      expect(ret.body.correctionNote).toBe('Date of birth does not match the birth certificate');
      expect((await office.get('/students?status=CORRECTION&q=JADHAV SNEHA').expect(200)).body.meta.total).toBe(1);
      expect((await hm.get('/dashboard/overview').expect(200)).body.approvals.admissions.items.map((x: { id: number }) => x.id)).not.toContain(a.body.id);
      await hm.post(`/students/${a.body.id}/admission/approve`, {}).expect(409); // with the office
      await office.patch(`/students/${a.body.id}`, { fullName: 'JADHAV SNEHA RAVI SUNITA', gender: 'FEMALE', dob: '2011-02-03', category: 'OBC', religion: 'Hindu' }).expect(200);
      const back = await office.post(`/students/${a.body.id}/admission/resubmit`).expect(200);
      expect(back.body).toMatchObject({ correctionNote: null, category: 'OBC', dob: '2011-02-03T00:00:00.000Z' });
      const usedGr = (await hm.get('/students?status=ACTIVE&pageSize=1').expect(200)).body.data[0].grNo;
      await hm.post(`/students/${a.body.id}/admission/approve`, { grNo: usedGr }).expect(409); // already used
      await hm.post(`/students/${a.body.id}/status`, { status: 'WITHDRAWN', effectiveDate: today, reason: 'Left' }).expect(409);
      const ok = await hm.post(`/students/${a.body.id}/admission/approve`, { grNo: 'se-7001' }).expect(200);
      expect(ok.body.status).toBe('ACTIVE');
      expect(ok.body.grNo).toBe('SE-7001');
      expect(ok.body.enrollments[0].rollNo).toBeGreaterThan(0);
      const after = (await hm.get(`/fees/students/${a.body.id}`).expect(200)).body;
      expect(after.ledger).toMatchObject({ currentYearFee: 10000, paid: 2500, balance: 7500 }); // the provisional payment stays
      expect(after.student.provisional).toBe(false);
      expect((await hm.get(`/fees/payments/${rc.body.id}`).expect(200)).body.student).toMatchObject({ provisional: false, grNo: ok.body.grNo });
      await hm.post(`/students/${a.body.id}/admission/approve`, { grNo: 'SE-7003' }).expect(409);
      // Rejected: kept on record with the reason, never in class lists or fees.
      const b = await office.post('/students', body('MORE KAVYA ANIL ASHA')).expect(201);
      await hm.post(`/students/${b.body.id}/admission/reject`, { reason: 'x' }).expect(422);
      // Fees taken for an application must be cancelled (refunded) before it can be rejected.
      const pb = (await office.get(`/fees/students/${b.body.id}`).expect(200)).body;
      const rb = await office.post('/fees/payments', { enrollmentId: pb.enrollmentId, paidOn: today, amount: 1000, mode: 'CASH' }).expect(201);
      await hm.post(`/students/${b.body.id}/admission/reject`, { reason: 'Age below the minimum for Std X' }).expect(409);
      await hm.post(`/fees/payments/${rb.body.id}/cancel`, { reason: 'Refunded: admission not given' }).expect(200);
      const r = await hm.post(`/students/${b.body.id}/admission/reject`, { reason: 'Age below the minimum for Std X' }).expect(200);
      expect(r.body.status).toBe('REJECTED');
      expect(r.body.statusHistory[0]).toMatchObject({ toStatus: 'REJECTED' });
      await office.post('/fees/payments', { enrollmentId: pb.enrollmentId, paidOn: today, amount: 500, mode: 'CASH' }).expect(409);
      expect((await office.get(`/students?status=CURRENT&q=MORE KAVYA`).expect(200)).body.meta.total).toBe(0);
      // An admission by someone who may approve (Super Admin) is confirmed at once.
      const c = await admin.post('/students', body('SHAIKH ZARA IMRAN NAZIA')).expect(201);
      expect(c.body).toMatchObject({ status: 'ACTIVE', grNo: null }); // the GR No can be added later
    });

    it('fee certificate: the office prints the annual class fee for a student; numbered, kept in a register', async () => {
      const st = await admin.post('/students', { student: { grNo: nextGr(), fullName: 'NAIK RIYA SURESH MEENA', gender: 'FEMALE' }, enrollment: { sectionId: ids.enXA } }).expect(201);
      const year = (await admin.get('/academic-years').expect(200)).body.find((y: { name: string }) => y.name === '2026-27');
      const c1 = await office.post('/fees/certificates', { studentId: st.body.id, academicYearId: year.id }).expect(201);
      expect(c1.body.certificateNo).toMatch(/^FC-\d{5}$/);
      const c = (await office.get(`/fees/certificates/${c1.body.id}`).expect(200)).body;
      expect(c).toMatchObject({ amount: 10000, amountInWords: 'Ten Thousand Rupees Only', className: 'Std X', mediumName: 'English Medium', yearName: '2026-27', currentYear: true });
      expect(c.student).toMatchObject({ fullName: 'NAIK RIYA SURESH MEENA', gender: 'FEMALE' });
      expect(c.breakdown).toMatchObject({ concession: 0, paid: 0, balance: 10000 });
      // After a part payment the next certificate shows what is already paid and the balance; the first stays as issued.
      const acc = (await office.get(`/fees/students/${st.body.id}`).expect(200)).body;
      await office.post('/fees/payments', { enrollmentId: acc.enrollmentId, paidOn: (require('@cps/shared') as typeof import('@cps/shared')).todayIn('Asia/Kolkata'), amount: 4000, mode: 'CASH' }).expect(201);
      const c2 = await office.post('/fees/certificates', { studentId: st.body.id, academicYearId: year.id }).expect(201);
      expect((await office.get(`/fees/certificates/${c2.body.id}`).expect(200)).body.breakdown).toMatchObject({ paid: 4000, balance: 6000, balanceInWords: 'Six Thousand Rupees Only' });
      expect((await office.get(`/fees/certificates/${c1.body.id}`).expect(200)).body.breakdown).toMatchObject({ paid: 0, balance: 10000 });
      expect(c2.body.certificateNo).not.toBe(c1.body.certificateNo);
      expect((await office.get(`/fees/students/${st.body.id}/certificates`).expect(200)).body).toHaveLength(2);
      // A pending admission has no certificate; teachers cannot issue one.
      const pend = await office.post('/students', { student: { fullName: 'RANE OM AJAY RUPA', gender: 'MALE' }, enrollment: { sectionId: ids.enXA } }).expect(201);
      await office.post('/fees/certificates', { studentId: pend.body.id, academicYearId: year.id }).expect(404);
      const teacher = as(app, (await login(app, 'bsingh', 'Teacher-pass2')).token);
      await teacher.post('/fees/certificates', { studentId: st.body.id, academicYearId: year.id }).expect(403);
      // Reprints show what was issued, even if the class fee changes later.
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: 10500 }).expect(200);
      expect((await office.get(`/fees/certificates/${c1.body.id}`).expect(200)).body.amount).toBe(10000);
      await admin.put(`/fees/class-fees/${ids.enX}`, { amount: 10000 }).expect(200);
    });
  });

  // ------------------------------------------------------------------ two-step sheets: Unit Test (OBT) first
  describe('a mark sheet with a Unit Test (OBT) column goes in two steps: OBT first (approved and locked), then the rest', () => {
    it('step 1 OBT only → whole chain → locked; step 2 the rest → final approval; the Headmaster can reopen the unit test', async () => {
      const roles = await admin.get('/roles').expect(200);
      const roleId = Object.fromEntries(roles.body.map((r: { code: string; id: number }) => [r.code, r.id]));
      const sem1 = (await admin.get('/exams').expect(200)).body.find((e: { code: string }) => e.code === 'SEM1');
      const hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
      const subj = (await hm.get(`/exams/pattern?classId=${ids.hiX}`).expect(200)).body.subjects[0];
      await hm.put('/exams/pattern', { classId: ids.hiX, examIds: [sem1.id], items: [{ classSubjectId: subj.classSubjectId, parts: [{ key: 'OBT', max: 20 }, { key: 'WRITTEN', max: 80 }] }] }).expect(200);
      for (const n of ['MISHRA ANU RAJ SITA', 'KHAN ZAID SALIM RUBINA']) {
        await admin.post('/students', { student: { grNo: nextGr(), fullName: n, gender: 'MALE' }, enrollment: { sectionId: ids.hiXA, joinedOn: '2026-06-15' } }).expect(201);
      }
      const person = async (code: string, name: string, user: string, roleCodes: string[]) => {
        const staffId = (await admin.post('/staff', { employeeCode: code, name }).expect(201)).body.id;
        await admin.post('/users', { username: user, staffId, temporaryPassword: 'Strong-pass1', roles: roleCodes.map((c) => ({ roleId: roleId[c], scopeType: 'ASSIGNED' })) }).expect(201);
        const first = await login(app, user, 'Strong-pass1');
        await as(app, first.token).post('/auth/change-password', { currentPassword: 'Strong-pass1', newPassword: 'Changed-pass2', confirmPassword: 'Changed-pass2' }).expect(204);
        return staffId;
      };
      const opStaff = await person('OP9', 'Unit Operator', 'op9', ['OPERATOR']);
      const tStaff = await person('TT9', 'Unit Teacher', 'tt9', ['SUBJECT_TEACHER', 'CLASS_TEACHER']);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: opStaff, role: 'OPERATOR', sectionId: ids.hiXA }).expect(201);
      await admin.post('/assignments', { academicYearId: ids.year, staffId: tStaff, role: 'SUBJECT_TEACHER', sectionId: ids.hiXA, classSubjectId: subj.classSubjectId }).expect(201);
      await admin.post(`/sections/${ids.hiXA}/class-teacher`, { staffId: tStaff }).expect(200);
      const op = as(app, (await login(app, 'op9', 'Changed-pass2')).token);
      const tt = as(app, (await login(app, 'tt9', 'Changed-pass2')).token);
      const u = { recordType: 'MARKS', examId: sem1.id, sectionId: ids.hiXA, classSubjectId: subj.classSubjectId };
      const view = async (who: ReturnType<typeof as>) => (await who.get(`/sheets?${new URLSearchParams(Object.entries(u).map(([k, v]) => [k, String(v)])).toString()}`).expect(200)).body;

      // Step 1: only OBT can be entered; no whole-subject Absent.
      let s = await view(op);
      expect(s).toMatchObject({ step: 'UNIT_TEST', lockedParts: [], can: { edit: true, editParts: ['OBT'], absentTick: false } });
      const rows = s.rows.filter((r: { enrollmentStatus: string }) => r.enrollmentStatus === 'ACTIVE');
      expect(rows.length).toBeGreaterThan(1);
      await op.put('/sheets', { unit: u, rows: [{ enrollmentId: rows[0].enrollmentId, parts: { OBT: 15, WRITTEN: 50 } }] }).expect(409); // the rest waits
      await op.put('/sheets', { unit: u, rows: [{ enrollmentId: rows[0].enrollmentId, absent: true }] }).expect(409); // use AB instead
      await op.put('/sheets', { unit: u, rows: rows.slice(1).map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, parts: { OBT: 12 } })) }).expect(200);
      s = await view(op);
      expect((await op.post(`/submissions/${s.submission.id}/submit`).expect(422)).body.detail).toMatch(/Unit Test \(OBT\) is empty for 1 student/);
      await op.put('/sheets', { unit: u, rows: [{ enrollmentId: rows[0].enrollmentId, parts: { OBT: 'ab' } }] }).expect(200);
      const id = s.submission.id;
      expect((await op.post(`/submissions/${id}/submit`).expect(200)).body.stage).toBe('SUBJECT_VERIFY'); // Written still empty: fine in step 1
      expect((await tt.post(`/submissions/${id}/verify`).expect(200)).body.stage).toBe('CLASS_APPROVE');
      expect((await tt.post(`/submissions/${id}/verify`).expect(200)).body.stage).toBe('HEADMASTER_APPROVE');
      const ok = (await hm.post(`/submissions/${id}/verify`).expect(200)).body;
      expect(ok).toMatchObject({ stage: 'OPERATOR', status: 'DRAFT', lockedParts: ['OBT'] }); // back to the operator, OBT locked

      // Performance report from the approved unit test: AB counts as 0; ranks once every subject is approved.
      const pr = (await tt.get(`/performance/report?report=UT1&sectionId=${ids.hiXA}`).expect(200)).body;
      expect(pr).toMatchObject({ report: { title: '1st Unit Test', part: 'OBT' }, earlier: [], complete: true, pending: [], maxTotal: 20 });
      // Semester I is not finished yet: its Written marks are not approved.
      expect((await tt.get(`/performance/report?report=SEM1&sectionId=${ids.hiXA}`).expect(200)).body).toMatchObject({ complete: false, pending: [pr.subjects[0].name] });
      const cs = String(subj.classSubjectId);
      const r0 = pr.students.find((x: { enrollmentId: number }) => x.enrollmentId === rows[0].enrollmentId);
      const r1 = pr.students.find((x: { enrollmentId: number }) => x.enrollmentId === rows[1].enrollmentId);
      expect(r0).toMatchObject({ marks: { [cs]: 'AB' }, total: 0, percent: 0 });
      expect(r1).toMatchObject({ marks: { [cs]: 12 }, total: 12, percent: 60, rank: 1 });
      expect(pr.summary[0]).toMatchObject({ highest: 12, failed: 0 }); // 12/20 = 60 %: passed
      expect(pr.subjects[0].teacher).toBe('Unit Teacher'); // signs the column
      expect(pr.summary[0].absentLeft).toBeGreaterThanOrEqual(1);

      // Step 2: OBT is locked; the rest opens.
      s = await view(op);
      expect(s).toMatchObject({ step: 'FINAL', lockedParts: ['OBT'], can: { editParts: ['WRITTEN'], absentTick: false } });
      await op.put('/sheets', { unit: u, rows: [{ enrollmentId: rows[1].enrollmentId, parts: { OBT: 18, WRITTEN: 40 } }] }).expect(409); // locked
      await op.put('/sheets', { unit: u, rows: rows.map((r: { enrollmentId: number }, i: number) => ({ enrollmentId: r.enrollmentId, parts: { OBT: i === 0 ? 'AB' : 12, WRITTEN: 40 } })) }).expect(200);
      expect((await view(op)).rows.find((r: { enrollmentId: number }) => r.enrollmentId === rows[1].enrollmentId)).toMatchObject({ marks1: 12, marks2: 40 });
      expect((await op.post(`/submissions/${id}/submit`).expect(200)).body.stage).toBe('SUBJECT_VERIFY');
      await hm.post(`/submissions/${id}/reopen-unit-test`, { reason: 'Recheck roll 1' }).expect(409); // being checked
      await tt.post(`/submissions/${id}/verify`).expect(200);
      await tt.post(`/submissions/${id}/verify`).expect(200);
      expect((await hm.post(`/submissions/${id}/verify`).expect(200)).body).toMatchObject({ stage: 'DONE', status: 'APPROVED' });
      // Semester I report: the Written marks (40 of 80 = 50 %), with the 1st Unit Test % next to it to follow the progress.
      const sr = (await hm.get(`/performance/report?report=SEM1&sectionId=${ids.hiXA}`).expect(200)).body;
      expect(sr).toMatchObject({ report: { title: 'Semester I', part: 'WRITTEN' }, complete: true, maxTotal: 80, earlier: [{ key: 'UT1', available: true }] });
      const s1 = sr.students.find((x: { enrollmentId: number }) => x.enrollmentId === rows[1].enrollmentId);
      expect(s1).toMatchObject({ marks: { [cs]: 40 }, total: 40, percent: 50, history: [{ key: 'UT1', percent: 60 }] });
      expect(sr.students.find((x: { enrollmentId: number }) => x.enrollmentId === rows[0].enrollmentId)).toMatchObject({ percent: 50, history: [{ key: 'UT1', percent: 0 }] });

      // The Headmaster reopens just the unit test: OBT goes back to step 1.
      await op.post(`/submissions/${id}/reopen-unit-test`, { reason: 'Recheck roll 1' }).expect(403);
      expect((await hm.post(`/submissions/${id}/reopen-unit-test`, { reason: 'Recheck roll 1 OBT' }).expect(200)).body).toMatchObject({ stage: 'OPERATOR', status: 'CORRECTION_REQUIRED', lockedParts: [] });
      expect(await view(op)).toMatchObject({ step: 'UNIT_TEST', can: { editParts: ['OBT'] } });
    });

    it('monthly performance: the subject teacher scores 9 skills (0–5) and submits; class teacher / Headmaster see it and can send it back', async () => {
      const hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
      const tt = as(app, (await login(app, 'tt9', 'Changed-pass2')).token); // subject teacher + class teacher of HI-X-A
      const op = as(app, (await login(app, 'op9', 'Changed-pass2')).token); // operator: not the subject teacher
      const months = (await tt.get('/monthly-performance/months').expect(200)).body;
      const month = months.current;
      expect(months.months.length).toBeGreaterThan(6);
      const subj = (await hm.get(`/exams/pattern?classId=${ids.hiX}`).expect(200)).body.subjects[0];
      const key = { sectionId: ids.hiXA, classSubjectId: subj.classSubjectId, month };
      const list = (await tt.get(`/monthly-performance?month=${month}`).expect(200)).body;
      expect(list.items.find((i: { sectionId: number; classSubjectId: number }) => i.sectionId === ids.hiXA && i.classSubjectId === subj.classSubjectId)).toMatchObject({ mine: true, status: 'NOT_STARTED' });
      const q = `/monthly-performance/sheet?sectionId=${key.sectionId}&classSubjectId=${key.classSubjectId}&month=${month}`;
      let s = (await tt.get(q).expect(200)).body;
      expect(s.can).toMatchObject({ edit: true, submit: true, sendBack: false });
      expect(s.skills.map((x: { label: string }) => x.label)).toEqual(['Reading', 'Writing', 'Vocabulary', 'Recitation', 'Home Work', 'Class Work', 'Understanding', 'Application', 'Completion']);
      const all = (v: number | string) => Object.fromEntries(s.skills.map((x: { key: string }) => [x.key, v]));
      await tt.put('/monthly-performance/sheet', { ...key, rows: [{ enrollmentId: s.students[0].enrollmentId, scores: { READING: 6 } }] }).expect(422); // maximum 5
      await tt.put('/monthly-performance/sheet', { ...key, rows: [{ enrollmentId: s.students[0].enrollmentId, scores: { READING: 4 } }] }).expect(200);
      expect((await tt.post('/monthly-performance/sheet/submit', key).expect(422)).body.detail).toMatch(/empty boxes/);
      await op.get(q).expect(404); // only the subject teacher, the class teacher and the Headmaster see it
      await op.put('/monthly-performance/sheet', { ...key, rows: [{ enrollmentId: s.students[0].enrollmentId, scores: { READING: 1 } }] }).expect(404);
      await tt.put('/monthly-performance/sheet', { ...key, rows: s.students.map((st: { enrollmentId: number }, i: number) => ({ enrollmentId: st.enrollmentId, scores: { ...all(4), ...(i === 0 ? { COMPLETION: 'ab' } : {}) } })) }).expect(200);
      s = (await tt.post('/monthly-performance/sheet/submit', key).expect(200)).body;
      expect(s).toMatchObject({ status: 'SUBMITTED', can: { edit: false } });
      expect(s.students[0].scores).toMatchObject({ READING: 4, COMPLETION: 'AB' });
      await tt.put('/monthly-performance/sheet', { ...key, rows: [{ enrollmentId: s.students[0].enrollmentId, scores: { READING: 5 } }] }).expect(409); // locked
      expect((await hm.get(q).expect(200)).body.can.sendBack).toBe(true);
      await op.post('/monthly-performance/sheet/send-back', { ...key, reason: 'Recheck' }).expect(404);
      expect((await tt.get(q).expect(200)).body.can.sendBack).toBe(false); // the class teacher only views
      await tt.post('/monthly-performance/sheet/send-back', { ...key, reason: 'Recheck please' }).expect(403);
      s = (await hm.post('/monthly-performance/sheet/send-back', { ...key, reason: 'Roll 1: Completion should not be AB' }).expect(200)).body;
      expect(s).toMatchObject({ status: 'RETURNED', returnNote: 'Roll 1: Completion should not be AB' });
      expect((await tt.get(q).expect(200)).body.can.edit).toBe(true); // open again for the teacher
    });

    it('the annual report card: once both semesters and every month are approved, the class teacher generates and the Headmaster publishes', async () => {
      const hm = as(app, (await login(app, 'hm1', 'Changed-pass2')).token);
      const tt = as(app, (await login(app, 'tt9', 'Changed-pass2')).token); // class teacher (and subject teacher) of HI-X-A
      const op = as(app, (await login(app, 'op9', 'Changed-pass2')).token); // operator of HI-X-A
      const sem2 = (await admin.post('/exams', { code: 'SEM2', nameEn: 'Semester II', reportTerm: 'TERM2', sequence: 2 }).expect(201)).body;
      await hm.post('/blank-sheets', { examId: sem2.id, sectionId: ids.hiXA }).expect(201);
      const ttStaff = (await admin.get(`/assignments?academicYearId=${ids.year}&sectionId=${ids.hiXA}&role=CLASS_TEACHER`).expect(200)).body[0].staff.id;
      const view = async (u: object) => (await op.get(`/sheets?${new URLSearchParams(Object.entries(u).map(([k, v]) => [k, String(v)])).toString()}`).expect(200)).body;
      // Mark sheets: operator → subject teacher → class teacher → Headmaster, in as many steps as the sheet has (unit test first).
      const approveMarks = async (u: { examId: number; sectionId: number; classSubjectId: number }) => {
        const st = (await admin.get(`/assignments?academicYearId=${ids.year}&sectionId=${ids.hiXA}&role=SUBJECT_TEACHER`).expect(200)).body;
        if (!st.some((a: { classSubjectId: number }) => a.classSubjectId === u.classSubjectId)) {
          await admin.post('/assignments', { academicYearId: ids.year, staffId: ttStaff, role: 'SUBJECT_TEACHER', sectionId: ids.hiXA, classSubjectId: u.classSubjectId }).expect(201);
        }
        for (let step = 0; step < 3; step++) {
          const s = await view({ recordType: 'MARKS', ...u });
          if (s.submission?.status === 'APPROVED') return;
          const open: string[] = s.can.editParts;
          const rows = s.rows.filter((r: { enrollmentStatus: string }) => r.enrollmentStatus === 'ACTIVE').map((r: { enrollmentId: number; parts: Record<string, unknown> | null }) => ({
            enrollmentId: r.enrollmentId,
            parts: Object.fromEntries(s.unit.pattern.map((p: { key: string; max: number }) => [p.key, r.parts?.[p.key] ?? (open.includes(p.key) ? p.max - 2 : null)])),
          }));
          await op.put('/sheets', { unit: { recordType: 'MARKS', ...u }, rows }).expect(200);
          const id = (await view({ recordType: 'MARKS', ...u })).submission.id;
          await op.post(`/submissions/${id}/submit`).expect(200);
          await tt.post(`/submissions/${id}/verify`).expect(200);
          await tt.post(`/submissions/${id}/verify`).expect(200);
          await hm.post(`/submissions/${id}/verify`).expect(200);
        }
        throw new Error('sheet not approved');
      };
      let d = (await tt.get(`/report-cards/division/${ids.hiXA}`).expect(200)).body;
      expect(d.can.generate).toBe(false);
      for (const m of d.gate.missing) {
        if (m.kind === 'MARKS') await approveMarks(m.unit);
        else if (m.kind === 'ATTENDANCE') {
          const s = await view(m.unit);
          await op.put('/sheets', { unit: m.unit, workingDays: 20, rows: s.rows.filter((r: { enrollmentStatus: string }) => r.enrollmentStatus === 'ACTIVE').map((r: { enrollmentId: number }) => ({ enrollmentId: r.enrollmentId, presentDays: 18 })) }).expect(200);
          const id = (await view(m.unit)).submission.id;
          await op.post(`/submissions/${id}/submit`).expect(200);
          await tt.post(`/submissions/${id}/verify`).expect(200);
          await hm.post(`/submissions/${id}/verify`).expect(200);
        }
      }
      d = (await tt.get(`/report-cards/division/${ids.hiXA}`).expect(200)).body;
      expect(d.gate).toMatchObject({ ready: true, missing: [] });
      expect(d.can).toMatchObject({ generate: true, publish: false, remarks: true });
      await op.post(`/report-cards/division/${ids.hiXA}/generate`, { term: 'FINAL' }).expect(403); // not the operator
      await tt.put(`/report-cards/division/${ids.hiXA}/remarks`, { term: 'FINAL', items: [{ enrollmentId: d.students[0].enrollmentId, progress: 'SATISFACTORY', conduct: 'GOOD', remark: 'Keep it up' }] }).expect(200);
      const g = (await tt.post(`/report-cards/division/${ids.hiXA}/generate`, { term: 'FINAL' }).expect(200)).body;
      expect(g.generated).toBe(d.students.length);
      d = (await hm.get(`/report-cards/division/${ids.hiXA}`).expect(200)).body;
      const card = (await hm.get(`/report-cards/${d.students[0].card.id}`).expect(200)).body;
      const snap = card.snapshot;
      expect(card).toMatchObject({ official: true, status: 'GENERATED', term: 'FINAL' });
      expect(snap.exams.map((e: { name: string }) => e.name)).toEqual(['Semester I', 'Semester II']);
      expect(snap.subjects[0].average.total).not.toBeNull();
      expect(snap.attendanceTerms.length).toBeGreaterThanOrEqual(1);
      expect(snap.remarks).toMatchObject({ progress: 'SATISFACTORY', conduct: 'GOOD', remark: 'Keep it up' });
      // School re-opening date: the start of the next academic year, when it is set up.
      const years = (await admin.get('/academic-years').expect(200)).body as { startDate: string; isCurrent: boolean }[];
      const cur = years.find((y) => y.isCurrent)!;
      const next = years.filter((y) => y.startDate > cur.startDate).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
      expect(snap.reopeningDate ? String(snap.reopeningDate).slice(0, 10) : null).toBe(next ? next.startDate.slice(0, 10) : null);
      await tt.post(`/report-cards/division/${ids.hiXA}/publish`, { term: 'FINAL' }).expect(403); // only the Headmaster publishes
      expect((await hm.post(`/report-cards/division/${ids.hiXA}/publish`, { term: 'FINAL' }).expect(200)).body.published).toBe(d.students.length);
    });

    it('admission for the next academic year: the student joins the next year class, with that year in the Student ID', async () => {
      const years = (await admin.get('/academic-years').expect(200)).body as { id: number; name: string; startDate: string; isCurrent: boolean }[];
      const cur = years.find((y) => y.isCurrent)!;
      const ny = years.find((y) => y.name === '2027-28')!;
      const ov = (await admin.get(`/students/overview?academicYearId=${ny.id}`).expect(200)).body;
      const nextSection = ov.sections.find((s: { name: string; schoolClass: { displayName: string } }) => /X$/.test(s.schoolClass.displayName) && s.name === 'A');
      expect(nextSection).toBeTruthy();
      const r = await admin.post('/students', { student: { fullName: 'DESAI NEXT YEAR AMOL SWATI', gender: 'FEMALE' }, enrollment: { sectionId: nextSection.sectionId } }).expect(201);
      const p = (await admin.get(`/students/${r.body.id}`).expect(200)).body;
      expect(p.enrollments[0]).toMatchObject({ academicYear: { name: '2027-28' } });
      expect(String(p.enrollments[0].joinedOn).slice(0, 10)).toBe(ny.startDate.slice(0, 10)); // joins when the year starts
      expect(p.studentCode).toMatch(/2027/);
      const inNext = (await admin.get(`/students?academicYearId=${ny.id}&q=DESAI NEXT`).expect(200)).body.meta.total;
      const inCurrent = (await admin.get(`/students?academicYearId=${cur.id}&q=DESAI NEXT`).expect(200)).body.meta.total;
      expect([inNext, inCurrent]).toEqual([1, 0]);
    });
  });
});
