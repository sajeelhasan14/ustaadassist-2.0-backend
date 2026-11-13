import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { z } from "zod";
import { aiIsOpenAI, answerShape, askAI, readJsonReply } from "@/lib/ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Same limits as reading a class list (POST /students/extract): a course outline is a few pages at most.
const MODEL_TIME_LIMIT_MS = 45_000;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// Accepted files, by extension (phones report file types inconsistently). Text files are read as text.
const fileTypes: Record<string, { kind: "document" | "text"; mimeType: string }> = {
  pdf: { kind: "document", mimeType: "application/pdf" },
  jpg: { kind: "document", mimeType: "image/jpeg" },
  jpeg: { kind: "document", mimeType: "image/jpeg" },
  png: { kind: "document", mimeType: "image/png" },
  webp: { kind: "document", mimeType: "image/webp" },
  heic: { kind: "document", mimeType: "image/heic" },
  heif: { kind: "document", mimeType: "image/heif" },
  txt: { kind: "text", mimeType: "" },
};

// The answer the AI must give: the topics, in teaching order. The same schema checks its reply.
const extraction = z.object({
  topics: z.array(z.string().describe("One topic of the course outline, as printed, without its number or bullet.")),
});

const instructions = `You read a university course outline (syllabus, course plan or table of contents) and list its topics.
- Return the topics in the order they will be taught, one per item.
- Keep each topic's own words. Drop numbering, bullets, week numbers, dates, marks and page numbers.
- A heading with sub-points: return the heading as one topic, unless the sub-points are clearly separate lessons.
- Ignore anything that is not a topic: course code, credit hours, objectives, books, grading, the teacher's name.
- Never invent a topic. If nothing readable is a topic, return an empty list.`;

// POST /api/v1/topics/extract: read a course's topics from a photo, scan or PDF of its outline. Nothing is saved:
// the app shows them in the topics box for the teacher to check, then saves with POST /courses/<id>/topics.
// Body: multipart/form-data with "files" (1–10).
export async function POST(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const form = await request.formData().catch(() => null);
  if (!form) return errorResponse(400, "invalid_input", "Send the files as multipart/form-data.");

  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  if (files.length === 0) return errorResponse(400, "invalid_input", "Add at least one file.");
  if (files.length > MAX_FILES) return errorResponse(400, "invalid_input", `Send at most ${MAX_FILES} files at once.`);
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    return errorResponse(400, "file_too_large", "The files are too large together (20 MB at most).");
  }

  const parts: ChatCompletionContentPart[] = [];
  for (const file of files) {
    const type = fileTypes[file.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!type) return errorResponse(400, "unsupported_file", `"${file.name}" isn't a PDF, photo or text file.`);
    // OpenAI reads PNG, JPEG, WEBP and GIF photos, not the iPhone's HEIC. Gemini reads HEIC too.
    if (type.mimeType.startsWith("image/hei") && aiIsOpenAI()) {
      return errorResponse(400, "unsupported_file", `"${file.name}" is a HEIC photo. Please share it as JPG instead.`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (type.kind === "text") {
      parts.push({ type: "text", text: `File "${file.name}":\n${bytes.toString("utf8")}` });
      continue;
    }
    const dataUrl = `data:${type.mimeType};base64,${bytes.toString("base64")}`;
    // The two companies take a PDF differently: OpenAI as a "file" part, Gemini in the image field.
    if (type.mimeType === "application/pdf" && aiIsOpenAI()) {
      parts.push({ type: "file", file: { filename: file.name, file_data: dataUrl } });
    } else {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    }
  }

  // The AI step: it only reads the files. lib/ai.ts picks the company and model and retries a busy one.
  let answer: unknown;
  try {
    const completion = await askAI(
      {
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: parts },
        ],
        response_format: answerShape("course_topics", extraction),
      },
      MODEL_TIME_LIMIT_MS,
    );
    answer = readJsonReply(completion);
  } catch (error) {
    console.error("Topic extraction failed:", error);
    return errorResponse(502, "ai_failed", "Couldn't read the file right now. Please try again.");
  }
  const parsed = extraction.safeParse(answer);
  if (!parsed.success) return errorResponse(502, "ai_failed", "Couldn't read this file. Try a clearer photo or another format.");

  // No AI from here: tidy each title, drop empty ones and repeats (same words, any capitals), keep the order.
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const raw of parsed.data.topics) {
    const title = raw.normalize("NFKC").replace(/^\s*(\d+[.)]|[-•*–])\s*/, "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    topics.push(title);
  }
  if (topics.length === 0) return errorResponse(422, "no_topics", "No topics found in this file. Try a clearer photo of the outline.");
  return Response.json({ topics });
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
