# Testing guide: sample data and what to try

This guide is for trying the app with **sample data**. Every name in the sample data is made up; no real student or
staff data is used. The sample data is for testing only and must never be loaded into the school's real database.

## 1. Start the app with sample data

Use three terminals in the project folder `C:\MeC\CPSAPP`:

| Terminal | Command | What it does |
|---|---|---|
| 1 | `npm run dev:db` | Starts a temporary database (all data is lost when it stops) |
| 2 | `npm run dev:api` | Starts the server on port 3000 |
| 3 | `npm run dev:web` | Starts the web app. Open the address it prints (http://localhost:5174 on this PC) |

Then, once, in a fourth terminal: `npm run sample-data`.

`npm run sample-data` only adds what is missing, so it is safe to run again. The temporary database gives each run a
new port: if `npm run dev:db` prints a different `DATABASE_URL` from the one in `apps/api/.env`, copy it into that
file before starting the API.

## 2. Sample logins

All demo logins use the password **`Test-pass-2026`** and are not asked to change it. The `admin` login keeps the
password you chose. The script signs in with its own temporary `sample-loader` login and disables it at the end; it
appears in **Users** and the **Audit log** as the creator of the sample records.

| Login | Person | What they see |
|---|---|---|
| `admin` | (you) | Everything; can admit and edit students. **No** approval rights for marks or attendance |
| `headmaster` | Sunita Deshmukh | The whole school: every student including caste/category, every class, who teaches what, audit log |
| `office` | Meena Pawar | The whole school; **admits and edits students**. Cannot see caste/category afterwards |
| `bsingh` | Bhupendra Singh | **Class teacher of ENGLISH-X A**: full profiles of that class, including parents' phone numbers. Also attendance verifier of X-B: names only there |
| `stripathi` | Shailesh Tripathi | Class teacher of HINDI-X A |
| `teacher1` … `teacher7` | English Nursery–IV class teachers | Their own class |
| `hteacher1` … `hteacher4` | Hindi I–IV class teachers | Their own class |
| `operator1` … `operator4` | Data entry operators | Names, roll and exam numbers of their divisions only; no phone numbers or addresses |
| `examcoord` | Rajesh Kulkarni | Exam coordinator |

Sign-in allows 5 attempts per minute. If you switch users quickly and get "too many attempts", wait a minute.

## 3. What the sample data contains

| Area | Sample data |
|---|---|
| School | Name, Hindi name, address, and the logo taken from the report-card photo |
| Year | 2026-27 with Semester I and Semester II |
| Classes | English medium Nursery–X (X has divisions A and B) and Hindi medium I–X: 24 divisions |
| Subjects | Per medium, with papers (Algebra/Geometry, Science I/II, History/Geography) for IX–X |
| Staff | 35: Head Mistress, exam coordinator, clerk, 4 operators, 28 teachers, all with logins |
| Assignments | Every division has a class teacher, an operator and a teacher for every subject |
| **Students** | **About 580 students** (16–29 per division). Each has a GR No (SE-1101…), exam number (E1001… / H1001…), roll numbers in A–Z order, date of birth, address, and father's and mother's names and mobiles. Hindi-medium students also have their names in Hindi (stored, not shown on screens or forms) |

## 4. Where things are

The menu on the left is grouped by what you do:

| Menu | What it is for |
|---|---|
| **Home** | What you can do, your own class and divisions, and a school overview for the Headmaster and office |
| **Students** | Find any student (or type in the search box at the top of every page). Filter by medium, class, boy/girl, or left/studying. Click a student to open the profile |
| **Classes** | Every division as a card: number of students, class teacher, operator. Click one to see its students in roll order, its subject teachers, and to print the class list |
| **Teachers & Staff**, **Who teaches what** | Staff directory, and who is class teacher / subject teacher / operator of each division |
| **Coming next** | Attendance, Exams & Marks, Report Cards: shown greyed out until they are built |
| **School setup** | Everything configured once: school profile and logo, years, classes, subjects, grading, rules, number formats, logins, roles |

## 5. Things to try

### As `headmaster`
1. **Home** shows 578 students, the English/Hindi split, and every division with its class teacher.
2. Type a name such as `ansari` in the search box at the top, then open a student.
3. On the profile, look at the **Profile**, **Parents** and **School record** tabs. The Headmaster also sees religion and category.
4. **Classes → ENGLISH-X A**: the students in roll order, the subject teachers, and **Print class list**.
5. Open a student and use **Mark as left / TC**: the reason is required, and the student moves out of the "Studying now" list (choose **Everyone** in the status filter to find them again).

### As `office`
1. **Students → Admit student**: fill in surname, first name, father's and mother's names, click **Use…** to build the full name in the school's order, choose the gender (Male/Female), then **Admit student**. As the office the student is saved as Provisional; the Headmaster enters the GR No when confirming. The exam number and roll number are filled in automatically.
2. On the new profile, use **Edit details**, the camera button (upload a photo) and **Division / roll no**.
3. **Classes → any division → Roll numbers A–Z** re-numbers the division alphabetically.

### As `bsingh` (class teacher)
1. **Home** shows a large card: *You are the class teacher of ENGLISH-X A*. Click **Open my class**.
2. Open any X-A student: date of birth, address and parents' mobile numbers are visible (tap a number to call on a phone).
3. Go back to **Classes** and open **X-B** (he is only its attendance verifier): the students are listed, but their profiles say contact details are hidden.
4. Religion and category are hidden for him: only the Headmaster and admin see those.

### As `operator1`
1. **Home** lists the 7 divisions this operator enters data for.
2. **Students** shows only those 156 students, with no phone numbers.
3. Try opening a student from another class by changing the number in the address bar: "Student not found in your classes". The server refuses it; it is not just hidden in the menu.

## 6. Who sees what about a student

| | Headmaster, admin | Office staff | Class teacher of the division | Subject teacher, operator, verifier of the division | Anyone else |
|---|---|---|---|---|---|
| Name, class, roll, GR No, exam no | ✓ | ✓ | ✓ | ✓ | ✗ |
| Date of birth, address, parents' mobiles | ✓ | ✓ | ✓ | ✗ | ✗ |
| Religion, category, caste, Aadhaar (last 4) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Admit / edit / change division | admin ✓, Headmaster ✗ | ✓ | ✗ | ✗ | ✗ |
| Mark as left / TC | ✓ | ✗ | ✗ | ✗ | ✗ |

Each column can be changed per role in **School setup → Roles & permissions**. For example, give the Headmaster
"Admit students and edit master records" if the Headmaster should also edit students.

## 7. Exams, marks, attendance, approvals and report cards

The sample data also contains four exams (UT1, Semester I, UT2, Semester II), June–October attendance, and UT1 and
Semester I marks. They are spread over every step, so each role has something waiting for them.

| Menu | Who uses it | What it is for |
|---|---|---|
| **Exams & Marks** | everyone with marks access | Each coloured box is one subject of one division. Click it to enter, check or approve. A blue outline means it is your turn |
| **Attendance** | operators, verifiers, class teachers, Headmaster | A grid of divisions × months. Working days for the month, then days present per student |
| **Approvals** | operators, teachers, Headmaster | **Waiting for you** (what you must do now), then **how many sheets are at each step for every standard**: not started, entering, sent back, waiting for subject teacher / class teacher / Headmaster, approved. Click a standard to see its divisions |
| **Report Cards** | operators, class teachers, Headmaster | Per division: what is still missing, remarks, Generate, Publish, Print all |
| **School setup → Exams** | exam coordinator, admin | Add exams and change maximum marks per class |

**The approval chain** (built into the server; nobody can skip a step):
1. **Operator** enters the marks (or attendance) and presses *Submit for verification*.
2. **Subject teacher** of that subject checks every row: *Verify*, or tick wrong rows and *Send back* with a reason. For attendance, the attendance verifier checks it (or the class teacher if no verifier is assigned).
3. **Class teacher** approves, or sends rows back.
4. **Headmaster** gives the final approval. The marks are then locked.

Rows sent back at any step go to the operator. After correction they pass **every step again, starting with the subject
teacher**. Rows nobody questioned keep their approvals. Nobody can verify data they entered themselves, and the Super
Admin has no approval rights.

**Report cards can be generated only when every subject's marks and every month's attendance for that division are
approved by the Headmaster.** Until then the Generate button is locked and the page lists exactly what is missing. A
draft preview, marked *DRAFT · NOT APPROVED*, can be opened at any time. The Headmaster publishes the cards; published
cards never change.

### Try it
| Sign in as | Do this |
|---|---|
| `headmaster` | **Approvals**: about 30 sheets wait for your final approval. Open one, check it and press *Give final approval*, or tick a row and *Send back*. Then **Report Cards → ENGLISH-X A**: cards are generated; press **Publish**. **HINDI-X A** is fully approved: press **Generate report cards** |
| `operator1` | **Approvals → Waiting for you**: sheets *sent back for correction*. Fix the red rows and press *Send corrected sheet*. Then **Report Cards** for ENGLISH-UKG A: generation is locked and lists what is missing |
| `teacher3` (Asha Fernandes) or `grao` (Geeta Rao) | Sheets waiting for the subject teacher or class teacher; verify one and watch it move to the next step on **Approvals** |
| `aiyer` (Arvind Iyer) or `stripathi` | Semester I sheets waiting for them as subject teacher |
| `office` | **Students → Import from Excel**: upload the school's class list (for example the Hindi X list). It checks every row and imports all of them or none |
| `headmaster` | Year end: **Classes → a division → Promote** (first copy the classes into the next year from that page) |

## 8. Fees

Each class has **one annual fee** for the academic year (no tuition / exam / admission heads). Every student has a
**fee ledger for each year**:

| Ledger line | Meaning |
|---|---|
| Previous year outstanding | Last year's unpaid balance, carried forward. For a student's first year in the ERP it is the opening balance typed in by the Headmaster / admin (for example from the old register) |
| Current year fees | The class's annual fee (RTE students: waived) |
| Concession | Optional, Headmaster / admin, with a reason |
| Total payable | Previous year outstanding + current year fees − concession |
| Total fees paid | All valid receipts of this year |
| Remaining outstanding balance | Total payable − total paid. At promotion it becomes next year's previous year outstanding |

The sample data has an annual fee for every class (₹6,000 Nursery … ₹11,000 Std IX–X), an opening balance from the
2025-26 register for about one student in seven, a few sibling concessions, many part payments from June to today,
and one bounced cheque that was cancelled.

| Where | What you see |
|---|---|
| **Home** (office, Headmaster, admin) | Collected so far, balance to collect, previous year still unpaid, today's collection |
| **Fees → Overview** | Total payable (this year's fees + previous years), collected, balance, collection for 30 days, payment modes, and each class |
| **Fees → Fee register** | Every student with previous year, current year, total payable, paid, **balance** and status. Filters: balance due, previous year unpaid, nothing paid, part paid, fully paid |
| **Fees → Receipts** | The day's (or any period's) receipts with totals per payment mode, for the cash book |
| **Fees → Class fees** | One amount per class for the selected year, saved class by class. *Copy fees from last year* fills the new year from the same classes (medium + standard); last year is never changed. A closed year is read-only |
| **Student → Fees** or **Fee register → a name** | The ledger above, a **year-by-year** table, and the year's receipts |
| **Collect fee** | Medium → class → student, the student's details and ledger, then the amount received today. The previous year's outstanding is cleared first. The receipt shows receipt no., date, student, admission (GR) no., class, academic year, previous year outstanding, current year fees, total payable, **fees paid today**, remaining balance and payment mode |

**Rules:** payments are taken on the student's latest year only (older balances have moved forward). A receipt is never
deleted: it is *cancelled* with a reason, and the balance (and the next year's carried-forward amount) goes back up.
A class fee cannot be lowered below what a student has already paid. Teachers do not see fees.

| Sign in as | Try |
|---|---|
| `office` | **Collect fee** for a student with a previous year balance, pay part of it, and print the receipt |
| `headmaster` | **Fees → Class fees**: change a class's fee; open a student's ledger: give a concession or cancel a receipt |
| `headmaster` | Year end: promote a class, then open a student's ledger for the new year: last year's balance is the previous year outstanding |

## 9. New admission form (Provisional → Confirmed)
Seven numbered sections, on screen and on the printed form:
1. **Class and admission:** RTE admission and how the child comes to school.
2. **Student:** name, gender, date of birth, place of birth, nationality, mother tongue, blood group.
3. **Previous school:** Std Passed, Last Std Passed Year (e.g. 2025-26), and Leaving Certificate number and date.
4. **Parents:** name, mobile and WhatsApp of father, mother and guardian.
5. **Documents received:** a checklist with scans (Affidavit included).
6. **Government IDs:** PEN, APAAR, Saral ID.
7. **Reserved details:** religion, category, caste, Aadhaar (Headmaster and admin only).

Height/weight, CWSN, identification marks, parents' occupation/education/income/email, address, emergency contact,
medical notes, siblings and bank details are no longer asked or printed (data already saved stays in the database).

**Student ID** is generated as medium (3 letters) + year + 8-digit number, e.g. `ENG202600000001`, `HIN202600000002`
(one running number for the school). Change the next number in Settings → Number formats → "Student ID".
Each new admission also gets an **admission form number** (`AF-2026-00001`, Settings → Number formats → "Admission form
number"). The printed admission form shows Form No. and Student ID at the top; the G.R. No. box stays empty until the
Headmaster gives one. The Student ID is printed on fee receipts, report cards, fee certificates, class lists and student
reports (not on the LC).

**Try it:** sign in as `office`, admit a student. The student is listed with a **Provisional** badge (no GR No or roll
no yet) and the office can collect fees at once (receipt says "Provisional admission"). Sign in as `headmaster`:
Home → "Provisional admissions" or Students → status "Provisional only" → open → type the **GR No** → **Confirm admission**.
The student becomes **Confirmed** with that GR No and gets a roll no, and fees already paid stay on the ledger. Rejecting is refused while
a fee receipt is valid: cancel (refund) it first.

**GR No is never generated** and stays blank until entered. The Headmaster may type it when confirming (optional);
after confirmation the office or the Headmaster adds or changes it with **Add GR No / Change GR No** on the student page.

**Editing:** while Provisional the office edits every section (reserved details too). After confirmation the record is
locked for the office (only "Add GR No" and "Division / roll no" remain); the Headmaster can still edit.

**Send back for correction:** the Headmaster writes what is wrong; the admission shows "Correction needed" (Students →
status "Sent back for correction"), the office corrects it with Edit details and clicks **Send to Headmaster again**.
Fees are untouched. **Reject** still needs every receipt cancelled or refunded first.

## 9c. Blank mark sheets and the mark-sheet approval flow
**One sheet per division, subject and semester.** Headmaster → **Blank mark sheets** → **Generate new sheet**: choose
semester, class, one subject or all; check / change the **maximum marks** (saved as the class's Mark pattern) →
**Save maximum marks & generate** (BMS-00001 …). A subject that already has its sheet is not generated again: open the
sheet and **Edit maximum marks** (allowed while the marks are still with the operator).

**Operator** → **Exams & Marks** shows "Mark sheets": every sheet of their divisions as soon as it is generated, with
**Print** (blank sheet, or Excel) and **Enter marks**. Marks can be entered only on a generated sheet; the maximum
marks cannot be changed by the operator. **Submit** → subject teacher.

**Approval (marks):** Subject teacher → Class teacher → Headmaster → **locked** (the Headmaster can **Reopen** with a
reason). **Send back** always goes ONE step down with a note (required) and the students to correct ticked
(highlighted): Headmaster → class teacher → subject teacher → operator. A sheet sent back to a teacher shows the note;
they either **Send back** further down or **Return** it to the step above with a note. At the operator the whole sheet
is open again (highlighted students in red); after **Send corrected sheet** it goes through every step again.
Attendance keeps the earlier flow (sent straight back to the operator).

## 9b. "Waiting for you" on Home
Every user's Home starts with **Waiting for you**: class lists to prepare (office / operator), to confirm (class teacher)
or to finalize (Headmaster), lists sent back with a note, classes ready for **Generate Exam Nos**, admissions sent back
for correction (office), promotions sent back by the Headmaster, students with GR No "TEMP" or none (office /
Headmaster), and marks / attendance to check. Each line opens the right page. The Headmaster sees the same items in
the "Needs your approval" list. Its **Class lists & Exam Nos** tile opens **Class lists** (menu) filtered to
"Waiting for me": every division with its step (being prepared → with class teacher → with Headmaster → ready for Exam
Nos → generated) and whom it is waiting for. **Marks** and **Attendance** have separate tiles.

## 9a. Class list, Exam Nos and promotion
**Class list** (Classes → a division) has five steps shown on the page:
1. **Prepared** — the Headmaster, office or the division's operator arranges roll numbers (A–Z or **Edit roll numbers**)
   and clicks **Send to class teacher**.
2. **Class teacher checks** — the class teacher may still change roll numbers, then clicks **Confirm class list**
   (or **Send back** with a note). After confirming, roll numbers are locked.
3. **Headmaster finalizes** — **Finalize**, or **Send back to class teacher** (roll numbers editable again).
4. **Final** — when every division of the class is final, the Headmaster or office clicks **Generate Exam Nos**.
5. **Exam Nos** — medium letter - standard - running number, one series for all divisions, division A then B in
   roll-number order (roll 1 → 001), restarting every year: `E-1-001`, `E-10-001`, `H-5-001`; Nursery `E-N-001`,
   LKG `E-J-001`, UKG `E-S-001`.
   A student joining later takes the next number.
The student list is always in roll-number order (students without a roll number last).

**Promotion** (menu → Promotion): Academic year → Medium → Class → list with Sr. No, name, Exam No, Student ID, GR No,
Result and Percentage (from the Greensheet). Passed → next class; Detained → same standard; Re-Exam → "Wait" (promote
later on its own). The office or operator **sends it to the Headmaster**, who **verifies** (applied) or sends it back;
the Headmaster's own promotion applies at once. Promoted into **Std I or Std V**, the GR No is printed as **TEMP** until
the new register number is entered with **Add GR No**. Next year's classes must exist first (admin: Academic years,
then "Copy classes").

**Sample "last year" to try it:** `npm run sample-last-year -w @cps/api` (after `npm run sample-data`) creates 2025-26 with
ENGLISH-UKG A, ENGLISH-IV A and HINDI-VII A (8 students each, Exam Nos E-S-001 / E-4-001 / H-7-001, all marks and attendance
approved, Greensheets approved: 6 pass, 1 re-exam, 1 detained) and puts 2026-27 ENGLISH-I, ENGLISH-V and HINDI-VIII back
to "class list being prepared". Then: office → Promotion → 2025-26 → a class → Send to Headmaster; headmaster → Verify
and promote; Classes → ENGLISH-I A → Roll numbers A–Z → Send to class teacher; class teacher (teacher4) → Edit roll numbers / Confirm;
headmaster → Finalize → Generate Exam Nos.

## 10. Reports & Analytics

Menu **Reports → Reports & Analytics**. Every report has an academic year and its own filters, search by student name
or admission no. (where it makes sense), sorting by clicking a column, pages of 50, and **Excel**, **PDF** and **Print**
buttons. Exports and print always contain the whole report (all pages), the date and time it was generated, the
filters used, the summary and the totals.

| Report | Who | Notes |
|---|---|---|
| Day-wise Fees Collection | Fee access (office, Headmaster, admin) | Every valid receipt between two dates. *Previous year fees collected* and *Current year fees collected* are separate columns (a receipt clears the carried-forward balance first). Summary: receipts, cash, online (UPI / bank transfer / card), cheque / DD, total |
| Class-wise Fees Collection | Fee access | Per class: students, fees applicable (previous year outstanding + current year fees), collected in the chosen dates (previous / current separately), and still outstanding today |
| Class-wise Pending Fees | Fee access | Students who owe money, with parents' names and contact number. *Include previous year outstanding: No* shows only this year's dues |
| Gender-wise Student List | Report access | Default: active students. Status *Inactive* = left school or passed out |
| Class-wise Student List | Report access | Numbered (Sr. No.), in class, section and roll order |
| School at a Glance | Report access | Totals by class (male, female, other, active, inactive, new admissions, transferred out), plus gender, active vs inactive and section-wise tables |

Teachers do not see fee reports. In student reports they see only their own divisions, and date of birth, phone and
admission date only for the division where they are class teacher. In PDFs, money is written without the ₹ sign
(the PDF fonts do not have it); Excel and the screen show ₹.

| Sign in as | Try |
|---|---|
| `office` | Day-wise collection for this month, filter *Cash*, export to Excel |
| `headmaster` | School at a Glance → PDF; Pending fees for two classes, *Include previous year outstanding: No* |
| `bsingh` | Reports shows only the student reports, limited to the teacher's classes |

## 11. Staff, expenses and vouchers, backdated receipts

**Staff management** (menu *Staff management*). The office registers a new staff member with personal details
(name, gender, date of birth, mobile, address, photo; documents on the profile). The record is **Pending
assignment**. The Headmaster assigns employee type, designation, department, qualification, joining date,
employment type, reporting manager and salary, then **activates**. Classes and subjects are given on the profile
(teaching staff only); they are the same records as *Who teaches what*. Every change is kept in the modification
history. The office cannot set employment or salary fields or change the status (the server refuses it).

**Expenses and vouchers** (menus *Expense management* and *Voucher management*). Every expense gets a voucher number
(EXP-000001 …) and starts as **Pending approval**. The Headmaster approves or rejects (with a reason). Only approved
vouchers count as expenses. An approved voucher can be edited or cancelled (reversed) only by the Super Admin, with a
reason. Nothing is deleted. Staff salary is an expense category: choose the staff member, month and year; partial
payments are allowed, a second payment for the same month must be confirmed, and the total can never exceed the
monthly salary. Salary vouchers are visible only to users with salary access. Vouchers print on A5 and download as PDF.

**Backdated fee collection.** If the payment date on *Collect fee* is before today (Mumbai time), the **manual
receipt number** from the paper receipt book is required and must not be used on another valid receipt. The system
receipt number is still generated; both appear on the receipt. The office cannot correct, cancel or re-issue a
receipt. The Headmaster / Super Admin can correct the date, mode, reference and manual number (with a reason) and
correct the amount by *cancel and re-issue*. All sample receipts before today carry a receipt-book number (RB-…).

| Sign in as | Try |
|---|---|
| `office` | *Add staff* → register someone; *Add expense* → electricity bill with a UPI reference; *Collect fee* dated yesterday |
| `headmaster` | *Staff list* → the pending person → *Assign designation*, then *Activate*; *Pending approval* → approve or reject; a student's ledger → *Correct* a receipt |
| `headmaster` | *Add expense* → category *Staff Salary*, a teacher, last month: see salary, paid and remaining |
| `headmaster` | Reports → *Backdated Fee Collection*, *Income & Expense Summary*, *Category-wise Expenses* |

## 12. Greensheet (Headmaster) and part-wise marks

Exams follow the school's Greensheet: **Semester I** (Formative Evaluation I + Summative Evaluation I) and **Semester II** (FE-II + SE-II). Unit tests were removed (old ones are archived, read-only).

| Who | Try |
|---|---|
| `headmaster` | **Exams & Marks → Set up exams → Mark pattern**: each class's parts and maximums (class I: OBS 10, Oral 10, Activity 10, Project 10, OBT 20, HW 5, CW 5 + Written 20, Oral 10; IX–X: MCQ out of 40 counted out of 10). **School default**, **Copy to other classes**. Sheets already submitted keep their pattern |
| `operator1` | Open a Semester II sheet of ENGLISH-I A: type each part; Formative total (C), Summative total (D) and grand total are calculated; paste several columns from Excel |
| `headmaster` | **Greensheet** → a division: summary (Boys / Girls / Total), each student's Sem I / Sem II %, average, grade, attendance, suggested result. Choose PASS / PROMOTED / Re-Exam / Detained, add grace marks (printed 34+1), **Approve Greensheet** (only when every mark sheet and every month's attendance is approved; then locked; **Reopen** with a reason) |
| anyone with the division | **Print**: complete Greensheet, or one page: Formative Evaluation cover, Year Work, Result, Result cover |

Marks typed before the Greensheet format were kept exactly as entered (Formative total + Summative total) and print in the "Formative" / "Summative" columns. The final report card shows the Headmaster's result once the Greensheet is approved.

## 12. Not built yet
- Daily (day-by-day) attendance: attendance is entered **month by month**, as on the school's sheets and report card.
- SMS / WhatsApp messages to parents (needs the school's official WhatsApp Business account).
- Certificates (Leaving Certificate, Bonafide).
- Online fee payment by parents (needs a payment gateway account), and SMS / WhatsApp fee reminders.
