import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "edit semester" body looks like. Every field is optional; send only what changes.
const semesterChanges = z
  .object({
    name: z.string().trim().min(1, "Name can't be empty."),
    startDate: z.iso.date("Use the format YYYY-MM-DD."),
    endDate: z.iso.date("Use the format YYYY-MM-DD."),
  })
  .partial();

// PATCH /api/v1/semesters/<id>: change a semester's name and/or dates.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/semesters/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = semesterChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, startDate, endDate } = parsed.data;

  try {
    // COALESCE($n, column) = "use the new value, or keep the old one if it wasn't sent".
    // teacher_id = $5 makes sure a teacher can only change their own semester.
    const [semester] = await query(
      `UPDATE semesters
          SET name = COALESCE($1, name),
              start_date = COALESCE($2, start_date),
              end_date = COALESCE($3, end_date)
        WHERE id = $4 AND teacher_id = $5
        RETURNING id, name, start_date::text AS "startDate", end_date::text AS "endDate"`,
      [name ?? null, startDate ?? null, endDate ?? null, id, teacherId],
    );
    if (!semester) return notFound();
    return Response.json({ semester });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 23505 = unique rule broken (name already used), 23514 = check rule broken (end before start).
    if (code === "23505") return errorResponse(409, "duplicate_name", `You already have a semester called "${name}".`);
    if (code === "23514") {
      return errorResponse(400, "invalid_input", "End date must be on or after the start date.", { endDate: ["End date must be on or after the start date."] });
    }
    throw error;
  }
}

// DELETE /api/v1/semesters/<id>: delete a semester. Its courses, sections and topics go with it.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/semesters/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const deleted = await query(
    "DELETE FROM semesters WHERE id = $1 AND teacher_id = $2 RETURNING id",
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Semester not found.");
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
