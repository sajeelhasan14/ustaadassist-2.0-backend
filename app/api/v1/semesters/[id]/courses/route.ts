import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "create course" body looks like.
const newCourse = z.object({
  code: z.string().trim().min(1, "Code is required."),
  title: z.string().trim().min(1, "Title is required."),
});

// GET /api/v1/semesters/<id>/courses: the courses in one of the teacher's semesters.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/semesters/[id]/courses">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: semesterId } = await ctx.params;
  if (!z.uuid().safeParse(semesterId).success) return errorResponse(404, "not_found", "Semester not found.");

  // The JOIN to semesters is the ownership check: another teacher's semester gives an empty list.
  const courses = await query(
    `SELECT c.id, c.semester_id AS "semesterId", c.code, c.title
       FROM courses c
       JOIN semesters s ON s.id = c.semester_id
      WHERE c.semester_id = $1 AND s.teacher_id = $2
      ORDER BY c.code`,
    [semesterId, teacherId],
  );
  return Response.json({ courses });
}

// POST /api/v1/semesters/<id>/courses: add a course to a semester. Body: { code, title }
export async function POST(request: Request, ctx: RouteContext<"/api/v1/semesters/[id]/courses">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: semesterId } = await ctx.params;
  if (!z.uuid().safeParse(semesterId).success) return errorResponse(404, "not_found", "Semester not found.");

  const parsed = newCourse.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { code, title } = parsed.data;

  try {
    // INSERT ... SELECT ... WHERE: the row is only inserted if the semester belongs to this teacher.
    const [course] = await query(
      `INSERT INTO courses (semester_id, code, title)
       SELECT id, $2, $3 FROM semesters WHERE id = $1 AND teacher_id = $4
       RETURNING id, semester_id AS "semesterId", code, title`,
      [semesterId, code, title, teacherId],
    );
    if (!course) return errorResponse(404, "not_found", "Semester not found.");
    return Response.json({ course }, { status: 201 });
  } catch (error) {
    // 23505 = unique rule broken: this semester already has a course with this code.
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_code", `This semester already has a course with code "${code}".`);
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
