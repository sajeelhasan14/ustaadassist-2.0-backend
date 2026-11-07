# Flow: the assistant (agent)

[app/api/v1/assistant/route.ts](../../app/api/v1/assistant/route.ts) ·
[lib/agent/](../../lib/agent/)

A teacher asks something in plain words. Gemini chooses tools, our code runs them, and Gemini answers from the results.

## The files

| File | Job |
|---|---|
| `app/api/v1/assistant/route.ts` | The door: checks the login and the input, calls `runAgent`, replies |
| `lib/agent/run-agent.ts` | The loop: ask Gemini → run its tools → give back the results → repeat |
| `lib/agent/gemini.ts` | One round with Gemini: model order, time limit, fallback |
| `lib/agent/instructions.ts` | The rules the agent follows, in plain English |
| `lib/agent/api-client.ts` | Reads our own API with the teacher's token |
| `lib/agent/types.ts` | What a tool looks like; `defineTool` checks Gemini's arguments |
| `lib/agent/tools/` | One file per tool; `index.ts` is the list |

Normal routes keep their logic inside the route file. The agent is the one exception, chosen by the user: it has several parts that change for different reasons, and its tools will keep growing.

## The trace

```
POST /api/v1/assistant   { message: "What classes do I have today?", history: [] }
   │
route.ts       token valid? (else 401)  body valid? (else 400)
   │
runAgent()     contents = history + message
   │
   ├─ round 1: askGemini(contents, instructions, tool list)
   │     Gemini: "call get_classes_on_date"
   │     runTool → tool.run → api("/today") → GET /api/v1/today with the teacher's token
   │     the result is added to contents
   │
   └─ round 2: askGemini(...)
         Gemini: no tool, just text → that's the answer
   │
reply          { reply: "...", toolsUsed: ["get_classes_on_date"], proposals: [], stats: [] }
```

## Rules built in

- **At most 6 rounds and 90 seconds**, so a confused agent stops by itself.
- **A tool error goes back to Gemini**, so it can tell the teacher instead of crashing. This also covers tools that don't exist: Gemini does sometimes invent one.
- **Gemini's arguments are checked** by the tool's Zod `input` before the tool runs.
- **The token never reaches Gemini.** Only tool results do, so they contain the teacher's student data.
- **The agent only reads.** It can prepare a change, but only the app can send one, after the teacher taps Confirm.

## Adding a tool

1. Create `lib/agent/tools/<name>.ts` with `defineTool({ name, description, input, run })`.
2. Add it to the list in `lib/agent/tools/index.ts`.

The description matters most: it's the only thing Gemini reads to decide when to use the tool.

## Errors

| Case | Response |
|---|---|
| No or bad token | `401 unauthorized` |
| Empty or too long message, or a `courseId`/`sectionId` that isn't a real id | `400 invalid_input` |
| Every Gemini model failed | `502 ai_failed` |

## Limits

- **Free tier:** Google allows 20 requests a day per model on the free key, and each question uses 2 or more. That's under 10 questions a day: fine for a quick test, not for real use.
- **Speed:** one round took from about 2 to 15 seconds in testing.

## Test results (2026-11-04)

Run with the real agent and real Gemini, against a stand-in API returning made-up data.

| Case | Result |
|---|---|
| Bad token over HTTP | 401 |
| Today's classes, course list, a follow-up using history | Right tools, correct answers |
| General question | Answered with no tool |
| Attendance question (no tool yet) | Said it can't see that; didn't invent numbers |
| Invented tool name | Handled; it recovered and answered |
| Cancel a class | Refused, but named screens that don't exist. The rule was fixed |

**Not tested yet**, because the daily quota ran out: the fixed rule above, plain text with no bold, a failing tool, private data ("what's Bilal's phone number?"), an unrelated request, and a full run over HTTP with a real login.

## The tools (all read-only)

