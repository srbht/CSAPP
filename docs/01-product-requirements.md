# 01 — Product Requirements Document (PRD)

Product working name: **CPS School ERP**
First customer: Children Public School, Goregaon (W), Mumbai (Hindi medium + English medium, Maharashtra State Board).
Covers deliverables **1 (PRD), 2 (module breakdown), 3 (navigation), 15 (UI/UX screen list)** and the **additional features** proposed beyond the brief.

---

## 1. Problem

Student data, attendance and marks live in many Google Sheets/Excel files, separately for each medium and class. Totals are maintained by hand and go stale: the current attendance sheet ignores October (see `00-school-data-findings.md`). Report cards are assembled manually. There is no approval trail, no history across years, and no single source of truth.

## 2. Goals and success metrics

| Goal | Metric |
|---|---|
| ERP becomes the single source of truth | 100 % of 2026-27 students, enrollments and UT1/Sem-I marks migrated; Sheets used only as import/export |
| Teachers adopt daily use | ≥ 90 % of working days have attendance submitted by 11:00 |
| Report cards without manual work | A full class's report cards generated in < 2 min, with zero manual calculation |
| Correctness | Report-card numbers reproduce the school's verified rules (`04-business-rules.md`) in automated tests |
| Accountability | Every marks/attendance change after submission has an audit entry with a user and a reason |

## 3. Users and personas

| Persona | Primary device | Key needs |
|---|---|---|
| Subject teacher | Mobile phone / staff-room PC | Fast marks entry for assigned subjects only, Excel option |
| Class teacher | Phone for attendance, PC for review | 1-minute daily attendance, verify class marks, remarks |
| Exam coordinator | PC | Configure exams, chase missing marks, completeness checks |
| Principal / Head Mistress | PC / tablet | Approve, publish, school-wide view |
| Office staff | PC | Admissions, GR register, certificates, imports/exports, printing |
| School admin / Super admin | PC | Setup, users, permissions, backups |
| Parent (future) | Phone | Report card, attendance, notices |

## 4. Scope

### 4.1 In scope for v1 (Phases 1–8)
Dashboard · Students (incl. enrollment history, promotion, transfer, withdrawal) · Attendance (daily, calendar, corrections, legacy monthly import) · Academics setup · Examinations · Marks · Verification & approval · Dynamic report cards + template designer + PDF · Reports & analytics · Import/Export Center · Teachers & staff · Users & permissions · School settings · Audit logs · **plus the v1 extras in §7.1**.

### 4.2 Explicitly out of scope for v1
Google Sheets API/OAuth/live sync (the architecture keeps a `DataSourceConnector` seam for it) · WhatsApp sending (data model and outbox designed, not built) · Fees · Timetable · Homework · Parent portal · Library · Transport · Staff attendance · Payroll.

## 5. Module breakdown (deliverable 2)

