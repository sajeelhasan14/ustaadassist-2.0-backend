# Flow: results and exports

[results/route.ts](../../app/api/v1/sections/[id]/results/route.ts) ·
[marks/route.ts](../../app/api/v1/sections/[id]/marks/route.ts) ·
[attendance/route.ts](../../app/api/v1/sections/[id]/attendance/route.ts) ·
[migration](../../supabase/migrations/20261104225041_results.sql)

The teacher enters marks, and the result sheet appears by itself. Nothing is saved: every request works it out again from the marks.

## Rules

| Rule | Detail |
|---|---|
| Theory | Sum of the marks from assessments that aren't lab work |
| Lab | Sum of the marks from assessments with `isLab: true` |
| Maximums | `labMax` = the lab assessments' marks added up. `theoryMax` = the course total minus `labMax`. The 80 + 20 split is never fixed in code |
| Pass | A component fails below **half of its own maximum**: 40/80 and 10/20 on a 2+1 course, 50/100 on a 3+0 course. Exactly half passes |
| Grade | From the total only, so a failed component can still show a passing letter, as on the real sheets |
| Absent | No mark at all. A real 0 has a row, so it isn't absent |
| Incomplete | Some marks but not all. Counted in `summary.incomplete`, because the sheet isn't final yet |

| Grade | From | Grade | From |
|---|---|---|---|
| A+ | 90 | C+ | 64 |
| A | 85 | C | 61 |
| A- | 80 | C- | 57 |
| B+ | 75 | D+ | 53 |
| B | 71 | D | 50 |
| B- | 68 | F | below 50 |

Grades use the percentage of the course total. Decimals aren't rounded up: 49.5 is F, and 52.5 is D.

**Remarks:** no lab: `Passes` or `Fail`. With a lab: `Passes`, `Fail in Theory`, `Fail in Pract.` or `Fail in Th. & Pr.`. No marks: `Absent`, printed as `----` and highlighted yellow.

**Words:** 72 → Seventy Two, 70 → Seventy only, 100 → One Hundred, 0 → Zero, 52.5 → Fifty Two Point Five.

## Sheet header

Department, class, year, semester and exam date come from `resultHeader` on the course, set with `PATCH /courses/<id>`. If a course has none, the teacher's latest one is copied, so it's typed once. University, examination, faculty and programme default to the University of Karachi lines from the samples.

Teacher name, course no., title, credit hours and section are filled in automatically.

## Trace: downloading a result sheet

```
Flutter "Download PDF"
  ▼ GET /sections/<id>/results?format=pdf
results/route.ts
  ├─ getTeacherId       token → teacher id
  ├─ SELECT course      ownership, credit hours, header, teacher name
  ├─ SELECT assessments, students, marks
  ├─ rows               theory, lab, total, words, grade, remarks for each student
  └─ format?            none → JSON
                        xlsx → SheetJS
                        pdf  → jsPDF + autoTable, legal size, header on every page
  ▼ the file
```

## The other files

| File | Route | Contents |
|---|---|---|
| Marksheet | `GET /sections/<id>/marks?format=` | One column per assessment, total, %. A blank means not entered |
| Attendance sheet | `GET /sections/<id>/attendance?format=` | One column per held class (P, A, or blank if not marked), %. Footer: Signature of Course Superior |
| Exam paper | `GET /assessments/<id>/questions?format=pdf&time=3 hours` | Approved questions only, numbered straight through. PDF only |

## Tested (2026-11-05)

Real routes and migrations on real Postgres in a temporary schema, stand-in login.

- **Results, 36 checks:** the pass line at 49 and 50, all 24 grade band edges, words, a real 0 against absent, incomplete students, all four remarks, exactly 40 and 10 passing, a failed lab keeping its letter, header copying, access, and Excel and PDF files.
- **Exports, 24 checks:** marksheet, attendance (cancelled classes left out, not-marked stays blank), reorder, printed paper, regenerate with real Gemini.
- The result sheet and exam paper PDFs were rendered and checked by eye. A draft question didn't appear on the paper.
- **Not yet run:** creating a PDF inside the real Next.js server. The production build works and the routes load, but they stop at the login check without a real account.

## Try it (PowerShell, dev server running)

Use the login from [semesters.md](semesters.md) for `$auth`. `$id` is a section's id.

```powershell
$api = "http://localhost:3000/api/v1"
Invoke-RestMethod -Uri "$api/sections/$id/results" -Headers $auth
Invoke-WebRequest -Uri "$api/sections/$id/results?format=pdf" -Headers $auth -OutFile result.pdf
```
