# Flow: today's classes (the app's home screen)

File: [app/api/v1/today/route.ts](../../app/api/v1/today/route.ts) (GET) · reads `sections`, `timetable_slots`, `off_days`, `class_sessions`, `attendance`, `topics`, `session_topics`

The first screen of the app: **"Today: 09:00 SE-454 A · Linked lists, 11:00 CS-201 A · Trees"**. Tap a class to take attendance.

**Why not use the class calendar?** `GET /sections/<id>/sessions` works out a whole semester for **one** section. The home screen needs **one day** for **all** sections. With 4 sections that would be 4 calls, each calculating ~35 classes to show 1. This route does one call, one day.

## Trace

```
GET /api/v1/today                    (today in Karachi)
GET /api/v1/today?date=2026-11-03    (any day, e.g. tomorrow)
 1. token → 401;  date not YYYY-MM-DD → 400
 2. weekday of the date (1 = Monday … 7 = Sunday)
 3. sections whose semester is running on that date
 4. add a public holiday on that date if missing (same as GET /off-days), then: is the date an off day?
 5. SELECTs for those sections: timetable slots on that weekday · stored classes on that date (with present/absent)
    · what those classes taught · each section's outline with taught counts
 6. each timetable slot → its stored class if there is one, else "planned" (or "off_day")
    + stored classes that aren't in the timetable (extra classes);  sorted by start time
 7. topics:
      marked (held) class   → what was taught
      planned class         → the section's next unfinished topic(s), same rule as the planner (see planner.md)
   ▼
200 { "date": "2026-11-02", "weekday": 1, "today": true,
      "offDay": null | { name, tentative },
      "classes": [ { id (null = not stored yet), sectionId, sectionName, courseId, courseCode, courseTitle,
                     startTime, endTime, status: planned | held | cancelled | off_day,
                     extra, note, present, absent, topics: [ { id, title } ] } ] }
```

**Tap a class → attendance:** if `id` is null, the app first calls `POST /sections/<sectionId>/sessions { date, startTime }` to get one ([timetable-attendance.md](timetable-attendance.md)), then `GET`/`PUT /sessions/<id>/attendance`, pre-filling `topics` from this response.

**The planner rule appears twice:** it's in the class calendar and here, 3 lines each. It's kept inline (flat code) with a comment pointing to [planner.md](planner.md). Change both if the rule changes.

## Attendance alerts and Coming up

The same reply also carries two lists for Home.

```
attendanceAlerts: [ { sectionId, sectionName, courseId, courseCode, below: 2, min: 75 } ]
comingUp:         [ { id, name, date, courseId, courseCode } ]
```

- **`attendanceAlerts`** lists sections with students below the teacher's line. It uses the same sum as `GET /sections/<id>/attendance`: held classes only, rounded to one decimal, then compared.
- **A student needs 4 marked classes first** (`MIN_CLASSES_FOR_ALERT`). With fewer, one absence already falls below 75%, so everyone who missed a single class would be flagged.
- **`comingUp`** lists up to 5 assessments dated from this day on, soonest first. Most assessments have no date, so this is often empty, and the app then shows nothing.

Tested 2026-11-07 on throwaway temporary tables: exactly 75% isn't below 75, a cancelled class doesn't count, a section with 2 classes gives no alert, changing the line changes the count, a decimal line works, undated and past assessments stay out, and another teacher sees nothing. Not yet run over HTTP.

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

SE-454 A: Mon 09:00 + Mon 14:00, topics Arrays → Linked lists → Stacks (Arrays taught 26 Oct). CS-201 A: Mon 11:00 + Thu 09:00, topic Trees.

| Date | Result |
|---|---|
| Mon 2 Nov | 09:00 SE-454 (Linked lists), 11:00 CS-201 (Trees), 14:00 SE-454 (Stacks): two courses, time order, next topics in order |
| … after marking 09:00 (Sana absent, Linked lists) | 09:00 `held`, 1 present / 1 absent, taught Linked lists; 14:00 still Stacks |
| Mon 9 Nov (Iqbal Day) | `offDay: Iqbal Day`, all 3 classes `off_day` |
| Tue 3 Nov | only the extra class (16:00, "Make-up") |
| Thu 5 Nov | CS-201 09:00 |
| 7 Dec (after the semester) | no classes |
| `?date=7-12-2026` | 400 |
| no date | today's date, `today: true` |

## Try it (PowerShell, in `backend/`, dev server running)

With the set-up from [timetable-attendance.md](timetable-attendance.md):

```powershell
$t = Invoke-RestMethod -Uri "$api/today" -Headers $auth
$t.offDay
$t.classes | Format-Table startTime, courseCode, sectionName, status, @{ n = "topic"; e = { $_.topics.title -join ", " } }
# tomorrow
$tomorrow = (Get-Date).AddDays(1).ToString("yyyy-MM-dd")
(Invoke-RestMethod -Uri "$api/today?date=$tomorrow" -Headers $auth).classes | Format-Table startTime, courseCode, status
```
