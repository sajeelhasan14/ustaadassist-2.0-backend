# Flow: question papers (generate, edit, write your own)

[questions/route.ts](../../app/api/v1/assessments/[id]/questions/route.ts) ·
[questions/generate/route.ts](../../app/api/v1/assessments/[id]/questions/generate/route.ts) ·
[questions/[id]/route.ts](../../app/api/v1/questions/[id]/route.ts) ·
[sections/route.ts](../../app/api/v1/assessments/[id]/sections/route.ts) ·
[paper-sections/[id]/route.ts](../../app/api/v1/paper-sections/[id]/route.ts) ·
[migration](../../supabase/migrations/20261104220448_question_papers.sql)

A teacher opens an assessment, says what paper they want, and picks the topics. Gemini writes a draft. The teacher edits it, approves it, or clears it and writes their own.

## Rules

- **Questions only.** No answers or explanations are written or stored.
- **The teacher decides the paper.** MCQs only, short, long, scenario based, mixed, sections, "attempt any", parts on any question. No layout is fixed in the code.
- **AI questions start as `draft`.** Only approved questions go on a paper.
- **A question the teacher writes is `approved` straight away.** The approval step exists to check AI work.
- **Gemini never sees student data:** only the course name, topic titles and the assessment's existing questions.
- **Gemini's marks are never changed by us**, with one exception: a question with parts always totals the sum of its parts. If Gemini misses a target, the reply shows it and the teacher decides.

## The shape of a paper

```
assessment "Final" (50 marks)
 └─ section "Section B", attemptAny 4
     └─ question 12 (long, 12 marks)
         └─ parts (a) 4 marks, (b) 4 marks, (c) 4 marks
```

A plain 10-question quiz is one untitled section, so the same shape holds everything.

## Generate: `POST /api/v1/assessments/<id>/questions/generate`

```
Body (all optional):
{
  "instructions": "MCQs only.",
  "topics": [ { "id": "<normalization>", "marks": 15 }, { "id": "<cardinality>", "marks": 5 } ]
}

 1. token → 401
 2. <id> not a UUID, or not this teacher's → 404
 3. Zod → 400 invalid_input. No body at all = use the defaults
 4. Choose topics: the teacher's list, else the topics taught in held classes, else the whole outline
      no topics in the course → 400 no_topics
      a topic from another course → 400 invalid_input
 5. Read existing questions: don't repeat them, and work out the marks left
      target = max marks − approved marks. A full paper uses the full marks, so spares can be generated
 6. Topic marks add up to more than the target → 400 invalid_input, before Gemini is called
 7. Ask Gemini, with a schema that forces exact fields. Models tried in order, 60 s each
      every model failed, or the reply doesn't fit the schema → 502 ai_failed
 8. No AI from here: drop broken questions (empty, no marks, an mcq without options)
      nothing usable → 502 ai_failed
 9. In one transaction, for each section: insert it, then all its questions as 'draft', 'ai'
   ▼
201 { sections: [...], targetMarks, marksTotal, topicPlan: [{ topicId, title, askedMarks, writtenMarks }], dropped }
```

Why topic marks are separate numbers: when weightage was only words ("mostly Testing, few Agile"), Gemini skipped the other topics completely. As numbers, it followed them.

`writtenMarks` counts every question on the paper. With "attempt any" the paper shows more marks than count, so these numbers run higher than `askedMarks`.

Why the paper's total comes from the assessment: the teacher already set "Quiz 1 = 20 marks", and marks entry uses that same number.

## Read: `GET /api/v1/assessments/<id>/questions`

`200 { assessment: { id, name, maxMarks }, approvedMarks, draftMarks, sections: [{ id, title, instructions, attemptAny, position, questions: [...] }] }`, in order.

`approvedMarks` and `draftMarks` are [countable marks](../concepts.md): in an "attempt any N" section only the N highest count.

## One question

`{ id, sectionId, topicId, type, text, options, parts, difficulty, marks, status, source, position }`

| Field | Values |
|---|---|
| `type` | free text: `mcq`, `short`, `long`, `scenario`, `true/false`… Only `mcq` is special: it must have options |
| `options` | list of choices for `mcq`, otherwise `null` |
| `parts` | `[{ label, text, marks }]`, or `null` |
| `difficulty` | `easy`, `medium`, `hard` |
| `status` | `draft`, `approved` |
| `source` | `ai`, `manual` |

