# Flow: holidays and off days

> **Changed 2026-11-11: holidays belong to one course.** `GET /off-days?courseId=<id>` (was `?semesterId=`) and `POST /off-days` with `courseId` in the body. Each course has its own list; public holidays are added per course (`unique (course_id, holiday_key)`). A new course starts with the days the teacher already marked in their other courses for the same dates (`POST /semesters/<id>/courses` copies them, newest course's version wins). `PATCH`/`DELETE /off-days/<id>` are unchanged. Migration `20261111120000_course_settings.sql` copied every old teacher-wide day into each course it touched. Older text below describes the teacher-wide version.

Files: [lib/holidays.ts](../../lib/holidays.ts) (date math) · [app/api/v1/off-days/route.ts](../../app/api/v1/off-days/route.ts) (GET, POST) ·
[app/api/v1/off-days/[id]/route.ts](../../app/api/v1/off-days/[id]/route.ts) (PATCH, DELETE) · table `off_days`

An **off day** is a day with no classes for **any** of the teacher's sections: a public holiday, or a day the teacher adds ("university closed"). A one-off cancellation of **one** class is not an off day; that's a cancelled session (see [timetable-attendance.md](timetable-attendance.md)).

## Holidays fill themselves in

`builtInHolidays(from, to)` in [lib/holidays.ts](../../lib/holidays.ts) walks every day from `from` to `to` and checks:

| Kind | How it's found | Tentative? |
|---|---|---|
| Fixed national days: Kashmir Day 5 Feb, Pakistan Day 23 Mar, Labour Day 1 May, Youm-e-Takbeer 28 May, Independence Day 14 Aug, Iqbal Day 9 Nov, Quaid Day 25 Dec | month-day of the date | no |
| Islamic: Ashura (9–10 Muharram, 2 days), Eid Milad-un-Nabi (12 Rabi ul Awwal), Eid ul Fitr (1–3 Shawwal), Eid ul Adha (10–12 Dhul Hijjah) | Node's built-in **Umm al-Qura** Hijri calendar turns each date into a Hijri month/day | **yes**: the real date depends on the moon sighting |

Each holiday gets a **key**, e.g. `independence-day-2026` or `eid-ul-fitr-1448` (Islamic ones use the Hijri year, because some Gregorian years contain the same Eid twice).

```
GET /api/v1/off-days?semesterId=<id>
 1. token → 401;  no / bad semesterId → 400;  not your semester → 404
 2. builtInHolidays(semester start, semester end)
 3. INSERT INTO off_days … SELECT FROM unnest(keys, names, starts, ends, tentatives)
      ON CONFLICT (teacher_id, holiday_key) DO NOTHING
      → only holidays you DON'T have yet are added. One you moved keeps its new date; one you deleted
        is still there with removed = true, so it doesn't come back.
 4. SELECT off days (not removed) that touch the semester, by date
   ▼
200 { "offDays": [ { id, name, startDate, endDate, tentative, builtIn } ] }
```

The class calendar (`GET /sections/<id>/sessions`) runs the same step 2–3, so classes never land on a holiday even if the off-days screen was never opened.

## Change, confirm, remove, add

```
POST   /api/v1/off-days        { "name": "University closed", "startDate": "2026-09-14", "endDate": "2026-09-15" }   → 201 (endDate optional)
PATCH  /api/v1/off-days/<id>   { "shiftDays": 1 }        ← Eid came a day late: moves start AND end
                               { "startDate", "endDate", "name" }  ← any of them
                               {}                        ← just confirm
       Any PATCH sets tentative = false, because you've now checked it. End before start → 400.
DELETE /api/v1/off-days/<id>   → 204. A public holiday is only hidden (removed = true); your own off day is deleted.
```

The DELETE does both cases in one statement: a CTE with an `UPDATE … WHERE holiday_key IS NOT NULL` and a `DELETE … WHERE holiday_key IS NULL`. Only one of them can match.

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

Semester 2026-08-01 → 2026-11-30.

| Case | Result |
|---|---|
| first GET | 3 pre-filled: 14 Aug Independence Day, 25 Aug Eid Milad-un-Nabi (tentative), 9 Nov Iqbal Day |
| second GET | still 3 (no duplicates) |
| PATCH Eid Milad `{ shiftDays: 1 }` | 26 Aug, tentative = false |
| PATCH end date before start | 400 |
| DELETE Iqbal Day, then GET | stays gone |
| POST 14–15 Sep "University closed" | 201, `builtIn: false` |
| unknown semester | 404 |

## Try it (PowerShell, in `backend/`, dev server running)

Log in as in [courses.md](courses.md) (`$auth`, `$api`, `$sem`).

```powershell
$off = (Invoke-RestMethod -Uri "$api/off-days?semesterId=$($sem.id)" -Headers $auth).offDays
$off | Format-Table name, startDate, endDate, tentative, builtIn
# Eid is a day late: shift it
$eid = $off | Where-Object tentative | Select-Object -First 1
Invoke-RestMethod -Method Patch -Uri "$api/off-days/$($eid.id)" -Headers $auth -ContentType "application/json" -Body '{"shiftDays":1}'
# add your own
Invoke-RestMethod -Method Post -Uri "$api/off-days" -Headers $auth -ContentType "application/json" -Body '{"name":"University closed","startDate":"2026-09-14","endDate":"2026-09-15"}'
```
