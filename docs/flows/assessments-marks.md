# Flow: assessments, marks and the gradebook

Files: [app/api/v1/courses/[id]/assessments/route.ts](../../app/api/v1/courses/[id]/assessments/route.ts) (GET, POST) ·
[app/api/v1/assessments/[id]/route.ts](../../app/api/v1/assessments/[id]/route.ts) (PATCH, DELETE) ·
[app/api/v1/assessments/[id]/marks/route.ts](../../app/api/v1/assessments/[id]/marks/route.ts) (GET, PUT) ·
[app/api/v1/sections/[id]/marks/route.ts](../../app/api/v1/sections/[id]/marks/route.ts) (GET) ·
tables `courses.total_marks`, `assessments`, `marks`

## The rules (from the user)

- The teacher decides **everything**: which assessments exist, how many, their names and how many marks each is worth. Nothing is fixed ("Final 50 + 3 Assignments × 10 + Quiz 10 + Presentation 10" is only one example).
- A course is "out of" its `totalMarks` (default 100, changeable).
- A student's total = the **plain sum** of their marks. No percentage weights.
- Grades / GPA come later, from the university's result format.
- **No scaling** (user decision, 2026-11-02): an assessment has one number, its marks. A quiz taken out of 30 is created as "Quiz, 30", and the teacher enters what the student scored out of 30.

## 1. Assessments

```
POST /api/v1/courses/<courseId>/assessments   { "name": "Quiz 1", "maxMarks": 10 }
 1. token → 401;  Zod: name not blank, maxMarks > 0 → 400
 2. transaction: course yours? (FOR UPDATE: two adds at once can't both take the last marks)  → 404
      allocated + maxMarks > course total → 400 over_total "Only 40 of 100 marks are left"
 3. INSERT at the end (position = last + 1);  same name already in the course → 409
   ▼
201 { "assessment": { id, name, maxMarks, position } }

GET /api/v1/courses/<courseId>/assessments
   → { totalMarks: 100, allocated: 60, unallocated: 40, students: 62,
       assessments: [ { id, name, maxMarks, position, marksEntered: 58 } ] }      ← "58 of 62 entered"

PATCH  /api/v1/assessments/<id>   { "name"?, "maxMarks"? }
       maxMarks over what's left → 400 over_total;  below a mark already entered → 400 below_marks
DELETE /api/v1/assessments/<id>   → 204 (its marks are deleted too, and its marks become free again)
```

**Why refuse going over the total?** Otherwise assessments could add up to 120 in a course out of 100, and a student could end at 110%. To make room, the teacher lowers an assessment or raises the course total (`PATCH /courses/<id> { "totalMarks": 120 }`).

## 2. Entering marks: the whole class list, one save

```
GET /api/v1/assessments/<id>/marks?sectionId=<id>         (no sectionId = all sections of the course)
   → { assessment: { id, name, maxMarks }, entered: 0,
       students: [ { id, rollNumber, fullName, sectionName, marks: null } ] }      null = not entered yet

PUT /api/v1/assessments/<id>/marks   { "marks": [ { "studentId": "…", "marks": 7.5 }, { "studentId": "…", "marks": null } ] }
 1. token;  Zod: marks ≥ 0 or null;  the same student twice → 400
 2. transaction: assessment yours? (FOR UPDATE: max marks can't change meanwhile) → 404
      any mark above maxMarks → 400 above_max, { studentIds }       ← NOTHING is saved
      any student not enrolled in this course → 400, { studentIds }  ← NOTHING is saved
      numbers → upsert (INSERT … ON CONFLICT DO UPDATE)
      nulls   → DELETE (clears a mark entered by mistake)
   ▼
200 { "saved": 2, "cleared": 1 }
```

Students **left out** of the list are not touched, so the app can send only the rows the teacher changed.

**"Not entered" is not 0.** A student with no mark has no row. A 0 is a real mark (they sat the quiz and got nothing). The gradebook shows the difference (`null` vs `0`) and counts the missing ones.

## 3. The gradebook

