import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
