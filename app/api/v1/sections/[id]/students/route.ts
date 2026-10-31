import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Collapse runs of spaces ("ALI  KHAN " → "ALI KHAN"), so the same name always looks the same.
const cleanText = z.string().transform((value) => value.trim().replace(/\s+/g, " "));

// What a valid "add student" body looks like. Seat numbers are stored in capitals, so "eb24…" and "EB24…" are one student.
const newStudent = z.object({
  rollNumber: cleanText.pipe(z.string().min(1, "Seat number is required.")).transform((value) => value.toUpperCase()),
  fullName: cleanText.pipe(z.string().min(1, "Name is required.")),
  fatherName: cleanText.nullish().transform((value) => value || null),
  email: z.email("Not a valid email.").nullish().transform((value) => value ?? null),
});

type Student = { id: string; rollNumber: string; fullName: string; fatherName: string | null; email: string | null };
const studentColumns = `id, roll_number AS "rollNumber", full_name AS "fullName", father_name AS "fatherName", email`;

// GET /api/v1/sections/<id>/students: the students enrolled in one of the teacher's sections, by seat number.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/students">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  // students.teacher_id = $2 is the ownership check: another teacher's section gives an empty list.
  const students = await query(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName", st.father_name AS "fatherName", st.email
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
      WHERE e.section_id = $1 AND st.teacher_id = $2
      ORDER BY st.roll_number`,
    [sectionId, teacherId],
  );
  return Response.json({ students });
}

// POST /api/v1/sections/<id>/students: enroll a student. Body: { rollNumber, fullName, fatherName?, email? }
// If the teacher already has a student with this seat number (e.g. in another section), that student is reused.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/students">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const parsed = newStudent.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { rollNumber, fullName, fatherName, email } = parsed.data;

  // Find-or-create the student and enroll them as one all-or-nothing unit.
  const result = await withTransaction(async (client) => {
    const section = await client.query(
      `SELECT sec.id FROM sections sec
         JOIN courses c ON c.id = sec.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE sec.id = $1 AND s.teacher_id = $2`,
      [sectionId, teacherId],
    );
    if (section.rowCount === 0) return { outcome: "section_not_found" } as const;

    // ON CONFLICT DO NOTHING: if the seat number is already taken, insert nothing (and return no row) instead of failing.
    const inserted = await client.query<Student>(
      `INSERT INTO students (teacher_id, roll_number, full_name, father_name, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (teacher_id, roll_number) DO NOTHING
       RETURNING ${studentColumns}`,
      [teacherId, rollNumber, fullName, fatherName, email],
    );
    let student = inserted.rows[0];
    const created = Boolean(student);

    if (!student) {
      const existing = await client.query<Student>(
        `SELECT ${studentColumns} FROM students WHERE teacher_id = $1 AND roll_number = $2`,
        [teacherId, rollNumber],
      );
      student = existing.rows[0];
      // Same seat number but a different name is almost always a typo in the list: stop and let the teacher decide.
      if (student.fullName.toUpperCase() !== fullName.toUpperCase()) {
        return { outcome: "seat_number_taken", student } as const;
      }

      // A student sits in only one section of a course: refuse if they're already in another section of this course.
      const otherSection = await client.query<{ name: string }>(
        `SELECT other.name
           FROM enrollments e
           JOIN sections other ON other.id = e.section_id
           JOIN sections this ON this.id = $1
          WHERE e.student_id = $2 AND other.course_id = this.course_id AND other.id <> this.id`,
        [sectionId, student.id],
      );
      if (otherSection.rows[0]) {
        return { outcome: "in_other_section", student, sectionName: otherSection.rows[0].name } as const;
      }
    }

    const enrolled = await client.query(
      `INSERT INTO enrollments (section_id, student_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING student_id`,
      [sectionId, student.id],
    );
    if (enrolled.rowCount === 0) return { outcome: "already_enrolled", student } as const;

    return { outcome: "ok", student, created } as const;
  });

  if (result.outcome === "section_not_found") return sectionNotFound();
  if (result.outcome === "seat_number_taken") {
    return errorResponse(409, "seat_number_taken", `Seat number ${rollNumber} already belongs to ${result.student.fullName}.`, {
      existingStudent: result.student,
    });
  }
  if (result.outcome === "in_other_section") {
    return errorResponse(409, "in_other_section", `${result.student.fullName} is already in section ${result.sectionName} of this course.`);
  }
  if (result.outcome === "already_enrolled") {
    return errorResponse(409, "already_enrolled", `${result.student.fullName} is already in this section.`);
  }
  // created = false means an existing student (from another section) was reused.
  return Response.json({ student: result.student, created: result.created }, { status: 201 });
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
