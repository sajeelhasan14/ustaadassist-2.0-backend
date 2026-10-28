# Flow: sign up, log in, open a page, log out (web)

Files involved:
[app/signup/page.tsx](../../app/signup/page.tsx) ·
[app/login/page.tsx](../../app/login/page.tsx) ·
[lib/auth-actions.ts](../../lib/auth-actions.ts) ·
[lib/supabase/server.ts](../../lib/supabase/server.ts) ·
[proxy.ts](../../proxy.ts) ·
[app/page.tsx](../../app/page.tsx) ·
[lib/db.ts](../../lib/db.ts) ·
[supabase/migrations/…_create_teachers.sql](../../supabase/migrations/20261027000000_create_teachers.sql)

---

## 1. Sign up

```
Teacher fills the form on /signup and presses "Sign up"
   │  browser POSTs the form fields: full_name, email, password
   ▼
proxy.ts            /signup is public → let it through
   ▼
signup(formData)    lib/auth-actions.ts (Server Action)
   │  1. read + trim the three fields; any empty → back to /signup?error=...
   │  2. createSupabaseServerClient()  (cookie box = this request's cookies)
   │  3. supabase.auth.signUp({ email, password, options.data.full_name })
   ▼
Supabase Auth       inserts a row into auth.users
   │  (same transaction) trigger on_auth_user_created
   ▼
handle_new_user()   inserts public.teachers (id = new user's id, full_name)
   ▼
back in signup():
   ├─ error (e.g. "User already registered")  → /signup?error=...
   ├─ no session (email confirmation is on)    → /login?message=Check your email...
   └─ session                                  → Supabase client calls setAll()
                                                  → Set-Cookie: sb-<ref>-auth-token
                                                  → redirect("/")
```

## 2. Log in

Same shape as sign-up, but `signInWithPassword()`:
- wrong email/password → Supabase returns "Invalid login credentials" → `/login?error=Invalid%20login%20credentials` → the `Notices` component shows it in red.
- correct → `Set-Cookie` with the login → redirect to `/`.

## 3. Open the home page while logged in

```
Browser: GET /     Cookie: sb-<ref>-auth-token=base64-...   (sent automatically)
   ▼
proxy.ts           getClaims(): signature OK (refresh first if expired) → logged in → carry on
   ▼
app/page.tsx       static shell is sent at once: "Loading…" + Log out button
   ▼  (inside <Suspense>)
CurrentTeacher     getClaims() again → claims.sub = teacher id
   │  query("SELECT full_name FROM teachers WHERE id = $1", [teacherId])   (lib/db.ts → Supabase Postgres)
   ▼
"Logged in as <name>" streams in and replaces "Loading…"
```

## 4. Log out

```
Press "Log out"  →  logout()  (Server Action)
   │  supabase.auth.signOut({ scope: "local" })   this browser only
   │  → setAll() with empty cookies → Set-Cookie that deletes sb-<ref>-auth-token
   ▼
redirect("/login")
```

## Where each security check happens

| Check | Where |
|---|---|
| Fields not empty | `login()` / `signup()` (and `required` in the HTML, which is only a convenience) |
| Password correct, email unique, password long enough | Supabase Auth |
| Cookie genuine and not expired | `getClaims()` in `proxy.ts`, and again in `CurrentTeacher` |
| Logged-out users can't see pages | `proxy.ts` redirect |

---

## 5. The app asks "who am I?" (`GET /api/v1/me`)

File: [app/api/v1/me/route.ts](../../app/api/v1/me/route.ts)

```
App logs in with Supabase Auth directly (supabase_flutter, or the PowerShell test below)
   │  gets back { access_token, refresh_token, ... }
   ▼
GET /api/v1/me      Authorization: Bearer <access_token>
   ▼
proxy.ts            matcher skips /api → not involved
   ▼
route.ts GET()
   │ 1. read the header; no "Bearer ..." → 401 {"error":{"code":"unauthorized",...}}
   │ 2. supabase.auth.getClaims(token); bad/expired → 401
   │    claims.sub = teacher id
   │ 3. query(SELECT ... FROM teachers JOIN auth.users ... WHERE t.id = $1)
   │    no row → 404 teacher_not_found
   ▼
200 {"teacher":{"id":"...","fullName":"...","email":"...","createdAt":"..."}}
```

Try it from PowerShell in `backend/` (this is exactly what the Flutter app will do):

```powershell
$key = (Select-String -Path .env.local -Pattern '^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.*)').Matches[0].Groups[1].Value
$login = Invoke-RestMethod -Method Post -Uri "https://xmicoapelndgosaiapvb.supabase.co/auth/v1/token?grant_type=password" -Headers @{ apikey = $key } -ContentType "application/json" -Body '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/me" -Headers @{ Authorization = "Bearer $($login.access_token)" } | ConvertTo-Json
```
