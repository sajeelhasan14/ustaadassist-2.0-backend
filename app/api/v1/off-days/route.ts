import { z } from "zod";
import { query } from "@/lib/db";
import { addPublicHolidays } from "@/lib/holidays";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "add off day" body looks like. One day, or a range (endDate defaults to startDate).
const newOffDay = z
  .object({
    courseId: z.uuid("Say which course the off day is for."),
    name: z.string().trim().min(1, "Name is required."),
    startDate: z.iso.date("Use the format YYYY-MM-DD."),
    endDate: z.iso.date("Use the format YYYY-MM-DD.").optional(),
  })
  .refine((day) => !day.endDate || day.endDate >= day.startDate, { message: "End date must be on or after the start date.", path: ["endDate"] });

const offDayColumns = `id, name, start_date::text AS "startDate", end_date::text AS "endDate", tentative, holiday_key IS NOT NULL AS "builtIn"`;

// GET /api/v1/off-days?courseId=<id>: every off day of one course, inside its semester, by date.
// Each course has its own list. Public holidays are added automatically the first time; after that the
// teacher's edits and deletions are kept.
export async function GET(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const courseId = new URL(request.url).searchParams.get("courseId") ?? "";
  if (!z.uuid().safeParse(courseId).success) return errorResponse(400, "invalid_input", "Add ?courseId=<id> to the URL.");

  // The JOIN to semesters is the ownership check, and gives the semester's dates.
  const [semester] = await query<{ startDate: string; endDate: string }>(
    `SELECT s.start_date::text AS "startDate", s.end_date::text AS "endDate"
       FROM courses c JOIN semesters s ON s.id = c.semester_id
      WHERE c.id = $1 AND s.teacher_id = $2`,
    [courseId, teacherId],
  );
  if (!semester) return errorResponse(404, "not_found", "Course not found.");

  await addPublicHolidays(teacherId, courseId, semester.startDate, semester.endDate);

  // An off day belongs to the semester if any of its days fall inside it.
  const offDays = await query(
    `SELECT ${offDayColumns} FROM off_days
      WHERE course_id = $1 AND NOT removed AND start_date <= $3 AND end_date >= $2
      ORDER BY start_date`,
    [courseId, semester.startDate, semester.endDate],
  );
  return Response.json({ offDays });
}

// POST /api/v1/off-days: add a day (or days) with no classes for one course, e.g. that university closes.
// Body: { courseId, name, startDate, endDate? }
export async function POST(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const parsed = newOffDay.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { courseId, name, startDate, endDate } = parsed.data;

  // INSERT ... SELECT: only adds it if the course belongs to this teacher; otherwise nothing comes back.
  const [offDay] = await query(
    `INSERT INTO off_days (teacher_id, course_id, name, start_date, end_date)
     SELECT $1, c.id, $3, $4, $5 FROM courses c JOIN semesters s ON s.id = c.semester_id
      WHERE c.id = $2 AND s.teacher_id = $1
     RETURNING ${offDayColumns}`,
    [teacherId, courseId, name, startDate, endDate ?? startDate],
  );
  if (!offDay) return errorResponse(404, "not_found", "Course not found.");
  return Response.json({ offDay }, { status: 201 });
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
