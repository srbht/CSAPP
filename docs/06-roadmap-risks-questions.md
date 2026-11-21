# 06 — Development Roadmap, Testing, Risks & Open Questions

Covers **deliverables 16 (roadmap) and 17 (risks & assumptions)**, the testing strategy, and the **questions that need school confirmation**.

---

## 1. Roadmap (deliverable 16)

The school is **mid-year** (Nov 2026), so the order is tuned so that the **2026-27 Semester II / annual report cards come out of the ERP**. A "Semester I re-issue from ERP" is a stretch goal once marks are migrated.

Each phase follows the same loop: explain → DB migration → API → UI → wire to real API → permissions & validation → tests → fix → update docs. **A phase is "done" only when its acceptance criteria pass end-to-end against MySQL.**

| Phase | Deliverables | Acceptance criteria (summary) |
|---|---|---|
| **1 Foundation** | Monorepo, Docker Compose (MySQL, Redis), Prisma schema for config/security/staff, auth (login/refresh/logout/lockout), RBAC + scope framework, audit service, school profile & branding, academic years/terms, mediums, standards, classes, divisions, subjects/papers, class-subject matrix, grading systems, policies, sequences, staff, teaching assignments, app shell (sidebar, top bar, context switcher, i18n EN/HI), **seed for CPS** (2 mediums, CCE grading, policies from findings) | Admin logs in, configures EN-X-A with 9 papers; a subject teacher login sees only their assignments; unauthorized API calls → 403 (tested) |
| **2 Students** | Student CRUD, guardians, enrollments, profile with history, search, duplicate detection, status changes, roll/exam-no generation, **student import** (header detection, Google-export handling, mapping, preview, duplicates, error workbook), export, Data Quality Center, photo bulk upload | The provided Hindi X file imports 31 students with **the duplicate UID and `--` placeholders flagged**; re-import creates 0 duplicates |
| **2b Registers & certificates** *(extra)* | General Register, Leaving Certificate, Bonafide (PDF, serials, QR) | LC prints in the school's format with correct Devanagari |
| **3 Attendance** | Calendar (weekly offs, events, scoped), daily mobile marking, submit/verify, corrections + approval, **legacy monthly summary import** (the school's PDF/Excel format), monthly register, attendance reports, import/export | Importing June–Oct for 10th EM reproduces the sheet's numbers **including October** (fixing the stale 74/81 totals); monthly % uses working days only |
| **4 Exams & marks** | Exams, exam-classes, subjects, components (entered + derived), mark sheets, keyboard grid, AB/EX/NA, per-sheet Excel round-trip, marks import (UT1 photo data via template), consolidated marksheet, marks status | UT1 10th EN-A totals and % match the school's sheet exactly (145 / 80.56 % …); exceeding max is rejected server-side |
| **5 Verification** | Submission, class verify, coordinator verify, principal approve, reject/resubmit, reopen, locking, inbox, notifications, revisions/diff, audit UI | Approved sheet cannot be modified via the UI, the API, or import (tests); reopen requires a reason and is logged |
| **6 Report cards** | Result schemes, visibility engine, template designer (versioned), CPS template replicating the reference card (+ monthly attendance option), Chromium PDF worker, individual/bulk/ZIP, print, publish/supersede/revoke, QR verify, history | Reference card (Std VIII, 2025-26) **reproduced number-for-number** from seeded data; only-UT1 / UT1+Sem1 / no-Annual scenarios render the right columns; Hindi PDF passes visual check |
| **7 Reports & analytics** | Reports catalog (student, attendance, exam, performance), dashboard cards/charts/action items, PDF/XLSX/CSV exports | Every dashboard number reconciles with a direct SQL count in tests |
| **8 Import/Export Center & go-live** | Central center for all types, saved mappings, history, retry failed, large-file background processing, backups + restore drill, deployment docs, runbooks, UAT with staff, training material (EN/HI) | 10,000-row import < 2 min; restore drill succeeds; UAT sign-off |

**Indicative effort** (one senior full-stack developer working with AI assistance): P1 2–3 wk · P2 2 wk · P2b 1 wk · P3 2 wk · P4 2–3 wk · P5 1.5 wk · P6 3 wk · P7 2 wk · P8 2 wk, about **18–21 weeks** in total. Phases 3 and 4 can overlap.

### Go-live plan for 2026-27 (proposed)
1. Phase 1–2 → import **all** current student lists (both mediums).
2. Phase 3 → import June–Oct monthly attendance as approved legacy summaries; **daily attendance in ERP from a cut-over date** (e.g. 1 Dec 2026 or start of a month).
3. Phase 4–5 → import UT1 (and Sem-I if available) marks in migration mode; UT2/Sem-II entered in the ERP.
4. Phase 6 → Semester II / annual report cards from the ERP (April 2027).

## 2. Testing strategy

| Layer | Tooling | Focus |
|---|---|---|
| Domain unit | Vitest | `packages/domain`: attendance calc (half-day, leave modes, join date, holidays, special days, legacy precedence), grade bands, rounding, absent policies, aggregate columns, visibility engine, workflow state machine. **Golden tests from the school's real documents** (reference card numbers, UT1 totals, attendance sheet with October) |
| API integration | Jest + Supertest + **Testcontainers (MySQL 8, Redis)** | Every endpoint: happy path, validation errors, **403 for wrong role, 403/404 for out-of-scope data**, 409 conflicts, locked-record protection, transactions rolled back on failure |
| Import | Fixture files incl. the school's actual XLSX (anonymised copy) | Header detection, IMPORTRANGE cached values, duplicates, missing columns, wrong mapping, 10k-row file, retry failed rows, approved-marks protection |
| PDF | Worker test renders → text extraction + **visual snapshot** (pixel diff) for EN and HI templates | Devanagari shaping (conjuncts), page fit, bulk ZIP |
| E2E | Playwright | Admission → attendance → marks → 4-stage approval → publish → download PDF; teacher scope; mobile attendance at 360 px |
| Security | Automated authz matrix test (role × endpoint), ZAP baseline scan, dependency audit in CI | |
| Performance | k6 | 50 concurrent teachers saving attendance/marks; list APIs at 5k students |

The brief's §23 test list maps directly onto these suites. Each item will be a named test case.

## 3. Key risks & mitigations (deliverable 17)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Mid-year migration**: historical attendance is monthly-only, marks are on paper or in photos | Incomplete report cards | Legacy monthly summary import; migration-mode marks import with approval; cut-over at month boundary |
| R2 | Exam structure differs by standard (VIII vs X) and is only partly known | Wrong report cards | Fully configurable components/schemes; **golden tests** for each standard's card before go-live |
| R3 | Combined names cannot be split reliably | Wrong father/mother names on LC/report cards | Keep `full_name_as_recorded` as the authority; split is assisted plus a human-verified flag; DQ Center tracks progress |
| R4 | Data-quality issues (duplicate UID, placeholders) | Duplicate or merged students | Duplicate detection; nothing auto-merged; DQ Center |
| R5 | Teacher adoption (time, devices, connectivity) | Parallel Excel use continues | Mobile-first attendance, Excel round-trip per sheet, Hindi UI, short training videos, champion teacher per medium |
| R6 | Devanagari rendering in PDFs | Broken Hindi on official documents | Chromium rendering + bundled Noto/Mukta fonts + visual tests |
| R7 | Single-server hosting failure | Downtime in exam season | Off-site backups, documented restore (RTO 4 h), monitoring; managed DB optional |
| R8 | Scope size (full ERP) | Delays | Strict phase gates; extras limited to §7.1 of the PRD; future modules only designed |
| R9 | Policy ambiguity (half day, leave, absent, average) | Disputed results | Every rule is a visible policy with a default; principal signs off the policy sheet |
| R10 | PII exposure (Aadhaar, caste, phones) | Legal/reputational (DPDP Act 2023) | Encryption, masked display, permission gating, export audit, consent for WhatsApp |
| R11 | Local dev environment: **MySQL, Redis and Docker are not installed on this machine** | Blocks Phase 1 | Install Docker Desktop (recommended) or native MySQL 8 + Memurai/Redis |

### Assumptions (proceeding with these unless told otherwise)
A1 Academic year 1 June – 30 April (⚙ editable). A2 Weekly off = Sunday. A3 GR No unique across the whole school. A4 Exam No re-issued every year per medium (`H`/`E` + 4 digits). A5 Pass = 35 % per subject and overall. A6 CCE bands as in `04` §4.6. A7 Half day = 0.5. A8 Leave counts as absent but is shown separately. A9 Absent in exam → "AB", result INCOMPLETE. A10 Average column appears only after both semesters are approved. A11 Report card: A4 portrait. A12 One school (multi-branch ready). A13 Workflow has all four stages, and the coordinator stage can be switched off.

## 4. Questions for the school (please confirm)

**Data & identifiers**
1. Is the **GR No.** the official admission number, and is it shared (unique) across Hindi and English mediums?
2. What is the **School UID** (`HIN20260000712`)? Who issues it? It is duplicated for two Hindi X students (Sr. 1 and Sr. 3). Which one is correct?
3. Exam No: `E1001` on the attendance sheet vs `1001` on the UT marksheet. Are they the same number, and is it renumbered every year?
4. Roll number: is it separate from the Exam No, or is the Exam No used as the roll number?
5. Names: can the office provide father's and mother's names as separate columns (needed for LC/certificates)? What do `--` entries mean (missing surname/mother's name)?

**Calendar & attendance**
6. Academic year dates, and weekly offs (Sunday only, or also 2nd/4th Saturday)?
7. Do working days differ between standards (e.g. extra days for Std X)?
8. Half day = 0.5 present? How should **leave** count in the percentage?
9. Report card attendance: **monthly table** (as requested in the brief), **semester-wise** (as on the current card), or both?
10. From which date should teachers start daily attendance in the ERP?

**Examinations & results**
11. Is **Formative (40) = UT1 + UT2 (20 + 20)**, or are formative marks separate activities?
12. Which unit tests and exams happen for each standard (Nursery–X), with max marks?
13. Std X report card: show **Algebra/Geometry, Sci-I/Sci-II, His&PS/Geog separately**, or combined as Mathematics/Science/Social Science?
14. Hindi-medium subjects per standard (is Marathi taught? Sanskrit/Urdu options?).
15. Confirm grade bands below B2 (C1 51–60, C2 41–50, D 33–40, E1 21–32, E2 ≤ 20).
16. Pass criteria: 35 % per subject *and* overall? Are co-scholastic subjects included in pass/fail?
17. Exam absence: show "AB"? Does it count as 0 in the total?
18. After Semester I only, should the card show **Semester I only** (our default) or also a partial "Average"?
19. Is **rank** printed? Are **grace marks** used?
20. Who approves: is there an Exam Coordinator, or does the class teacher go straight to the Principal?

**Report card & documents**
21. Please share: **Hindi-medium report card**, a **Std X report card**, any primary-section (Nursery–IV) card, Leaving Certificate and Bonafide formats.
22. Paper size used for printing (A4?) and whether a student photo should be added.
23. High-resolution logo, principal's signature and stamp images.

**Operations**
24. Number of students per medium/standard (to size the server) and number of teachers.
25. Devices teachers will use (own phones / school PCs) and internet reliability in school.
26. Hosting preference (cloud VPS we manage / school's own server) and who is the system administrator.

## 5. Files still needed
See `00-school-data-findings.md` §8.
