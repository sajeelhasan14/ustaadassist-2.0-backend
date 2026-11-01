import { z } from "zod";
import { query } from "@/lib/db";
import { addDays, builtInHolidays } from "@/lib/holidays";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, e.g. 09:00 or 14:30.");

// Cancel a class, add an extra class, or get a class's id before taking attendance.
const sessionBody = z.object({
  date: z.iso.date("Use the format YYYY-MM-DD."),
  startTime: time,
  endTime: time.optional(), // only needed for an extra class; timetable classes take it from the timetable
  status: z.enum(["planned", "cancelled"]).optional(),
  note: z.string().trim().max(500).optional(),
});

type Slot = { weekday: number; startTime: string; endTime: string };
type OffDay = { name: string; startDate: string; endDate: string };
type StoredSession = {
  id: string; date: string; startTime: string; endTime: string; status: string; extra: boolean; note: string | null;
  present: number; absent: number;
};

const sessionColumns = `id, date::text AS date, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
  status, extra, note`;

// GET /api/v1/sections/<id>/sessions: every class of the semester, in order, with a summary.
// Worked out from the timetable, the semester dates and the off days; held, cancelled and extra classes come from class_sessions.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/sessions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const [semester] = await query<{ startDate: string; endDate: string }>(
    `SELECT s.start_date::text AS "startDate", s.end_date::text AS "endDate"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!semester) return sectionNotFound();

  // Add the public holidays this teacher doesn't have yet (same as GET /off-days), so no class lands on Eid.
  const holidays = builtInHolidays(semester.startDate, semester.endDate);
  await query(
    `INSERT INTO off_days (teacher_id, holiday_key, name, start_date, end_date, tentative)
     SELECT $1::uuid, * FROM unnest($2::text[], $3::text[], $4::date[], $5::date[], $6::boolean[])
     ON CONFLICT (teacher_id, holiday_key) DO NOTHING`,
    [
      teacherId,
      holidays.map((holiday) => holiday.key),
      holidays.map((holiday) => holiday.name),
      holidays.map((holiday) => holiday.startDate),
      holidays.map((holiday) => holiday.endDate),
      holidays.map((holiday) => holiday.tentative),
    ],
  );

  const slots = await query<Slot>(
    `SELECT weekday, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
       FROM timetable_slots WHERE section_id = $1 ORDER BY weekday, start_time`,
    [sectionId],
  );
  const offDays = await query<OffDay>(
    `SELECT name, start_date::text AS "startDate", end_date::text AS "endDate" FROM off_days
      WHERE teacher_id = $1 AND NOT removed AND start_date <= $3 AND end_date >= $2`,
    [teacherId, semester.startDate, semester.endDate],
  );
  // count(...) FILTER (WHERE ...) counts only the rows that match, so one query gives both numbers.
  const stored = await query<StoredSession>(
    `SELECT cs.id, cs.date::text AS date, to_char(cs.start_time, 'HH24:MI') AS "startTime", to_char(cs.end_time, 'HH24:MI') AS "endTime",
            cs.status, cs.extra, cs.note,
            count(a.student_id) FILTER (WHERE a.present)::int AS present,
            count(a.student_id) FILTER (WHERE NOT a.present)::int AS absent
       FROM class_sessions cs
       LEFT JOIN attendance a ON a.session_id = cs.id
      WHERE cs.section_id = $1
      GROUP BY cs.id`,
    [sectionId],
  );
  const storedByTime = new Map(stored.map((session) => [`${session.date} ${session.startTime}`, session]));

  // Walk the semester day by day. getUTCDay() is 0 for Sunday; we number days 1 = Monday … 7 = Sunday.
  const sessions = [];
  for (let date = semester.startDate; date <= semester.endDate; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    for (const slot of slots.filter((slot) => slot.weekday === weekday)) {
      const saved = storedByTime.get(`${date} ${slot.startTime}`);
      if (saved) {
        sessions.push({ ...saved, offDayName: null });
        storedByTime.delete(`${date} ${slot.startTime}`);
        continue;
      }
      const offDay = offDays.find((day) => day.startDate <= date && date <= day.endDate);
      sessions.push({
        id: null, date, startTime: slot.startTime, endTime: slot.endTime,
        status: offDay ? "off_day" : "planned", extra: false, note: null, present: 0, absent: 0,
        offDayName: offDay?.name ?? null,
      });
    }
  }
  // What's left: extra classes, and stored classes whose timetable slot was later removed.
  for (const saved of storedByTime.values()) sessions.push({ ...saved, offDayName: null });
  sessions.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  // "Today" at the university (Karachi), as YYYY-MM-DD. en-CA happens to format dates that way.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const summary = {
    held: sessions.filter((session) => session.status === "held").length,
    cancelled: sessions.filter((session) => session.status === "cancelled").length,
    offDays: sessions.filter((session) => session.status === "off_day").length,
    notMarked: sessions.filter((session) => session.status === "planned" && session.date < today).length,
    remaining: sessions.filter((session) => session.status === "planned" && session.date >= today).length,
  };
  return Response.json({ today, summary, sessions });
}

// POST /api/v1/sections/<id>/sessions: find or create the stored class at this date and time.
// Body: { date, startTime, endTime?, status?: "planned" | "cancelled", note? }
// A time that isn't in the timetable becomes an extra class (endTime required). Sending it again updates status/note.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/sessions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const parsed = sessionBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { date, startTime, status, note } = parsed.data;

  const [semester] = await query<{ startDate: string; endDate: string }>(
    `SELECT s.start_date::text AS "startDate", s.end_date::text AS "endDate"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!semester) return sectionNotFound();
  if (date < semester.startDate || date > semester.endDate) {
    return errorResponse(400, "outside_semester", `The semester runs from ${semester.startDate} to ${semester.endDate}.`);
  }

  // Is this a timetable class? Then its end time comes from the timetable and it isn't "extra".
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const [slot] = await query<{ endTime: string }>(
    `SELECT to_char(end_time, 'HH24:MI') AS "endTime" FROM timetable_slots
      WHERE section_id = $1 AND weekday = $2 AND start_time = $3::time`,
    [sectionId, weekday, startTime],
  );
  const endTime = slot?.endTime ?? parsed.data.endTime;
  if (!endTime) return errorResponse(400, "invalid_input", "This time isn't in the timetable, so add an end time for the extra class.", { endTime: ["Required for an extra class."] });
  if (endTime <= startTime) return errorResponse(400, "invalid_input", "End time must be after start time.", { endTime: ["End time must be after start time."] });

  // If the class is already stored, only status and note change (a held class keeps its attendance).
  const [session] = await query(
    `INSERT INTO class_sessions (section_id, date, start_time, end_time, status, extra, note)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'planned'), $6, $7)
     ON CONFLICT (section_id, date, start_time) DO UPDATE
       SET status = COALESCE($5, class_sessions.status),
           note = COALESCE($7, class_sessions.note)
     RETURNING ${sessionColumns}`,
    [sectionId, date, startTime, endTime, status ?? null, !slot, note ?? null],
  );
  return Response.json({ session });
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
