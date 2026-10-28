# Concepts, in simple words

Each idea used in the project is explained here once. Look things up here whenever a word is unclear.

---

## Database connection

Before the app can run SQL, it has to "call" the database server over the internet and log in with the username and password in `DATABASE_URL`. That open line is a **connection**.

Opening one is slow (it takes a noticeable fraction of a second) and Supabase only allows a limited number at once.

## Connection pool

**Everyday example:** a rickshaw stand. Instead of building a new rickshaw for every passenger and throwing it away after the ride, a few rickshaws wait at the stand. A passenger takes one, rides, and brings it back for the next person.

A **pool** keeps a few database connections open. When code needs to run a query, it borrows a connection, uses it and gives it back. This is fast and stays within Supabase's limit.

In our code: `new Pool(...)` in `lib/db.ts`.

## Releasing a connection

Giving a borrowed connection back to the pool. If you forget, the pool slowly runs dry and the app hangs while it waits for a free connection. That is why `withTransaction()` releases inside `finally`, which runs whether things succeed or fail.

## Transaction

**Everyday example:** a bank transfer. Taking money from you and adding it to your friend must both happen, or neither.

A transaction groups several SQL statements into one **all-or-nothing** unit:
1. `BEGIN`: "Start a group. Don't make anything final yet."
2. Run the statements.
3. `COMMIT`: "All worked; make it final." Or, if anything failed, `ROLLBACK`: "Cancel everything since BEGIN."

All statements in a transaction must use **the same connection**. That is why `withTransaction()` hands you a `client` to use.

**In UstaadAssist:** saving attendance for a whole class, entering marks for an assessment, approving an AI-generated quiz.

## Parameterized query ($1, $2) and SQL injection

**Wrong:** `"SELECT * FROM students WHERE name = '" + name + "'"`. If someone types `'; DROP TABLE students; --` as a name, it becomes part of the SQL and runs. This is called **SQL injection**.

**Right:** `query("SELECT * FROM students WHERE name = $1", [name])`. The SQL and the values travel separately, so the database always treats `name` as plain data and never as commands.

**Rule for this project:** never build SQL by joining strings with user values. Always use `$1, $2, ...`.

## Environment variables (.env.local)

Settings that change between computers and must stay secret, like database passwords. Next.js reads them from `.env.local` into `process.env`.

- `.env.local` holds the real values. It is git-ignored and never committed.
- `.env.example` lists the names only, so anyone setting up the project knows what to fill in.
- Only variables starting with `NEXT_PUBLIC_` are sent to the browser. Everything else stays on the server.

## server-only

A one-line guard (`import "server-only"`). If any browser-side component ever imports a file that has it, the build fails with an error. We put it in `lib/db.ts` so database code can never be shipped to the browser.

## globalThis

An object that stays the same for as long as the Node.js server process is running. In development, Next.js re-runs our files every time we save, which would create a fresh pool each time. Storing the pool on `globalThis` lets the re-run code find and reuse the existing one.

---

## Migration

**Everyday example:** the numbered steps in a furniture assembly manual. Anyone with the manual can build the same table, step by step, in the right order.

A migration is one SQL file that changes the database structure (create a table, add a column). The files live in `supabase/migrations/`, are saved in git, and have a timestamp in their name so they always run in order. The Supabase CLI records which files have already run on a database, so each one only runs once.

**Rule:** never edit a migration that has already run. To change something, add a new migration.

## Schema (public, auth)

A schema is a folder inside the database that groups tables. Supabase uses:
- `auth`: Supabase's own login tables (`auth.users`). We read from it but never change it ourselves.
- `public`: our tables (`public.teachers`, and later courses, students, …).

## Primary key

The column that uniquely identifies each row, like a CNIC number for a person. No two rows can have the same one. For `teachers` it is `id`.

## Foreign key (references)

A column that points to a row in another table. `teachers.id references auth.users (id)` means: "this id must exist in `auth.users`". The database refuses a teacher whose login doesn't exist.

**`on delete cascade`**: if the login is deleted, delete the teacher row too, so no orphan profile is left behind.

## UUID

A long random id like `3f2b8c1e-...`. Supabase gives every user one. They're practically impossible to guess, unlike `1, 2, 3`.

## timestamptz

A date and time **with timezone**. Always store times this way so that "10:00 in Karachi" is never confused with "10:00 in London". `default now()` fills in the current time automatically.

## Supabase's automatic REST API and the anon key

Supabase automatically creates a web API for every table in `public`. Apps can call it using the **anon key**, which is *not* secret (it ships inside the Flutter app). We don't use this API, because all our data goes through our Next.js API, but it is switched on anyway. So we must lock it.

## Row Level Security (RLS)

A per-table lock. Turned on with **no rules (policies)**, it means "nobody gets any rows through Supabase's REST API". Our server connects as the database **owner**, which RLS doesn't apply to, so our API still works.

**Rule for this project:** every new table gets `enable row level security` in the same migration.

## Trigger

**Everyday example:** a motion-sensor light. Nobody presses the switch; something happens and the light reacts automatically.

A trigger runs a function automatically when something happens to a table. Ours: *after a new row is inserted into `auth.users`* (someone signed up), run `handle_new_user()`, which inserts the matching `teachers` row. It works no matter whether the signup came from the web or from Flutter.

Inside a trigger, `new` means "the row that was just inserted".

## security definer and search_path

- `security definer`: the function runs with the permissions of whoever *created* it (the owner), not whoever caused it. That's needed because the signup is performed by Supabase Auth's own role, which isn't allowed to write to our `teachers` table.
- `set search_path = ''`: makes the function use only full names like `public.teachers`. This stops anyone from tricking it with a look-alike table in another schema. Supabase recommends it for every `security definer` function.

## raw_user_meta_data and coalesce

- `raw_user_meta_data`: extra info sent with the signup (we send `full_name`). `->> 'full_name'` reads that field as text.
- `coalesce(a, '')`: "use `a`, but if it's empty (NULL), use `''`". It keeps the insert from failing if a name wasn't sent.
