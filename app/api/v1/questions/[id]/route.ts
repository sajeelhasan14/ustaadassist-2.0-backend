import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Every field is optional; send only what changes. null clears parts or topicId.
// status "approved" is how a draft gets onto the paper; "draft" takes it back off.
const questionChanges = z
  .object({
    sectionId: z.uuid(),
    type: z.string().trim().toLowerCase().min(1, "Question type is required.").max(30),
    text: z.string().trim().min(1, "Question text is required.").max(4000),
    options: z.array(z.string().trim().min(1).max(500)).min(2, "Add at least 2 options.").max(6),
    parts: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(20),
          text: z.string().trim().min(1).max(4000),
          marks: z.number().positive("Must be more than 0.").max(1000),
        }),
      )
      .min(1)
      .max(10)
      .nullable(),
    difficulty: z.enum(["easy", "medium", "hard"]),
    marks: z.number().positive("Must be more than 0.").max(1000),
    topicId: z.uuid().nullable(),
    status: z.enum(["draft", "approved"]),
  })
  .partial();

// PATCH /api/v1/questions/<id>: edit a question, move it to another section, and/or approve it.
// A change may send only some fields, and the rules depend on the whole question (an mcq needs options).
// So we merge the changes onto the saved question and check the result, not just the body.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/questions/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = questionChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  const result = await withTransaction(async (client) => {
    // The JOINs up to semesters are the ownership check. The lock stops two edits overwriting each other.
    const current = await client.query<SavedQuestion>(
      `SELECT q.section_id AS "sectionId", q.type, q.text, q.options, q.parts, q.difficulty, q.marks::float8 AS marks,
              q.topic_id AS "topicId", q.status, q.assessment_id AS "assessmentId", a.course_id AS "courseId"
         FROM questions q
         JOIN assessments a ON a.id = q.assessment_id
         JOIN courses c ON c.id = a.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE q.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF q`,
      [id, teacherId],
    );
    const saved = current.rows[0];
    if (!saved) return { outcome: "not_found" } as const;

    const next = { ...saved, ...parsed.data };
    if (next.type !== "mcq") next.options = null; // Only multiple choice has options, so changing the type drops them.
    if (next.type === "mcq" && !next.options) {
      return { outcome: "invalid", fields: { options: ["A multiple-choice question needs options."] } } as const;
    }
    // With parts, the total is always the sum of the parts, so the two can't disagree.
    if (next.parts) next.marks = next.parts.reduce((sum, part) => sum + Math.round(part.marks * 100), 0) / 100;

    // The topic must come from this question's own course, and the section from its own paper.
    if (parsed.data.topicId) {
      const topic = await client.query(`SELECT 1 FROM topics WHERE id = $1 AND course_id = $2`, [next.topicId, saved.courseId]);
      if (topic.rowCount === 0) return { outcome: "invalid", fields: { topicId: ["This topic isn't in this course."] } } as const;
    }
    if (parsed.data.sectionId) {
      const section = await client.query(`SELECT 1 FROM paper_sections WHERE id = $1 AND assessment_id = $2`, [next.sectionId, saved.assessmentId]);
      if (section.rowCount === 0) return { outcome: "invalid", fields: { sectionId: ["This section isn't on this paper."] } } as const;
    }

    const updated = await client.query(
      `UPDATE questions
          SET section_id = $1, type = $2, text = $3, options = $4::jsonb, parts = $5::jsonb,
              difficulty = $6, marks = $7, topic_id = $8, status = $9
        WHERE id = $10
        RETURNING id, section_id AS "sectionId", topic_id AS "topicId", type, text, options, parts, difficulty,
                  marks::float8 AS marks, status, source, position`,
      [
        next.sectionId,
        next.type,
        next.text,
        next.options ? JSON.stringify(next.options) : null,
        next.parts ? JSON.stringify(next.parts) : null,
        next.difficulty,
        next.marks,
        next.topicId,
        next.status,
        id,
      ],
    );
    return { outcome: "ok", question: updated.rows[0] } as const;
  });

  if (result.outcome === "not_found") return notFound();
  if (result.outcome === "invalid") return errorResponse(400, "invalid_input", "Some fields are invalid.", result.fields);
  return Response.json({ question: result.question });
}

// DELETE /api/v1/questions/<id>: remove one question. The others keep their order (a gap in positions is fine).
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/questions/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const deleted = await query(
    `DELETE FROM questions q
      USING assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE q.id = $1 AND a.id = q.assessment_id AND s.teacher_id = $2
      RETURNING q.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// A question as read from the database, before any changes are merged in.
type SavedQuestion = {
  sectionId: string;
  type: string;
  text: string;
  options: string[] | null;
  parts: { label: string; text: string; marks: number }[] | null;
  difficulty: "easy" | "medium" | "hard";
  marks: number;
  topicId: string | null;
  status: "draft" | "approved";
  assessmentId: string;
  courseId: string;
};

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
