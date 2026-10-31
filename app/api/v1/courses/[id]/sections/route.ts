import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "create section" body looks like.
const newSection = z.object({
  name: z.string().trim().min(1, "Name is required."),
});

// GET /api/v1/courses/<id>/sections: the sections of one of the teacher's courses, with student counts.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/sections">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return errorResponse(404, "not_found", "Course not found.");

  // The JOINs to courses and semesters are the ownership check: another teacher's course gives an empty list.
  // LEFT JOIN enrollments keeps sections with no students (their count is 0).
  const sections = await query(
    `SELECT sec.id, sec.course_id AS "courseId", sec.name, COUNT(e.student_id)::int AS "studentCount"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
       LEFT JOIN enrollments e ON e.section_id = sec.id
      WHERE sec.course_id = $1 AND s.teacher_id = $2
      GROUP BY sec.id
      ORDER BY sec.name`,
    [courseId, teacherId],
  );
  return Response.json({ sections });
}

// POST /api/v1/courses/<id>/sections: add a section to a course. Body: { name }
export async function POST(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/sections">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return errorResponse(404, "not_found", "Course not found.");

  const parsed = newSection.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name } = parsed.data;

  try {
    // INSERT ... SELECT ... WHERE: the row is only inserted if the course's semester belongs to this teacher.
    const [section] = await query(
      `INSERT INTO sections (course_id, name)
       SELECT c.id, $2 FROM courses c
         JOIN semesters s ON s.id = c.semester_id
        WHERE c.id = $1 AND s.teacher_id = $3
       RETURNING id, course_id AS "courseId", name`,
      [courseId, name, teacherId],
    );
    if (!section) return errorResponse(404, "not_found", "Course not found.");
    return Response.json({ section: { ...section, studentCount: 0 } }, { status: 201 });
  } catch (error) {
    // 23505 = unique rule broken: this course already has a section with this name.
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_name", `This course already has a section named "${name}".`);
    }
    throw error;
  }
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
