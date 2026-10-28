# UstaadAssist — Architecture

This guide grows with the code. Every step that adds a file or folder updates it.

## The big picture

```
 Flutter app (../frontend)          Web dashboard (app/ pages)
        │  HTTPS + token                    │  runs on the server
        ▼                                    ▼
   app/api/v1/*  (API routes)  ───►  services/  (business logic)  ◄──┘
                                          │
                                       lib/db.ts
                                          │
                                 Supabase PostgreSQL
```

- **Flutter and the web dashboard never talk to the database directly.** Everything goes through our server code.
- **API routes are thin.** They read the request, check it and call a service.
- **Services hold the real logic** (attendance %, grading, permission checks), so web and mobile always get the same answers.
- **`lib/db.ts` is the only file that talks to Postgres.**

## Folders and files

| Path | Job | Used by |
|---|---|---|
| `app/` | Next.js pages (dashboard) and API routes (`app/api/v1`) | browser, Flutter |
| `lib/db.ts` | Database connection pool, `query()` and `withTransaction()` | services (later) |
| `.env.example` | List of the settings the app needs (no real values) | you, when setting up `.env.local` |
| `supabase/migrations/` | Numbered SQL files that build the database, in order | Supabase CLI (`npm run db:push`) |
| `supabase/config.toml` | Supabase CLI settings (created by `supabase init`; mostly for running Supabase locally, which we don't do yet) | Supabase CLI |
| `docs/` | This guide, concept explanations and flow traces | you |

## Database tables

| Table | One row per | Created by | Notes |
|---|---|---|---|
| `auth.users` | login | Supabase Auth | Supabase's table. We never write to it. |
| `public.teachers` | teacher | trigger `on_auth_user_created`, at signup | `id` = the login's id. RLS on. |

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
| All data goes through the Next.js API | Calculations and permission checks live in one place. |
| A course can have many sections | Real courses are taught to several class groups. |
| Per-course grading weights and bands | Courses differ (labs, quiz counts); the teacher enters raw marks, the server calculates. |
| Individual teacher accounts | No school/admin level for now. |
