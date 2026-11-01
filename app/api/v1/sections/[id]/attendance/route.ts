import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/v1/sections/<id>/attendance?min=75: each student's attendance in this section.
// percentage = present ÷ classes the student was marked in (so a student who joined late isn't counted absent
// for classes before they joined). shortage = below `min` percent (default 75).
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/attendance">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const min = z.coerce.number().min(0).max(100).catch(75).parse(new URL(request.url).searchParams.get("min") ?? 75);

  const [section] = await query<{ held: number }>(
    `SELECT (SELECT count(*) FROM class_sessions WHERE section_id = sec.id AND status = 'held')::int AS held
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!section) return sectionNotFound();

  // Only marks from held classes count (a class cancelled after marking keeps its rows, but they're ignored).
  const rows = await query<{ id: string; rollNumber: string; fullName: string; present: number; marked: number }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName",
            count(a.student_id) FILTER (WHERE a.present)::int AS present,
            count(a.student_id)::int AS marked
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       LEFT JOIN (attendance a JOIN class_sessions cs ON cs.id = a.session_id AND cs.status = 'held')
              ON a.student_id = st.id AND cs.section_id = e.section_id
      WHERE e.section_id = $1
      GROUP BY st.id
      ORDER BY st.roll_number`,
    [sectionId],
  );

  const students = rows.map((row) => {
    // One decimal place: 13 of 15 → 86.7. null when no class has been marked yet.
    const percentage = row.marked > 0 ? Math.round((row.present / row.marked) * 1000) / 10 : null;
    return { ...row, percentage, shortage: percentage !== null && percentage < min };
  });
  return Response.json({ held: section.held, min, students });
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
