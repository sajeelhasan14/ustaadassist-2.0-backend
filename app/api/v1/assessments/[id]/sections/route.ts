import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Everything is optional: an untitled section is a plain list of questions.
const newSection = z.object({
  title: z.string().trim().max(200).default(""),
  instructions: z.string().trim().max(2000).default(""),
  attemptAny: z.int().positive("Must be more than 0.").max(100).optional(),
});

// POST /api/v1/assessments/<id>/sections: add a section to the paper. Body: { title?, instructions?, attemptAny? }
export async function POST(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/sections">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = newSection.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { title, instructions, attemptAny } = parsed.data;

  const section = await withTransaction(async (client) => {
    // The JOINs up to semesters are the ownership check. The lock stops two adds getting the same position.
    const owned = await client.query(
      `SELECT 1
         FROM assessments a
         JOIN courses c ON c.id = a.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE a.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF a`,
      [id, teacherId],
    );
    if (owned.rowCount === 0) return null;

    const inserted = await client.query(
      `INSERT INTO paper_sections (assessment_id, title, instructions, attempt_any, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM paper_sections WHERE assessment_id = $1))
       RETURNING id, title, instructions, attempt_any AS "attemptAny", position`,
      [id, title, instructions, attemptAny ?? null],
    );
    return inserted.rows[0];
  });

  if (!section) return notFound();
  return Response.json({ section }, { status: 201 });
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
