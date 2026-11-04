# Flow: questions (generate and add)

[assessments/[id]/questions/route.ts](../../app/api/v1/assessments/[id]/questions/route.ts) ·
[assessments/[id]/questions/generate/route.ts](../../app/api/v1/assessments/[id]/questions/generate/route.ts) ·
[migration](../../supabase/migrations/20261104084727_questions.sql)

A teacher opens an assessment and taps Generate. Gemini writes the questions, and they wait as drafts until the teacher approves them.

## Rules

- **AI questions start as `draft`.** Only the teacher can approve them, and only approved questions go on a paper.
- **A question the teacher writes is `approved` straight away.** The approval step exists to check AI work.
- **Gemini never sees student data:** only the course name, topic titles and the assessment's existing questions.
- **Gemini's marks are never changed by us.** If they miss the target, the reply shows it and the teacher decides.

## Generate: `POST /api/v1/assessments/<id>/questions/generate`

```
Body (all optional): { topicIds, count = 10, types = ["mcq","short"], difficulty = "mixed", note }
 1. token → 401
 2. <id> not a UUID, or not this teacher's → 404
 3. Zod → 400 invalid_input. No body at all = use the defaults
 4. Choose topics: the teacher's list, else the topics taught in held classes, else the whole outline
      no topics in the course → 400 no_topics
      a topicId from another course → 400 invalid_input
 5. Read existing questions: don't repeat them, and work out the marks left
      target = max marks − approved marks. A full paper uses the full marks, so spares can be generated
 6. Ask Gemini, with a schema that forces exact fields. Models tried in order, 45 s each
      every model failed, or the reply doesn't fit the schema → 502 ai_failed
 7. No AI from here: drop broken questions (wrong type, empty, an mcq whose answer isn't an option)
      nothing usable → 502 ai_failed
 8. One INSERT for all rows, as status 'draft', source 'ai'
   ▼
201 { questions: [...], targetMarks, marksTotal, dropped }
```

## List: `GET /api/v1/assessments/<id>/questions`

`200 { assessment: { id, name, maxMarks }, approvedMarks, draftMarks, questions: [...] }`, in order.

## Add your own: `POST /api/v1/assessments/<id>/questions`

Body: `{ type, text, options?, answer, explanation?, difficulty?, marks, topicId? }`.
Multiple choice needs options, and the answer must be one of them. A topic must be from this course. Reply: `201 { question }`.

## One question

`{ id, topicId, type, text, options, answer, explanation, difficulty, marks, status, source, position }`

| Field | Values |
|---|---|
| `type` | `mcq`, `short`, `long` |
| `difficulty` | `easy`, `medium`, `hard` |
| `status` | `draft`, `approved` |
| `source` | `ai`, `manual` |

## Tested (2026-11-04)

The real route code ran with a stand-in login and a stand-in database, because the migration isn't pushed yet. Gemini was real, with made-up topics. **The SQL hasn't run against the real database.**

| Case | Result |
|---|---|
| Bad token | 401 |
| Id isn't a UUID / someone else's assessment | 404 |
| `count: 99` | 400, message on `count` |
| Topic from another course | 400, message on `topicIds` |
| Course with no topics | 400 `no_topics` |
| Multiple choice without options | 400, message on `options` |
| Answer isn't one of the options | 400, message on `answer` |
| Valid question of your own | 201 |
| Real Gemini, 5 questions, 20-mark quiz | 201 in 16.5 s; marks added to 20; none dropped; all from taught topics; all drafts |

## Try it (PowerShell, in `backend/`, dev server running)

Use the login from [semesters.md](semesters.md) for `$auth`. `$id` is an assessment's id.

```powershell
$api = "http://localhost:3000/api/v1"
$body = @{ count = 5 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/assessments/$id/questions/generate" -Headers $auth -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "$api/assessments/$id/questions" -Headers $auth
```
