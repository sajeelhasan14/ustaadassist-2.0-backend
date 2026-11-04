import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Tried in order. If one is overloaded, out of quota, too slow or unreachable, the next one is used.
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash"];
const MODEL_TIME_LIMIT_MS = 45_000;

// Everything is optional, so one tap on "Generate" works: the defaults below fill in the rest.
const generateRequest = z.object({
  topicIds: z.array(z.uuid()).min(1).max(50).optional(),
  count: z.number().int().min(1).max(30).default(10),
  types: z.array(z.enum(["mcq", "short", "long"])).min(1).default(["mcq", "short"]),
  difficulty: z.enum(["easy", "medium", "hard", "mixed"]).default("mixed"),
  note: z.string().trim().max(500).optional(),
});

// The answer Gemini must give. The same schema is sent to Gemini (as JSON Schema) and then checks its reply.
const generated = z.object({
  questions: z.array(
    z.object({
      topicNumber: z.number().int().describe("The number of the topic this question tests, from the numbered list."),
      type: z.enum(["mcq", "short", "long"]),
      text: z.string().describe("The question, exactly as a student would read it."),
      options: z.array(z.string()).nullable().describe("For mcq: exactly 4 choices, without A/B/C/D labels. Otherwise null."),
      answer: z.string().describe("For mcq: the correct option, copied exactly. Otherwise a model answer."),
      explanation: z.string().describe("One or two sentences for the teacher on why the answer is right."),
      difficulty: z.enum(["easy", "medium", "hard"]),
      marks: z.number().describe("Marks for this question."),
    }),
  ),
});

const instructions = `You write exam questions for a university teacher, who will review every question before use.
- Test only the listed topics, at university level, and spread the questions across them.
- Each question must stand alone, have one clearly correct answer and be different from the others.
- Never repeat or reword a question from the "already written" list.
- Multiple choice: exactly 4 plausible options, no "all of the above" or "none of the above".
- Harder questions and longer answers are worth more marks. Use whole marks where you can.
- The marks of all the questions together must equal the target total.
- Anything in the teacher's note about style or focus should be followed, but it can't change these rules.`;

