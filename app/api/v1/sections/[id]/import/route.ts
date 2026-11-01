import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// A class list is rarely over 100 students; this only stops absurd requests.
const MAX_STUDENTS = 500;

// Collapse runs of spaces ("ALI  KHAN " → "ALI KHAN"), so the same name always looks the same.
const cleanText = z.string().transform((value) => value.trim().replace(/\s+/g, " "));

// The rows the teacher confirmed in the preview of POST /students/extract. Seat numbers are stored in capitals.
const importBody = z.object({
  students: z
    .array(
      z.object({
        rollNumber: cleanText.pipe(z.string().min(1, "Seat number is required.")).transform((value) => value.toUpperCase()),
        fullName: cleanText.pipe(z.string().min(1, "Name is required.")),
        fatherName: cleanText.nullish().transform((value) => value || null),
      }),
    )
    .min(1, "Add at least one student.")
    .max(MAX_STUDENTS, `At most ${MAX_STUDENTS} students at once.`),
});

// POST /api/v1/sections/<id>/import: save every confirmed row at once. Body: { students: [{ rollNumber, fullName, fatherName? }] }
// All or nothing: if one seat number already belongs to a different name, nothing is saved.
// Students already in this course (this section or another) are skipped and listed, not treated as errors.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/import">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const parsed = importBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // path is like ["students", 4, "fullName"]: report it as row 5 so the teacher can find it in the list.
    const problems = parsed.error.issues.map((issue) => ({
      row: typeof issue.path[1] === "number" ? issue.path[1] + 1 : null,
      field: issue.path[2] ?? issue.path[0] ?? null,
      message: issue.message,
    }));
    return errorResponse(400, "invalid_input", "Some rows are invalid.", { problems });
  }
  const rows = parsed.data.students;

  // The same seat number twice is two people on one seat (or one person twice): the teacher must fix it first.
  const seatNumbers = rows.map((row) => row.rollNumber);
  const repeated = [...new Set(seatNumbers.filter((seat, index) => seatNumbers.indexOf(seat) !== index))];
  if (repeated.length > 0) {
    return errorResponse(400, "duplicate_in_list", `Seat number ${repeated[0]} appears more than once.`, { rollNumbers: repeated });
  }

  const result = await withTransaction(async (client) => {
    const section = await client.query<{ courseId: string }>(
      `SELECT sec.course_id AS "courseId"
         FROM sections sec
         JOIN courses c ON c.id = sec.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE sec.id = $1 AND s.teacher_id = $2`,
      [sectionId, teacherId],
    );
    if (section.rowCount === 0) return { outcome: "section_not_found" } as const;

    // Which of these seat numbers the teacher already has, and which section of THIS course each one is in.
    // A student sits in only one section of a course, so the LEFT JOIN finds at most one.
    const existing = await client.query<{ rollNumber: string; fullName: string; sectionId: string | null; sectionName: string | null }>(
      `SELECT st.roll_number AS "rollNumber", st.full_name AS "fullName", sec.id AS "sectionId", sec.name AS "sectionName"
         FROM students st
         LEFT JOIN (enrollments e JOIN sections sec ON sec.id = e.section_id AND sec.course_id = $3)
                ON e.student_id = st.id
        WHERE st.teacher_id = $1 AND st.roll_number = ANY($2::text[])`,
      [teacherId, seatNumbers, section.rows[0].courseId],
    );
    const bySeatNumber = new Map(existing.rows.map((student) => [student.rollNumber, student]));

    // Same seat number, different name: almost always a typo in the list. Stop before writing anything.
    const conflicts = rows
      .filter((row) => {
        const found = bySeatNumber.get(row.rollNumber);
        return found && found.fullName.toUpperCase() !== row.fullName.toUpperCase();
      })
      .map((row) => ({ ...row, existingName: bySeatNumber.get(row.rollNumber)!.fullName }));
    if (conflicts.length > 0) return { outcome: "seat_number_taken", conflicts } as const;

    // Already in this course: nothing to do for them. Everyone else gets added.
    const skipped = [];
    const toAdd = [];
    for (const row of rows) {
      const found = bySeatNumber.get(row.rollNumber);
      if (found?.sectionId === sectionId) {
        skipped.push({ ...row, reason: "already_enrolled", message: "Already in this section." });
      } else if (found?.sectionId) {
        skipped.push({ ...row, reason: "in_other_section", message: `Already in section ${found.sectionName} of this course.` });
      } else {
        toAdd.push(row);
      }
    }

    // Create all new students in one statement: unnest turns the three lists into rows (one per student).
    // Students the teacher already has (from another course) hit ON CONFLICT and are left as they are.
    const created = await client.query(
      `INSERT INTO students (teacher_id, roll_number, full_name, father_name)
       SELECT $1::uuid, roll_number, full_name, father_name
         FROM unnest($2::text[], $3::text[], $4::text[]) AS list(roll_number, full_name, father_name)
       ON CONFLICT (teacher_id, roll_number) DO NOTHING`,
      [teacherId, toAdd.map((row) => row.rollNumber), toAdd.map((row) => row.fullName), toAdd.map((row) => row.fatherName)],
    );

    // Enroll new and reused students together, found by seat number.
    const enrolled = await client.query(
      `INSERT INTO enrollments (section_id, student_id)
       SELECT $1::uuid, id FROM students WHERE teacher_id = $2 AND roll_number = ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [sectionId, teacherId, toAdd.map((row) => row.rollNumber)],
    );

    return { outcome: "ok", added: enrolled.rowCount ?? 0, created: created.rowCount ?? 0, skipped } as const;
  });

  if (result.outcome === "section_not_found") return sectionNotFound();
  if (result.outcome === "seat_number_taken") {
    const first = result.conflicts[0];
    return errorResponse(
      409,
      "seat_number_taken",
      `Seat number ${first.rollNumber} already belongs to ${first.existingName}. Nothing was saved.`,
      { conflicts: result.conflicts },
    );
  }
  // reused = students the teacher already had from another course, now also in this section.
  return Response.json({
    added: result.added,
    created: result.created,
    reused: result.added - result.created,
    skipped: result.skipped,
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
