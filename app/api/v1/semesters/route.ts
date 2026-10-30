import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid "create semester" body looks like.
const newSemester = z
  .object({
    name: z.string().trim().min(1, "Name is required."),
    startDate: z.iso.date("Use the format YYYY-MM-DD."),
    endDate: z.iso.date("Use the format YYYY-MM-DD."),
  })
  .refine((s) => s.endDate >= s.startDate, {
    message: "End date must be on or after the start date.",
    path: ["endDate"],
  });

// GET /api/v1/semesters: the teacher's semesters, newest first.
export async function GET(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const semesters = await query(
    `SELECT id, name, start_date::text AS "startDate", end_date::text AS "endDate"
       FROM semesters
      WHERE teacher_id = $1
      ORDER BY start_date DESC`,
    [teacherId],
  );
  return Response.json({ semesters });
}

// POST /api/v1/semesters: create a semester. Body: { name, startDate, endDate }
export async function POST(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const parsed = newSemester.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, startDate, endDate } = parsed.data;

  try {
    const [semester] = await query(
      `INSERT INTO semesters (teacher_id, name, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, start_date::text AS "startDate", end_date::text AS "endDate"`,
      [teacherId, name, startDate, endDate],
    );
    return Response.json({ semester }, { status: 201 });
  } catch (error) {
    // 23505 = Postgres "unique rule broken": this teacher already has a semester with this name.
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_name", `You already have a semester called "${name}".`);
    }
    throw error;
  }
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
