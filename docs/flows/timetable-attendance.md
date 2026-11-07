# Flow: timetable, class calendar and attendance

Files: [app/api/v1/sections/[id]/timetable/route.ts](../../app/api/v1/sections/[id]/timetable/route.ts) (GET, PUT) ·
[app/api/v1/sections/[id]/sessions/route.ts](../../app/api/v1/sections/[id]/sessions/route.ts) (GET, POST) ·
[app/api/v1/sessions/[id]/route.ts](../../app/api/v1/sessions/[id]/route.ts) (PATCH, DELETE) ·
[app/api/v1/sessions/[id]/attendance/route.ts](../../app/api/v1/sessions/[id]/attendance/route.ts) (GET, PUT) ·
[app/api/v1/sections/[id]/attendance/route.ts](../../app/api/v1/sections/[id]/attendance/route.ts) (GET) ·
tables `timetable_slots`, `class_sessions`, `attendance` (+ `off_days`, see [off-days.md](off-days.md))

## The big idea: classes are worked out, not stored

```
 timetable (Mon 09:00, Wed 11:00)
   × every day of the semester (1 Aug → 30 Nov)
   − off days (holidays, "university closed")
   = planned classes                                   ← calculated on every GET, never saved
   + stored classes (held / cancelled / extra)         ← rows in class_sessions, they replace the matching planned one
   = the calendar
```

Change the timetable, shift Eid, or move the semester end: the calendar is right on the next GET, with nothing to regenerate. A class becomes a row only when something happened to it.

## 1. Timetable: the whole week at once

```
PUT /api/v1/sections/<sectionId>/timetable
{ "slots": [ { "weekday": 1, "startTime": "09:00", "endTime": "10:30" }, { "weekday": 3, "startTime": "11:00", "endTime": "12:30" } ] }
 1. token → 401;  section id not a UUID → 404
 2. Zod: weekday 1–7 (1 = Monday), times "HH:MM" 24-hour, end after start → 400
 3. sort by day + time; two slots overlapping on the same day → 400 overlapping_slots
 4. transaction: section yours? (else 404) → DELETE the old week → INSERT the new week (unnest)
   ▼
200 { "slots": [...] }          GET returns the same list, Monday first.  { "slots": [] } clears it.
```

## 2. The class calendar

```
GET /api/v1/sections/<sectionId>/sessions
 1. token, section yours → semester dates  (else 401 / 404)
 2. add missing public holidays to off_days (same as GET /off-days)
 3. three SELECTs: timetable slots, off days in the semester, stored classes with present/absent counts
 4. walk the semester day by day; for each timetable slot on that weekday:
      stored class at that date + time?  → use it
      inside an off day?                 → status "off_day", offDayName
      otherwise                          → status "planned", id: null
 5. add stored classes that matched no slot (extra classes, or a slot later removed); sort
   ▼
200 { "today": "2026-11-02",
      "summary": { held, cancelled, offDays, notMarked (planned + in the past), remaining (planned, today or later) },
      "sessions": [ { id, date, startTime, endTime, status, extra, note, present, absent, offDayName } ] }
```

`status` is one of `planned` · `held` · `cancelled` · `off_day`. A planned class has `id: null` because it isn't a row yet.

## 3. Doing something with one class: POST = find or create

```
POST /api/v1/sections/<sectionId>/sessions   { date, startTime, endTime?, status?: "planned" | "cancelled", note? }
 1. token, section yours, date inside the semester (else 400 outside_semester)
 2. is there a timetable slot on that weekday at that start time?
      yes → end time from the timetable, extra = false
      no  → it's an EXTRA class: endTime required (else 400)
 3. INSERT … ON CONFLICT (section_id, date, start_time) DO UPDATE SET status/note (only if sent)
   ▼
200 { "session": { id, date, startTime, endTime, status, extra, note } }
```

Used for:
- **Cancel a class:** `{ "date": "2026-08-03", "startTime": "09:00", "status": "cancelled", "note": "Teacher sick" }`
- **Extra / make-up class:** `{ "date": "2026-08-08", "startTime": "10:00", "endTime": "11:30" }`
- **Get an id before taking attendance:** `{ "date": "2026-08-05", "startTime": "11:00" }` (nothing changes if it already exists)

```
PATCH  /api/v1/sessions/<id>   { "status": "planned" }  un-cancel · { "note": null } clear the note   ("held" only comes from attendance)
DELETE /api/v1/sessions/<id>   → 204. Forgets the row and its attendance. A timetable class goes back to "planned"; an extra class disappears.
```

## 4. Taking attendance: only tap the absent

