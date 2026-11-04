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

## Bulk insert: unnest with several lists

`unnest` can take **several lists at once** and zip them into rows, like the columns of a table:

```sql
SELECT * FROM unnest(ARRAY['EB…003','EB…005'], ARRAY['ABDUL GHANI','NASIR AKHTAR'], ARRAY['MUHAMMAD AFZAL', NULL])
         AS list(roll_number, full_name, father_name);
--  roll_number | full_name    | father_name
--  EB…003      | ABDUL GHANI  | MUHAMMAD AFZAL
--  EB…005      | NASIR AKHTAR | NULL
```

Put `INSERT INTO students (...) SELECT ... FROM unnest(...)` in front and **one statement inserts the whole class**. The app sends three lists (`$2::text[]`, `$3::text[]`, `$4::text[]`), not 60 separate INSERTs. Item 1 of each list makes row 1, and so on.

**Everyday example:** instead of walking to the office 60 times with one form each, you hand in one stack.

## `= ANY($1::text[])`: "is in this list"

`WHERE roll_number = ANY($1::text[])` means "the seat number is one of these". It's the same as `IN ('a', 'b', 'c')`, but the whole list goes in as **one parameter**, so it stays safe from SQL injection however long the list is. `::text[]` tells Postgres the parameter is a list of text.

## Set (JavaScript)

A collection where each value appears only once. `new Set(list).size === list.length` is a quick way to check "no duplicates in this list", and `set.has(id)` checks membership quickly.

## CTE: several inserts in one statement (`WITH ... AS (INSERT ...)`)

A **CTE** (Common Table Expression) is a named step inside one SQL statement. `WITH new_course AS (...)` runs the part in brackets and lets later parts read its result like a table. In Postgres that step can even be an `INSERT ... RETURNING`.

We use it to create a course **and** its section "A" together:

```sql
WITH new_course  AS (INSERT INTO courses ... RETURNING id, ...),
     new_section AS (INSERT INTO sections (course_id, name) SELECT id, 'A' FROM new_course RETURNING ...)
SELECT ... FROM new_course JOIN new_section ...
```

One statement is always all-or-nothing, so this needs no transaction. If the semester isn't yours, `new_course` is empty, so `new_section` inserts nothing too.

**Everyday example:** an admission form with a tear-off slip. The office accepts the whole form or rejects it; you never get the slip without the form.

**When a transaction is still needed:** when step 2 depends on JavaScript logic or a check in between. Then we use `withTransaction` (as in the topics reorder).

## LEFT JOIN, COUNT and GROUP BY

- `JOIN` keeps only rows with a match on both sides, so a section with no students would disappear.
- `LEFT JOIN enrollments` keeps **every** section. Where there are no students, the enrollment columns are empty (NULL).
- `GROUP BY sec.id` folds all the enrollment rows of one section into one result row, and `COUNT(e.student_id)` counts them. COUNT skips NULLs, so an empty section gives 0.
- `::int` turns the count into a normal number. Postgres counts are `bigint`, which `pg` returns as text (`"65"`).

**Everyday example:** listing every classroom with its headcount, including empty rooms (0), not only rooms that have someone in them.

## json_build_object

Builds a JSON object inside SQL: `json_build_object('id', c.id, 'code', c.code)` gives `{"id": "...", "code": "..."}`. We use it so one result row can carry two separate objects (`course` and `section`), and the route returns that row as-is.

## Find-or-create and `ON CONFLICT DO NOTHING`

**Find-or-create:** "use this student if they already exist, otherwise make them". We need it because one student can be in several of your sections but must exist only once.

`INSERT ... ON CONFLICT (teacher_id, roll_number) DO NOTHING RETURNING ...` tries to insert. If the unique rule would be broken, Postgres quietly inserts nothing and returns **no row**, instead of throwing error 23505. So:
- a row came back → it's a new student
- no row → the seat number is taken, so we `SELECT` the existing student

Trying the INSERT first (instead of SELECT first, then INSERT) is safe even if two requests arrive at the same moment: only one insert can win, and the other sees "no row".

**Everyday example:** handing in a library membership form. If you're already a member, the desk doesn't make a second card; they just look up your existing one.

## Zod transforms: cleaning input, not just checking it

- `.transform(fn)` changes the value after it passes: `v.trim().replace(/\s+/g, " ")` turns `"ABDUL   GHANI "` into `"ABDUL GHANI"`, and `.toUpperCase()` makes seat numbers capitals.
- `.pipe(z.string().min(1))` checks the **cleaned** value, so `"   "` counts as empty.
- `.nullish()` means the field may be missing (`undefined`) or `null`.

Cleaning in one place means the database never holds `"eb24…"` and `"EB24…"` as two different students.

