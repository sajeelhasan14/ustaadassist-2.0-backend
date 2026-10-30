import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const topicChanges = z.object({
  title: z.string().trim().min(1, "Title can't be empty."),
});

// PATCH /api/v1/topics/<id>: rename a topic. Body: { title }
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/topics/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = topicChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  // topic → course → semester → teacher: only changes the topic if it belongs to this teacher.
  const [topic] = await query(
    `UPDATE topics t
        SET title = $1
       FROM courses c
       JOIN semesters s ON s.id = c.semester_id
      WHERE t.id = $2 AND c.id = t.course_id AND s.teacher_id = $3
      RETURNING t.id, t.title, t.position`,
    [parsed.data.title, id, teacherId],
  );
  if (!topic) return notFound();
  return Response.json({ topic });
}

// DELETE /api/v1/topics/<id>: remove a topic. The others keep their order (a gap in positions is fine).
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/topics/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const deleted = await query(
    `DELETE FROM topics t
      USING courses c
       JOIN semesters s ON s.id = c.semester_id
      WHERE t.id = $1 AND c.id = t.course_id AND s.teacher_id = $2
      RETURNING t.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Topic not found.");
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
