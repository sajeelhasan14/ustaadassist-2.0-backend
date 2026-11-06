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
reply          { reply: "...", toolsUsed: ["get_classes_on_date"] }
```

## Rules built in

- **At most 6 rounds and 90 seconds**, so a confused agent stops by itself.
- **A tool error goes back to Gemini**, so it can tell the teacher instead of crashing. This also covers tools that don't exist: Gemini does sometimes invent one.
- **Gemini's arguments are checked** by the tool's Zod `input` before the tool runs.
- **The token never reaches Gemini.** Only tool results do, so they contain the teacher's student data.
- **The agent only reads.** No tool changes anything yet.

## Adding a tool

1. Create `lib/agent/tools/<name>.ts` with `defineTool({ name, description, input, run })`.
2. Add it to the list in `lib/agent/tools/index.ts`.

The description matters most: it's the only thing Gemini reads to decide when to use the tool.

## Errors

| Case | Response |
|---|---|
| No or bad token | `401 unauthorized` |
| Empty or too long message | `400 invalid_input` |
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

## Test results (2026-11-07)

Real tools, with a stand-in API returning made-up data.

| Case | Result |
|---|---|
| Tool checks: sections included, marks labelled, null stays null, classes trimmed, header dropped, bad id refused, names unique | 7 of 7 pass |
| "Who is short on attendance in SE-454?" (real Gemini) | Right tools, correct answer, 5 s |
| "Am I behind in Software Testing?" (real Gemini) | Right tools, correct answer, 5 s |
| "What did Omar get in the Mid?" (real Gemini) | **Not tested:** the first model was out of quota (429), the other two busy (503) |

The stand-in data was written by hand from reading the routes, so the tools still need a run against the real API with a real login.

## Try it (PowerShell, in `backend/`, dev server running)

Use the login from [semesters.md](semesters.md) for `$auth`, then:

```powershell
$api = "http://localhost:3000/api/v1"
$body = @{ message = "What classes do I have today?" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/assistant" -Headers $auth -ContentType "application/json" -Body $body
```
