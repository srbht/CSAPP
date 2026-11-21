# 05 — API Endpoint List (deliverable 7)

Base path `/api/v1`. JSON. Auth: `Authorization: Bearer <access JWT>`, except `/auth/*` and `/public/*`.

**Conventions**
- List endpoints: `?page=1&pageSize=25&sort=-createdAt&q=…&filter[field]=value`; response `{ data: [...], meta: { page, pageSize, total } }`. `pageSize ≤ 100`.
- Errors: RFC 9457 Problem Details `{ type, title, status, code, detail, errors: [{ path, code, message }] }`. Codes come from `@cps/shared` (`MARKS_EXCEED_MAX`, `SHEET_LOCKED`, `DUPLICATE_STUDENT`, …).
- Concurrency: mutable resources return `version`; PATCH/PUT require `version` in the body → `409 VERSION_CONFLICT`.
- Long operations return `202 { jobId }` → `GET /jobs/:id`.
- The **Perm** column lists the permission checked. Data scope is always applied in addition.

## Auth & session
| Method | Path | Perm | Purpose |
|---|---|---|---|
| POST | /auth/login | public | username/mobile + password → access token, sets refresh cookie |
| POST | /auth/refresh | cookie | rotate refresh, new access |
| POST | /auth/logout | auth | revoke family |
| POST | /auth/change-password | auth | |
| GET | /me | auth | profile, roles, permission codes, scopes, preferences |
| PATCH | /me/preferences | auth | language, current year/medium |

## Users, roles, audit
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET/POST | /users | users.manage | |
| GET/PATCH | /users/:id | users.manage | |
| POST | /users/:id/reset-password · /lock · /unlock | users.manage | |
| GET/POST | /roles · GET/PATCH /roles/:id | roles.manage | |
| PUT | /roles/:id/permissions | roles.manage | |
| GET | /permissions | roles.manage | catalog |
| PUT | /users/:id/roles | users.manage | role + scope list |
| GET | /audit-logs · /audit-logs/:id | audit.read | filters: user, entity, action, date |

## School settings & academics
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET/PATCH | /school | settings.manage (GET: auth) | profile |
| POST | /school/logo · /school/stamp · /school/principal-signature | settings.manage | multipart |
| CRUD | /academic-years | settings.manage | + POST /:id/activate, /:id/close |
| CRUD | /academic-years/:id/terms | settings.manage | |
| CRUD | /mediums · /standards | settings.manage | |
| CRUD | /classes | academics.manage | filter year, medium |
| CRUD | /classes/:id/sections | academics.manage | |
| CRUD | /subjects | academics.manage | tree (papers) |
| GET/PUT | /classes/:id/subjects | academics.manage | class-subject matrix, bulk |
| CRUD | /grading-systems (+ bands) | academics.manage | |
| GET | /policies/effective?scope… | auth | resolved values + origin scope |
| CRUD | /policies | settings.manage | |
| GET/PATCH | /sequences | settings.manage | + GET /sequences/:key/preview |
| CRUD | /calendar-events | attendance.calendar.manage | |
| GET | /calendar/working-days?sectionId&month | auth | per-day working flag + counts |
| POST | /academic-years/:id/rollover | settings.manage | 202; clone structure to next year |

## Staff & assignments
| Method | Path | Perm | Purpose |
|---|---|---|---|
| CRUD | /staff | staff.manage | |
| GET | /staff/:id/workload | staff.manage / self | |
| GET/POST/PATCH | /assignments | assignments.manage | filters year, staff, section |
| PUT | /sections/:id/class-teacher | assignments.manage | |
| GET | /me/assignments | auth | teacher's own divisions/subjects |

## Students
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | /students | students.read | search q (name/GR/exam no/mobile), filters year, medium, class, section, status |
| POST | /students | students.write | create student + guardians + enrollment (transaction, duplicate check) |
| POST | /students/duplicate-check | students.write | live candidates for the admission form |
| GET/PATCH | /students/:id | students.read / write | |
| GET | /students/:id/history | students.read | enrollments, status, results timeline |
| GET | /students/:id/attendance?yearId | students.read | monthly |
| GET | /students/:id/results | marks.read | |
| POST | /students/:id/photo | students.write | |
| POST | /students/photos/bulk | students.write | ZIP by GR No, 202 |
| CRUD | /students/:id/guardians · /students/:id/documents | students.write | |
| POST | /students/:id/status | students.status | withdraw / transfer / reactivate {to, date, reason} |
| POST | /enrollments/:id/change-section | students.write | |
| PATCH | /enrollments/:id | students.write | roll no, exam no |
| POST | /sections/:id/roll-numbers/generate | students.write | ordering rule |
| POST | /promotions/preview | students.promote | source class → suggested outcome per student |
| POST | /promotions/commit | students.promote | 202 |
| GET/POST | /certificates · POST /certificates/:id/cancel | certificates.* | LC, bonafide; GET /:id/pdf |
| GET | /registers/general-register | students.read | GR book, export |
| GET | /data-quality/issues · POST /data-quality/issues/:id/resolve | dataquality.manage | |

