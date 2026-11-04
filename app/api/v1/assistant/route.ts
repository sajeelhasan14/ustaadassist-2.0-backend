import { z } from "zod";
import { createApiGet } from "@/lib/agent/api-client";
import { runAgent } from "@/lib/agent/run-agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// What a valid question looks like. The app sends the conversation so far, so nothing needs to be stored.
const question = z.object({
  message: z.string().trim().min(1, "Message is required.").max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(8000) }))
    .max(40)
    .default([]),
});

// POST /api/v1/assistant: ask the assistant something. Body: { message, history? }
// This file only handles the request. The agent itself lives in lib/agent/.
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(await isValidToken(token))) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const parsed = question.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  try {
    const api = createApiGet(new URL(request.url).origin, token);
    return Response.json(await runAgent(parsed.data.message, parsed.data.history, api));
  } catch (error) {
    console.error("Assistant failed:", error);
    return errorResponse(502, "ai_failed", "The assistant isn't available right now. Please try again.");
  }
}

async function isValidToken(token: string): Promise<boolean> {
  if (!token) return false;
  // Passing the token means cookies are ignored; only this token is checked.
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims(token);
  return Boolean(data?.claims.sub);
}

// Every API error has the same shape, so the app can handle them all the same way.
function errorResponse(status: number, code: string, message: string, fields?: object) {
  return Response.json({ error: { code, message, fields } }, { status });
}
