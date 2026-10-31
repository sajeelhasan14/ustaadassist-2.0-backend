import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "rename section" body looks like.
const sectionChanges = z.object({
  name: z.string().trim().min(1, "Name can't be empty."),
});

// PATCH /api/v1/sections/<id>: rename a section.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/sections/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = sectionChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name } = parsed.data;

  try {
    // UPDATE ... FROM courses, semesters: only renames the section if its course's semester belongs to this teacher.
    const [section] = await query(
      `UPDATE sections sec
          SET name = $1
         FROM courses c, semesters s
        WHERE sec.id = $2 AND c.id = sec.course_id AND s.id = c.semester_id AND s.teacher_id = $3
        RETURNING sec.id, sec.course_id AS "courseId", sec.name`,
      [name, id, teacherId],
    );
    if (!section) return notFound();
    return Response.json({ section });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_name", `This course already has a section named "${name}".`);
    }
    throw error;
  }
}

// DELETE /api/v1/sections/<id>: delete a section. Its enrollments go with it; the students themselves stay.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/sections/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // DELETE ... USING courses, semesters: only deletes the section if its course's semester belongs to this teacher.
  const deleted = await query(
    `DELETE FROM sections sec
      USING courses c, semesters s
      WHERE sec.id = $1 AND c.id = sec.course_id AND s.id = c.semester_id AND s.teacher_id = $2
      RETURNING sec.id`,
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
