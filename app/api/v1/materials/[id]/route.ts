import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// How long an "open this file" link keeps working.
const LINK_SECONDS = 600;

// What can be changed. The file itself can't: upload a new one instead.
const materialChanges = z
  .object({
    name: z.string().trim().min(1, "Name can't be empty.").max(255),
    topicId: z.uuid().nullable(),
  })
  .partial();

// GET /api/v1/materials/<id>: a link to open the file, which stops working after 10 minutes.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/materials/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const material = await findMaterial(id, teacherId);
  if (!material) return notFound();

  const link = await storageFor(request).createSignedUrl(material.storagePath, LINK_SECONDS);
  if (link.error) {
    console.error("Material link failed:", link.error);
    return errorResponse(502, "storage_failed", "Couldn't open the file right now. Please try again.");
  }
  return Response.json({ url: link.data.signedUrl, expiresInSeconds: LINK_SECONDS });
}

// PATCH /api/v1/materials/<id>: rename a file or move it to another topic. Body: { name?, topicId? }
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/materials/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = materialChanges.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { name, topicId } = parsed.data;

  const material = await findMaterial(id, teacherId);
  if (!material) return notFound();

  if (topicId) {
    const [topic] = await query(`SELECT 1 AS found FROM topics WHERE id = $1 AND course_id = $2`, [topicId, material.courseId]);
    if (!topic) return errorResponse(400, "invalid_input", "Some fields are invalid.", { topicId: ["This topic isn't in this course."] });
  }

  // COALESCE can't tell "leave it" from "clear it", so topicId carries a flag saying whether it was sent.
  const [updated] = await query(
    `UPDATE materials
        SET name = COALESCE($1, name),
            topic_id = CASE WHEN $2::boolean THEN $3::uuid ELSE topic_id END
      WHERE id = $4
      RETURNING id, course_id AS "courseId", topic_id AS "topicId", name, mime_type AS "mimeType",
                size_bytes::float8 AS "sizeBytes", created_at AS "createdAt"`,
    [name ?? null, topicId !== undefined, topicId ?? null, id],
  );
  if (!updated) return notFound();
  return Response.json({ material: updated });
}

// DELETE /api/v1/materials/<id>: remove the file from storage and from the list.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/materials/[id]">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const material = await findMaterial(id, teacherId);
  if (!material) return notFound();

  // The file goes first. If that fails, the row stays, so the teacher can see it and try again.
  const removed = await storageFor(request).remove([material.storagePath]);
  if (removed.error) {
    console.error("Material delete failed:", removed.error);
    return errorResponse(502, "storage_failed", "Couldn't delete the file right now. Please try again.");
  }
  await query(`DELETE FROM materials WHERE id = $1`, [id]);
  return new Response(null, { status: 204 });
}

// The material if it belongs to this teacher. The JOINs up to semesters are the ownership check.
async function findMaterial(id: string, teacherId: string) {
  const [material] = await query<{ storagePath: string; courseId: string }>(
    `SELECT m.storage_path AS "storagePath", m.course_id AS "courseId"
       FROM materials m
       JOIN courses c ON c.id = m.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE m.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  return material;
}

// The materials bucket, acting as this teacher: their token goes with every request, so the storage policy applies.
function storageFor(request: Request) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: request.headers.get("authorization") ?? "" } },
    auth: { persistSession: false },
  });
  return client.storage.from("materials");
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "File not found.");
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
