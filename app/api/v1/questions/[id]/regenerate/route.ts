import { z } from "zod";
import { answerShape, askAI, readJsonReply } from "@/lib/ai";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Per model. Writing takes longer than reading, so this is more than lib/ai.ts's default.
const MODEL_TIME_LIMIT_MS = 60_000;

// Optional: what the teacher didn't like, in their own words ("make it harder", "use a banking example").
const regenerateRequest = z.object({ instructions: z.string().trim().max(1000).optional() });

// The answer the AI must give. The same schema is sent to the AI (as JSON Schema) and then checks its reply.
const generated = z.object({
  text: z.string().describe("The new question, exactly as a student would read it."),
  options: z.array(z.string()).nullable().describe("For mcq: exactly 4 choices, without A/B/C/D labels. Otherwise null."),
  difficulty: z.enum(["easy", "medium", "hard"]),
  parts: z.array(z.object({ text: z.string() })).describe("One entry per part in the old question, in the same order. Empty if it had none."),
});

const instructions = `You replace one exam question for a university teacher, who will review it before use.
- Write only the question. Never include answers, hints or explanations.
- Keep the same kind of question and the same topic, but ask something genuinely different.
- Never repeat or reword anything in the "already on this paper" list.
- Multiple choice: exactly 4 plausible options, no "all of the above" or "none of the above".
- If the old question has parts, write the same number of parts.`;

// POST /api/v1/questions/<id>/regenerate: The AI replaces this one question. Body (optional): { instructions }
// Its place, type, topic and marks stay. The new version is a draft, because the teacher hasn't checked it.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/questions/[id]/regenerate">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // No body at all is fine here.
  const parsed = regenerateRequest.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  // The JOINs up to semesters are the ownership check.
  const [question] = await query<{
    assessmentId: string;
    type: string;
    text: string;
    marks: number;
    parts: { label: string; text: string; marks: number }[] | null;
    topic: string | null;
    courseTitle: string;
  }>(
    `SELECT q.assessment_id AS "assessmentId", q.type, q.text, q.marks::float8 AS marks, q.parts,
            t.title AS topic, c.title AS "courseTitle"
       FROM questions q
       JOIN assessments a ON a.id = q.assessment_id
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
       LEFT JOIN topics t ON t.id = q.topic_id
      WHERE q.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  if (!question) return notFound();

  const others = await query<{ text: string }>(`SELECT text FROM questions WHERE assessment_id = $1 AND id <> $2`, [question.assessmentId, id]);
  const oldParts = question.parts ?? [];
  const prompt = [
    `Course: ${question.courseTitle}`,
    question.topic ? `Topic: ${question.topic}` : "",
    `Kind of question: ${question.type}, worth ${question.marks} marks`,
    `Old question: ${question.text}`,
    oldParts.length > 0 ? `Old parts:\n${oldParts.map((part) => `${part.label} ${part.text}`).join("\n")}` : "",
    others.length > 0 ? `Already on this paper, don't repeat:\n${others.map((other) => `- ${other.text}`).join("\n")}` : "",
    parsed.data.instructions ? `Teacher's request: ${parsed.data.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // The AI step: it sees only the course, the topic and the paper. It never sees student data.
  // lib/ai.ts picks the company and model from .env.local, and tries the next model if one is busy.
  let answer: unknown;
  try {
    const completion = await askAI(
      {
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: prompt },
        ],
        response_format: answerShape("question", generated),
        // Unlike copying a list, writing a good question needs some reasoning.
        reasoning_effort: "medium",
      },
      MODEL_TIME_LIMIT_MS,
    );
    answer = readJsonReply(completion);
  } catch (error) {
    console.error("Question regeneration failed:", error);
    return errorResponse(502, "ai_failed", "Couldn't write a new question right now. Please try again.");
  }
  const reply = generated.safeParse(answer);
  if (!reply.success) return errorResponse(502, "ai_failed", "Couldn't write a new question right now. Please try again.");

  // From here on, no AI. A reply that breaks the rules is refused, so the old question stays as it was.
  const { text, options, difficulty, parts } = reply.data;
  const usableOptions = question.type !== "mcq" || ((options?.length ?? 0) >= 2 && new Set(options).size === options?.length);
  const usableParts = parts.length === oldParts.length && parts.every((part) => part.text.trim());
  if (!text.trim() || !usableOptions || !usableParts) {
    return errorResponse(502, "ai_failed", "Couldn't write a new question right now. Please try again.");
  }
  // Labels and marks stay: the teacher set the marks, and only the wording is being replaced.
  const newParts = oldParts.map((part, index) => ({ ...part, text: parts[index].text.trim() }));

  const [updated] = await query(
    `UPDATE questions
        SET text = $1, options = $2::jsonb, parts = $3::jsonb, difficulty = $4, status = 'draft', source = 'ai'
      WHERE id = $5
      RETURNING id, section_id AS "sectionId", topic_id AS "topicId", type, text, options, parts, difficulty,
                marks::float8 AS marks, status, source, position`,
    [text.trim(), question.type === "mcq" ? JSON.stringify(options) : null, newParts.length > 0 ? JSON.stringify(newParts) : null, difficulty, id],
  );
  // Deleted while the AI was writing.
  if (!updated) return notFound();
  return Response.json({ question: updated });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Question not found.");
}

// The teacher id inside a valid "Authorization: Bearer <token>" header, or null.
async function getTeacherId(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return null;
  // Passing the token means cookies are ignored; only this token is checked.
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims(token);
  return data?.claims.sub ?? null;
}

// Every API error has the same shape, so the app can handle them all the same way.
function errorResponse(status: number, code: string, message: string, fields?: object) {
  return Response.json({ error: { code, message, fields } }, { status });
}
