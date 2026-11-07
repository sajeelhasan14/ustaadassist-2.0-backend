import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Any name and any marks: the teacher decides what exists and what it's worth.
const newAssessment = z.object({
  name: z.string().trim().min(1, "Name is required.").max(100),
  maxMarks: z.number().positive("Must be more than 0.").max(1000),
  // Lab work counts in the Lab column of the result sheet, everything else in Theory.
  isLab: z.boolean().default(false),
  // Optional, like every date on an assessment: most are added with no date at all.
  date: z.iso.date("Use the format YYYY-MM-DD.").optional(),
});

// numeric columns arrive in JavaScript as text ("7.50"), so every mark is cast to float8 to get a real number.
const assessmentColumns = `a.id, a.name, a.max_marks::float8 AS "maxMarks", a.is_lab AS "isLab", a.position, a.held_on::text AS date`;

// GET /api/v1/courses/<id>/assessments: the course's assessments in order, with how many marks are allocated
// and, for each assessment, how many students already have a mark.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/assessments">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return courseNotFound();

  // students = everyone enrolled in any section of the course (each student is in only one of them).
  const [course] = await query<{ code: string; totalMarks: number; students: number }>(
    `SELECT c.code, c.total_marks::float8 AS "totalMarks",
            (SELECT count(*) FROM enrollments e JOIN sections sec ON sec.id = e.section_id WHERE sec.course_id = c.id)::int AS students
       FROM courses c JOIN semesters s ON s.id = c.semester_id
      WHERE c.id = $1 AND s.teacher_id = $2`,
    [courseId, teacherId],
  );
  if (!course) return courseNotFound();

  const assessments = await query<{ maxMarks: number }>(
    `SELECT ${assessmentColumns}, count(m.student_id)::int AS "marksEntered"
       FROM assessments a
       LEFT JOIN marks m ON m.assessment_id = a.id
      WHERE a.course_id = $1
      GROUP BY a.id
      ORDER BY a.position`,
    [courseId],
  );
  const allocated = cents(assessments.reduce((sum, assessment) => sum + assessment.maxMarks, 0)) / 100;
  return Response.json({
    courseCode: course.code,
    totalMarks: course.totalMarks,
    allocated,
    unallocated: cents(course.totalMarks - allocated) / 100,
    students: course.students,
    assessments,
  });
}

// POST /api/v1/courses/<id>/assessments: add an assessment at the end. Body: { name, maxMarks, isLab?, date? }
// Refused if it would take the course over its total (e.g. 60 of 100 used, a 50-mark Final → 400).
export async function POST(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/assessments">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return courseNotFound();

  const parsed = newAssessment.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, maxMarks, isLab, date } = parsed.data;

  try {
    const result = await withTransaction(async (client) => {
      // FOR UPDATE on the course: two assessments added at the same moment can't both squeeze into the last marks.
      const course = await client.query<{ totalMarks: number; allocated: number }>(
        `SELECT c.total_marks::float8 AS "totalMarks",
                (SELECT COALESCE(SUM(max_marks), 0) FROM assessments WHERE course_id = c.id)::float8 AS allocated
           FROM courses c JOIN semesters s ON s.id = c.semester_id
          WHERE c.id = $1 AND s.teacher_id = $2
          FOR UPDATE OF c`,
        [courseId, teacherId],
      );
      const found = course.rows[0];
      if (!found) return { outcome: "not_found" } as const;
      // Compared in hundredths: in JavaScript 33.3 + 33.3 + 33.4 is 100.00000000000001, which would wrongly be "over 100".
      if (cents(found.allocated + maxMarks) > cents(found.totalMarks)) {
        return { outcome: "over_total", left: cents(found.totalMarks - found.allocated) / 100, totalMarks: found.totalMarks } as const;
      }

      const inserted = await client.query(
        `INSERT INTO assessments (course_id, name, max_marks, is_lab, held_on, position)
         VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(position) FROM assessments WHERE course_id = $1), 0) + 1)
         RETURNING id, name, max_marks::float8 AS "maxMarks", is_lab AS "isLab", position, held_on::text AS date`,
        [courseId, name, maxMarks, isLab, date ?? null],
      );
      return { outcome: "ok", assessment: inserted.rows[0] } as const;
    });

    if (result.outcome === "not_found") return courseNotFound();
    if (result.outcome === "over_total") {
      return errorResponse(400, "over_total", `Only ${result.left} of ${result.totalMarks} marks are left in this course.`, {
        maxMarks: [`At most ${result.left}, or raise the course total.`],
      });
    }
    return Response.json({ assessment: result.assessment }, { status: 201 });
  } catch (error) {
    // 23505 = unique rule broken: the course already has an assessment with this name.
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_name", `This course already has "${name}".`);
    }
    throw error;
  }
}

// 7.5 → 750. Whole numbers add up exactly; decimals don't (see POST).
function cents(marks: number) {
  return Math.round(marks * 100);
}

function courseNotFound() {
  return errorResponse(404, "not_found", "Course not found.");
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
