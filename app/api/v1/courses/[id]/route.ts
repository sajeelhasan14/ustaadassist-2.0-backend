import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "edit course" body looks like. Send only what changes.
const courseChanges = z
  .object({
    code: z.string().trim().min(1, "Code can't be empty."),
    title: z.string().trim().min(1, "Title can't be empty."),
    totalMarks: z.number().positive().max(1000),
    creditHours: z.string().trim().min(1, "Credit hours can't be empty.").max(10),
    // Printed at the top of the result sheet. Sent as a whole; every line is optional.
    resultHeader: z.object({
      university: z.string().trim().max(200).optional(),
      examination: z.string().trim().max(200).optional(),
      faculty: z.string().trim().max(200).optional(),
      programme: z.string().trim().max(200).optional(),
      department: z.string().trim().max(200).optional(),
      majorDepartment: z.string().trim().max(200).optional(),
      className: z.string().trim().max(200).optional(),
      year: z.string().trim().max(50).optional(),
      semester: z.string().trim().max(50).optional(),
      examDate: z.string().trim().max(100).optional(),
    }),
  })
  .partial();

// PATCH /api/v1/courses/<id>: change a course's code, title and/or total marks.
// The total can't go below the marks already given to its assessments.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/courses/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = courseChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { code, title, totalMarks, creditHours, resultHeader } = parsed.data;

  if (totalMarks !== undefined) {
    const [course] = await query<{ allocated: number }>(
      `SELECT (SELECT COALESCE(SUM(max_marks), 0) FROM assessments WHERE course_id = c.id)::float8 AS allocated
         FROM courses c JOIN semesters s ON s.id = c.semester_id
        WHERE c.id = $1 AND s.teacher_id = $2`,
      [id, teacherId],
    );
    if (!course) return notFound();
    // Compared in hundredths, so decimal marks add up exactly.
    if (Math.round(totalMarks * 100) < Math.round(course.allocated * 100)) {
      return errorResponse(400, "below_allocated", `The assessments already add up to ${course.allocated} marks.`, {
        totalMarks: [`Must be at least ${course.allocated}.`],
      });
    }
  }

  try {
    // UPDATE ... FROM semesters: only changes the course if its semester belongs to this teacher.
    const [course] = await query(
      `UPDATE courses c
          SET code = COALESCE($1, c.code),
              title = COALESCE($2, c.title),
              total_marks = COALESCE($5, c.total_marks),
              credit_hours = COALESCE($6, c.credit_hours),
              result_header = COALESCE($7::jsonb, c.result_header)
         FROM semesters s
        WHERE c.id = $3 AND s.id = c.semester_id AND s.teacher_id = $4
        RETURNING c.id, c.semester_id AS "semesterId", c.code, c.title, c.total_marks::float8 AS "totalMarks",
                  c.credit_hours AS "creditHours", c.result_header AS "resultHeader"`,
      [code ?? null, title ?? null, id, teacherId, totalMarks ?? null, creditHours ?? null, resultHeader ? JSON.stringify(resultHeader) : null],
    );
    if (!course) return notFound();
    return Response.json({ course });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_code", `This semester already has a course with code "${code}".`);
    }
    throw error;
  }
}

// DELETE /api/v1/courses/<id>: delete a course. Its sections and topics go with it.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/courses/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // DELETE ... USING semesters: only deletes the course if its semester belongs to this teacher.
  const deleted = await query(
    `DELETE FROM courses c
      USING semesters s
      WHERE c.id = $1 AND s.id = c.semester_id AND s.teacher_id = $2
      RETURNING c.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
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
