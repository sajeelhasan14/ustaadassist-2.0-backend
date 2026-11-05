# Flow: course materials

[courses/[id]/materials/route.ts](../../app/api/v1/courses/[id]/materials/route.ts) ·
[materials/[id]/route.ts](../../app/api/v1/materials/[id]/route.ts) ·
[table](../../supabase/migrations/20261104230947_materials.sql) ·
[bucket and policy](../../supabase/migrations/20261104230959_materials_storage.sql)

A teacher uploads slides or notes to a course, optionally under a topic, and opens them from any device.

## Rules

- **Two places, one record.** The file is in the private `materials` bucket. The `materials` table remembers its name, size and course.
- **Each teacher has a folder.** Paths are `<teacher id>/<course id>/<random id>`. A storage policy refuses any other folder.
- **The teacher's own token is used.** The server has no admin key, so storage checks the real login on every request.
- **No public links.** Opening a file gives a link that stops working after 10 minutes.
- **20 MB limit.** PDF, Word, PowerPoint, Excel, text and images only.

## Upload: `POST /api/v1/courses/<id>/materials`

```
Multipart form: file, topicId?
 1. token → 401
 2. course not this teacher's → 404
 3. no file, too big, wrong type → 400
 4. topic not in this course → 400
 5. upload to <teacher>/<course>/<random id>     failed → 502 storage_failed, no row saved
 6. INSERT the row                               failed → the file is removed again
   ▼
201 { material }
```

## Delete

The file goes first. If that fails the row stays, so the teacher still sees it and can try again.

Deleting a whole course removes its rows, but not its files: they stay in the bucket, unreachable. This needs a cleanup later.

## Tested (2026-11-05)

28 checks with real routes and real Postgres, but **a stand-in for Supabase Storage**: login, ownership, file size and type, topics, a storage failure on upload and delete, rename, expiring link, deleting a topic.

**Not yet tested: a real upload.** The bucket and policy are live, but storage needs a real login and the database has no teacher account yet. Try this first once one exists.

## Try it (PowerShell 7, dev server running)

Use the login from [semesters.md](semesters.md) for `$auth`. `$id` is a course's id.

```powershell
$api = "http://localhost:3000/api/v1"
Invoke-RestMethod -Method Post -Uri "$api/courses/$id/materials" -Headers $auth -Form @{ file = Get-Item .\notes.pdf }
Invoke-RestMethod -Uri "$api/courses/$id/materials" -Headers $auth
```
