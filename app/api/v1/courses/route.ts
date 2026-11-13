import { query } from "@/lib/db";
import { DEFAULT_GRADE_SCALE } from "@/lib/grades";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/v1/courses: every course the teacher has, whatever its semester.
// The app's first screen lists these. Reading them one semester at a time hid courses
// whose dates differ from the newest semester's, so this returns them all in one go.
export async function GET(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  // The JOIN to semesters is the ownership check: only this teacher's courses come back.
  // Newest semester first, then by name, so the courses being taught now are on top.
  const courses = await query(
    `SELECT c.id, c.semester_id AS "semesterId", c.code, c.title, c.total_marks::float8 AS "totalMarks",
            c.credit_hours AS "creditHours", c.result_header AS "resultHeader",
            c.min_attendance::float8 AS "minAttendance", COALESCE(c.grade_scale, $2::jsonb) AS "gradeScale",
            c.grade_scale IS NULL AS "defaultGradeScale"
       FROM courses c
       JOIN semesters s ON s.id = c.semester_id
      WHERE s.teacher_id = $1
      ORDER BY s.start_date DESC, c.title`,
    [teacherId, JSON.stringify(DEFAULT_GRADE_SCALE)],
  );
  return Response.json({ courses });
}

// Reads the teacher's id from the "Authorization: Bearer <token>" header, or null if it's missing or invalid.
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