## Attendance
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | /attendance/sessions?sectionId&date | attendance.mark | returns session (creates DRAFT in memory if none) + roster + working-day flag |
| PUT | /attendance/sessions | attendance.mark | upsert {sectionId, date, records[], version} |
| POST | /attendance/sessions/:id/submit · /verify | attendance.mark / class teacher | |
| POST | /attendance/sections/:id/months/:ym/verify | class teacher | locks month |
| GET | /attendance/register?sectionId&month | reports.view | monthly register grid |
| GET/POST | /attendance/corrections · POST /:id/approve · /:id/reject | correct.request / approve | |
| GET/POST | /attendance/monthly-summaries · POST /approve | attendance.legacy.* | legacy months |
| GET | /attendance/pending?date | auth | divisions without submitted attendance |

## Examinations & marks
| Method | Path | Perm | Purpose |
|---|---|---|---|
| CRUD | /exams | exams.manage | |
| POST | /exams/:id/classes | exams.manage | attach classes, sections |
| GET/PUT | /exam-classes/:id/subjects | exams.manage | subjects + components grid, bulk max marks |
| POST | /exam-classes/:id/transition | per action | {action: SCHEDULE / MARK_CONDUCTED / …} |
| CRUD | /result-schemes (+ columns) | exams.manage | |
| GET | /result-schemes/:id/preview?enrollmentId | exams.manage | computed card JSON |
| GET | /mark-sheets?examId&mine=true | marks.read | teacher's sheets with status, progress, due |
| GET | /mark-sheets/:id | marks.read | roster + components + marks + permissions on sheet |
| PATCH | /mark-sheets/:id/marks | marks.enter | batch cell updates {version, cells[]} |
| POST | /mark-sheets/:id/submit | marks.enter | |
| GET | /mark-sheets/:id/template.xlsx · POST /mark-sheets/:id/import | marks.enter | per-sheet Excel round-trip |
| GET | /marks/status?examId&classId | marks.read | completion matrix |
| GET | /marks/consolidated?examId&sectionId | marks.read | consolidated marksheet (JSON / PDF / XLSX) |

## Workflow & approvals
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | /approvals/inbox | auth | items awaiting the caller's stage |
| POST | /mark-sheets/:id/reject | marks.verify.* / approve | {comment} |
| POST | /section-reviews/:examClassId/:sectionId/verify | marks.verify.class | |
| POST | /exam-classes/:id/coordinator-verify | marks.verify.coordinator | |
| POST | /exam-classes/:id/approve | marks.approve | locks |
| POST | /exam-classes/:id/reopen · /mark-sheets/:id/reopen | marks.reopen | {reason} |
| GET | /workflow/history?entityType&entityId | marks.read | |
| GET/PUT | /term-assessments?sectionId&termId | remarks.enter | remarks, conduct, progress |
| CRUD | /remark-bank | remarks.enter | |

## Report cards
| Method | Path | Perm | Purpose |
|---|---|---|---|
| CRUD | /report-card-templates · POST /:id/versions | templates.manage | |
| POST | /report-card-templates/preview | templates.manage | {layout, enrollmentId} → HTML |
| GET | /publications/readiness?classId&sectionId&schemeId | reportcards.generate | readiness checks list |
| POST | /publications | reportcards.generate | draft publication (preview) |
| GET | /publications/:id/cards/:enrollmentId/preview | reportcards.generate | HTML |
| POST | /publications/:id/publish | reportcards.publish | 202 compute + render |
| POST | /publications/:id/revoke | reportcards.publish | {reason} |
| GET | /publications · /publications/:id | reportcards.generate | history |
| GET | /report-cards/:id/pdf | reportcards.generate / students.read | |
| POST | /publications/:id/zip | reportcards.generate | 202 → ZIP |
| GET | /public/verify/:code | public (rate-limited) | authenticity check |

## Reports & dashboard
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | /dashboard/summary?yearId&mediumId&classId&sectionId | auth (scoped) | cards |
| GET | /dashboard/charts/:chart | auth | students-by-class, attendance-trend, … |
| GET | /dashboard/action-items | auth | role-specific to-dos |
| GET | /reports | auth | catalog with filter definitions |
| GET | /reports/:key?filters | reports.view | paginated JSON |
| POST | /reports/:key/export | exports.run | {format: pdf/xlsx/csv} → 202 |

## Import / export / jobs / files
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | /imports/types | auth | types + fields + required context |
| GET | /imports/templates/:type?context | imports.run | generated XLSX |
| POST | /imports | imports.run | multipart file + type + context → 202 |
| GET | /imports · /imports/:id | imports.run | history, summary |
| PUT | /imports/:id/mapping | imports.run | |
| GET | /imports/:id/rows?status | imports.run | preview |
| PATCH | /imports/:id/rows/:rowId | imports.run | resolve duplicate (link/create/skip) |
| POST | /imports/:id/confirm · /cancel · /retry-failed | imports.run | |
| GET | /imports/:id/error-report | imports.run | XLSX |
| CRUD | /import-mappings | imports.run | |
| POST | /exports · GET /exports · /exports/:id | exports.run | |
| GET | /jobs/:id | owner | status/progress/result link |
| GET | /files/:id/download | owner/perm | signed redirect |

## Health
`GET /health` (liveness) · `GET /ready` (DB + Redis) — not under `/api/v1`, no auth, no data.
