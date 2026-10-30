import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const newTopic = z.object({
  title: z.string().trim().min(1, "Title is required."),
});

// The complete outline in its new order: every topic id of the course, each exactly once.
const newOrder = z.object({
  topicIds: z.array(z.uuid("Each item must be a topic id.")),
});

// GET /api/v1/courses/<id>/topics: the course outline, in teaching order.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/topics">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return courseNotFound();

  // topic → course → semester → teacher: the joins are the ownership check.
  const topics = await query(
    `SELECT t.id, t.title, t.position
       FROM topics t
       JOIN courses c ON c.id = t.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE t.course_id = $1 AND s.teacher_id = $2
      ORDER BY t.position`,
    [courseId, teacherId],
  );
  return Response.json({ topics });
}

// POST /api/v1/courses/<id>/topics: add a topic at the end of the outline. Body: { title }
export async function POST(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/topics">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return courseNotFound();

  const parsed = newTopic.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  // Inserted only if the course belongs to this teacher; position = last position + 1 (or 1 if empty).
  const [topic] = await query(
    `INSERT INTO topics (course_id, title, position)
     SELECT c.id, $2, COALESCE((SELECT MAX(position) FROM topics WHERE course_id = c.id), 0) + 1
       FROM courses c
       JOIN semesters s ON s.id = c.semester_id
      WHERE c.id = $1 AND s.teacher_id = $3
     RETURNING id, title, position`,
    [courseId, parsed.data.title, teacherId],
  );
  if (!topic) return courseNotFound();
  return Response.json({ topic }, { status: 201 });
}

// PUT /api/v1/courses/<id>/topics: reorder the outline. Body: { topicIds: [all topic ids, in the new order] }
export async function PUT(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/topics">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return courseNotFound();

  const parsed = newOrder.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { topicIds } = parsed.data;

  // Check and update as one all-or-nothing unit, on one connection.
  const result = await withTransaction(async (client) => {
    const course = await client.query(
      `SELECT c.id FROM courses c JOIN semesters s ON s.id = c.semester_id
        WHERE c.id = $1 AND s.teacher_id = $2`,
      [courseId, teacherId],
    );
    if (course.rowCount === 0) return "course_not_found";

    // FOR UPDATE locks these rows until we finish, so no topic can be added or removed meanwhile.
    const current = await client.query<{ id: string }>(
      "SELECT id FROM topics WHERE course_id = $1 FOR UPDATE",
      [courseId],
    );
    const currentIds = new Set(current.rows.map((row) => row.id));
    const sameTopics =
      topicIds.length === currentIds.size &&
      new Set(topicIds).size === topicIds.length &&
      topicIds.every((id) => currentIds.has(id));
    if (!sameTopics) return "wrong_topics";

    // unnest ... WITH ORDINALITY turns [idA, idB, ...] into rows (idA, 1), (idB, 2), ... ; one UPDATE sets them all.
    await client.query(
      `UPDATE topics t
          SET position = o.position
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
        WHERE t.id = o.id`,
      [topicIds],
    );
    return "ok";
  });

  if (result === "course_not_found") return courseNotFound();
  if (result === "wrong_topics") {
    return errorResponse(400, "invalid_input", "Send every topic of this course exactly once, in the new order.", {
      topicIds: ["Must contain every topic id of this course exactly once."],
    });
  }

  const topics = await query(
    "SELECT id, title, position FROM topics WHERE course_id = $1 ORDER BY position",
    [courseId],
  );
  return Response.json({ topics });
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