| # | Module | Key capabilities | Phase |
|---|---|---|---|
| M1 | **Auth & Users** | Login (username/mobile + password), refresh tokens, password reset by admin, lockout, roles, configurable permissions, data scopes | 1 |
| M2 | **School Settings** | Profile, logo/stamp/signatures, academic years & terms, mediums, standards, classes & divisions, subjects & papers, grading systems, **scoped policies** (pass %, half-day weight, absent policy…), number sequences (GR, Exam No, Student ID) | 1 |
| M3 | **Teachers & Staff** | Directory, assignments (subject/class teacher/attendance) per year, workload view, link staff to user | 1 |
| M4 | **Students** | Master record + guardians (siblings share guardians), enrollments per year, search/filter, profile with full history, status changes, promotion wizard, transfer, withdrawal, documents, photo bulk upload | 2 |
| M5 | **Attendance** | Calendar (weekly offs, holidays, special working days, scoped), daily register, mark-all-present, half-day/leave, submit, corrections with approval, **legacy monthly summary import**, monthly register | 3 |
| M6 | **Examinations** | Exams per year/medium, applicable classes/divisions, subjects with **components** (Formative/Summative/Theory/Practical/Oral), max/pass marks, schedule, **derived components**, status lifecycle | 4 |
| M7 | **Marks** | Keyboard-first grid, AB/EX/NA statuses, draft autosave, Excel import/export per mark sheet, validation, class consolidated marksheet | 4 |
| M8 | **Verification & Approval** | Subject teacher → class teacher → coordinator → principal (stages configurable), reject with comment, reopen with reason, locking, pending queues | 5 |
| M9 | **Report Cards** | Result schemes (dynamic columns), template designer (versioned), preview, individual/bulk PDF, ZIP, print, publish/supersede/revoke, history, QR verification | 6 |
| M10 | **Reports & Analytics** | Student, attendance, exam and performance reports with common filters; PDF/XLSX/CSV/print; dashboard charts | 7 |
| M11 | **Import / Export Center** | Templates, upload → map → validate → preview → confirm → background process → results, error workbook, saved mappings, history, retry failed rows | 2 (students) → 8 (central) |
| M12 | **Audit Logs** | Searchable, filterable, append-only, before/after diff viewer | 1 (infra) / 5 (UI) |
| M13 | **Certificates & Registers** *(extra)* | General Register (GR) book, Leaving Certificate, Bonafide, ID cards | 2b |
| M14 | **Data Quality Center** *(extra)* | Duplicate candidates, missing fields, placeholder names, unmatched imports | 2 |
| M15 | **Notifications** *(in-app now, WhatsApp later)* | In-app tasks/alerts (pending approvals, deadlines); outbox table ready for WhatsApp/SMS | 5 / future |

## 6. Navigation structure (deliverable 3)

Global top bar: **context switcher (Academic Year · Medium)** persisted per user · global search (students by name/GR/Exam No/mobile) · notifications bell · language toggle (English / हिन्दी) · user menu.

```
Dashboard
Students
  ├─ All Students            (list, filters, import/export)
  ├─ Admissions              (new admission wizard)
  ├─ Promotion & Year-end    (wizard)
  ├─ Transfers & Withdrawals
  ├─ Certificates            (LC, Bonafide, ID cards)       [extra]
  └─ General Register        [extra]
Attendance
  ├─ Mark Attendance
  ├─ Monthly Register
  ├─ Corrections             (requests / approvals)
  ├─ Academic Calendar
  └─ Attendance Reports
Academics
  ├─ Classes & Divisions
  ├─ Subjects & Papers
  ├─ Teacher Assignments
  └─ Grading Systems
Examinations
  ├─ Exams                   (list + lifecycle)
  ├─ Result Schemes          (report-card column logic)
  └─ Exam Schedule
Marks
  ├─ My Mark Sheets          (teacher home for marks)
  ├─ Marks Entry             (grid)
  ├─ Consolidated Marksheet
  └─ Marks Status            (completion tracker)
Approvals                    (badge count; queue per stage)
Report Cards
  ├─ Generate & Publish
  ├─ Publications / History
  ├─ Templates (Designer)
  └─ Remarks & Conduct       (class-teacher entry)
Reports & Analytics
Import / Export Center
  ├─ New Import · Import History · Exports · Templates · Saved Mappings
Teachers & Staff
Users & Permissions
School Settings
  ├─ Profile · Academic Years & Terms · Mediums · Standards · Policies · Number Sequences · Backups
Data Quality                 [extra]
Audit Logs
```

The menu is permission-driven: a subject teacher sees only Dashboard, Marks (own sheets), Attendance (if assigned), Approvals (own rejections) and Students (assigned divisions, read-only). The backend enforces the same rules independently.

## 7. Additional features proposed (beyond the brief)

These are chosen for a Maharashtra-board, two-medium school that is migrating mid-year from Google Sheets.

### 7.1 Recommended for v1 (high value, modest cost)

