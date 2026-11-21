# CPS School ERP

School ERP for Children Public School, Goregaon (W), Mumbai: Hindi and English medium, Maharashtra State Board.
Design documents are in [docs/](docs/README.md).

## Status
**Phase 1 (foundation)** is complete: sign-in and permissions, school setup, academic years and terms, mediums,
standards, classes and divisions, subjects and papers, grading systems, rules (policies), number formats, staff,
academic assignments (operators, subject teachers, class teachers, attendance verifiers), users, roles and audit logs.

**Students:** admission, profiles with parents, Excel import of the school's lists (all-or-nothing), photos, leaving/TC
with history, alphabetical roll numbers, year-end promotion, per-role visibility.

**Exams, marks, attendance and approvals:** exams (UT1, UT2, Semester I/II) with maximum marks per class; marks and
monthly attendance entered by operators and approved Operator → Subject Teacher → Class Teacher → Headmaster, with
row-level send-back, separation of duties and full history; an Approvals page with counts per standard and step.

**Fees:** one annual fee per class and year (copy from last year), a fee ledger per student and year (previous year
outstanding carried forward, current year fee, RTE waiver, concessions with reason), part payments, receipts showing the
ledger and the amount paid today, cancellation with reason, fee register, collection reports.

**Report cards:** generated only after every subject and month is approved by the Headmaster; frozen snapshots in the
school's CCE layout; publish by the Headmaster; consolidated marksheets.

## Stack
React 19 + Vite + Tailwind 4 + shadcn-style UI · NestJS 11 · Prisma 7 · MySQL 8.4 · Zod 4 (validation rules shared by web and API).

```
apps/api        NestJS API (+ prisma/ schema, migrations, seed; test/ end-to-end tests)
apps/web        React app
packages/shared permissions, roles, policies, grading, validation schemas (used by both apps)
docs/           design documents
school-files/   the school's original files (personal data, git-ignored)
```

## Run it

Requirements: Node 20.19+ (tested on 24).

```bash
npm install
npm run build:shared
cp apps/api/.env.example apps/api/.env      # then set JWT_ACCESS_SECRET (32+ random chars)
```

**Option A, quick try (no MySQL install, data is discarded on exit):**
```bash
npm run dev:db        # starts a temporary MySQL, migrates, seeds, prints DATABASE_URL and the admin login
# in apps/api/.env set DATABASE_URL to the URL it prints, then in two more terminals:
npm run dev:api       # http://localhost:3000
npm run dev:web       # http://localhost:5173 (or the next free port it prints)
npm run sample-data   # optional: made-up classes, staff, logins, assignments and ~580 students
```
Sample logins and things to try are in [docs/08-testing-guide.md](docs/08-testing-guide.md).

**Option B, persistent (recommended for real use):** install Docker Desktop, then
```bash
docker compose up -d                # MySQL 8.4 + Redis
npm run db:migrate && npm run db:seed   # seed prints the first Super Admin password once
npm run dev:api
npm run dev:web
```

The first login forces a password change. The Super Admin sets up the school and creates logins, but has **no
academic approval authority**; create a Headmaster login for that.

## Tests
```bash
npm test       # shared unit tests + API end-to-end tests against a real temporary MySQL 8.4
```
