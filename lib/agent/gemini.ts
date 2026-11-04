import "server-only";
import { GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type GenerateContentResponse } from "@google/genai";

// Tried in order. If one is overloaded, out of quota, too slow or unreachable, the next one is used.
// 3.5 comes first here because the newer models were often busy in testing, and a teacher is waiting for a reply.
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash"];
const MODEL_TIME_LIMIT_MS = 30_000;

// One round with Gemini: it reads the conversation and either answers or asks for tools.
export async function askGemini(
  contents: Content[],
  systemInstruction: string,
  functionDeclarations: FunctionDeclaration[],
): Promise<GenerateContentResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  for (const model of GEMINI_MODELS) {
    try {
      return await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations }],
          // Choosing a tool needs little reasoning; low thinking answers much faster.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: AbortSignal.timeout(MODEL_TIME_LIMIT_MS),
        },
      });
    } catch (error) {
      // A bad request (400) or a bad key (401/403) would fail on every model, so stop here.
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 401 || status === 403) throw error;
      console.warn(`Gemini model ${model} failed (${status ?? (error as Error).name}), trying the next one.`);
    }
  }
  throw new Error("Every Gemini model failed.");
}