| Tool | Reads | Answers things like |
|---|---|---|
| `get_classes_on_date` | `/today` | What classes do I have tomorrow? |
| `list_courses` | `/semesters`, their courses, their sections | Which courses do I teach? Also finds the ids for every other tool |
| `get_assessments` | `/courses/<id>/assessments` | How many marks are still unallocated? |
| `get_materials` | `/courses/<id>/materials` | What have I uploaded? (file names only, it can't read inside) |
| `get_off_days` | `/off-days` | When is the next holiday? |
| `get_paper` | `/assessments/<id>/questions` | Is the Mid paper approved yet? |
| `get_students` | `/sections/<id>/students` | How many students are in Section A? |
| `get_attendance` | `/sections/<id>/attendance` | Who is short on attendance? |
| `get_plan` | `/sections/<id>/sessions` | Am I behind? What did I teach last class? |
| `get_marks` | `/sections/<id>/marks` | What did Omar get in the Mid? |
| `get_results` | `/sections/<id>/results` | How many students failed? |

Most questions take two tool rounds: `list_courses` to find the id, then the tool that holds the answer.

Three tools change the route's reply before Gemini sees it:

- **`get_marks`** labels every mark with its assessment's name. The route sends a bare list lined up by position, and Gemini could match a number to the wrong assessment.
- **`get_plan`** trims each class to what a question needs, because a semester can have about 50 classes.
- **`get_results`** leaves out the printed sheet header, which no question needs.

## Changes: propose, then Confirm

Gemini never changes anything. The `propose_` tools in `lib/agent/tools/proposals.ts` check the request against real data and describe the change. The app shows that with a Confirm button.

| Tool | The change it prepares | It refuses when |
|---|---|---|
| `propose_cancel_class` | `POST /sections/<id>/sessions` with status cancelled | No class that day, the class isn't planned, or two classes that day and no time given |
| `propose_extra_class` | `POST /sections/<id>/sessions` | The end time isn't after the start time |
| `propose_add_assessment` | `POST /courses/<id>/assessments` | Not enough marks left, or the name is taken |
| `propose_assessment_date` | `PATCH /assessments/<id>` | The assessment isn't in that course |
| `propose_off_day` | `POST /off-days` | The end date is before the start date |
| `propose_attendance_line` | `PATCH /me` | The number is outside 0 to 100 |

```
"Cancel my class on 10 November"
   │
Gemini        calls propose_cancel_class { sectionId, date }
   │
proposals.ts  reads the calendar: is there one planned class that day? (else an error goes back to Gemini)
              builds { title, detail, method, path, body } from the checked values
   │
run-agent.ts  collects the proposal beside the reply
   │
the app       shows "Cancel class · SE-454 · Section A · Tue 10 Nov · 09:00" with Not now and Confirm
   │  tap Confirm
the app       sends POST /sections/<id>/sessions with the teacher's own token
   │
the route     runs all its normal checks, and the class is cancelled
```

- **Gemini can't show one thing and send another.** The title, detail and request are all built by our code from the same checked values. Gemini's words are only the sentence above the card.
- **The route checks again.** Confirm uses the normal routes, so a class held in the meantime still gets its normal answer.
- **Deleting isn't offered.** Students, marks and courses can't be removed from the chat. The assistant says so and points to the app.

## Numbers under a reply

`get_plan` also returns `stats`: topics done, classes behind and topics left. `run-agent.ts` passes them to the app as tiles. They appear on any question that used `get_plan`, even one that was only about a past class.

## Page awareness

The app can send `courseId` and `sectionId` beside the message, so "who is short?" means the course the teacher has open.

```
POST /api/v1/assistant   { message: "Who is short?", courseId: "...", sectionId: "..." }
   │
route.ts            both must be real ids (else 400)
   │
runAgent()          passes { courseId, sectionId } to buildInstructions()
   │
instructions.ts     pageRules() adds an "Open page" part to Gemini's rules
   │
Gemini              calls get_attendance straight away, with no list_courses round
```

- **Home sends neither id,** so `pageRules()` adds nothing and the assistant works from `list_courses`.
- **Naming another course still works.** The rules tell Gemini to answer about the course the teacher named.
- **Ids go in the instructions, not the teacher's message,** so they never appear in the chat history.
- **Another teacher's id gets nothing.** The tools use the teacher's own token, so the route replies "not found".

## Test results (2026-11-07)

Real tools, with a stand-in API returning made-up data.

| Case | Result |
|---|---|
| Tool checks: sections included, marks labelled, null stays null, classes trimmed, header dropped, bad id refused, names unique | 7 of 7 pass |
| "Who is short on attendance in SE-454?" (real Gemini) | Right tools, correct answer, 5 s |
| "Am I behind in Software Testing?" (real Gemini) | Right tools, correct answer, 5 s |
| "What did Omar get in the Mid?" from a course page (real Gemini) | `get_marks` only, 4 s. Correctly said not entered, not zero |
| Same question from Home (real Gemini) | `list_courses` then `get_marks`, 4 s. Same answer |
| Page rules: Home adds none, a course page adds both ids | Pass |
| "Who is short on attendance?" from a course page (real Gemini) | **Not tested:** all three models were busy or timed out on that attempt |

Later the same day, with the propose_ tools:

| Case | Result |
|---|---|
| 14 tool checks: each refusal above, the exact request built, no date sent when none given | All pass |
| "Cancel my class on 10 November" (real Gemini) | `propose_cancel_class`, said ready to confirm, not done |
| "Add a presentation worth 10 marks" (real Gemini) | `propose_add_assessment`, no invented date |
| "How far am I in this course?" (real Gemini) | `get_plan`, correct, three tiles |
| "Delete all my students" (real Gemini) | Refused, no tool used |

**Not tested yet:** a bad id over HTTP (the 400), naming a different course from a course page, confirming a change against the real API. The stand-in data was written by hand from reading the routes, so the tools still need a run against the real API with a real login.

## Try it (PowerShell, in `backend/`, dev server running)

Use the login from [semesters.md](semesters.md) for `$auth`, then:

```powershell
$api = "http://localhost:3000/api/v1"
$body = @{ message = "What classes do I have today?" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/assistant" -Headers $auth -ContentType "application/json" -Body $body
```