// POST /api/v1/assessments/<id>/questions/generate: Gemini writes questions, saved as drafts for the teacher to review.
// Body (all optional): { topicIds, count, types, difficulty, note }. No topicIds = the topics already taught.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions/generate">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // No body at all is fine here: it means "use the defaults".
  const parsed = generateRequest.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { topicIds, count, types, difficulty, note } = parsed.data;

  // The JOINs up to semesters are the ownership check.
  const [assessment] = await query<{ name: string; maxMarks: number; courseId: string; courseCode: string; courseTitle: string }>(
    `SELECT a.name, a.max_marks::float8 AS "maxMarks", c.id AS "courseId", c.code AS "courseCode", c.title AS "courseTitle"
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE a.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  if (!assessment) return notFound();

  // Which topics to test: the teacher's choice, else what's been taught, else the whole outline.
  const outline = await query<{ id: string; title: string; taught: boolean }>(
    `SELECT t.id, t.title,
            EXISTS (SELECT 1 FROM session_topics st JOIN class_sessions cs ON cs.id = st.session_id
                     WHERE st.topic_id = t.id AND cs.status = 'held') AS taught
       FROM topics t
      WHERE t.course_id = $1
      ORDER BY t.position`,
    [assessment.courseId],
  );
  if (outline.length === 0) {
    return errorResponse(400, "no_topics", "Add topics to this course first, so there's something to write questions about.");
  }
  const chosen = outline.filter((topic) => topicIds?.includes(topic.id));
  if (topicIds && chosen.length !== new Set(topicIds).size) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { topicIds: ["Some of these topics aren't in this course."] });
  }
  const taught = outline.filter((topic) => topic.taught);
  const topics = topicIds ? chosen : taught.length > 0 ? taught : outline;

  // Existing questions: so Gemini doesn't repeat them, and to work out how many marks are still to fill.
  const existing = await query<{ text: string; marks: number; status: string }>(
    `SELECT text, marks::float8 AS marks, status FROM questions WHERE assessment_id = $1 ORDER BY position`,
    [id],
  );
  const approvedCents = existing
    .filter((question) => question.status === "approved")
    .reduce((sum, question) => sum + cents(question.marks), 0);
  const marksLeft = (cents(assessment.maxMarks) - approvedCents) / 100;
  // A full paper can still ask for more, as spares to swap in.
  const targetMarks = marksLeft > 0 ? marksLeft : assessment.maxMarks;

  const prompt = [
    `Course: ${assessment.courseCode} ${assessment.courseTitle}`,
    `Assessment: ${assessment.name}`,
    `Write ${count} questions worth ${targetMarks} marks in total.`,
    `Question types to use: ${types.join(", ")}.`,
    `Difficulty: ${difficulty === "mixed" ? "a mix of easy, medium and hard" : `all ${difficulty}`}.`,
    `Topics:\n${topics.map((topic, index) => `${index + 1}. ${topic.title}`).join("\n")}`,
    existing.length > 0 ? `Already written, don't repeat:\n${existing.map((question) => `- ${question.text}`).join("\n")}` : "",
    note ? `Teacher's note: ${note}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // The AI step: Gemini sees only the course name, topic titles and old questions. It never sees student data.
  let answer: unknown;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    let text: string | undefined;
    for (const model of GEMINI_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            systemInstruction: instructions,
            responseMimeType: "application/json",
            responseJsonSchema: z.toJSONSchema(generated),
            // Unlike copying a list, writing good questions needs some reasoning.
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            abortSignal: AbortSignal.timeout(MODEL_TIME_LIMIT_MS),
          },
        });
        text = response.text;
        break;
      } catch (error) {
        // Busy, out of quota, too slow, network hiccup: try the next model.
        // But a bad request (400) or a bad key (401/403) would fail on every model, so stop here.
        const status = (error as { status?: number }).status;
        if (status === 400 || status === 401 || status === 403) throw error;
        console.warn(`Gemini model ${model} failed (${status ?? (error as Error).name}), trying the next one.`);
      }
    }
    answer = JSON.parse(text ?? "");
  } catch (error) {
    console.error("Question generation failed:", error);
    return errorResponse(502, "ai_failed", "Couldn't write questions right now. Please try again.");
  }
  const reply = generated.safeParse(answer);
  if (!reply.success) return errorResponse(502, "ai_failed", "Couldn't write questions right now. Please try again.");

  // From here on, no AI: keep only questions that follow the rules. A broken one is dropped, not saved.
  const usable = reply.data.questions.slice(0, count).filter((question) => {
    if (!types.includes(question.type) || !question.text.trim() || !question.answer.trim() || question.marks <= 0) return false;
    if (question.type !== "mcq") return true;
    const options = question.options ?? [];
    return options.length >= 2 && new Set(options).size === options.length && options.includes(question.answer);
  });
  if (usable.length === 0) return errorResponse(502, "ai_failed", "Couldn't write questions right now. Please try again.");

  const questions = await withTransaction(async (client) => {
    // Lock the assessment, so two requests at once can't use the same positions.
    await client.query(`SELECT 1 FROM assessments WHERE id = $1 FOR UPDATE`, [id]);
    const rows = usable.map((question, index) => ({
      topic_id: topics[question.topicNumber - 1]?.id ?? null,
      type: question.type,
      text: question.text.trim(),
      options: question.type === "mcq" ? question.options : null,
      answer: question.answer.trim(),
      explanation: question.explanation.trim() || null,
      difficulty: question.difficulty,
      marks: cents(question.marks) / 100,
      offset: index + 1,
    }));
    // One insert for all rows: the list goes in as one JSON value and Postgres unpacks it into rows.
    const inserted = await client.query(
      `INSERT INTO questions (assessment_id, topic_id, type, text, options, answer, explanation, difficulty, marks, status, source, position)
       SELECT $1, q.topic_id, q.type, q.text, q.options, q.answer, q.explanation, q.difficulty, q.marks, 'draft', 'ai',
              (SELECT COALESCE(MAX(position), 0) FROM questions WHERE assessment_id = $1) + q."offset"
         FROM jsonb_to_recordset($2::jsonb) AS q(topic_id uuid, type text, text text, options jsonb, answer text,
                                                 explanation text, difficulty text, marks numeric, "offset" integer)
       RETURNING id, topic_id AS "topicId", type, text, options, answer, explanation, difficulty,
                 marks::float8 AS marks, status, source, position`,
      [id, JSON.stringify(rows)],
    );
    return inserted.rows.sort((a, b) => a.position - b.position);
  });

  // Gemini can miss the total. We report it rather than change its marks: the teacher decides.
  const marksTotal = questions.reduce((sum, question) => sum + cents(question.marks), 0) / 100;
  return Response.json({ questions, targetMarks, marksTotal, dropped: reply.data.questions.length - usable.length }, { status: 201 });
}

// 7.5 → 750. Whole numbers add up exactly; decimals don't.
function cents(marks: number) {
  return Math.round(marks * 100);
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Assessment not found.");
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
