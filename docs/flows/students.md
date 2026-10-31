# Flow: students in a section (add, list, remove)

Files: [app/api/v1/sections/[id]/students/route.ts](../../app/api/v1/sections/[id]/students/route.ts) (GET, POST) ·
[app/api/v1/sections/[id]/students/[studentId]/route.ts](../../app/api/v1/sections/[id]/students/[studentId]/route.ts) (DELETE) ·
tables `students`, `enrollments` · migration `20261031133628_students_father_name.sql`

A **student** belongs to the teacher (one row per seat number). An **enrollment** says "this student is in this section". Adding a student to a section therefore means **find-or-create the student, then enroll them**.

## Add a student

```
POST /api/v1/sections/<sectionId>/students
     { "rollNumber": "EB24210106003", "fullName": "ABDUL GHANI", "fatherName": "MUHAMMAD AFZAL" }
 1. token → 401
 2. sectionId not a UUID → 404
 3. Zod: seat number and name not blank, email valid if given → 400
    and cleans: trims, collapses double spaces, seat number → CAPITALS, blank father's name → null
 4. withTransaction (all-or-nothing):
    a. is this section yours? (section → course → semester → teacher)        no → 404
    b. INSERT INTO students ... ON CONFLICT (teacher_id, roll_number) DO NOTHING
         row returned → new student (created: true)
         no row       → seat number already used: SELECT that student
                         different name           → 409 seat_number_taken (+ existingStudent)
                         in another section of THIS course → 409 in_other_section
                         otherwise (same name)    → reuse them (created: false)
    c. INSERT INTO enrollments ... ON CONFLICT DO NOTHING
         no row → 409 already_enrolled
   ▼
201 { "student": { id, rollNumber, fullName, fatherName, email }, "created": true | false }
```

**Why `seat_number_taken` instead of overwriting:** the university list for SE-454 Section A has rows 21 and 22 both on `EB24210106056` (MUHAMMAD AFZAL and MUHAMMAD AHMED AFRIDI). Overwriting would silently replace one student with the other. Stopping lets the teacher fix the seat number.

**Why `in_other_section`:** a class (group of students) takes a course from a teacher once per semester. The course can have several sections, but each student sits in only one of them. Reusing a student in a **different course** (e.g. next semester) is normal and allowed. The check lives in the route (inside the transaction) because `enrollments` stores only the section, not the course.

## List and remove

```
GET    /api/v1/sections/<sectionId>/students              → { "students": [...] } by seat number; empty if not yours
DELETE /api/v1/sections/<sectionId>/students/<studentId>  → 204; only the enrollment goes, the student stays
```

## Tested (rolled-back transaction, temporary teachers A and B, real names from the Section A list)

| Action | Result |
|---|---|
| Zod gets `" eb24210106003 "`, `"ABDUL   GHANI "`, father `"  "` | `EB24210106003`, `ABDUL GHANI`, `null` |
| Zod gets blank seat no, blank name, email `x` | 400 with a message for each field |
| A adds ABDUL GHANI to section A | created |
| A adds row 21 (…056 MUHAMMAD AFZAL), then row 22 (…056 MUHAMMAD AHMED AFRIDI) | first created, second → 409 seat_number_taken |
| A adds ABDUL GHANI to section A again | 409 already_enrolled |
| A adds ABDUL GHANI to section B of the **same** course | 409 in_other_section (A) |
| A adds ABDUL GHANI to a section of **another** course | reused, `created: false` |
| B adds a student to A's section | 404 |
| B lists / removes from A's section | empty / 404 |
| A removes Ghani from section A | 204; he is still in the other course |

## Try it (PowerShell, in `backend/`, dev server running)

Log in and create a course as in [sections.md](sections.md), so `$r.section` is section "A".

```powershell
$sec = $r.section.id
# add two students
Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/students" -Headers $auth -ContentType "application/json" -Body '{"rollNumber":"EB24210106003","fullName":"ABDUL GHANI","fatherName":"MUHAMMAD AFZAL"}'
Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/students" -Headers $auth -ContentType "application/json" -Body '{"rollNumber":"EB24210106056","fullName":"MUHAMMAD AFZAL"}'
# the duplicate seat number from the real list → 409 (PowerShell shows it as an error)
Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/students" -Headers $auth -ContentType "application/json" -Body '{"rollNumber":"EB24210106056","fullName":"MUHAMMAD AHMED AFRIDI"}'
# list
$students = (Invoke-RestMethod -Uri "$api/sections/$sec/students" -Headers $auth).students
$students
# remove the first one from the section
Invoke-RestMethod -Method Delete -Uri "$api/sections/$sec/students/$($students[0].id)" -Headers $auth
```
