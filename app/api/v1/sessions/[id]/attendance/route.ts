import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Only the absent students are sent: everyone else in the section is present. Most classes need 0–5 taps.
const attendanceBody = z.object({
  absent: z.array(z.uuid("Not a valid student id.")).max(500),
});

// GET /api/v1/sessions/<id>/attendance: the section's students with their mark for this class.
// Not marked yet → everyone shows as present (marked: false), so the teacher only taps the absent ones.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sessions/[id]/attendance">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sessionId } = await ctx.params;
  if (!z.uuid().safeParse(sessionId).success) return notFound();

  const [session] = await query<{ sectionId: string; status: string }>(
    `SELECT cs.section_id AS "sectionId", cs.status
       FROM class_sessions cs
       JOIN sections sec ON sec.id = cs.section_id
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE cs.id = $1 AND s.teacher_id = $2`,
    [sessionId, teacherId],
  );
  if (!session) return notFound();

  // COALESCE(a.present, true): no mark yet means "present" as the suggestion.
  const students = await query(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName", COALESCE(a.present, true) AS present
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       LEFT JOIN attendance a ON a.session_id = $1 AND a.student_id = st.id
      WHERE e.section_id = $2
      ORDER BY st.roll_number`,
    [sessionId, session.sectionId],
  );
  return Response.json({ marked: session.status === "held", students });
}

// PUT /api/v1/sessions/<id>/attendance: save this class's attendance. Body: { absent: [studentId, ...] }
// Replaces any earlier marks for the class, and the class becomes "held".
export async function PUT(request: Request, ctx: RouteContext<"/api/v1/sessions/[id]/attendance">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sessionId } = await ctx.params;
  if (!z.uuid().safeParse(sessionId).success) return notFound();

  const parsed = attendanceBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const absent = [...new Set(parsed.data.absent)];

  // "Today" at the university (Karachi), as YYYY-MM-DD. en-CA happens to format dates that way.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

  const result = await withTransaction(async (client) => {
    // FOR UPDATE: if the same class is saved twice at once, the second save waits for the first to finish.
    const session = await client.query<{ sectionId: string; date: string; status: string }>(
      `SELECT cs.section_id AS "sectionId", cs.date::text AS date, cs.status
         FROM class_sessions cs
         JOIN sections sec ON sec.id = cs.section_id
         JOIN courses c ON c.id = sec.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE cs.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF cs`,
      [sessionId, teacherId],
    );
    const found = session.rows[0];
    if (!found) return { outcome: "not_found" } as const;
    if (found.status === "cancelled") return { outcome: "cancelled" } as const;
    if (found.date > today) return { outcome: "future" } as const;

    // Every absent id must be a student of this section.
    const enrolled = await client.query<{ studentId: string }>(
      `SELECT student_id AS "studentId" FROM enrollments WHERE section_id = $1`,
      [found.sectionId],
    );
    const enrolledIds = new Set(enrolled.rows.map((row) => row.studentId));
    const unknown = absent.filter((studentId) => !enrolledIds.has(studentId));
    if (unknown.length > 0) return { outcome: "unknown_students", unknown } as const;

    // Replace the old marks: one row per enrolled student, present unless their id is in the absent list.
    await client.query("DELETE FROM attendance WHERE session_id = $1", [sessionId]);
    await client.query(
      `INSERT INTO attendance (session_id, student_id, present)
       SELECT $1, student_id, NOT (student_id = ANY($3::uuid[])) FROM enrollments WHERE section_id = $2`,
      [sessionId, found.sectionId, absent],
    );
    await client.query("UPDATE class_sessions SET status = 'held' WHERE id = $1", [sessionId]);
    return { outcome: "ok", present: enrolledIds.size - absent.length, absent: absent.length } as const;
  });

  if (result.outcome === "not_found") return notFound();
  if (result.outcome === "cancelled") return errorResponse(409, "class_cancelled", "This class is cancelled. Un-cancel it first.");
  if (result.outcome === "future") return errorResponse(400, "future_class", "This class hasn't happened yet.");
  if (result.outcome === "unknown_students") {
    return errorResponse(400, "invalid_input", "Some absent students aren't in this section.", { absent: result.unknown });
  }
  return Response.json({ present: result.present, absent: result.absent });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Class not found.");
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
