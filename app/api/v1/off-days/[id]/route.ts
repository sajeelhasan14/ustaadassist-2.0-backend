import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "edit off day" body looks like. Every field is optional.
// shiftDays moves the whole off day, e.g. Eid starts a day later than expected: { "shiftDays": 1 }.
const offDayChanges = z
  .object({
    name: z.string().trim().min(1, "Name can't be empty."),
    startDate: z.iso.date("Use the format YYYY-MM-DD."),
    endDate: z.iso.date("Use the format YYYY-MM-DD."),
    shiftDays: z.int().min(-30).max(30),
    tentative: z.boolean(),
  })
  .partial();

const offDayColumns = `id, name, start_date::text AS "startDate", end_date::text AS "endDate", tentative, holiday_key IS NOT NULL AS "builtIn"`;

// PATCH /api/v1/off-days/<id>: rename, change dates, shift, or confirm an off day.
// Any edit confirms it (tentative → false), because the teacher has now checked it. Send {} to just confirm.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/off-days/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = offDayChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, startDate, endDate, shiftDays, tentative } = parsed.data;

  try {
    // date + integer = that many days later, in Postgres.
    const [offDay] = await query(
      `UPDATE off_days
          SET name = COALESCE($1, name),
              start_date = COALESCE($2::date, start_date) + $4::int,
              end_date = COALESCE($3::date, end_date) + $4::int,
              tentative = COALESCE($5, false)
        WHERE id = $6 AND teacher_id = $7 AND NOT removed
        RETURNING ${offDayColumns}`,
      [name ?? null, startDate ?? null, endDate ?? null, shiftDays ?? 0, tentative ?? null, id, teacherId],
    );
    if (!offDay) return notFound();
    return Response.json({ offDay });
  } catch (error) {
    // 23514 = check rule broken: end date before start date.
    if ((error as { code?: string }).code === "23514") {
      return errorResponse(400, "invalid_input", "End date must be on or after the start date.", { endDate: ["End date must be on or after the start date."] });
    }
    throw error;
  }
}

// DELETE /api/v1/off-days/<id>: classes happen on these days after all.
// A public holiday is only hidden (removed = true), so it isn't added back next time. A day you added is deleted.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/off-days/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // Only one of the two steps can match: a row either has a holiday_key or it doesn't.
  const deleted = await query(
    `WITH hidden AS (
       UPDATE off_days SET removed = true
        WHERE id = $1 AND teacher_id = $2 AND holiday_key IS NOT NULL AND NOT removed
        RETURNING id
     ), gone AS (
       DELETE FROM off_days WHERE id = $1 AND teacher_id = $2 AND holiday_key IS NULL RETURNING id
     )
     SELECT id FROM hidden UNION ALL SELECT id FROM gone`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Off day not found.");
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