## Change the paper

| Teacher does | Request | Notes |
|---|---|---|
| Edit a question | `PATCH /questions/<id>` with only the changed fields | Changes are merged onto the saved question, then checked |
| Approve one | `PATCH /questions/<id>` `{ "status": "approved" }` | `"draft"` takes it back |
| Move one to a section | `PATCH /questions/<id>` `{ "sectionId": "..." }` | The section must be on the same paper |
| Delete one | `DELETE /questions/<id>` | |
| Approve all | `PATCH /assessments/<id>/questions` `{ "status": "approved" }` | |
| Throw away the AI draft | `DELETE /assessments/<id>/questions?status=draft` | Keeps what's approved; empty sections go too |
| Clear everything | `DELETE /assessments/<id>/questions` | The app should ask first |
| Add own question | `POST /assessments/<id>/questions` | Give `marks`, or `parts` with marks. No `sectionId` = the last section; a new paper gets an untitled one |
| Add a section | `POST /assessments/<id>/sections` | |
| Edit a section | `PATCH /paper-sections/<id>` | `attemptAny: null` = all compulsory |
| Delete a section | `DELETE /paper-sections/<id>` | Its questions are deleted too |

## Trace: "10 marks of Normalization, MCQs only"

```
Flutter "Generate" button
  ▼ POST /assessments/<id>/questions/generate
generate/route.ts
  ├─ getTeacherId          token → teacher id
  ├─ SELECT assessment     ownership, plus maxMarks
  ├─ SELECT topics         outline; checks the picked topics are in this course
  ├─ SELECT questions      what exists, so countableMarks() gives the marks left
  ├─ askAI() (lib/ai.ts)   the AI fills in the form (answerShape, reasoning medium, 60 s per model)
  ├─ filter                drops broken questions
  └─ withTransaction       INSERT paper_sections, INSERT questions (status 'draft')
  ▼ 201 { sections, topicPlan, ... }
Flutter shows the draft → teacher edits → PATCH /questions/<id>
                       → teacher approves → PATCH /assessments/<id>/questions
```

## Tested (2026-11-05)

The real route code and real migrations ran on real Postgres, in a temporary schema that was then deleted, with a stand-in login. Not yet run over HTTP with a real login, because the database has no teacher account.

**49 route checks passed:** login and ownership on every route (someone else's id → 404), bad input, free question types, parts adding up, sections, moving questions, the `mcq` rule in both directions, clearing `parts`, `topicId` and `attemptAny`, attempt-any marks, approve all, clear drafts, clear all, cascade delete.

**Real Gemini, 5 tries:**

| Request | Result | Time |
|---|---|---|
| Quiz, 20 marks, MCQs only, Normalization 15 + Cardinality 5 | 20 MCQs, exactly 15 and 5, no answers | 18.6 s |
| Final, 50 marks: 3 sections, attempt any, parts, one scenario, 4 topics | 18 questions, structure right, 50 marks, all topics used | 130.6 s |
| No body at all | 7 questions, 10 marks | 19.6 s |
| Same quiz, twice | **502**: every model busy or too slow | 8 s and 128 s |

On the Final, topics asked 25/10/10/5 and the paper offered 37/6/18/5 of its 66 marks, so with "attempt any" topic marks are only a rough guide. Cardinality came out low.

## Try it (PowerShell, in `backend/`, dev server running)

Use the login from [semesters.md](semesters.md) for `$auth`. `$id` is an assessment's id, `$topic` a topic id.

```powershell
$api = "http://localhost:3000/api/v1"
$body = @{ instructions = "Section A: 5 MCQs. Section B: 2 scenario questions with parts (a) and (b)."; topics = @(@{ id = $topic; marks = 10 }) } | ConvertTo-Json -Depth 4
$paper = Invoke-RestMethod -Method Post -Uri "$api/assessments/$id/questions/generate" -Headers $auth -ContentType "application/json" -Body $body
$paper.sections | ForEach-Object { $_.title; $_.questions.text }

# Throw it away and start again
Invoke-RestMethod -Method Delete -Uri "$api/assessments/$id/questions?status=draft" -Headers $auth
```
