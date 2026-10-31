# Flow: sections (auto "A", add, list, rename, delete)

Files: [app/api/v1/courses/[id]/sections/route.ts](../../app/api/v1/courses/[id]/sections/route.ts) (GET, POST) ·
[app/api/v1/sections/[id]/route.ts](../../app/api/v1/sections/[id]/route.ts) (PATCH, DELETE) ·
[app/api/v1/semesters/[id]/courses/route.ts](../../app/api/v1/semesters/[id]/courses/route.ts) (POST creates section "A") · table `sections`

Same shape as [courses](courses.md). The difference: ownership is checked **two levels up**, section → course → semester → `teacher_id`, because `sections` has no `teacher_id`.

## Section "A" is created with every course (minimal teacher effort)

```
POST /api/v1/semesters/<semesterId>/courses   { "code": "SE-454", "title": "..." }
 1–3. token, UUID, Zod (same as before)
 4. ONE statement (a CTE):
      new_course  = INSERT INTO courses ... only if the semester is yours
      new_section = INSERT INTO sections (course_id, 'A') for that course
      → both saved, or neither
   ▼
201 { "course": { id, semesterId, code, title }, "section": { id, courseId, name: "A" } }
```

The app can use `section.id` straight away for the next step (importing students). The teacher never sees a "create section" screen unless they teach a second section.

## Adding another section

```
POST /api/v1/courses/<courseId>/sections   { "name": "B" }
 1. token → 401
 2. courseId not a UUID → 404
 3. Zod: name not blank → 400
 4. INSERT INTO sections ... SELECT FROM courses JOIN semesters WHERE course = <courseId> AND teacher = <from token>
      no row (not your course) → 404
      23505 (name already used in this course) → 409
   ▼
201 { "section": { id, courseId, name, studentCount: 0 } }
```

Deleting a section removes its **enrollments** (cascade) but **not the students**: their rows stay, because they may be in your other sections.

## Tested (rolled-back transaction, temporary teachers A and B)

| Action | Result |
|---|---|
| A creates course SE-454 | course + section "A" created |
| B creates a course in A's semester | nothing created (no course, no section) |
| A adds section B | created |
| B adds a section to A's course | no row → 404 |
| A adds "A" again | 23505 → 409 |
| A lists sections | `A (0)`, `B (0)` |
| B lists / renames / deletes A's sections | empty / 404 / 404 |
| A renames B → B2, then deletes it | done |

## Try it (PowerShell, in `backend/`, dev server running)

Log in first and set `$auth`, `$api` and `$sem` as in [courses.md](courses.md).

```powershell
# add a course: the reply also has its section "A"
$r = Invoke-RestMethod -Method Post -Uri "$api/semesters/$($sem.id)/courses" -Headers $auth -ContentType "application/json" -Body '{"code":"SE-454","title":"Software Engineering"}'
$r.section
# add section B
$b = (Invoke-RestMethod -Method Post -Uri "$api/courses/$($r.course.id)/sections" -Headers $auth -ContentType "application/json" -Body '{"name":"B"}').section
# list sections with student counts
(Invoke-RestMethod -Uri "$api/courses/$($r.course.id)/sections" -Headers $auth).sections
# rename, then delete
(Invoke-RestMethod -Method Patch -Uri "$api/sections/$($b.id)" -Headers $auth -ContentType "application/json" -Body '{"name":"B (Morning)"}').section
Invoke-RestMethod -Method Delete -Uri "$api/sections/$($b.id)" -Headers $auth
```