```
GET /api/v1/sessions/<id>/attendance
   → { "marked": false, "students": [ { id, rollNumber, fullName, present: true } ] }
     Not marked yet → everyone is suggested present (COALESCE(a.present, true)).

PUT /api/v1/sessions/<id>/attendance   { "absent": ["<studentId>", ...], "topicIds": ["<topicId>"] }   ← topicIds: what was taught (planner), optional
 1. token → 401;  Zod: absent = list of UUIDs → 400
 2. transaction:
      class yours? (SELECT … FOR UPDATE: two saves at once wait in line)  → 404
      cancelled → 409 class_cancelled;  date after today (Karachi) → 400 future_class
      every absent id enrolled in this section? → else 400
      DELETE old marks → INSERT one row per enrolled student: present = NOT (id = ANY(absent))
      class status → "held"
   ▼
200 { "present": 2, "absent": 1 }
```

`topicIds` left out → the topics saved before are kept; `[]` → none; a topic of another course → 400. `GET …/attendance` also returns `"topics"` (what was saved for this class). Details: [planner.md](planner.md).

Saving again replaces the marks, so fixing a mistake is the same call.

**The app's flow:** tap a class in the calendar → `POST /sections/<id>/sessions` (gets the id) → `GET …/attendance` (everyone ✓) → tap the absent ones → `PUT …/attendance`.

## 5. Attendance summary and shortage

```
GET /api/v1/sections/<sectionId>/attendance?min=75
   → { "held": 3, "min": 75, "average": 83.3,
       "students": [ { id, rollNumber, fullName, present: 1, marked: 3, percentage: 33.3, shortage: true } ] }
```

- `marked` = held classes this student has a mark in. **percentage = present ÷ marked**, so a student enrolled late isn't counted absent for classes before they joined.
- `average` is the whole section: every present mark ÷ every mark, `null` until a class is marked. The app's dashboard shows it.
- `percentage` is `null` until the first class is marked. `shortage` = below `min`. Leave `?min` out to use the teacher's own line (`teachers.min_attendance`, default 75, set with `PATCH /me` or on the Me screen).
- Marks from a class that was later cancelled are ignored (only `held` classes count).

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

Semester 1 Aug – 30 Nov 2026, SE-454 section A, 3 students, timetable Mon 09:00–10:30 + Wed 11:00–12:30. "Today" was 2 Nov 2026.

| Case | Result |
|---|---|
| timetable with 09:00–10:30 and 10:00–11:00 on Monday | 400 overlapping_slots |
| Mon + Wed saved | GET lists Monday first |
| calendar | 35 classes, first Mon 3 Aug 09:00 |
| 26 Aug (Eid Milad, shifted) / 14 Sep (university closed) / 9 Nov (Iqbal Day, deleted) | `off_day` "Eid Milad-un-Nabi" / `off_day` / `planned` |
| cancel Mon 3 Aug | `cancelled`, end time 10:30 taken from the timetable |
| extra class Sat 8 Aug without / with end time | 400 / `extra: true` |
| class on 7 Dec (after the semester) | 400 outside_semester |
| attendance GET before marking | everyone present, `marked: false` |
| PUT `{ absent: [Sana] }` | 2 present, 1 absent; GET shows Sana ✗, `marked: true` |
| PUT on the cancelled class / on 25 Nov (future) / unknown student id | 409 / 400 future_class / 400 |
| after 3 held classes (Sana absent twice) | Sana 1/3 = 33.3% shortage; Ghani 100% |
| calendar summary | held 3, cancelled 1, off days 2, not marked 21, remaining 9 |
| PATCH un-cancel + `note: null` | `planned`, note cleared |
| DELETE the extra class | gone from the calendar |

## Try it (PowerShell, in `backend/`, dev server running)

Log in and create a course as in [sections.md](sections.md), so `$r.section` is section "A", and import a few students ([student-import.md](student-import.md)).

```powershell
$sec = $r.section.id
# 1. timetable: Monday and Wednesday
Invoke-RestMethod -Method Put -Uri "$api/sections/$sec/timetable" -Headers $auth -ContentType "application/json" -Body '{"slots":[{"weekday":1,"startTime":"09:00","endTime":"10:30"},{"weekday":3,"startTime":"11:00","endTime":"12:30"}]}'

# 2. the calendar
$cal = Invoke-RestMethod -Uri "$api/sections/$sec/sessions" -Headers $auth
$cal.summary
$cal.sessions | Format-Table date, startTime, status, offDayName

# 3. take attendance for the first planned class in the past
$class = $cal.sessions | Where-Object { $_.status -eq "planned" -and $_.date -lt $cal.today } | Select-Object -First 1
$s = (Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/sessions" -Headers $auth -ContentType "application/json" -Body (@{ date = $class.date; startTime = $class.startTime } | ConvertTo-Json)).session
$roster = (Invoke-RestMethod -Uri "$api/sessions/$($s.id)/attendance" -Headers $auth).students
$roster | Format-Table rollNumber, fullName, present
# mark the first student absent
Invoke-RestMethod -Method Put -Uri "$api/sessions/$($s.id)/attendance" -Headers $auth -ContentType "application/json" -Body (@{ absent = @($roster[0].id) } | ConvertTo-Json)

# 4. who is short?
(Invoke-RestMethod -Uri "$api/sections/$sec/attendance" -Headers $auth).students | Format-Table rollNumber, fullName, present, marked, percentage, shortage
```
