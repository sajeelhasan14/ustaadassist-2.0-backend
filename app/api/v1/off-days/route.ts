import { z } from "zod";
import { query } from "@/lib/db";
import { builtInHolidays } from "@/lib/holidays";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "add off day" body looks like. One day, or a range (endDate defaults to startDate).
const newOffDay = z
  .object({
    name: z.string().trim().min(1, "Name is required."),
    startDate: z.iso.date("Use the format YYYY-MM-DD."),
    endDate: z.iso.date("Use the format YYYY-MM-DD.").optional(),
  })
  .refine((day) => !day.endDate || day.endDate >= day.startDate, { message: "End date must be on or after the start date.", path: ["endDate"] });

const offDayColumns = `id, name, start_date::text AS "startDate", end_date::text AS "endDate", tentative, holiday_key IS NOT NULL AS "builtIn"`;

// GET /api/v1/off-days?semesterId=<id>: every off day inside one of the teacher's semesters, by date.
// Public holidays are added automatically the first time; after that the teacher's edits and deletions are kept.
export async function GET(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const semesterId = new URL(request.url).searchParams.get("semesterId") ?? "";
  if (!z.uuid().safeParse(semesterId).success) return errorResponse(400, "invalid_input", "Add ?semesterId=<id> to the URL.");

  const [semester] = await query<{ startDate: string; endDate: string }>(
    `SELECT start_date::text AS "startDate", end_date::text AS "endDate" FROM semesters WHERE id = $1 AND teacher_id = $2`,
    [semesterId, teacherId],
  );
  if (!semester) return errorResponse(404, "not_found", "Semester not found.");

  // Add the public holidays this teacher doesn't have yet. ON CONFLICT on holiday_key skips ones already added,
  // including ones the teacher moved or deleted (deleted ones stay as removed = true), so their choice is kept.
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

  // An off day belongs to the semester if any of its days fall inside it.
  const offDays = await query(
    `SELECT ${offDayColumns} FROM off_days
      WHERE teacher_id = $1 AND NOT removed AND start_date <= $3 AND end_date >= $2
      ORDER BY start_date`,
    [teacherId, semester.startDate, semester.endDate],
  );
  return Response.json({ offDays });
}

// POST /api/v1/off-days: add a day (or days) with no classes, e.g. the university closes. Applies to all your sections.
// Body: { name, startDate, endDate? }
export async function POST(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const parsed = newOffDay.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, startDate, endDate } = parsed.data;

  const [offDay] = await query(
    `INSERT INTO off_days (teacher_id, name, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING ${offDayColumns}`,
    [teacherId, name, startDate, endDate ?? startDate],
  );
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