| Feature | Why it matters for this school |
|---|---|
| **Legacy monthly-attendance import** | June–Oct 2026 exists only as monthly totals. Without it, report cards for 2026-27 would show incomplete attendance. |
| **Derived exam components** | Formative marks may be computed from UT1 + UT2 (pending confirmation). Teachers should not re-type marks. |
| **Subject → paper hierarchy** | Std X Algebra + Geometry = Mathematics, Sci-I + Sci-II = Science; the report-card roll-up is configurable. |
| **Class Consolidated Marksheet** | Reproduces the school's existing paper verification sheet (with student-signature column and on-roll/absent/passed footer). Teachers keep a familiar step. |
| **General Register & Leaving Certificate / Bonafide** | Legally required registers in Maharashtra schools and the most frequent office request. Certificates are generated from data already in the ERP, with serial numbers and a cancel/reissue audit. |
| **QR verification on report cards & certificates** | A printed card links to `/verify/<code>`, which shows the authentic published data and defeats tampered photocopies. |
| **Data Quality Center** | Surfaces duplicate UIDs, `--` placeholders, missing DOB/phone and unsplit names before they reach report cards. |
| **Bilingual UI (English + हिन्दी), Marathi-ready** | Hindi-medium staff can work in Hindi. Labels live in translation files. |
| **Remarks bank** | Pick from standard remarks in English/Hindi with one click; editable per student. |
| **Mark-entry deadlines & reminders** | Coordinator sets a due date per exam; the dashboard and notifications show overdue sheets. |
| **Year-end rollover wizard** | Clones classes, subjects, exams and policies into the next year, promotes students by result, and closes the old year read-only. |
| **Configurable number sequences** | GR No (`SE-####`), Exam No (`H####`/`E####`), Student ID (`STU######`), LC serials, generated race-free. |
| **Mobile-first attendance screen (PWA)** | Teachers mark attendance on phones. Installable, large tap targets; offline draft with sync later. |
| **Photo bulk upload (ZIP matched by GR No)** | Fast photo capture for ID cards and report cards. |
| **Automated encrypted backups + restore drill** | Daily DB dump plus binlog to off-site storage; restore tested monthly. |
| **Sensitive-data protection** | Aadhaar stored encrypted and shown masked (`XXXX-XXXX-1234`); caste/category visible only with a specific permission. |

### 7.2 Recommended for v1.x / later

ID card designer · student identifiers for government portals (PEN / APAAR / UDISE+ / SARAL export formats) · WhatsApp report-card delivery and absence alerts (designed now; see `02-architecture.md` §9) · Parent portal with OTP login · Fees · Timetable · Homework · Staff attendance · Library · Transport · Hindi name transliteration helper · offline-first attendance sync · grace-marks module (if the school uses board-style grace rules) · result-analysis comparison across years.

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | List APIs p95 < 300 ms at 5,000 students / 5 years. Marks grid save < 500 ms. 1,000 report-card PDFs < 10 min in background |
| Scale | Thousands of students, ~1.5 M attendance rows per year at full daily usage, concurrent teachers at 09:00 peak |
| Availability | School hours 07:00–19:00 IST. Planned maintenance outside these hours |
| Data safety | RPO ≤ 15 min (binlog), RTO ≤ 4 h. Nothing physically deleted that history depends on |
| Security | OWASP ASVS L2 practices; see `02-architecture.md` §7 |
| Accessibility | WCAG 2.1 AA contrast, keyboard operation of all grids/forms |
| Localisation | UI EN/HI; data fields store Unicode; PDFs render Devanagari with correct conjuncts |
| Devices | Chrome/Edge latest on PC; Android Chrome ≥ 10; layouts from 360 px wide |
| Timezone | All business dates in `Asia/Kolkata`; timestamps stored in UTC |

## 9. UI/UX screen list (deliverable 15)

Design language: clean SaaS look (shadcn/ui), left sidebar plus top bar, breadcrumbs, a consistent page header with title, filters and a primary action. Every table is server-paginated. Every destructive action is confirmed. Empty states explain the next step.

