import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/v1/sections/<id>/marks: the gradebook. One row per student, one column per assessment, plus the total.
// total = plain sum of the marks entered (no weights). percentage = total ÷ the course total.
// Grades are not given yet: they will follow the university's result format.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/marks">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const [course] = await query<{ id: string; totalMarks: number }>(
    `SELECT c.id, c.total_marks::float8 AS "totalMarks"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!course) return sectionNotFound();

  const assessments = await query<{ id: string; name: string; maxMarks: number }>(
    `SELECT id, name, max_marks::float8 AS "maxMarks" FROM assessments WHERE course_id = $1 ORDER BY position`,
    [course.id],
  );
  const students = await query<{ id: string; rollNumber: string; fullName: string }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName"
       FROM enrollments e JOIN students st ON st.id = e.student_id
      WHERE e.section_id = $1
      ORDER BY st.roll_number`,
    [sectionId],
  );
  const marks = await query<{ assessmentId: string; studentId: string; marks: number }>(
    `SELECT m.assessment_id AS "assessmentId", m.student_id AS "studentId", m.marks::float8 AS marks
       FROM marks m
       JOIN assessments a ON a.id = m.assessment_id
       JOIN enrollments e ON e.student_id = m.student_id AND e.section_id = $2
      WHERE a.course_id = $1`,
    [course.id, sectionId],
  );
  const markOf = new Map(marks.map((mark) => [`${mark.studentId} ${mark.assessmentId}`, mark.marks]));

  const rows = students.map((student) => {
    // Same order as `assessments`, so column 1 is always the first assessment. null = not entered.
    const studentMarks = assessments.map((assessment) => markOf.get(`${student.id} ${assessment.id}`) ?? null);
    const entered = studentMarks.filter((mark) => mark !== null);
    // Rounded to 2 decimals so 7.1 + 0.2 shows as 7.3, not 7.299999.
    const total = Math.round(entered.reduce((sum, mark) => sum + mark, 0) * 100) / 100;
    return {
      ...student,
      marks: studentMarks,
      total,
      percentage: Math.round((total / course.totalMarks) * 1000) / 10,
      missing: studentMarks.length - entered.length,
    };
  });

  return Response.json({
    totalMarks: course.totalMarks,
    allocated: Math.round(assessments.reduce((sum, assessment) => sum + assessment.maxMarks, 0) * 100) / 100,
    assessments,
    students: rows,
  });
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
