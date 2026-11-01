import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Collapse runs of spaces ("ALI  KHAN " → "ALI KHAN"), so the same name always looks the same.
const cleanText = z.string().transform((value) => value.trim().replace(/\s+/g, " "));

// What a valid "edit student" body looks like. Every field is optional; send only what changes.
// fatherName and email can be set to null to clear them.
const studentChanges = z
  .object({
    rollNumber: cleanText.pipe(z.string().min(1, "Seat number can't be empty.")).transform((value) => value.toUpperCase()),
    fullName: cleanText.pipe(z.string().min(1, "Name can't be empty.")),
    fatherName: cleanText.nullable().transform((value) => value || null),
    email: z.email("Not a valid email.").nullable(),
  })
  .partial();

// PATCH /api/v1/students/<id>: fix a student's seat number, name, father's name or email.
// The change shows in every section the student is in, because there is only one row per student.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/students/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = studentChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { rollNumber, fullName, fatherName, email } = parsed.data;

  try {
    // COALESCE keeps the old value when a field isn't sent. That can't clear a value (null would mean "keep"),
    // so fatherName and email use CASE with a "was it sent?" flag instead.
    const [student] = await query(
      `UPDATE students
          SET roll_number = COALESCE($1, roll_number),
              full_name = COALESCE($2, full_name),
              father_name = CASE WHEN $3 THEN $4 ELSE father_name END,
              email = CASE WHEN $5 THEN $6 ELSE email END
        WHERE id = $7 AND teacher_id = $8
        RETURNING id, roll_number AS "rollNumber", full_name AS "fullName", father_name AS "fatherName", email`,
      [rollNumber ?? null, fullName ?? null, fatherName !== undefined, fatherName ?? null, email !== undefined, email ?? null, id, teacherId],
    );
    if (!student) return notFound();
    return Response.json({ student });
  } catch (error) {
    // 23505 = unique rule broken: another of your students already has this seat number.
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "seat_number_taken", `Another of your students already has seat number ${rollNumber}.`);
    }
    throw error;
  }
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Student not found.");
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
