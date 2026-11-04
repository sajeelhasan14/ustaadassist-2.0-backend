import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "add my own question" body looks like.
const newQuestion = z
  .object({
    type: z.enum(["mcq", "short", "long"]),
    text: z.string().trim().min(1, "Question text is required.").max(4000),
    options: z.array(z.string().trim().min(1).max(500)).min(2, "Add at least 2 options.").max(6).optional(),
    answer: z.string().trim().min(1, "Answer is required.").max(4000),
    explanation: z.string().trim().max(4000).optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
    marks: z.number().positive("Must be more than 0.").max(1000),
    topicId: z.uuid().optional(),
  })
  // Zod checks each field alone; these two rules compare fields with each other.
  .refine((question) => question.type !== "mcq" || question.options !== undefined, {
    path: ["options"],
    message: "A multiple-choice question needs options.",
  })
  .refine((question) => question.type !== "mcq" || !question.options || question.options.includes(question.answer), {
    path: ["answer"],
    message: "The answer must be one of the options.",
  });

// numeric columns arrive in JavaScript as text ("7.50"), so marks are cast to float8 to get a real number.
const questionColumns = `id, topic_id AS "topicId", type, text, options, answer, explanation, difficulty,
  marks::float8 AS marks, status, source, position`;

// GET /api/v1/assessments/<id>/questions: the assessment's questions in order, with how its marks are used so far.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // The JOINs up to semesters are the ownership check.
  const [assessment] = await query(
    `SELECT a.id, a.name, a.max_marks::float8 AS "maxMarks"
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE a.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  if (!assessment) return notFound();

  const questions = await query<{ marks: number; status: string }>(
    `SELECT ${questionColumns} FROM questions WHERE assessment_id = $1 ORDER BY position`,
    [id],
  );
  const marksOf = (status: string) =>
    cents(questions.filter((question) => question.status === status).reduce((sum, question) => sum + question.marks, 0)) / 100;
  return Response.json({ assessment, approvedMarks: marksOf("approved"), draftMarks: marksOf("draft"), questions });
}

// POST /api/v1/assessments/<id>/questions: add a question the teacher wrote.
// It's approved straight away: the approval step exists to check AI work, and the teacher wrote this one.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = newQuestion.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { type, text, options, answer, explanation, difficulty, marks, topicId } = parsed.data;

  const result = await withTransaction(async (client) => {
    // Lock the assessment, so two adds at once can't get the same position.
    const owned = await client.query<{ courseId: string }>(
      `SELECT a.course_id AS "courseId"
         FROM assessments a
         JOIN courses c ON c.id = a.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE a.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF a`,
      [id, teacherId],
    );
    if (!owned.rows[0]) return { outcome: "not_found" } as const;

    // The topic must come from this assessment's own course.
    if (topicId) {
      const topic = await client.query(`SELECT 1 FROM topics WHERE id = $1 AND course_id = $2`, [topicId, owned.rows[0].courseId]);
      if (topic.rowCount === 0) return { outcome: "bad_topic" } as const;
    }

    const inserted = await client.query(
      `INSERT INTO questions (assessment_id, topic_id, type, text, options, answer, explanation, difficulty, marks, status, source, position)
       SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'approved', 'manual', COALESCE(MAX(position), 0) + 1
         FROM questions WHERE assessment_id = $1
       RETURNING ${questionColumns}`,
      [id, topicId ?? null, type, text, type === "mcq" ? JSON.stringify(options) : null, answer, explanation ?? null, difficulty, marks],
    );
    return { outcome: "ok", question: inserted.rows[0] } as const;
  });

  if (result.outcome === "not_found") return notFound();
  if (result.outcome === "bad_topic") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { topicId: ["This topic isn't in this course."] });
  }
  return Response.json({ question: result.question }, { status: 201 });
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
