import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// classesNeeded: how many classes the topic takes (default 1). The planner uses it.
const newTopic = z.object({
  title: z.string().trim().min(1, "Title is required."),
  classesNeeded: z.int().min(1).max(50).default(1),
});

// A whole outline at once, pasted in one go. spreadOver = the classes available, shared out across the topics.
const newTopics = z.object({
  titles: z.array(z.string().trim().min(1, "A topic can't be empty.").max(300)).min(1).max(100),
  spreadOver: z.int().min(1).max(1000).optional(),
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
    `SELECT t.id, t.title, t.position, t.classes_needed AS "classesNeeded"
       FROM topics t
       JOIN courses c ON c.id = t.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE t.course_id = $1 AND s.teacher_id = $2
      ORDER BY t.position`,
    [courseId, teacherId],
  );
  return Response.json({ topics });
}

// POST /api/v1/courses/<id>/topics: add to the end of the outline.
// Body: { title, classesNeeded? } for one topic, or { titles, spreadOver? } for many at once.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/topics">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return courseNotFound();

  const body = await request.json().catch(() => null);

  // Many topics: one statement, so they're all saved or none are.
  if (body?.titles !== undefined) {
    const many = newTopics.safeParse(body);
    if (!many.success) {
      return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(many.error).fieldErrors);
    }
    const { titles, spreadOver } = many.data;
    // 32 classes over 10 topics: every topic gets 3, and the first 2 get one more. Never less than 1.
    const each = Math.floor((spreadOver ?? 0) / titles.length);
    const extra = (spreadOver ?? 0) % titles.length;
    const classes = titles.map((_, index) => Math.min(50, Math.max(1, each + (index < extra ? 1 : 0))));

    // WITH ORDINALITY numbers the rows 1, 2, 3…, which keeps the pasted order.
    const added = await query<{ position: number }>(
      `INSERT INTO topics (course_id, title, position, classes_needed)
       SELECT c.id, item.title, (SELECT COALESCE(MAX(position), 0) FROM topics WHERE course_id = c.id) + item.number, item.classes
         FROM courses c
         JOIN semesters s ON s.id = c.semester_id
        CROSS JOIN unnest($2::text[], $3::int[]) WITH ORDINALITY AS item(title, classes, number)
        WHERE c.id = $1 AND s.teacher_id = $4
       RETURNING id, title, position, classes_needed AS "classesNeeded"`,
      [courseId, titles, classes, teacherId],
    );
    if (added.length === 0) return courseNotFound();
    return Response.json({ topics: added.sort((a, b) => a.position - b.position) }, { status: 201 });
  }

  const parsed = newTopic.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  // Inserted only if the course belongs to this teacher; position = last position + 1 (or 1 if empty).
  const [topic] = await query(
    `INSERT INTO topics (course_id, title, position, classes_needed)
     SELECT c.id, $2, COALESCE((SELECT MAX(position) FROM topics WHERE course_id = c.id), 0) + 1, $4
       FROM courses c
       JOIN semesters s ON s.id = c.semester_id
      WHERE c.id = $1 AND s.teacher_id = $3
     RETURNING id, title, position, classes_needed AS "classesNeeded"`,
    [courseId, parsed.data.title, teacherId, parsed.data.classesNeeded],
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
    `SELECT id, title, position, classes_needed AS "classesNeeded" FROM topics WHERE course_id = $1 ORDER BY position`,
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
