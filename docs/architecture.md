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
| `GET /api/v1/courses` | `{ courses: [{ id, semesterId, code, title, totalMarks, creditHours, resultHeader }] }`: **every** course the teacher has, newest semester first, then by title. The app's first screen (My courses) uses this. |
| `GET /api/v1/semesters/<id>/courses` | `{ courses: [{ id, semesterId, code, title }] }`, by code; empty if the semester isn't yours |
| `POST /api/v1/semesters/<id>/courses` | body `{ code, title }` → `201 { course, section }` (section "A" is created automatically); `404` if the semester isn't yours; `409` duplicate code |
| `PATCH /api/v1/courses/<id>` | body: any of `{ code, title }` → `{ course }` |
| `DELETE /api/v1/courses/<id>` | `204`, deletes its sections and topics too |
| `GET /api/v1/courses/<id>/topics` | `{ topics: [{ id, title, position }] }`, in teaching order |
| `POST /api/v1/courses/<id>/topics` | body `{ title, classesNeeded? }` → `201 { topic }`, added at the end. Or `{ titles, spreadOver? }` → `201 { topics }`: many at once, all or nothing, sharing `spreadOver` classes between them |
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
| `POST /api/v1/students/extract` | multipart: `files` (1–10 PDF/photo/xlsx/xls/csv, ≤ 20 MB), optional `sectionId` → `{ list: { courseCode, courseTitle, classLabel, sectionName }, students: [{ row, rollNumber, fullName, fatherName, status, message }], warnings }`. **Saves nothing.** `502 ai_failed` if Gemini can't read it |
| `GET /api/v1/assessments/<id>/questions` | the paper: `{ assessment, approvedMarks, draftMarks, sections: [{ id, title, instructions, attemptAny, position, questions }] }`, in order |
| `POST /api/v1/assessments/<id>/questions` | body `{ sectionId?, type, text, options?, parts?, difficulty?, marks?, topicId? }` → `201 { question }`, already approved. No `sectionId` = the last section |
| `PATCH /api/v1/assessments/<id>/questions` | body `{ status: "approved" }` → `{ approved }`, approves every draft |
| `DELETE /api/v1/assessments/<id>/questions` | clears the whole paper → `{ deleted }`. `?status=draft` clears only the drafts |
| `POST /api/v1/assessments/<id>/questions/generate` | body (all optional) `{ instructions, topics: [{ id, marks? }] }` → `201 { sections, targetMarks, marksTotal, topicPlan, dropped }`, saved as drafts. `502 ai_failed` if Gemini can't be reached |
| `PATCH /api/v1/questions/<id>` | any of `{ sectionId, type, text, options, parts, difficulty, marks, topicId, status }` → `{ question }`. `status` approves one question |
| `DELETE /api/v1/questions/<id>` | `204` |
| `POST /api/v1/assessments/<id>/sections` | body `{ title?, instructions?, attemptAny? }` → `201 { section }` |
| `PATCH /api/v1/paper-sections/<id>` | any of `{ title, instructions, attemptAny }` → `{ section }`. `attemptAny: null` = all compulsory |
| `DELETE /api/v1/paper-sections/<id>` | `204`; **its questions are deleted too** |
| `PUT /api/v1/assessments/<id>/questions` | body `{ sections: [{ id, questionIds }] }` → `204`. New order for the whole paper; must list everything exactly once |
| `POST /api/v1/questions/<id>/regenerate` | body (optional) `{ instructions }` → `{ question }`. Gemini rewrites this one question; type, topic and marks stay; it becomes a draft |
| `GET /api/v1/assessments/<id>/questions?format=pdf&time=3 hours` | the printable paper. Approved questions only; `400 no_approved_questions` if there are none |
| `GET /api/v1/sections/<id>/results` | the result sheet: `{ course, section, teacher, header, hasLab, theoryMax, labMax, summary, students: [{ theory, lab, total, totalInWords, percentage, grade, remarks, absent, missing }] }`. Add `?format=xlsx` or `?format=pdf` to download |
| `GET /api/v1/sections/<id>/marks?format=xlsx` or `pdf` | the marksheet file |
| `GET /api/v1/sections/<id>/attendance?format=xlsx` or `pdf` | the attendance sheet file: one column per class held |
| `GET /api/v1/courses/<id>/materials` | `{ materials: [{ id, courseId, topicId, name, mimeType, sizeBytes, createdAt }] }`, newest first. `?topicId=` for one topic |
| `POST /api/v1/courses/<id>/materials` | multipart: `file` (≤ 20 MB; PDF, Word, PowerPoint, Excel, text, image), `topicId?` → `201 { material }` |
| `GET /api/v1/materials/<id>` | `{ url, expiresInSeconds }`, a link that stops working after 10 minutes |
| `PATCH /api/v1/materials/<id>` | body `{ name?, topicId? }` → `{ material }` |
| `DELETE /api/v1/materials/<id>` | `204`; removes the file and its row |