## Adding a column to an existing table

`alter table public.students add column father_name text;` adds a column to a table that already has rows. Existing rows get `NULL` (empty) for it, which is why a new column that must start empty can't be `not null` without a default. It went in a **new** migration file, because pushed migrations are never edited.

## multipart/form-data (uploading files)

JSON can only carry text, so files are sent as **multipart/form-data**: the request body is split into parts, each with a name (`files`, `sectionId`) and its content, which can be a whole file. In a route, `await request.formData()` reads it, and `form.getAll("files")` gives every attached file. Browsers use the same format for `<input type="file">` forms.

**Everyday example:** a parcel with several labelled envelopes inside, one per document.

## Structured output (making AI answer in a fixed shape)

Left alone, an AI answers in free text, which code can't rely on. With `responseMimeType: "application/json"` and `responseJsonSchema`, Gemini **must** answer as JSON that fits our schema. We write the schema once in Zod. `z.toJSONSchema(extraction)` turns it into the JSON Schema Gemini understands, and `extraction.safeParse(answer)` checks the reply with the same rules. `.describe("...")` adds a hint for each field.

**Everyday example:** giving someone a printed form with boxes to fill in, instead of asking them to "write down the students".

## Base64

A way to write any file (bytes) as plain letters and digits, so it can travel inside a text/JSON request. `bytes.toString("base64")`. It makes the data about one third bigger, one reason for the 20 MB limit.

## Fallback models, time limits and AbortSignal

AI services get overloaded (503), hit quota limits (429), answer very slowly or are briefly unreachable. So the route keeps a **list** of models and tries the next one when one fails, but not for errors that would fail everywhere (400 bad request, 401/403 bad key).

`AbortSignal.timeout(45_000)` is a timer that **cancels** the request after 45 seconds. Without it, one overloaded model once took 5 minutes to answer.

**Everyday example:** calling a second shop when the first one's line is busy or keeps you on hold too long.

## AI "thinking" level

Newer Gemini models reason step by step before answering. That helps hard problems but costs time. Copying names from a list is easy, so we ask for `ThinkingLevel.LOW`: same quality for this job, much faster.

## Unicode look-alikes and NFKC

Different alphabets have letters that look the same but are different characters: Greek "Α" (Alpha) is not English "A". Text copied from PDFs often contains them. To a computer, "ΑΚΗΤΑR" ≠ "AKHTAR", so searching and duplicate checks would fail. We replace look-alikes with English letters. `normalize("NFKC")` also turns special forms (full-width letters, ligatures like "ﬁ") into normal ones.

## Clearing a value: CASE WHEN instead of COALESCE

`COALESCE($1, father_name)` means "the new value, or keep the old one if nothing was sent". But then sending `null` can never **clear** a value, because null already means "keep". So for fields that may be cleared we send two parameters: "was it sent?" (true/false) and the value:

```sql
father_name = CASE WHEN $3 THEN $4 ELSE father_name END
--   $3 = true,  $4 = null   → cleared
--   $3 = false              → kept
```

## Calculated vs stored data

Some data is better **worked out each time** than saved. The class calendar is the example: timetable × semester days − off days. If we saved every future class as a row, every timetable change, holiday shift or new semester end date would mean finding and fixing those rows, and one missed row is a wrong calendar. Calculating means there's nothing to keep in sync. We store only what can't be calculated: what actually **happened** (held, cancelled, extra).

**Everyday example:** a school bell timetable on the wall vs a diary. You don't write "Maths, 9:00" into the diary for every Monday of the year; you look at the timetable. The diary only records what happened ("Maths cancelled, teacher sick").

## Soft delete (a "removed" flag)

Instead of deleting a row, set `removed = true` and leave it out of lists. We do this for public holidays: if the row were really deleted, the next "add missing holidays" step would see it missing and add it back. The hidden row remembers "the teacher doesn't want this one".

## Hijri dates with `Intl.DateTimeFormat`

Node can show any date in other calendars. `new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", …)` turns 2026-03-20 into "1 Shawwal 1447" (Eid ul Fitr). **Umm al-Qura** is the Islamic calendar Saudi Arabia calculates in advance. Pakistan follows its own moon sighting, which is often the same day and sometimes a day later. That's why these holidays are marked **tentative** and the teacher can shift them by one day.

## Date arithmetic in Postgres: `date + integer`

In Postgres, adding a number to a `date` moves it by that many days: `'2026-08-25'::date + 1` = `2026-08-26`. That's how `{ "shiftDays": 1 }` moves an off day's start and end together.

## `count(...) FILTER (WHERE ...)`

Counts only the rows that match the condition. One query gives several counts at once:

