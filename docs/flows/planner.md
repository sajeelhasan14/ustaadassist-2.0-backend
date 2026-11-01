# Flow: teaching planner

Files: [app/api/v1/sections/[id]/sessions/route.ts](../../app/api/v1/sections/[id]/sessions/route.ts) (the plan is part of its GET) ·
[app/api/v1/sessions/[id]/attendance/route.ts](../../app/api/v1/sessions/[id]/attendance/route.ts) (records what was taught) ·
[app/api/v1/courses/[id]/topics/route.ts](../../app/api/v1/courses/[id]/topics/route.ts), [app/api/v1/topics/[id]/route.ts](../../app/api/v1/topics/[id]/route.ts) (`classesNeeded`) ·
tables `topics` (+ `classes_needed`), `session_topics`

The planner answers two questions for one section: **which topic goes in which upcoming class**, and **are there enough classes left?**

## Nothing triggers it: it is worked out on every request

There is no background job and no saved plan. Whenever the app asks for the calendar (`GET /sections/<id>/sessions`), the server works the plan out from:

```
the class calendar (timetable × semester − off days + stored classes)     ← already calculated in this GET
+ the course outline in order, with classesNeeded per topic               ← topics
+ what each HELD class of this section taught                             ← session_topics
= the plan
```

So cancelling a class, shifting Eid, adding an extra class, reordering topics or changing `classesNeeded` all change the plan on the next request.

**Why it lives inside the calendar GET instead of its own `/plan` route:** the plan needs the exact calendar this GET already builds. A separate route would have to copy those 40 lines of calendar code. One call now gives the app both.

## Attendance and topics: two separate records, one screen

Attendance (who came) and topics (what was taught) have nothing to do with each other in the data. Both are just notes attached to the same class:

```
           class: Wed 12 Aug, 11:00
              /                 \
   attendance (who came)    session_topics (what was taught)
```

They share **one screen and one save** only to save the teacher effort (the user's choice, 2026-11-02): the app pre-fills "Topic: Linked lists" from `plan.nextTopic`, the teacher taps the absent students, and one `PUT` saves both.

## When is a topic "done"?

| Rule | Example |
|---|---|
| Taught in as many held classes as it needs | Linked lists needs 2, taught in 2 classes → done |
| **Or** started, and a later topic has been taught too (the teacher moved on early) | Linked lists taught once (needs 2), then Stacks taught → Linked lists done, not pushed forward forever |
| A topic **never** taught stays in the plan, even if later ones were taught | Queues skipped, Trees taught → Queues is still next |

Only **held** classes count. If a class is later cancelled, its topic is no longer "taught".

## Trace

```
GET /api/v1/sections/<sectionId>/sessions
 … the calendar steps (see timetable-attendance.md) …
 + SELECT the course's topics, each with classesTaught = number of HELD classes of this section that taught it
 + SELECT what each stored class taught (shown on held classes)
 ── the plan (plain JavaScript, no AI) ──
 1. each topic → done / in_progress / not_started (rules above), classesLeft = classesNeeded − classesTaught (0 if done)
 2. queue = every unfinished topic, repeated once per class it still needs, in outline order
        e.g. [Linked lists, Stacks, Queues, Trees, Trees, Trees]
 3. upcoming = classes with status "planned" from today on (off days and cancelled classes are skipped automatically)
 4. hand out: upcoming class 1 gets queue[0], class 2 gets queue[1], …  (each class's "topics", each topic's "plannedDates")
 5. classesShort = queue length − upcoming classes (never below 0)
   ▼
200 { "today", "summary",
      "plan": { "nextTopic": { id, title },            ← what the attendance screen pre-fills
                "topicsDone", "topicsLeft",
                "classesNeeded", "classesAvailable", "classesShort",
                "topics": [ { id, title, position, classesNeeded, classesTaught, status, classesLeft, plannedDates } ] },
      "sessions": [ { …, "topics": [ { id, title } ] } ]   ← held: what was taught; upcoming: what's planned }
```

## Recording what was taught

```
PUT /api/v1/sessions/<id>/attendance   { "absent": [...], "topicIds": ["<topicId>"] }
   inside the same transaction as the attendance:
   topicIds sent → every id must be a topic of this section's course (else 400) → replace session_topics for the class
   topicIds left out → keep what was saved before;  [] → no topics
GET /api/v1/sessions/<id>/attendance   → also returns "topics": what was saved for this class
```

**The app's flow:** open a class → `GET …/attendance` → if `topics` is empty, pre-fill `plan.nextTopic` (from the calendar it already loaded) → teacher taps absentees (and changes the topic if needed) → `PUT` with `absent` + `topicIds`.

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

Semester 1 Aug – 30 Nov 2026, "today" 2 Nov, timetable Mon 09:00 + Wed 11:00. Topics: Arrays (1), Linked lists (2), Stacks (1, default), Queues (1), Trees (3).

| Case | Result |
|---|---|
| POST topics with / without `classesNeeded`; GET topics | 2 / default 1; GET includes it |
| nothing taught | 8 topic-classes onto the 8 upcoming classes (9 Nov Iqbal Day skipped), next = Arrays, short 0 |
| Arrays taught 26 Oct, Linked lists 28 Oct | next = Linked lists (`in_progress` 1/2); the 28 Oct class shows "Linked lists" |
| Stacks taught (Linked lists still had 1 class left) | Linked lists `done`, next = Queues |
| Trees taught, Queues never | Queues stays next (`not_started`), Trees 1/3 |
| attendance re-saved without `topicIds` | topics kept |
| topic from another course | 400 |
| Trees `classesNeeded` → 20 | needs 20 classes, 8 available → `classesShort: 12` |
| rename Trees | `classesNeeded` kept |
| the Arrays class cancelled | Arrays counts as not taught → next = Arrays |
| whole Phase 2 test re-run | 29/29 still pass |

## Try it (PowerShell, in `backend/`, dev server running)

Set up a section with a timetable and students as in [timetable-attendance.md](timetable-attendance.md) (`$sec`, `$r.course`).

```powershell
$course = $r.course.id
foreach ($t in @(@{title="Arrays"}, @{title="Linked lists"; classesNeeded=2}, @{title="Trees"; classesNeeded=3})) {
  Invoke-RestMethod -Method Post -Uri "$api/courses/$course/topics" -Headers $auth -ContentType "application/json" -Body ($t | ConvertTo-Json) | Out-Null
}
$cal = Invoke-RestMethod -Uri "$api/sections/$sec/sessions" -Headers $auth
$cal.plan | Select-Object nextTopic, classesNeeded, classesAvailable, classesShort
$cal.plan.topics | Format-Table title, status, classesTaught, classesNeeded, plannedDates

# teach the next topic in the first planned class before today
$class = $cal.sessions | Where-Object { $_.status -eq "planned" -and $_.date -lt $cal.today } | Select-Object -First 1
$s = (Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/sessions" -Headers $auth -ContentType "application/json" -Body (@{ date = $class.date; startTime = $class.startTime } | ConvertTo-Json)).session
Invoke-RestMethod -Method Put -Uri "$api/sessions/$($s.id)/attendance" -Headers $auth -ContentType "application/json" -Body (@{ absent = @(); topicIds = @($cal.plan.nextTopic.id) } | ConvertTo-Json)

# the plan moved on
(Invoke-RestMethod -Uri "$api/sections/$sec/sessions" -Headers $auth).plan.topics | Format-Table title, status, classesTaught, plannedDates
```