| `POST /api/v1/assistant` | body `{ message, history? }` → `{ reply, toolsUsed }`. Reads data with tools, changes nothing. `502 ai_failed` if Gemini can't be reached |

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
| `app/api/v1/courses/route.ts` | `GET` all of the teacher's courses, across semesters | Flutter My courses screen |
| `app/api/v1/semesters/[id]/courses/route.ts` | `GET` list + `POST` add courses in one semester | Flutter app (later), PowerShell |
| `app/api/v1/courses/[id]/route.ts` | `PATCH` edit + `DELETE` one course | Flutter app (later), PowerShell |
| `docs/flows/courses.md` | Trace + test commands for the courses API | you |
| `app/api/v1/courses/[id]/topics/route.ts` | `GET` outline, `POST` add at end, `PUT` reorder (first use of `withTransaction`) | Flutter app (later), PowerShell |
| `app/api/v1/topics/[id]/route.ts` | `PATCH` rename + `DELETE` one topic | Flutter app (later), PowerShell |
| `docs/flows/topics.md` | Trace + test commands for the topics API | you |
| `app/api/v1/courses/[id]/sections/route.ts` | `GET` list (with student counts) + `POST` add sections of one course | Flutter app (later), PowerShell |
| `app/api/v1/sections/[id]/route.ts` | `PATCH` rename + `DELETE` one section | Flutter app (later), PowerShell |
| `docs/flows/sections.md` | Trace + test commands for the sections API | you |
| `app/api/v1/sections/[id]/students/route.ts` | `GET` list + `POST` add (find-or-create + enroll) students of one section | Flutter app (later: adding one student by hand), PowerShell |
| `app/api/v1/sections/[id]/students/[studentId]/route.ts` | `DELETE` take a student out of a section | Flutter app (later), PowerShell |
| `docs/flows/students.md` | Trace + test commands for the students API | you |
| `app/api/v1/students/extract/route.ts` | `POST` read a class list in any format with Gemini, then clean and check every row (preview only) | Flutter app (camera/file import, later), PowerShell |
| `app/api/v1/sections/[id]/import/route.ts` | `POST` save the confirmed rows of an import: all students created + enrolled in one transaction; rows already in the course are skipped | Flutter app (after the import preview, later), PowerShell |
| `docs/flows/student-import.md` | Trace + test commands for the student import (step 1 read, step 2 save) | you |
| `docs/flows/semesters.md` | Trace + test commands for the semesters API | you |
| `app/api/v1/students/[id]/route.ts` | `PATCH` fix a student's seat no, name, father's name or email (shows in every section) | Flutter app (later), PowerShell |
| `lib/holidays.ts` | `builtInHolidays(from, to)`: Pakistan's public holidays (fixed dates + Islamic dates from the Umm al-Qura calendar) and `addDays()`. **Date math only, no database.** The one shared file, because two routes need exactly the same calendar | `off-days/route.ts`, `sections/[id]/sessions/route.ts` |
| `app/api/v1/off-days/route.ts` | `GET ?semesterId=` off days in a semester (adds missing public holidays first) + `POST` add your own off day(s) | Flutter app (later), PowerShell |
| `app/api/v1/off-days/[id]/route.ts` | `PATCH` rename / move / shift / confirm + `DELETE` (public holidays are only hidden) | Flutter app (later), PowerShell |
| `docs/flows/off-days.md` | Trace + test commands for holidays and off days | you |
| `app/api/v1/sections/[id]/timetable/route.ts` | `GET` + `PUT` (replace the whole week) a section's weekly classes | Flutter app (later), PowerShell |
| `app/api/v1/sections/[id]/sessions/route.ts` | `GET` the whole semester's classes, worked out from timetable − off days + stored classes, **plus the teaching plan** (topics placed onto upcoming classes, "short by N classes"); `POST` find-or-create one class (cancel, extra class, or get an id for attendance) | Flutter app (later), PowerShell |
| `app/api/v1/sessions/[id]/route.ts` | `PATCH` cancel / un-cancel / note + `DELETE` forget a stored class | Flutter app (later), PowerShell |
| `app/api/v1/sessions/[id]/attendance/route.ts` | `GET` roster with marks (everyone present if not marked yet) + saved topics; `PUT { absent: [...], topicIds?: [...] }` | Flutter app (later), PowerShell |
| `app/api/v1/sections/[id]/attendance/route.ts` | `GET` each student's present / marked / % / shortage | Flutter app (later), PowerShell |
| `docs/flows/timetable-attendance.md` | Trace + test commands for timetable, class calendar and attendance | you |
| `app/api/v1/today/route.ts` | `GET ?date=` the teacher's classes on one day across all sections, with status, attendance counts and topic (taught, or next planned) | Flutter home screen (later), PowerShell |
| `docs/flows/today.md` | Trace + test commands for the home screen's "today" | you |
| `app/api/v1/courses/[id]/assessments/route.ts` | `GET` a course's assessments with allocated / unallocated marks + `POST` add one (refused if over the course total) | Flutter app (later), PowerShell |
| `app/api/v1/assessments/[id]/route.ts` | `PATCH` rename / change max marks + `DELETE` (its marks go too) | Flutter app (later), PowerShell |
| `app/api/v1/assessments/[id]/marks/route.ts` | `GET` class list with marks (`?sectionId=` optional) + `PUT` save marks for many students at once (`null` clears) | Flutter app (later), PowerShell |
| `app/api/v1/sections/[id]/marks/route.ts` | `GET` the gradebook: students × assessments, total, % of course total, missing count | Flutter app (later), result sheet (later), PowerShell |
| `app/api/v1/assessments/[id]/questions/route.ts` | The whole paper: `GET` it, `POST` add your own question, `PATCH` approve all drafts, `DELETE` clear it | Flutter app (later), PowerShell |
| `app/api/v1/assessments/[id]/questions/generate/route.ts` | `POST` Gemini writes a paper from the teacher's request and topic marks, saved as drafts | Flutter app (later), PowerShell |
| `app/api/v1/questions/[id]/route.ts` | One question: `PATCH` edit, move or approve it, `DELETE` remove it | Flutter app (later), PowerShell |
| `app/api/v1/assessments/[id]/sections/route.ts` | `POST` add a section to a paper | Flutter app (later), PowerShell |
| `app/api/v1/paper-sections/[id]/route.ts` | One section: `PATCH` edit it, `DELETE` remove it with its questions | Flutter app (later), PowerShell |
| `app/api/v1/questions/[id]/regenerate/route.ts` | `POST` Gemini rewrites one question in place | Flutter app (later), PowerShell |
| `app/api/v1/sections/[id]/results/route.ts` | `GET` the result sheet, worked out from the marks, as JSON, Excel or PDF | Flutter app (later), PowerShell |
| `app/api/v1/courses/[id]/materials/route.ts` | `GET` a course's files, `POST` upload one | Flutter app (later), PowerShell |
| `app/api/v1/materials/[id]/route.ts` | One file: `GET` an expiring link, `PATCH` rename or move, `DELETE` | Flutter app (later), PowerShell |
| `docs/flows/results.md` | Trace + rules for results and every export | you |
| `docs/flows/materials.md` | Trace + rules for uploading and opening files | you |
| `docs/flows/assessments-marks.md` | Trace + test commands for assessments, marks entry and the gradebook | you |
| `docs/flows/planner.md` | How the teaching plan is worked out (inside `GET /sections/<id>/sessions`) and how taught topics are recorded | you |
| `app/api/v1/assistant/route.ts` | `POST` ask the assistant: checks login and input, then calls `runAgent` | Flutter chat (later), PowerShell |
| `lib/agent/run-agent.ts` | `runAgent()`: the agent loop (ask the AI, run tools, repeat) | `assistant/route.ts` |
| `lib/ai.ts` | `askAI()`: one question to the AI through the OpenAI SDK; key, address and models come from `.env.local`; tries each model in turn | `run-agent.ts`, `students/extract`, `questions/generate`, `questions/[id]/regenerate`. Also `aiIsOpenAI()` (the few differences between companies) and `answerShape()` (the fixed JSON shape) |
| `lib/agent/instructions.ts` | `buildInstructions()`: the rules the agent follows | `run-agent.ts` |
| `lib/agent/api-client.ts` | `createApiGet()`: reads our API with the teacher's token | `assistant/route.ts`, every tool |
| `lib/agent/types.ts` | `AgentTool`, `ApiGet`, `defineTool()` | every tool, `run-agent.ts` |
| `lib/agent/tools/` | One file per tool; `index.ts` lists them | `run-agent.ts` |
| `docs/flows/assistant.md` | Trace, rules, test results and test commands for the assistant | you |
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
| `public.courses` | subject in one semester ("CS-101") | API (Step 1.3) | belongs to a semester; code unique per semester; `total_marks` (default 100) |
| `public.topics` | outline item | API (Step 1.3) | belongs to a course; `position` = teaching order; `classes_needed` (default 1) for the planner |
| `public.sections` | class group ("A") | API (Step 1.5a); "A" auto-created with each course | belongs to a course; name unique per course |
| `public.students` | student | API (Step 1.5b) / import (Step 1.6) | belongs to a teacher; roll number (= "Seat No") unique per teacher, stored in capitals; optional `father_name` |
| `public.enrollments` | student in a section | API (Step 1.5b) | links sections ↔ students (many-to-many) |
| `public.off_days` | holiday or day off (one day or a range) | `GET /off-days` / `GET /sections/<id>/sessions` (public holidays, automatically) / API (teacher's own) | belongs to a teacher, applies to all their sections; `holiday_key` (pre-filled only, unique per teacher), `tentative` (Islamic dates until confirmed), `removed` (deleted public holiday, kept hidden) |
| `public.timetable_slots` | weekly class ("Mon 09:00–10:30") | API (Step 2.2) | belongs to a section; `weekday` 1 = Monday … 7 = Sunday |
| `public.class_sessions` | class worth remembering: held, cancelled or extra | API (Step 2.3) | belongs to a section; unique per section + date + start time. **Ordinary future classes are not stored**, they are worked out |
| `public.assessments` | anything marked: "Quiz 1", "Mid", "Final"… | API (Step 4.1) | belongs to a course (shared by its sections); `max_marks`; name unique per course; their sum may not exceed the course total (checked by the API) |
| `public.marks` | one student's marks in one assessment | API (Step 4.2) | no row = not entered (≠ 0); `marks <= max_marks` checked by the API |
| `public.materials` | a file uploaded to a course | API (Step 7.1) | belongs to a course, optionally a topic (cleared if the topic is deleted); the file itself is in the private `materials` storage bucket, inside a folder named after the teacher's id |
| `public.assistant_chats` | a saved assistant conversation | API (assistant, 2026-11-08) | belongs to a teacher (deleted with them); `title` = first question; `messages` JSON list of `{ role, text, stats?, at }`; Confirm cards are not kept; sorted by `updated_at`. RLS on. |
| `public.paper_sections` | a part of a paper: "Section B: attempt any 4" | API (Step 5.2) | belongs to an assessment; `title` and `instructions` may be empty (a plain list is one untitled section); `attempt_any` empty = all compulsory |
| `public.questions` | question on a paper. Questions only, no answers | API (Step 5.1) | belongs to a section; `type` is free text, only `mcq` is special and must have `options`; `parts` JSON list of `{ label, text, marks }`; `status` draft/approved, `source` ai/manual; `topic_id` optional, cleared if the topic is deleted |
| `public.session_topics` | topic taught in a class | attendance `PUT` with `topicIds` (Step 3.1) | links class_sessions ↔ topics (one class can cover 2 topics; one topic can take several classes) |
| `public.attendance` | one student's mark at one held class | API (Step 2.4) | `present` true/false; replaced as a whole each time the class is saved |

How they connect (`──<` means "one to many"):

```
teachers ──< semesters ──< courses ──< sections >──┐
    │                         │           │  │      enrollments
    │                         ├──< topics │  │      │
    │                         └──< assessments ──< marks >── students
    │                                     │  └──< timetable_slots
    │                                     └──< class_sessions ──< attendance >──┐
    │                                            └──< session_topics >── topics
    ├──< students >───────────────────────────────────────────────┴─────────────┘
    └──< off_days
```

**Who owns what:** `semesters`, `students` and `off_days` have `teacher_id`. Everything else is owned through its parent: a section belongs to a course, which belongs to a semester, which belongs to a teacher. Deleting a parent deletes its children (`on delete cascade`).

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
| Ordinary classes are worked out, not stored | The calendar = timetable × semester days − off days, recalculated on every request. Only held / cancelled / extra classes are rows. Changing the timetable, a holiday or the semester dates re-plans every future class instantly, with nothing to regenerate or get out of sync. |
| Public holidays are pre-filled | Fixed national days + Islamic days (Umm al-Qura, marked tentative). The teacher confirms or shifts with one tap and never types a holiday. A deleted one is hidden, not re-added. |
| Attendance: send only the absent | Everyone is present by default, so a class takes a few taps. % = present ÷ classes the student was marked in; shortage below 75% (changeable per request with `?min=`). |
| The plan is worked out, not stored | Inside the calendar `GET`: unfinished topics (in outline order, each as many times as classes it still needs) are handed to the upcoming classes one by one. A cancelled class, shifted holiday or reordered outline changes the plan on the next request. |
| What was taught is recorded on the attendance screen | The app pre-fills `plan.nextTopic`; the teacher just saves. Chosen by the user for less effort (2026-11-02); can move to the planner screen later without changing the database. |
| Marks: no weights, no fixed categories | Total = plain sum of marks entered; % = total ÷ course total. Grades wait for the university's result format. An assessment that would take the course over its total is refused, so totals never go above 100%. |
| Decimal marks compared in hundredths | In JavaScript 33.3 + 33.3 + 33.4 = 100.00000000000001. Every "over the total / above max" check compares `Math.round(x × 100)`, and Postgres stores `numeric(6,2)`. |
| The agent lives in `lib/agent/`, not in its route | The one exception to "logic inside the route". It has several parts that change for different reasons, and its tools keep growing. Chosen by the user (2026-11-04). |
| Agent tools call our own API with the teacher's token | No logic is copied, and every login and ownership check still applies. |
| The AI via the OpenAI SDK (`openai`), with our own loop | Changed 2026-11-08 from `@google/genai`. Gemini accepts OpenAI's format at its own address, so one code path works with a Gemini key today and an OpenAI key later; only `.env.local` changes. No agent framework, every step can be read. |
| Times are Karachi time | "Today" (for "class hasn't happened yet" and the calendar summary) uses `Asia/Karachi`, the university's timezone. |