| # | Screen | Type | Notes |
|---|---|---|---|
| S1 | Login | form | Username or mobile; forgot password → "contact admin" |
| S2 | First-login password change | form | Forced when `must_change_password` |
| S3 | Dashboard | cards + charts + action list | Role-aware widgets; filters: year, medium, standard, division |
| S4 | Student list | data table | Search, filters, column visibility, bulk select → export / promote / print LC |
| S5 | Student profile | tabs | Overview · Guardians · Enrollment history · Attendance · Marks & results · Report cards · Documents · Certificates · Audit |
| S6 | Admission / edit student | multi-step form | Duplicate check runs live on name + DOB + mother's name |
| S7 | Promotion wizard | wizard | Source class → result-based suggestions → target division/roll → confirm |
| S8 | Transfer / withdraw dialog | dialog | Reason, date, optional LC generation |
| S9 | Mark attendance | mobile-first list | Default "all present"; tap to cycle P/A/L/H; counters; Save draft / Submit |
| S10 | Monthly register | grid (read) | Days × students; P/A/L/H symbols; totals; print/export |
| S11 | Attendance corrections | queue | Request → approve/reject |
| S12 | Academic calendar | calendar + list | Holidays, special working days, scoped; working-day counts per month |
| S13 | Classes & divisions | table + drawer | Per year/medium; class teacher, capacity |
| S14 | Subjects & papers | tree table | Parent subject → papers; per-medium |
| S15 | Class-subject matrix | matrix | Which subjects/papers each class takes, optional flag, order |
| S16 | Teacher assignments | matrix | Division × subject → teacher; workload sidebar |
| S17 | Grading systems | editor | Bands with live preview |
| S18 | Policies | form per scope | Inheritance shown (school → medium → standard) |
| S19 | Exams list | table + status chips | Lifecycle actions |
| S20 | Exam editor | form + subject/component grid | Bulk-apply max marks; derived-component builder |
| S21 | Result scheme editor | column builder + live preview | EXAM / AGGREGATE columns, visibility rules |
| S22 | My mark sheets | card list | Status, due date, progress % |
| S23 | Marks entry grid | spreadsheet grid | Arrow/Enter navigation, `AB`/`EX`/`NA` shortcuts, autosave, validation inline, Import/Export Excel |
| S24 | Marks status tracker | heat-map table | Division × subject status for coordinator |
| S25 | Consolidated marksheet | print view | Matches the school's current paper format |
| S26 | Approvals inbox | queue + detail | Diff vs previous version; approve/reject with comment |
| S27 | Remarks & conduct | grid | Remarks bank picker |
| S28 | Report-card generate & publish | wizard | Readiness checklist (what blocks publication) → preview → publish → bulk PDF |
| S29 | Publication history | table | Versions, supersede/revoke, download ZIP |
| S30 | Template designer | split view | Section list + properties panel ↔ live A4 preview with real student data |
| S31 | Reports center | catalog + report viewer | Common filter bar; export menu |
| S32 | Import wizard | 7-step stepper | Upload → Map → Validate → Preview → Confirm → Processing → Results |
| S33 | Import history / Export jobs | tables | Download error workbook / output |
| S34 | Staff directory & profile | table + tabs | Assignments, workload, pending tasks |
| S35 | Users & roles | tables + permission matrix editor | |
| S36 | School profile & branding | form | Upload logo, stamp, signatures |
| S37 | Academic years & terms | table | Activate / close year |
| S38 | Number sequences | table | Pattern preview |
| S39 | Data quality center | issue list | Fix-in-place links |
| S40 | Audit log viewer | table + diff drawer | |
| S41 | Certificates (LC/Bonafide) | form + preview | Serial no, reissue/cancel |
| S42 | Public verification page | public | `/verify/:code`, minimal data |
| S43 | Notifications panel | drawer | |