```
GET /api/v1/sections/<sectionId>/marks
   → { totalMarks: 120, allocated: 110,
       assessments: [ { id, name: "Quiz 1", maxMarks: 10, average: 72.5 }, { …"Mid" }, … ],   ← average: class mean as a % of maxMarks, null until someone has a mark
       students: [ { id, rollNumber, fullName,
                     marks: [7.5, null, 41.25, null],      ← same order as "assessments"; null = not entered
                     total: 48.75,                          ← sum of the entered marks
                     percentage: 40.6,                      ← total ÷ totalMarks, 1 decimal
                     missing: 2 } ] }
```

This is the base for the result sheet (Excel/PDF in the university's format), which comes later.

## Decimal marks

Marks like 7.5 or 41.25 are allowed (stored as `numeric(6,2)`: up to 2 decimals). Two things to know:

- **`pg` returns `numeric` as text** ("7.50"), so every query selects `marks::float8` to send real numbers.
- **JavaScript decimals aren't exact:** 33.3 + 33.3 + 33.4 = 100.00000000000001. Every check ("over the total", "above max") compares whole hundredths, `Math.round(x × 100)`, so a split that adds up to exactly 100 is accepted.

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

SE-454 (sections A: Ali, Sana; B: Bilal) and CS-201 (out of 50, Outsider).

| Case | Result |
|---|---|
| new course / with `totalMarks: 50` | 100 / 50 |
| Quiz 1 (10), Assignment 1 (10), Mid (30), then Final 60 | first three created in order; Final 60 → 400 "Only 50 … left" |
| "Quiz 1" again | 409 |
| Final 50 | list: 100 of 100 allocated, 0 left, 3 students (both sections) |
| 16.6 + 16.6 + 16.8 in a course out of 50 | accepted, exactly 50 allocated |
| course total → 90 / → 120 | 400 below_allocated / 120 |
| Mid → 60 (would be 130 of 120) / → 50 | 400 / exactly 120 |
| Sana 11 out of 10 | 400 above_max, nothing saved (Ali's 7.5 in the same request not saved either) |
| a student from another course | 400 |
| Ali 7.5, Sana 10, Bilal 0 | saved 3, Bilal's 0 is a real mark |
| Sana → 9, Bilal → null | saved 1, cleared 1, Ali untouched |
| Quiz max → 8 (Sana has 9) | 400 below_marks |
| gradebook section A | Ali `[7.5, null, 41.25, null]` total 48.75 of 120 = 40.6%, 2 missing |
| delete Assignment 1 | 110 allocated, 10 free |
| import, Phase 2 and planner tests re-run | 10/10, 29/29, 14/14 |

## Try it (PowerShell, in `backend/`, dev server running)

Set up a course with students as in [student-import.md](student-import.md) (`$r.course`, `$sec`).

```powershell
$course = $r.course.id
$quiz = (Invoke-RestMethod -Method Post -Uri "$api/courses/$course/assessments" -Headers $auth -ContentType "application/json" -Body '{"name":"Quiz 1","maxMarks":10}').assessment
Invoke-RestMethod -Method Post -Uri "$api/courses/$course/assessments" -Headers $auth -ContentType "application/json" -Body '{"name":"Final","maxMarks":95}'   # 400: only 90 left
Invoke-RestMethod -Uri "$api/courses/$course/assessments" -Headers $auth | Select-Object totalMarks, allocated, unallocated

# enter marks: everyone gets 8, the first student 9.5
$list = (Invoke-RestMethod -Uri "$api/assessments/$($quiz.id)/marks?sectionId=$sec" -Headers $auth).students
$marks = @($list | ForEach-Object { @{ studentId = $_.id; marks = 8 } }); $marks[0].marks = 9.5
Invoke-RestMethod -Method Put -Uri "$api/assessments/$($quiz.id)/marks" -Headers $auth -ContentType "application/json" -Body (@{ marks = $marks } | ConvertTo-Json)

# the gradebook
(Invoke-RestMethod -Uri "$api/sections/$sec/marks" -Headers $auth).students | Format-Table rollNumber, fullName, total, percentage, missing
```
