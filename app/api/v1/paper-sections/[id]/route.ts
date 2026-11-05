import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Every field is optional; send only what changes. attemptAny: null makes every question compulsory again.
const sectionChanges = z
  .object({
    title: z.string().trim().max(200),
    instructions: z.string().trim().max(2000),
    attemptAny: z.int().positive("Must be more than 0.").max(100).nullable(),
  })
  .partial();

// PATCH /api/v1/paper-sections/<id>: rename a section or change its instructions.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/paper-sections/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = sectionChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { title, instructions, attemptAny } = parsed.data;

  // section → assessment → course → semester → teacher: only changes the section if it belongs to this teacher.
  // COALESCE can't tell "leave it" from "clear it", so attemptAny carries a flag saying whether it was sent.
  const [section] = await query(
    `UPDATE paper_sections ps
        SET title = COALESCE($1, ps.title),
            instructions = COALESCE($2, ps.instructions),
            attempt_any = CASE WHEN $3::boolean THEN $4::integer ELSE ps.attempt_any END
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE ps.id = $5 AND a.id = ps.assessment_id AND s.teacher_id = $6
      RETURNING ps.id, ps.title, ps.instructions, ps.attempt_any AS "attemptAny", ps.position`,
    [title ?? null, instructions ?? null, attemptAny !== undefined, attemptAny ?? null, id, teacherId],
  );
  if (!section) return notFound();
  return Response.json({ section });
}

// DELETE /api/v1/paper-sections/<id>: remove a section and every question in it.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/paper-sections/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const deleted = await query(
    `DELETE FROM paper_sections ps
      USING assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE ps.id = $1 AND a.id = ps.assessment_id AND s.teacher_id = $2
      RETURNING ps.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Section not found.");
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
