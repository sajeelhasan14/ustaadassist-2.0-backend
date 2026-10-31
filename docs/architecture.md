# UstaadAssist — Architecture

This guide grows with the code. Every step that adds a file or folder updates it.

## The big picture

```
 Flutter app (../frontend)          Web dashboard (app/ pages)
        │  HTTPS + token                    │  runs on the server
        ▼                                    ▼
   app/api/v1/*  (API routes)                app/*/page.tsx
        │  check token, run SQL, reply        │  check cookie, run SQL, render
        └──────────────┬──────────────────────┘
                    lib/db.ts
                       │
              Supabase PostgreSQL
```

- **Flutter and the web dashboard never talk to the database directly.** Everything goes through our server code. (The one exception: Flutter logs in with Supabase Auth directly.)
- **Each route or page file holds its own logic**: who is asking, the SQL, the response. You can read one file top to bottom and see everything that endpoint does. We don't use a separate "services" layer.
- **`lib/db.ts` is the only file that opens database connections.**

## How login is checked (two layers)

| Layer | Where | What it does |
|---|---|---|
| 1. Gate | `proxy.ts` | Quick check on every page request. No login → redirect to `/login`. |
| 2. At the data | inside each page / API route | `getClaims()` again, right before reading data. The teacher id from the token goes into the SQL `WHERE`. |

Web pages carry the login in **cookies**. Flutter sends it as an `Authorization: Bearer <token>` header to `/api/v1/*`; proxy skips `/api`, and each API route checks the token itself.

## API conventions (`/api/v1/*`)

- **Versioned URL** (`v1`): old app versions stay on phones for months; a breaking change goes in `v2` while `v1` keeps working.
- **Login:** `Authorization: Bearer <access token>` only. No cookies.
- **JSON field names in camelCase** (`fullName`), done in the SQL with `AS "fullName"`.
- **Every error has one shape:** `{ "error": { "code": "unauthorized", "message": "..." } }` with a matching HTTP status (401 not logged in, 404 not found, 400 bad input).

| Endpoint | Returns |
|---|---|
| `GET /api/v1/me` | `{ teacher: { id, fullName, email, createdAt } }` |
| `GET /api/v1/semesters` | `{ semesters: [{ id, name, startDate, endDate }] }`, newest first |
| `POST /api/v1/semesters` | body `{ name, startDate, endDate }` → `201 { semester }` |
| `PATCH /api/v1/semesters/<id>` | body: any of `{ name, startDate, endDate }` → `{ semester }` |
| `DELETE /api/v1/semesters/<id>` | `204`, deletes its courses too |
| `GET /api/v1/semesters/<id>/courses` | `{ courses: [{ id, semesterId, code, title }] }`, by code; empty if the semester isn't yours |
| `POST /api/v1/semesters/<id>/courses` | body `{ code, title }` → `201 { course, section }` (section "A" is created automatically); `404` if the semester isn't yours; `409` duplicate code |
| `PATCH /api/v1/courses/<id>` | body: any of `{ code, title }` → `{ course }` |
| `DELETE /api/v1/courses/<id>` | `204`, deletes its sections and topics too |
| `GET /api/v1/courses/<id>/topics` | `{ topics: [{ id, title, position }] }`, in teaching order |
| `POST /api/v1/courses/<id>/topics` | body `{ title }` → `201 { topic }`, added at the end |
| `PUT /api/v1/courses/<id>/topics` | body `{ topicIds: [...] }` (every topic, new order) → `{ topics }` |
| `PATCH /api/v1/topics/<id>` | body `{ title }` → `{ topic }` |
| `DELETE /api/v1/topics/<id>` | `204`; the rest keep their order |
| `GET /api/v1/courses/<id>/sections` | `{ sections: [{ id, courseId, name, studentCount }] }`, by name; empty if the course isn't yours |
| `POST /api/v1/courses/<id>/sections` | body `{ name }` → `201 { section }`; `409` duplicate name |
| `PATCH /api/v1/sections/<id>` | body `{ name }` → `{ section }` |
| `DELETE /api/v1/sections/<id>` | `204`; removes its enrollments, the students stay |
| `GET /api/v1/sections/<id>/students` | `{ students: [{ id, rollNumber, fullName, fatherName, email }] }`, by seat number |
| `POST /api/v1/sections/<id>/students` | body `{ rollNumber, fullName, fatherName?, email? }` → `201 { student, created }`; reuses an existing student with the same seat number; `409 seat_number_taken` (different name) / `409 in_other_section` (already in another section of this course) / `409 already_enrolled` |
| `DELETE /api/v1/sections/<id>/students/<studentId>` | `204`; removes the enrollment, the student stays |

