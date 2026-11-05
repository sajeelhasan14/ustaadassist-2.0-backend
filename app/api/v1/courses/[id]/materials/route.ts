import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

// What a teacher would really keep for a course. Anything else is refused, so the bucket can't hold programs.
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const materialColumns = `m.id, m.course_id AS "courseId", m.topic_id AS "topicId", m.name,
  m.mime_type AS "mimeType", m.size_bytes::float8 AS "sizeBytes", m.created_at AS "createdAt"`;

// GET /api/v1/courses/<id>/materials: the course's files, newest first. Add ?topicId=<id> for one topic's files.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/materials">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return notFound();

  const topicId = new URL(request.url).searchParams.get("topicId");
  if (topicId !== null && !z.uuid().safeParse(topicId).success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { topicId: ["Not a valid topic id."] });
  }

  if (!(await ownsCourse(courseId, teacherId))) return notFound();
  const materials = await query(
    `SELECT ${materialColumns} FROM materials m
      WHERE m.course_id = $1 AND ($2::uuid IS NULL OR m.topic_id = $2)
      ORDER BY m.created_at DESC`,
    [courseId, topicId],
  );
  return Response.json({ materials });
}

// POST /api/v1/courses/<id>/materials: upload one file. Multipart form: file, topicId? (optional)
export async function POST(request: Request, ctx: RouteContext<"/api/v1/courses/[id]/materials">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: courseId } = await ctx.params;
  if (!z.uuid().safeParse(courseId).success) return notFound();
  if (!(await ownsCourse(courseId, teacherId))) return notFound();

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { file: ["Choose a file to upload."] });
  }
  if (file.size > MAX_FILE_BYTES) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { file: ["The file must be 20 MB or smaller."] });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { file: ["Use a PDF, Word, PowerPoint, Excel, text or image file."] });
  }

  const topicId = form?.get("topicId");
  if (typeof topicId === "string" && topicId !== "") {
    const valid = z.uuid().safeParse(topicId).success;
    const [topic] = valid ? await query(`SELECT 1 AS found FROM topics WHERE id = $1 AND course_id = $2`, [topicId, courseId]) : [];
    if (!topic) return errorResponse(400, "invalid_input", "Some fields are invalid.", { topicId: ["This topic isn't in this course."] });
  }

  // The first folder must be the teacher's id: the storage policy refuses anything else.
  // A random file name, so two files called "notes.pdf" can't overwrite each other.
  const storagePath = `${teacherId}/${courseId}/${randomUUID()}`;
  const storage = storageFor(request);
  const uploaded = await storage.upload(storagePath, file, { contentType: file.type });
  if (uploaded.error) {
    console.error("Material upload failed:", uploaded.error);
    return errorResponse(502, "storage_failed", "Couldn't upload the file right now. Please try again.");
  }

  try {
    const [material] = await query(
      `WITH inserted AS (
         INSERT INTO materials (course_id, topic_id, name, storage_path, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *
       )
       SELECT ${materialColumns} FROM inserted m`,
      [courseId, typeof topicId === "string" && topicId !== "" ? topicId : null, file.name.slice(0, 255), storagePath, file.type, file.size],
    );
    return Response.json({ material }, { status: 201 });
  } catch (error) {
    // The list and the bucket must agree, so a file nobody can see is removed again.
    await storage.remove([storagePath]);
    throw error;
  }
}

// The materials bucket, acting as this teacher: their token goes with every request, so the storage policy applies.
function storageFor(request: Request) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: request.headers.get("authorization") ?? "" } },
    auth: { persistSession: false },
  });
  return client.storage.from("materials");
}

// True if this course belongs to this teacher. The JOIN to semesters is the ownership check.
async function ownsCourse(courseId: string, teacherId: string) {
  const rows = await query(
    `SELECT 1 AS found FROM courses c JOIN semesters s ON s.id = c.semester_id WHERE c.id = $1 AND s.teacher_id = $2`,
    [courseId, teacherId],
  );
  return rows.length > 0;
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
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
