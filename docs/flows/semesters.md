# Flow: semesters (create, list, edit, delete)

Files: [app/api/v1/semesters/route.ts](../../app/api/v1/semesters/route.ts) (GET, POST) ·
[app/api/v1/semesters/[id]/route.ts](../../app/api/v1/semesters/[id]/route.ts) (PATCH, DELETE) ·
[lib/db.ts](../../lib/db.ts) · table `semesters` ([migration](../../supabase/migrations/20261029000000_core_academic.sql))

## Create: `POST /api/v1/semesters`

```
App sends   Authorization: Bearer <token>
            { "name": "Fall 2026", "startDate": "2026-09-01", "endDate": "2026-12-20" }
   ▼
POST()
 1. getTeacherId(request)   no/invalid token → 401 unauthorized
 2. request.json()          not JSON → treated as null → step 3 fails
 3. newSemester.safeParse   Zod checks: name not blank, dates are YYYY-MM-DD, end ≥ start
                            any problem → 400 invalid_input + fields: { "endDate": ["..."] }
 4. INSERT ... RETURNING    teacher_id comes from the token, never from the body
      Postgres 23505 (same name for this teacher) → 409 duplicate_name
   ▼
201 { "semester": { "id": "...", "name": "Fall 2026", "startDate": "2026-09-01", "endDate": "2026-12-20" } }
```

## List: `GET /api/v1/semesters`

token → `SELECT ... WHERE teacher_id = $1 ORDER BY start_date DESC` → `200 { "semesters": [...] }` (newest first; empty list if none).

## Edit: `PATCH /api/v1/semesters/<id>`

```
Body: any of { name, startDate, endDate }  (only what changes)
 1. token → 401
 2. <id> from the URL (await ctx.params); not a UUID → 404
 3. Zod (all fields optional) → 400
 4. UPDATE ... SET x = COALESCE($n, x) ... WHERE id = $4 AND teacher_id = $5 RETURNING ...
      no row (doesn't exist OR belongs to another teacher) → 404
      23505 duplicate name → 409 · 23514 end before start → 400
   ▼
200 { "semester": { ...updated } }
```

## Delete: `DELETE /api/v1/semesters/<id>`

token → UUID check → `DELETE ... WHERE id = $1 AND teacher_id = $2 RETURNING id` → no row → 404, else **204** (no body).
Its courses, and their sections and topics, are deleted with it (`on delete cascade`).

## Tested (in a rolled-back transaction, two temporary teachers A and B)

| Action | Result |
|---|---|
| A creates "Fall 2026" | created |
| A creates "Fall 2026" again | 23505 → 409 |
| B creates "Fall 2026" | created (names are unique **per teacher**) |
| A renames only | name changed, dates kept (COALESCE) |
| A sets end before start | 23514 → 400 |
| B edits / deletes A's semester | no row → 404 |
| A deletes own | deleted |

## Try it (PowerShell, in `backend/`, dev server running)

```powershell
$key = (Select-String -Path .env.local -Pattern '^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.*)').Matches[0].Groups[1].Value
$login = Invoke-RestMethod -Method Post -Uri "https://xmicoapelndgosaiapvb.supabase.co/auth/v1/token?grant_type=password" -Headers @{ apikey = $key } -ContentType "application/json" -Body '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
$auth = @{ Authorization = "Bearer $($login.access_token)" }
$api = "http://localhost:3000/api/v1/semesters"

# create
$s = Invoke-RestMethod -Method Post -Uri $api -Headers $auth -ContentType "application/json" -Body '{"name":"Fall 2026","startDate":"2026-09-01","endDate":"2026-12-20"}'
$s.semester
# list
(Invoke-RestMethod -Uri $api -Headers $auth).semesters
# edit (rename only)
(Invoke-RestMethod -Method Patch -Uri "$api/$($s.semester.id)" -Headers $auth -ContentType "application/json" -Body '{"name":"Autumn 2026"}').semester
# see an error: end before start
try { Invoke-RestMethod -Method Post -Uri $api -Headers $auth -ContentType "application/json" -Body '{"name":"Bad","startDate":"2026-12-01","endDate":"2026-09-01"}' } catch { $_.ErrorDetails.Message }
# delete
Invoke-RestMethod -Method Delete -Uri "$api/$($s.semester.id)" -Headers $auth
```
