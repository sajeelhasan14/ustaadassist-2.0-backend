import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "edit course" body looks like. Send only what changes.
const courseChanges = z
  .object({
    code: z.string().trim().min(1, "Code can't be empty."),
    title: z.string().trim().min(1, "Title can't be empty."),
  })
  .partial();

// PATCH /api/v1/courses/<id>: change a course's code and/or title.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/courses/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = courseChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { code, title } = parsed.data;

  try {
    // UPDATE ... FROM semesters: only changes the course if its semester belongs to this teacher.
    const [course] = await query(
      `UPDATE courses c
          SET code = COALESCE($1, c.code),
              title = COALESCE($2, c.title)
         FROM semesters s
        WHERE c.id = $3 AND s.id = c.semester_id AND s.teacher_id = $4
        RETURNING c.id, c.semester_id AS "semesterId", c.code, c.title`,
      [code ?? null, title ?? null, id, teacherId],
    );
    if (!course) return notFound();
    return Response.json({ course });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_code", `This semester already has a course with code "${code}".`);
    }
    throw error;
  }
}

// DELETE /api/v1/courses/<id>: delete a course. Its sections and topics go with it.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/courses/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // DELETE ... USING semesters: only deletes the course if its semester belongs to this teacher.
  const deleted = await query(
    `DELETE FROM courses c
      USING semesters s
      WHERE c.id = $1 AND s.id = c.semester_id AND s.teacher_id = $2
      RETURNING c.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Course not found.");
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
