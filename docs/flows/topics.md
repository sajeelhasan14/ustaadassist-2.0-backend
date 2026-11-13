# Flow: topics (the course outline)

> **Added 2026-11-11: `POST /topics/extract`** reads a course's topics from a photo, scan, PDF or text file of its outline (multipart `files`, up to 10, 20 MB). The AI only reads; numbering, bullets and repeats are cleaned without AI; nothing is saved. The app puts the topics in the topics box, and the teacher saves them with `POST /courses/<id>/topics` as before. 422 `no_topics` when nothing was found.

Files: [app/api/v1/courses/[id]/topics/route.ts](../../app/api/v1/courses/[id]/topics/route.ts) (GET, POST, PUT) ·
[app/api/v1/topics/[id]/route.ts](../../app/api/v1/topics/[id]/route.ts) (PATCH, DELETE) · table `topics` · [lib/db.ts](../../lib/db.ts) `withTransaction`

Ownership goes two levels up: **topic → course → semester → teacher** (two JOINs in every query).

**Planner (Phase 3):** every topic also has `classesNeeded` (default 1): how many classes it takes. Send it when adding (`{ "title": "Trees", "classesNeeded": 3 }`) or change it with `PATCH /topics/<id> { "classesNeeded": 3 }`. Every topic response includes it. See [planner.md](planner.md).

## Add: `POST /api/v1/courses/<id>/topics`  `{ "title": "Linked Lists" }`

token → UUID → Zod → `INSERT ... SELECT ... position = MAX(position) + 1 ... WHERE the course's semester is yours` → `201 { topic }` (or 404).

## Reorder: `PUT /api/v1/courses/<id>/topics`  `{ "topicIds": [idC, idA, idB] }`

```
 1. token → 401 · UUID → 404 · Zod (array of UUIDs) → 400
 2. withTransaction(client => {               BEGIN
      SELECT course ... owned by teacher?     no → "course_not_found"
      SELECT topic ids ... FOR UPDATE         lock this course's topics
      sent list == real list?                 same size, no repeats, all belong → else "wrong_topics"
      UPDATE topics ... FROM unnest($1) WITH ORDINALITY   one statement sets every position
    })                                         COMMIT (or ROLLBACK on any error)
 3. "course_not_found" → 404 · "wrong_topics" → 400 · ok → 200 { topics } in the new order
```

## Tested (rolled-back transaction)

| Action | Outline afterwards |
|---|---|
| A adds Arrays, Linked Lists, Stacks | 1.Arrays 2.Linked Lists 3.Stacks |
| B adds / renames / deletes in A's course | 404 each, nothing changed |
| Reorder Stacks to the top | 1.Stacks 2.Arrays 3.Linked Lists |
| Rename Arrays, delete Linked Lists | 1.Stacks 2.Arrays & Strings |
| Add Queues | 1.Stacks 2.Arrays & Strings 3.Queues |

## Try it (PowerShell, in `backend/`, dev server running, logged in as in [courses.md](courses.md))

```powershell
# assumes $auth, $api and a course $c from docs/flows/courses.md
foreach ($t in "Arrays","Linked Lists","Stacks") {
  Invoke-RestMethod -Method Post -Uri "$api/courses/$($c.id)/topics" -Headers $auth -ContentType "application/json" -Body (@{ title = $t } | ConvertTo-Json) | Out-Null
}
$topics = (Invoke-RestMethod -Uri "$api/courses/$($c.id)/topics" -Headers $auth).topics
$topics
# move the last topic to the top
$order = @($topics[2].id, $topics[0].id, $topics[1].id)
(Invoke-RestMethod -Method Put -Uri "$api/courses/$($c.id)/topics" -Headers $auth -ContentType "application/json" -Body (@{ topicIds = $order } | ConvertTo-Json)).topics
# see the safety check: send only two of the three
try { Invoke-RestMethod -Method Put -Uri "$api/courses/$($c.id)/topics" -Headers $auth -ContentType "application/json" -Body (@{ topicIds = @($order[0], $order[1]) } | ConvertTo-Json) } catch { $_.ErrorDetails.Message }
```
