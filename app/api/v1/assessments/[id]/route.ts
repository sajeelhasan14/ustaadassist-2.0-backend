import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Every field is optional; send only what changes.
const assessmentChanges = z
  .object({
    name: z.string().trim().min(1, "Name can't be empty.").max(100),
    maxMarks: z.number().positive("Must be more than 0.").max(1000),
  })
  .partial();

// PATCH /api/v1/assessments/<id>: rename an assessment or change its max marks.
// maxMarks can't push the course over its total, or go below a mark that's already entered.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = assessmentChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, maxMarks } = parsed.data;

  try {
    const result = await withTransaction(async (client) => {
      // Lock the course row (as in POST), so the allocation check can't race another change.
      const current = await client.query<{ maxMarks: number; totalMarks: number; allocated: number; highestMark: number | null }>(
        `SELECT a.max_marks::float8 AS "maxMarks", c.total_marks::float8 AS "totalMarks",
                (SELECT SUM(max_marks) FROM assessments WHERE course_id = c.id)::float8 AS allocated,
                (SELECT MAX(marks) FROM marks WHERE assessment_id = a.id)::float8 AS "highestMark"
           FROM assessments a
           JOIN courses c ON c.id = a.course_id
           JOIN semesters s ON s.id = c.semester_id
          WHERE a.id = $1 AND s.teacher_id = $2
          FOR UPDATE OF c`,
        [id, teacherId],
      );
      const found = current.rows[0];
      if (!found) return { outcome: "not_found" } as const;
      if (maxMarks !== undefined) {
        // In hundredths, so decimals add up exactly (33.3 + 33.3 + 33.4 = 100, not 100.00000000000001).
        const left = (cents(found.totalMarks) - cents(found.allocated) + cents(found.maxMarks)) / 100;
        if (cents(maxMarks) > cents(left)) return { outcome: "over_total", left, totalMarks: found.totalMarks } as const;
        if (found.highestMark !== null && maxMarks < found.highestMark) {
          return { outcome: "below_marks", highestMark: found.highestMark } as const;
        }
      }

      const updated = await client.query(
        `UPDATE assessments SET name = COALESCE($1, name), max_marks = COALESCE($2, max_marks)
          WHERE id = $3
          RETURNING id, name, max_marks::float8 AS "maxMarks", position`,
        [name ?? null, maxMarks ?? null, id],
      );
      return { outcome: "ok", assessment: updated.rows[0] } as const;
    });

    if (result.outcome === "not_found") return notFound();
    if (result.outcome === "over_total") {
      return errorResponse(400, "over_total", `This assessment can be worth at most ${result.left} of ${result.totalMarks} marks.`, {
        maxMarks: [`At most ${result.left}, or raise the course total.`],
      });
    }
    if (result.outcome === "below_marks") {
      return errorResponse(400, "below_marks", `A student already has ${result.highestMark} marks in this assessment.`, {
        maxMarks: [`Must be at least ${result.highestMark}.`],
      });
    }
    return Response.json({ assessment: result.assessment });
  } catch (error) {
    // 23505 = unique rule broken: the course already has an assessment with this name.
    if ((error as { code?: string }).code === "23505") {
      return errorResponse(409, "duplicate_name", `This course already has "${name}".`);
    }
    throw error;
  }
}

// DELETE /api/v1/assessments/<id>: remove an assessment and every mark entered for it.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const deleted = await query(
    `DELETE FROM assessments a
      USING courses c, semesters s
      WHERE a.id = $1 AND c.id = a.course_id AND s.id = c.semester_id AND s.teacher_id = $2
      RETURNING a.id`,
    [id, teacherId],
  );
  if (deleted.length === 0) return notFound();
  return new Response(null, { status: 204 });
}

// 7.5 → 750. Whole numbers add up exactly; decimals don't.
function cents(marks: number) {
  return Math.round(marks * 100);
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