- **Validation errors** (`400 invalid_input`) also include `fields`, e.g. `{ "endDate": ["End date must be on or after the start date."] }`, so the app can show each message next to its field.
- **Dates** travel as text `"YYYY-MM-DD"` (selected with `::text` to avoid timezone shifts).
- **Someone else's id** gets the same `404` as a missing id, so ids can't be probed.

## Folders and files

| Path | Job | Used by |
|---|---|---|
| `app/` | Next.js pages (dashboard) and API routes (`app/api/v1`) | browser, Flutter |
| `lib/db.ts` | Database connection pool, `query()` and `withTransaction()` | every page and API route that reads data |
| `app/api/v1/me/route.ts` | `GET /api/v1/me`: checks the Bearer token, returns the teacher | Flutter app (later), `curl` |
| `app/api/v1/semesters/route.ts` | `GET` list + `POST` create semesters | Flutter app (later), PowerShell |
| `app/api/v1/semesters/[id]/route.ts` | `PATCH` edit + `DELETE` one semester (`[id]` = the id in the URL) | Flutter app (later), PowerShell |
| `app/api/v1/semesters/[id]/courses/route.ts` | `GET` list + `POST` add courses in one semester | Flutter app (later), PowerShell |
| `app/api/v1/courses/[id]/route.ts` | `PATCH` edit + `DELETE` one course | Flutter app (later), PowerShell |
| `docs/flows/courses.md` | Trace + test commands for the courses API | you |
| `app/api/v1/courses/[id]/topics/route.ts` | `GET` outline, `POST` add at end, `PUT` reorder (first use of `withTransaction`) | Flutter app (later), PowerShell |
| `app/api/v1/topics/[id]/route.ts` | `PATCH` rename + `DELETE` one topic | Flutter app (later), PowerShell |
| `docs/flows/topics.md` | Trace + test commands for the topics API | you |
| `app/api/v1/courses/[id]/sections/route.ts` | `GET` list (with student counts) + `POST` add sections of one course | Flutter app (later), PowerShell |
| `app/api/v1/sections/[id]/route.ts` | `PATCH` rename + `DELETE` one section | Flutter app (later), PowerShell |
| `docs/flows/sections.md` | Trace + test commands for the sections API | you |
| `app/api/v1/sections/[id]/students/route.ts` | `GET` list + `POST` add (find-or-create + enroll) students of one section | Flutter app (later), PowerShell, the import (Step 1.6) |
| `app/api/v1/sections/[id]/students/[studentId]/route.ts` | `DELETE` take a student out of a section | Flutter app (later), PowerShell |
| `docs/flows/students.md` | Trace + test commands for the students API | you |
| `docs/flows/semesters.md` | Trace + test commands for the semesters API | you |
| `lib/supabase/server.ts` | `createSupabaseServerClient()`: **the one Supabase client**. Reads the login from cookies, or checks a Bearer token passed to `getClaims(token)` | pages, server actions, every API route (only `proxy.ts` has its own setup) |
| `proxy.ts` | Runs before every page: refreshes the login, redirects logged-out users to `/login` | Next.js, automatically |
| `lib/auth-actions.ts` | Server Actions `login`, `signup`, `logout` | the login/signup forms, the Log out button |
| `app/login/page.tsx`, `app/signup/page.tsx` | The login and signup forms | browser |
| `app/page.tsx` | Temporary home: "Logged in as …" + Log out (replaced by the dashboard in Step 0.6) | browser |
| `docs/flows/auth.md` | Step-by-step trace of sign up → log in → open page → log out | you |
| `.env.example` | List of the settings the app needs (no real values) | you, when setting up `.env.local` |
| `supabase/migrations/` | Numbered SQL files that build the database, in order | Supabase CLI (`npm run db:push`) |
| `supabase/config.toml` | Supabase CLI settings (created by `supabase init`; mostly for running Supabase locally, which we don't do yet) | Supabase CLI |
| `docs/` | This guide, concept explanations and flow traces | you |

## Database tables

| Table | One row per | Created by | Notes |
|---|---|---|---|
| `auth.users` | login | Supabase Auth | Supabase's table. We never write to it. |
| `public.teachers` | teacher | trigger `on_auth_user_created`, at signup | `id` = the login's id. RLS on. |
| `public.semesters` | teaching term ("Fall 2026") | API (Step 1.2) | belongs to a teacher; `end_date >= start_date`; name unique per teacher |
| `public.courses` | subject in one semester ("CS-101") | API (Step 1.3) | belongs to a semester; code unique per semester |
| `public.topics` | outline item | API (Step 1.3) | belongs to a course; `position` = teaching order |
| `public.sections` | class group ("A") | API (Step 1.5a); "A" auto-created with each course | belongs to a course; name unique per course |
| `public.students` | student | API (Step 1.5b) / import (Step 1.6) | belongs to a teacher; roll number (= "Seat No") unique per teacher, stored in capitals; optional `father_name` |
| `public.enrollments` | student in a section | API (Step 1.5b) | links sections ↔ students (many-to-many) |

How they connect (`──<` means "one to many"):

```
teachers ──< semesters ──< courses ──< sections >──┐
    │                         │                     enrollments
    │                         └──< topics           │
    └──< students >─────────────────────────────────┘
```

**Who owns what:** `semesters` and `students` have `teacher_id`. Everything else is owned through its parent: a section belongs to a course, which belongs to a semester, which belongs to a teacher. Deleting a parent deletes its children (`on delete cascade`).

## Changing the database

1. `npm run db:new <name>` creates an empty, timestamped file in `supabase/migrations/`.
2. Write the SQL. Every new table gets `enable row level security`.
3. `npm run db:push` runs the new files on Supabase. `npm run db:status` shows which have run.

Never edit a migration that has already been pushed. Add a new one instead.

One-time setup on a new computer: `npx supabase login`, then `npx supabase link --project-ref <ref>` (the ref is in your Supabase project URL).

## Decisions so far

| Decision | Why |
|---|---|
| Raw SQL with `pg`, no ORM | Learn real SQL and keep full control over queries. |
| Supabase for Postgres, Auth and Storage | Hosted Postgres plus ready-made login and file storage. |
| All data goes through Next.js | Calculations and permission checks happen on our server, never in the app or browser. |
| Logic inside each route/page file, no service layer | Fewer files; each file reads top to bottom. If the same code gets copied into many files, we decide together whether to share it. |
| A course can have many sections | Real courses are taught to several class groups. |
| Marks split is fully up to the teacher | Each course has a total (default 100). The teacher creates any assessments, any number, each worth any marks they choose; nothing is fixed. A student's total is the sum of the marks they got. Grades come from the university's table. |
| Built for one university | Final results are exported in that university's exact format. |
| Teacher types as little as possible | The app pre-fills, imports (CSV or PDF scan) and calculates; the teacher only confirms and enters marks. |
| Individual teacher accounts | No school/admin level for now. |
