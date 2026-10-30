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

---

## Cookie

**Everyday example:** a token you get at a cloakroom. You show it every time you come back, and the attendant knows which coat is yours.

A cookie is a small piece of text the server asks the browser to keep. The browser then **automatically sends it back with every request** to that site. That is how the server knows who is asking without you typing your password on every page.

Cookies can be marked **HttpOnly** (JavaScript in the page can't read them, which makes them hard to steal) and **Secure** (only sent over HTTPS). Supabase sets these for us.

## Session

The "you are logged in" state. With Supabase it is made of two tokens, stored in cookies.

## Access token (JWT) and claims

**Everyday example:** a visitor pass with your name, an expiry time and an official stamp.

The **access token** is a **JWT**: text with three parts, `header.payload.signature`.
- The **payload** holds the **claims**: facts like `sub` (the user's id), `email`, `exp` (expiry time).
- The **signature** is Supabase's stamp. If anyone changes even one letter of the payload, the stamp no longer matches.

It expires after about **1 hour** on purpose: if it's stolen, it's only useful briefly.

## Refresh token

A second, longer-lived token whose only job is to get a **new access token** when the old one expires. Supabase refresh tokens are **single-use**: each refresh gives you a new pair.

## getClaims() vs getSession() vs getUser()

| Method | What it does | Trust it? |
|---|---|---|
| `getSession()` | Reads the cookie and believes it | **No.** Anyone can edit a cookie. |
| `getClaims()` | Reads the cookie, **checks the signature**, refreshes if expired | **Yes.** Fast, usually no network call. |
| `getUser()` | Asks the Supabase server about the user | Yes, but needs a network call each time. |

We use `getClaims()`.

## Proxy (Next.js 16; called "middleware" before)

**Everyday example:** the security guard at a building's gate. Everyone passes him before reaching any office. He checks your pass and sends you to reception if you don't have one.

`proxy.ts` is a function that Next.js runs **before** every matching request, before any page code. Ours refreshes the login and redirects logged-out users to `/login`.

The **matcher** decides which URLs the guard checks. We skip images, CSS/JS files (no need to log in to load a logo) and `/api` (API routes check tokens themselves, because Flutter doesn't use cookies).

**The guard is only the first check.** Next.js warns not to rely on proxy alone; every place that reads data also checks who is asking ("defense in depth").

## Redirect

A response that says "go to this other URL instead" (status 307). The browser follows it automatically.

## Server Component, Server Action

- **Server Component:** a React page or component that runs on the server and sends finished HTML. It **can read cookies but can't change them.**
- **Server Action:** a function marked `"use server"` that a form can call directly, like a mini API endpoint. It **can** change cookies. We'll use these for login and signup.

## Cache headers (Cache-Control)

Instructions to browsers and CDNs (big caching servers in front of websites) about whether they may store a copy of a response. When a response sets login cookies, Supabase gives us `Cache-Control: no-store`, meaning "never store this". Otherwise a CDN could hand one teacher's login cookie to another teacher.

---

## HTML form, FormData

A `<form>` collects inputs. Each input's `name` becomes a key. When submitted, the browser sends all of them to the server together. On the server they arrive as **FormData**: `formData.get("email")` gives the email the user typed.

`required`, `type="email"` and `minLength` make the **browser** check the fields before sending. That is only a convenience: anyone can skip the browser, so **the server must check again**.

## Server Action as a form's `action`

`<form action={login}>` means "when submitted, run the `login` function **on the server** with the form's FormData". Next.js creates the hidden endpoint for us. The file has `"use server"` at the top so every function in it is a Server Action.

## Query string (search params)

The part of a URL after `?`: `/login?error=Invalid%20login%20credentials`. It's how we pass a short message to the next page. `%20` is a space, encoded so it's safe in a URL; `URLSearchParams` does that encoding for us.

In Next.js 16, a page receives `searchParams` as a **Promise**, so you `await` it.

## Static shell, Suspense and streaming (cacheComponents)

**Everyday example:** a restaurant brings bread and water the moment you sit down, and the main dish follows when it's cooked. You aren't left at an empty table.

This project has `cacheComponents: true` in `next.config.ts`. Next.js then builds the parts of each page that are the same for everyone **ahead of time** (the **static shell**) and sends them instantly.

Parts that depend on **this request** (cookies, the query string) can't be built ahead. They must be wrapped in `<Suspense fallback={...}>`: the shell is sent first with the fallback ("Loading…"), and the real content **streams in** when ready. Reading cookies or `searchParams` outside a `<Suspense>` is an error in this mode.

In our pages, the forms are part of the static shell; only the error notice and "Logged in as…" stream in.

## Email confirmation

If "Confirm email" is turned on in Supabase (Authentication → Sign In / Providers → Email), sign-up doesn't log the user in. Supabase emails a link; clicking it confirms the account, and then the user can log in. Supabase's built-in email sender only allows a few emails per hour, so for development it's common to turn confirmation off.

---

## API, endpoint, Route Handler

An **API** is a set of URLs that return data (usually JSON) instead of web pages, for other programs to use, like our Flutter app. Each URL + method (`GET /api/v1/me`) is an **endpoint**.

In Next.js, an endpoint is a `route.ts` file. The folder path is the URL (`app/api/v1/me/route.ts` → `/api/v1/me`), and the exported function's name is the HTTP method (`export async function GET`).

## HTTP methods and status codes

- **Methods** say what you want: `GET` read, `POST` create, `PATCH` change, `DELETE` remove.
- **Status codes** say how it went: `200` OK, `307` redirect, `400` bad input, `401` not logged in, `403` logged in but not allowed, `404` not found, `500` the server crashed.

## Authorization header and Bearer token

Apps don't have a browser cookie box, so they send the login token themselves, in a request header:

```
Authorization: Bearer eyJhbGciOi...
```

"Bearer" means "whoever carries this token is the user", just like a cookie. Our API reads it, checks Supabase's signature with `getClaims(token)`, and gets the teacher id from `claims.sub`.

## JSON

The text format APIs use for data: `{ "teacher": { "fullName": "Ali", "email": "ali@example.com" } }`. `Response.json(...)` turns a JavaScript object into it.

## SQL JOIN and AS

- `JOIN auth.users u ON u.id = t.id`: combine each teacher row with the matching login row, so one query gets the name (from `teachers`) and the email (from `auth.users`).
- `t.full_name AS "fullName"`: rename the column in the result. The quotes keep the capital N (Postgres lowercases names without quotes).

## CSRF (why the API doesn't accept cookies)

**Cross-Site Request Forgery:** a bad website makes your browser send a request to *our* site, and the browser attaches *our* cookies automatically, so the request runs as you. A Bearer token is never attached automatically, so an API that only accepts Bearer tokens isn't open to this.

---

## One-to-many and many-to-many

- **One-to-many:** one semester has many courses, but each course is in exactly one semester. The "many" side stores the link: `courses.semester_id`.
- **Many-to-many:** a section has many students, and a student can be in many sections. Neither side can hold a single id, so a **table in the middle** (a *junction table*) stores one row per pair: `enrollments (section_id, student_id)`.

**Everyday example:** a class register. Each line says "this student is in this class". The same student can appear in several registers.

## Normalisation (why not one big table)

Store each fact **once**. "Fall 2026" lives in one `semesters` row; courses point to it by id. Renaming it is then one update, not a hunt through every course row. Splitting data into linked tables this way is called **normalisation**.

## Default values: gen_random_uuid()

`id uuid primary key default gen_random_uuid()`: if an insert doesn't give an `id`, Postgres makes a new random UUID. Our code never has to invent ids.

## Constraints: unique, check, not null

Rules the **database** enforces, no matter which code inserts the data:
- `not null`: the column must have a value.
- `unique (teacher_id, roll_number)`: the **pair** can't repeat. Two teachers can both have roll number "21-001", but one teacher can't have it twice.
- `check (end_date >= start_date)`: any row breaking the rule is refused with an error.
- A **composite primary key** `primary key (section_id, student_id)` means the same student can't be enrolled in the same section twice.

## date vs timestamptz

- `date`: just a calendar day (`2026-09-01`). Used for semester start and end.
- `timestamptz`: an exact moment, with time and timezone. Used for `created_at`.

## Index

**Everyday example:** the index at the back of a book. Instead of reading every page to find "trigger", you look it up and jump straight there.

An index lets Postgres find rows by a column without scanning the whole table. Primary keys and `unique` rules get one automatically. Postgres does **not** automatically index foreign-key columns, so we add them where we'll search often: `topics(course_id)` ("all topics of this course"), `enrollments(student_id)` ("all sections of this student").

## Savepoint

A bookmark inside a transaction. `ROLLBACK TO SAVEPOINT s` undoes everything after the bookmark but keeps the transaction going. We used it to test several "this should fail" inserts in one transaction. In Postgres, once a statement fails, the transaction refuses every further command until you roll back, so the savepoint lets the test continue.

---

## REST (resource URLs + methods)

A common way to lay out an API: the **URL names the thing**, the **method says what to do** with it.

| | `/semesters` (the collection) | `/semesters/<id>` (one item) |
|---|---|---|
| `GET` | list them | (read one, not needed yet) |
| `POST` | create a new one | |
| `PATCH` | | change some fields |
| `DELETE` | | delete it |

## Dynamic route segment: `[id]`

A folder name in square brackets is a **variable part of the URL**. `app/api/v1/semesters/[id]/route.ts` handles `/api/v1/semesters/abc-123`, `/api/v1/semesters/xyz-789`, and so on. Inside, `const { id } = await ctx.params` gives `"abc-123"`.

## Input validation with Zod

**Everyday example:** the receptionist who checks a form before it goes to the office, and hands it back with "you forgot to sign here".

`z.object({ name: z.string().trim().min(1), startDate: z.iso.date() })` describes what valid input looks like. `schema.safeParse(body)` returns either `{ success: true, data }` (cleaned, e.g. trimmed) or `{ success: false, error }` with a message per field. `z.flattenError(error).fieldErrors` turns that into `{ "startDate": ["Use the format YYYY-MM-DD."] }`.

- `.refine(fn, { message, path })`: a custom rule involving several fields (end date ≥ start date).
- `.partial()`: makes every field optional (used for PATCH, where you only send what changes).

## RETURNING

`INSERT ... RETURNING id, name` / `UPDATE ... RETURNING ...` / `DELETE ... RETURNING id` make Postgres give back the affected rows. One query both changes the data **and** tells us the result. An **empty result means no row matched**, which is how we detect "not found / not yours".

## COALESCE in an UPDATE (partial updates)

`SET name = COALESCE($1, name)`: if `$1` is `NULL` (field not sent), keep the current `name`; otherwise use the new value. That's how one `UPDATE` handles "change only the fields that were sent".

## Postgres error codes

When Postgres refuses something, the error has a 5-character `code`:
- `23505`: a `unique` rule was broken (duplicate) → we answer `409`.
- `23514`: a `check` rule was broken → we answer `400`.
- `23503`: a foreign key was broken (points at something that doesn't exist).

## More HTTP status codes

- `201 Created`: a new item was made (POST).
- `204 No Content`: done, nothing to send back (DELETE).
- `409 Conflict`: the request clashes with existing data (duplicate name).

## The `date` timezone trap

`pg` turns a Postgres `date` like `2026-09-01` into a JavaScript `Date` at **midnight in the server's timezone**. Sent as JSON, that becomes UTC, e.g. `2026-08-31T19:00:00.000Z` on a Pakistan server: **the wrong day**. Selecting `start_date::text` makes Postgres send the plain text `"2026-09-01"`, so no conversion happens.

---

## Nested URLs (`/semesters/<id>/courses`)

When something is always created **inside** a parent, the URL shows the parent: `POST /semesters/<id>/courses` means "add a course to *this* semester". Once the course exists, it has its own id, so editing and deleting use the shorter `/courses/<id>`.

## Checking ownership through a parent: INSERT … SELECT, UPDATE … FROM, DELETE … USING

`courses` has no `teacher_id`; its owner is found through `semesters`. Postgres lets one statement both **check the parent** and **change the row**:

- `INSERT INTO courses (...) SELECT id, $2, $3 FROM semesters WHERE id = $1 AND teacher_id = $4`: the `SELECT` produces **one row only if the semester is yours**, and that row is what gets inserted. Not yours → nothing inserted → empty `RETURNING` → 404.
- `UPDATE courses c ... FROM semesters s WHERE c.id = $3 AND s.id = c.semester_id AND s.teacher_id = $4`: update the course only when it can be joined to a semester owned by this teacher.
- `DELETE FROM courses c USING semesters s WHERE ...`: the same idea for deleting.

Doing the check and the change **in one statement** means there's no gap between "check" and "change" where something could slip through.

---

## PUT vs PATCH

- `PATCH` = "change **some** fields of this thing" (rename one topic).
- `PUT` = "**replace** this thing completely with what I'm sending". We use it for reordering: the app sends the **whole** new order of the outline, not just one move.

## "Add at the end": MAX(position) + 1

`COALESCE((SELECT MAX(position) FROM topics WHERE course_id = ...), 0) + 1`: find the highest position in this course and add 1. For an empty outline `MAX` is `NULL`, `COALESCE` turns that into `0`, so the first topic gets position 1.

## Row lock: SELECT … FOR UPDATE

**Everyday example:** putting a "reserved" sign on a set of chairs while you rearrange them, so nobody sits down in the middle of it.

`SELECT ... FOR UPDATE` inside a transaction **locks** those rows until the transaction ends. Anyone else trying to change them waits. In the reorder, it stops another request from adding or deleting a topic between our check ("is this the complete list?") and our update.

Locks only last as long as the transaction, which is why this only makes sense inside `withTransaction()`.

## unnest(...) WITH ORDINALITY

Turns a list into rows, and numbers them:

```sql
SELECT * FROM unnest(ARRAY['c','a','b']) WITH ORDINALITY AS o(id, position);
--  id | position
--  c  | 1
--  a  | 2
--  b  | 3
```

The reorder joins these rows to `topics` by id and copies each number into `position`: **one UPDATE sets the whole new order.**

## Set (JavaScript)

A collection where each value appears only once. `new Set(list).size === list.length` is a quick way to check "no duplicates in this list", and `set.has(id)` checks membership quickly.
