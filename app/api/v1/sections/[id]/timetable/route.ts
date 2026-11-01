import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, e.g. 09:00 or 14:30.");

// The whole week at once. weekday: 1 = Monday … 7 = Sunday. An empty list clears the timetable.
const timetableBody = z.object({
  slots: z
    .array(
      z
        .object({ weekday: z.int().min(1).max(7), startTime: time, endTime: time })
        .refine((slot) => slot.endTime > slot.startTime, { message: "End time must be after start time.", path: ["endTime"] }),
    )
    .max(30),
});

const slotColumns = `weekday, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"`;

// GET /api/v1/sections/<id>/timetable: the section's weekly classes, Monday first.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/timetable">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  // The join up to semesters is the ownership check: another teacher's section gives an empty list.
  const slots = await query(
    `SELECT t.weekday, to_char(t.start_time, 'HH24:MI') AS "startTime", to_char(t.end_time, 'HH24:MI') AS "endTime"
       FROM timetable_slots t
       JOIN sections sec ON sec.id = t.section_id
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE t.section_id = $1 AND s.teacher_id = $2
      ORDER BY t.weekday, t.start_time`,
    [sectionId, teacherId],
  );
  return Response.json({ slots });
}

// PUT /api/v1/sections/<id>/timetable: replace the whole week. Body: { slots: [{ weekday, startTime, endTime }] }
// Class dates are worked out from this, so changing it re-plans every class that hasn't happened yet.
export async function PUT(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/timetable">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const parsed = timetableBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some slots are invalid.", z.flattenError(parsed.error));
  }
  // Sort by day, then time, so overlapping slots end up next to each other. "09:00" < "10:30" works as text.
  const slots = parsed.data.slots.toSorted((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].weekday === slots[i - 1].weekday && slots[i].startTime < slots[i - 1].endTime) {
      return errorResponse(400, "overlapping_slots", `Two classes overlap on day ${slots[i].weekday} (${slots[i - 1].startTime} and ${slots[i].startTime}).`);
    }
  }

  // Delete the old week and insert the new one as one unit, so a half-changed week is never seen.
  const result = await withTransaction(async (client) => {
    const section = await client.query(
      `SELECT sec.id FROM sections sec
         JOIN courses c ON c.id = sec.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE sec.id = $1 AND s.teacher_id = $2`,
      [sectionId, teacherId],
    );
    if (section.rowCount === 0) return null;

    await client.query("DELETE FROM timetable_slots WHERE section_id = $1", [sectionId]);
    const inserted = await client.query(
      `INSERT INTO timetable_slots (section_id, weekday, start_time, end_time)
       SELECT $1::uuid, * FROM unnest($2::smallint[], $3::time[], $4::time[])
       RETURNING ${slotColumns}`,
      [sectionId, slots.map((slot) => slot.weekday), slots.map((slot) => slot.startTime), slots.map((slot) => slot.endTime)],
    );
    return inserted.rows;
  });
  if (!result) return sectionNotFound();
  return Response.json({ slots: result });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function sectionNotFound() {
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