```sql
count(a.student_id) FILTER (WHERE a.present)      AS present,
count(a.student_id) FILTER (WHERE NOT a.present)  AS absent
```

## Upsert: `ON CONFLICT ... DO UPDATE`

Like `ON CONFLICT DO NOTHING`, but instead of skipping, it **changes** the existing row. "Insert this class, or if it's already there, just update its status." Inside `DO UPDATE`, `class_sessions.status` means the existing row's value, so `COALESCE($5, class_sessions.status)` keeps the old status when no new one was sent.

## `UNION ALL`

Sticks the rows of two `SELECT`s together into one list. The off-day DELETE uses it to return the id from whichever of its two steps (hide or delete) actually matched.

## "Today" depends on the timezone

At 2 a.m. in Karachi it's still yesterday in London. Servers often run in UTC, so `new Date()` alone can give the wrong day. `new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date())` gives today's date **in Karachi** as `YYYY-MM-DD` (the Canadian English format happens to be exactly that).

## Postgres `numeric` and why `pg` returns it as text

`numeric(6,2)` stores exact decimal numbers: up to 6 digits, 2 after the point (so 9999.99 at most). It's exact, unlike JavaScript numbers. That's why `pg` hands it over as **text** ("7.50"): converting it to a JavaScript number could lose precision for huge values. Marks are small, so we cast in SQL, `marks::float8`, and get a normal number (7.5) in the JSON.

## Why 0.1 + 0.2 isn't 0.3 in JavaScript

Computers store decimals in binary, and most decimals (0.1, 33.3…) can't be written exactly in binary, just like 1/3 can't be written exactly in decimal (0.3333…). Tiny errors appear: `33.3 + 33.3 + 33.4` gives `100.00000000000001`. **Fix:** compare in whole hundredths, `Math.round(x * 100)`. Whole numbers add up exactly. **Everyday example:** shops count in paisa, not in fractions of a rupee, so the till always balances.

## "Not entered" vs 0 (no row vs a row)

A missing mark and a zero mean different things: "hasn't been marked yet" vs "sat the test and scored nothing". We keep them apart by **not storing a row** until a mark is entered. The API shows a missing mark as `null` and counts it as `missing`, so the teacher can see what's left to enter.

## AI agent

A normal AI call is one question and one answer. An agent can take steps: it decides what it needs, uses a tool, looks at the result, and decides again. Like asking an assistant at the office "who's short on attendance?": they open the register, read it, and then answer you. The student import is one call. The assistant is an agent.

## Tool (function calling)

Gemini can't reach our database. We give it a list of tools, each with a name and a description. It replies "please run `list_courses`", **our** code runs it, and we send back the result. Like a manager who can't go to the file room: they ask, and a clerk fetches the file. Gemini only ever sees the list and the results, never the code.

## The agent loop

The repeating part of an agent: ask Gemini → run the tools it asked for → add the results to the conversation → ask again. It ends when Gemini replies with text and no tool request. We stop it after 6 rounds or 90 seconds, so it can't run forever.

## System instructions

Rules sent to the AI with every request, separate from the teacher's message. Like a job description handed to a new employee. They greatly reduce mistakes but can't guarantee none, so the important protections (login, ownership, no write tools) are in our code, not only in the instructions.

## Hallucination

When an AI states something false as if it were true. In testing Gemini invented a tool name and two screen names. That's why facts must come from tools, and why our code checks every tool name and argument.

## Rate limit and quota (429)

A limit on how many requests an API accepts. Google's free tier allows 20 requests a day per model, and then replies `429`. A `503` is different: it means the model is busy for everyone right now, and trying again soon often works.

## Structured output (a schema for AI answers)

Normally an AI replies in free text, which code can't rely on. With a schema we give it a form to fill in: these exact fields, of these types. It's the difference between "tell me about the question" and a printed form with boxes for Question, Answer and Marks. We still check the reply afterwards, because the form forces the shape, not the truth: a multiple-choice answer can still fail to match any option.

## Draft and approved (human in the loop)

AI work is treated like a junior assistant's work: useful, but someone responsible signs it off. `status` starts as `draft`, and only the teacher can move it to `approved`. A paper uses approved questions only, so an unchecked AI question can't reach students.

## `jsonb`

A Postgres column type that stores JSON. We use it for a question's `options`, because the list of choices is always read together with its question, so it doesn't need its own table.

## `jsonb_to_recordset` (many rows in one insert)

Turns a JSON list into table rows inside a query. We send all generated questions as one value and Postgres unpacks them, like handing over one stack of forms instead of walking to the counter ten times.

## Thinking level

Gemini can reason before it answers. More thinking means better work but a slower reply. Copying a student list uses `LOW`. Writing exam questions uses `MEDIUM`, because quality matters more there.
