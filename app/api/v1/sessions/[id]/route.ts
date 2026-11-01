import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// "held" is not allowed here: a class becomes held by taking attendance (PUT /sessions/<id>/attendance).
const sessionChanges = z
  .object({
    status: z.enum(["planned", "cancelled"]),
    note: z.string().trim().max(500).nullable(),
  })
  .partial();

// PATCH /api/v1/sessions/<id>: cancel or un-cancel a class, or change its note (null clears it).
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/sessions/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = sessionChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { status, note } = parsed.data;

  // UPDATE … FROM joins up to semesters, so only the owner's class can change.
  const [session] = await query(
    `UPDATE class_sessions cs
        SET status = COALESCE($1, cs.status),
            note = CASE WHEN $2 THEN $3 ELSE cs.note END
       FROM sections sec, courses c, semesters s
      WHERE cs.id = $4 AND sec.id = cs.section_id AND c.id = sec.course_id AND s.id = c.semester_id AND s.teacher_id = $5
      RETURNING cs.id, cs.date::text AS date, to_char(cs.start_time, 'HH24:MI') AS "startTime",
                to_char(cs.end_time, 'HH24:MI') AS "endTime", cs.status, cs.extra, cs.note`,
    [status ?? null, note !== undefined, note ?? null, id, teacherId],
  );
  if (!session) return notFound();
  return Response.json({ session });
}

// DELETE /api/v1/sessions/<id>: forget a stored class and its attendance.
// A timetable class goes back to "planned"; an extra class disappears from the calendar.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/sessions/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const deleted = await query(
    `DELETE FROM class_sessions cs
      USING sections sec, courses c, semesters s
      WHERE cs.id = $1 AND sec.id = cs.section_id AND c.id = sec.course_id AND s.id = c.semester_id AND s.teacher_id = $2
      RETURNING cs.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Class not found.");
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
