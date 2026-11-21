# CPS School ERP — Design Documentation

Children Public School, Goregaon (W), Mumbai · Hindi & English medium · Maharashtra State Board (CCE)

| # | Document | Brief deliverables covered |
|---|---|---|
| 00 | [School data findings](00-school-data-findings.md) | §25 file inspection (all 5 files), report-card analysis, design decisions, missing files |
| 01 | [Product requirements](01-product-requirements.md) | 1 PRD · 2 module breakdown · 3 navigation · 15 screen list · **extra features** |
| 02 | [Architecture](02-architecture.md) | System architecture · project structure · 14 import/export architecture · PDF · security · storage · deployment · backups |
| 03 | [Database design](03-database-design.md) | 5 ERD · 6 table definitions · 8 student data model · integrity rules |
| 04 | [Business rules](04-business-rules.md) | 4 roles & permissions · 9 attendance · 10 exam model · 11 marks & grading · 12 verification workflow · 13 report-card logic |
| 05 | [API endpoints](05-api-endpoints.md) | 7 API list |
| 06 | [Roadmap, testing, risks, questions](06-roadmap-risks-questions.md) | 16 roadmap · testing strategy · 17 risks & assumptions · **questions for the school** |
| 07 | [Operators & approval workflow](07-academic-approval-workflow.md) | Operator → Subject Teacher → Class Teacher → Headmaster workflow, assignments, partial rejection, notifications, screens, test scenarios |
| 08 | [Testing guide](08-testing-guide.md) | Sample data, demo logins for every role, where things are, who sees what about a student, what is not built yet |

Status (10 Nov 2026):
- **Phase 1 (foundation) built and tested**: login, roles & permissions (incl. Headmaster / Operator), school setup, academic years & terms, mediums, standards, classes & divisions, subjects & papers, grading, policies, number formats, staff, academic assignments, users, audit logs.
- Decided by the school: report-card attendance is **monthly**; exams are UT1, UT2, Semesters (configured per class in Phase 4).
- Still open: see doc 06 §4.
