# Flow: courses (add, list, edit, delete)

Files: [app/api/v1/semesters/[id]/courses/route.ts](../../app/api/v1/semesters/[id]/courses/route.ts) (GET, POST) ·
[app/api/v1/courses/[id]/route.ts](../../app/api/v1/courses/[id]/route.ts) (PATCH, DELETE) · table `courses`

Same shape as [semesters](semesters.md) (token → Zod → SQL → JSON). The difference: **ownership is checked through the semester**, because `courses` has no `teacher_id`.

```
POST /api/v1/semesters/<semesterId>/courses   { "code": "CS-201", "title": "Data Structures" }
 1. token → 401
 2. semesterId not a UUID → 404
 3. Zod: code and title not blank → 400
 4. INSERT INTO courses ... SELECT ... FROM semesters WHERE id = <semesterId> AND teacher_id = <from token>
      no row inserted (not your semester) → 404
      23505 (code already used in this semester) → 409
   ▼
201 { "course": { "id", "semesterId", "code", "title" }, "section": { ..., "name": "A" } }   ← section "A" is auto-created, see sections.md
```

## Tested (rolled-back transaction, temporary teachers A and B)

| Action | Result |
|---|---|
| A adds CS-201 to own semester | created |
| A adds CS-201 again | 23505 → 409 |
| B adds a course to A's semester | no row → 404 |
| A renames title only | title changed, code kept |
| B edits / lists / deletes A's course | nothing → 404 / empty list |
| A deletes own course | deleted |

## Try it (PowerShell, in `backend/`, dev server running)

```powershell
$key = (Select-String -Path .env.local -Pattern '^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.*)').Matches[0].Groups[1].Value
$login = Invoke-RestMethod -Method Post -Uri "https://xmicoapelndgosaiapvb.supabase.co/auth/v1/token?grant_type=password" -Headers @{ apikey = $key } -ContentType "application/json" -Body '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
$auth = @{ Authorization = "Bearer $($login.access_token)" }
$api = "http://localhost:3000/api/v1"

# a semester to put courses in
$sem = (Invoke-RestMethod -Method Post -Uri "$api/semesters" -Headers $auth -ContentType "application/json" -Body '{"name":"Fall 2026","startDate":"2026-09-01","endDate":"2026-12-20"}').semester
# add a course
$c = (Invoke-RestMethod -Method Post -Uri "$api/semesters/$($sem.id)/courses" -Headers $auth -ContentType "application/json" -Body '{"code":"CS-201","title":"Data Structures"}').course
# list courses in that semester
(Invoke-RestMethod -Uri "$api/semesters/$($sem.id)/courses" -Headers $auth).courses
# rename
(Invoke-RestMethod -Method Patch -Uri "$api/courses/$($c.id)" -Headers $auth -ContentType "application/json" -Body '{"title":"DSA"}').course
# delete
Invoke-RestMethod -Method Delete -Uri "$api/courses/$($c.id)" -Headers $auth
```
