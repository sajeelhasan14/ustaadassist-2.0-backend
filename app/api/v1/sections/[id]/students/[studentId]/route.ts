import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/v1/sections/<id>/students/<studentId>: one student in one section, for the student details screen:
// their details, attendance (with the dates they missed), and their marks in each of the course's assessments.
// Same sums as GET /sections/<id>/attendance: held classes only, % rounded to one decimal, the course's own line.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/students/[studentId]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId, studentId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success || !z.uuid().safeParse(studentId).success) return notFound();

  // The JOINs are the ownership check: the student must be enrolled in this teacher's section.
  const [student] = await query<{
    id: string; rollNumber: string; fullName: string; fatherName: string | null; email: string | null;
    courseId: string; minAttendance: number; totalMarks: number;
  }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName", st.father_name AS "fatherName", st.email,
            c.id AS "courseId", c.min_attendance::float8 AS "minAttendance", c.total_marks::float8 AS "totalMarks"
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       JOIN sections sec ON sec.id = e.section_id
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE e.section_id = $1 AND e.student_id = $2 AND s.teacher_id = $3`,
    [sectionId, studentId, teacherId],
  );
  if (!student) return notFound();

  // Every held class this student was marked in, newest first.
  const classes = await query<{ date: string; startTime: string; present: boolean }>(
    `SELECT cs.date::text AS date, to_char(cs.start_time, 'HH24:MI') AS "startTime", a.present
       FROM class_sessions cs
       JOIN attendance a ON a.session_id = cs.id AND a.student_id = $2
      WHERE cs.section_id = $1 AND cs.status = 'held'
      ORDER BY cs.date DESC, cs.start_time DESC`,
    [sectionId, studentId],
  );
  const present = classes.filter((one) => one.present).length;
  const percentage = classes.length === 0 ? null : Math.round((present * 1000) / classes.length) / 10;

  // Each assessment of the course, with this student's mark. null = not entered (or absent).
  const marks = await query<{ id: string; name: string; maxMarks: number; isLab: boolean; marks: number | null }>(
    `SELECT a.id, a.name, a.max_marks::float8 AS "maxMarks", a.is_lab AS "isLab", m.marks::float8 AS marks
       FROM assessments a
       LEFT JOIN marks m ON m.assessment_id = a.id AND m.student_id = $2
      WHERE a.course_id = $1
      ORDER BY a.position`,
    [student.courseId, studentId],
  );
  const total = Math.round(marks.reduce((sum, one) => sum + (one.marks ?? 0), 0) * 100) / 100;

  return Response.json({
    student: { id: student.id, rollNumber: student.rollNumber, fullName: student.fullName, fatherName: student.fatherName, email: student.email },
    attendance: {
      present,
      marked: classes.length,
      percentage,
      min: student.minAttendance,
      shortage: percentage !== null && percentage < student.minAttendance,
      absentOn: classes.filter((one) => !one.present).map(({ date, startTime }) => ({ date, startTime })),
    },
    marks: { total, outOf: student.totalMarks, assessments: marks },
  });
}

// DELETE /api/v1/sections/<id>/students/<studentId>: take a student out of a section.
// Only the enrollment is removed; the student stays, because they may be in the teacher's other sections.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/students/[studentId]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId, studentId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success || !z.uuid().safeParse(studentId).success) return notFound();

  // DELETE ... USING students: only removes the enrollment if the student belongs to this teacher.
  const deleted = await query(
    `DELETE FROM enrollments e
      USING students st
      WHERE e.section_id = $1 AND e.student_id = $2 AND st.id = e.student_id AND st.teacher_id = $3
      RETURNING e.student_id`,
    [sectionId, studentId, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "not in this section" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Student is not in this section.");
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
