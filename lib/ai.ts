import "server-only";
import OpenAI, { APIError } from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { ResponseFormatJSONSchema } from "openai/resources/shared";
import { z } from "zod";

// Every AI feature asks through here, in OpenAI's format. Which company answers is set in .env.local, not in code:
//   Gemini: AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/  and a Gemini key
//   OpenAI: leave AI_BASE_URL empty                                                and an OpenAI key
// AI_MODELS is a comma list, tried in order: if one is busy, out of quota or too slow, the next one is used.

const MODEL_TIME_LIMIT_MS = 30_000;

export type AIRequest = Omit<ChatCompletionCreateParamsNonStreaming, "model">;

// An empty AI_BASE_URL means OpenAI itself. The few things that differ between the companies check this.
export function aiIsOpenAI(): boolean {
  return !process.env.AI_BASE_URL;
}

// The fixed answer shape the AI must fill in, from a Zod schema. The same Zod schema then checks the reply.
// strict: the AI must follow the shape exactly (every field present, nothing extra).
export function answerShape(name: string, schema: z.ZodType): ResponseFormatJSONSchema {
  const { $schema, ...shape } = z.toJSONSchema(schema); // $schema is only a label; the AI needs the shape
  void $schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: shape } };
}

export async function askAI(request: AIRequest, timeLimitMs = MODEL_TIME_LIMIT_MS): Promise<ChatCompletion> {
  // Made here, not when the file loads, so a missing key fails one request instead of the whole build.
  const client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || undefined,
    maxRetries: 1,
  });
  const models = (process.env.AI_MODELS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("AI_MODELS is empty in .env.local.");

  // OpenAI only. store: false keeps questions and answers (student data) out of the key owner's OpenAI console Logs
  // (Gemini rejects this field with a 400). And OpenAI's newer models allow tools in this format only with reasoning
  // off, so the assistant asks with "none" there.
  const openAIOnly = aiIsOpenAI() ? { store: false, ...(request.tools ? { reasoning_effort: "none" as const } : {}) } : {};

  for (const model of models) {
    try {
      // Low reasoning effort unless the route asks for more: picking a tool or copying a list needs little thinking.
      return await client.chat.completions.create(
        { reasoning_effort: "low", ...request, ...openAIOnly, model },
        { timeout: timeLimitMs },
      );
    } catch (error) {
      // A bad request (400) or a bad key (401/403) would fail on every model, so stop here.
      const status = error instanceof APIError ? error.status : undefined;
      if (status === 400 || status === 401 || status === 403) throw error;
      console.warn(`AI model ${model} failed (${status ?? (error as Error).name}), trying the next one.`);
    }
  }
  throw new Error("Every AI model failed.");
}

// The reply's text, read as JSON. Used with answerShape; the caller still checks it with its Zod schema.
export function readJsonReply(completion: ChatCompletion): unknown {
  return JSON.parse(completion.choices[0]?.message.content ?? "");
}
