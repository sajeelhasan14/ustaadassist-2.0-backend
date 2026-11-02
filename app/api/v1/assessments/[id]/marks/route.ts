import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// The teacher types numbers down the class list and saves once. null clears a mark entered by mistake.
// Students left out of the list are not touched.
const marksBody = z.object({
  marks: z
    .array(z.object({ studentId: z.uuid("Not a valid student id."), marks: z.number().min(0, "Can't be negative.").nullable() }))
    .min(1, "Send at least one mark.")
    .max(500),
});

// GET /api/v1/assessments/<id>/marks?sectionId=<id>: the class list with each student's mark (null = not entered).
// Without sectionId: every student of the course, all sections together.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/marks">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: assessmentId } = await ctx.params;
  if (!z.uuid().safeParse(assessmentId).success) return notFound();

  const sectionId = new URL(request.url).searchParams.get("sectionId");
  if (sectionId !== null && !z.uuid().safeParse(sectionId).success) {
    return errorResponse(400, "invalid_input", "sectionId must be a section id.");
  }

  const [assessment] = await query<{ id: string; name: string; maxMarks: number; courseId: string }>(
    `SELECT a.id, a.name, a.max_marks::float8 AS "maxMarks", a.course_id AS "courseId"
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE a.id = $1 AND s.teacher_id = $2`,
    [assessmentId, teacherId],
  );
  if (!assessment) return notFound();

  // $3 IS NULL OR …: one query for both cases (one section, or the whole course).
  const students = await query<{ marks: number | null }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName", sec.name AS "sectionName", m.marks::float8 AS marks
       FROM sections sec
       JOIN enrollments e ON e.section_id = sec.id
       JOIN students st ON st.id = e.student_id
       LEFT JOIN marks m ON m.assessment_id = $2 AND m.student_id = st.id
      WHERE sec.course_id = $1 AND ($3::uuid IS NULL OR sec.id = $3)
      ORDER BY st.roll_number`,
    [assessment.courseId, assessmentId, sectionId],
  );
  return Response.json({
    assessment: { id: assessment.id, name: assessment.name, maxMarks: assessment.maxMarks },
    entered: students.filter((student) => student.marks !== null).length,
    students,
  });
}

// PUT /api/v1/assessments/<id>/marks: save marks. Body: { marks: [{ studentId, marks: number | null }] }
// All or nothing: one mark over the maximum, or one student not in this course, and nothing is saved.
export async function PUT(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/marks">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: assessmentId } = await ctx.params;
  if (!z.uuid().safeParse(assessmentId).success) return notFound();

  const parsed = marksBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some marks are invalid.", z.flattenError(parsed.error));
  }
  const entries = parsed.data.marks;
  if (new Set(entries.map((entry) => entry.studentId)).size !== entries.length) {
    return errorResponse(400, "invalid_input", "A student appears more than once.");
  }

  const result = await withTransaction(async (client) => {
    // FOR UPDATE: max marks can't be changed while these marks are being checked and saved.
    const assessment = await client.query<{ maxMarks: number; courseId: string }>(
      `SELECT a.max_marks::float8 AS "maxMarks", a.course_id AS "courseId"
         FROM assessments a
         JOIN courses c ON c.id = a.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE a.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF a`,
      [assessmentId, teacherId],
    );
    const found = assessment.rows[0];
    if (!found) return { outcome: "not_found" } as const;

    // Compared in hundredths, so 7.5 out of 7.5 is never "too high" because of decimal rounding.
    const tooHigh = entries.filter((entry) => entry.marks !== null && Math.round(entry.marks * 100) > Math.round(found.maxMarks * 100));
    if (tooHigh.length > 0) return { outcome: "too_high", maxMarks: found.maxMarks, studentIds: tooHigh.map((entry) => entry.studentId) } as const;

    // Every student must be enrolled in a section of this course.
    const enrolled = await client.query<{ studentId: string }>(
      `SELECT e.student_id AS "studentId" FROM enrollments e JOIN sections sec ON sec.id = e.section_id
        WHERE sec.course_id = $1 AND e.student_id = ANY($2::uuid[])`,
      [found.courseId, entries.map((entry) => entry.studentId)],
    );
    const enrolledIds = new Set(enrolled.rows.map((row) => row.studentId));
    const unknown = entries.filter((entry) => !enrolledIds.has(entry.studentId)).map((entry) => entry.studentId);
    if (unknown.length > 0) return { outcome: "unknown_students", studentIds: unknown } as const;

    // Numbers are inserted, or update the mark already there (upsert). nulls delete the mark.
    const toSave = entries.filter((entry) => entry.marks !== null);
    const toClear = entries.filter((entry) => entry.marks === null);
    await client.query(
      `INSERT INTO marks (assessment_id, student_id, marks)
       SELECT $1, * FROM unnest($2::uuid[], $3::numeric[])
       ON CONFLICT (assessment_id, student_id) DO UPDATE SET marks = EXCLUDED.marks, updated_at = now()`,
      [assessmentId, toSave.map((entry) => entry.studentId), toSave.map((entry) => entry.marks)],
    );
    await client.query(
      `DELETE FROM marks WHERE assessment_id = $1 AND student_id = ANY($2::uuid[])`,
      [assessmentId, toClear.map((entry) => entry.studentId)],
    );
    return { outcome: "ok", saved: toSave.length, cleared: toClear.length } as const;
  });

  if (result.outcome === "not_found") return notFound();
  if (result.outcome === "too_high") {
    return errorResponse(400, "above_max", `Marks can't be more than ${result.maxMarks}. Nothing was saved.`, { studentIds: result.studentIds });
  }
  if (result.outcome === "unknown_students") {
    return errorResponse(400, "invalid_input", "Some students aren't in this course. Nothing was saved.", { studentIds: result.studentIds });
  }
  return Response.json({ saved: result.saved, cleared: result.cleared });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Assessment not found.");
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
