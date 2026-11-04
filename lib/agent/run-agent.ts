import type { Content, FunctionCall, FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { askGemini } from "./gemini";
import { buildInstructions } from "./instructions";
import { tools } from "./tools";
import type { ApiGet } from "./types";

// Limits, so a confused agent can't loop forever or keep the teacher waiting.
const MAX_ROUNDS = 6;
const RUN_TIME_LIMIT_MS = 90_000;
const GAVE_UP_REPLY = "Sorry, that took too long. Please try asking in a simpler way.";

export type ChatMessage = { role: "user" | "assistant"; text: string };

// The tool list in the form Gemini reads. It sees the descriptions, never the code.
const declarations: FunctionDeclaration[] = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parametersJsonSchema: z.toJSONSchema(tool.input),
}));

// The agent: ask Gemini, run the tools it wants, give it the results, and repeat until it answers.
export async function runAgent(message: string, history: ChatMessage[], api: ApiGet) {
  // "Today" at the university (Karachi), as YYYY-MM-DD. en-CA happens to format dates that way.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const instructions = buildInstructions(today);

  const contents: Content[] = [
    ...history.map((turn) => ({ role: turn.role === "user" ? "user" : "model", parts: [{ text: turn.text }] })),
    { role: "user", parts: [{ text: message }] },
  ];
  const toolsUsed: string[] = [];
  const deadline = Date.now() + RUN_TIME_LIMIT_MS;

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round++) {
    const response = await askGemini(contents, instructions, declarations);
    const calls = response.functionCalls ?? [];

    // No tool requested: this is the final answer.
    if (calls.length === 0) return { reply: response.text?.trim() || GAVE_UP_REPLY, toolsUsed };

    // Keep Gemini's own turn exactly as it was sent, then add the results of the tools it asked for.
    contents.push(response.candidates![0].content!);
    const results = await Promise.all(calls.map((call) => runTool(call, api)));
    contents.push({ role: "user", parts: results.map((functionResponse) => ({ functionResponse })) });
    // Gemini sometimes asks for a tool that doesn't exist, so only real ones are reported.
    toolsUsed.push(...calls.map((call) => call.name!).filter((name) => tools.some((tool) => tool.name === name)));
  }
  return { reply: GAVE_UP_REPLY, toolsUsed };
}

// Runs one tool. A failure goes back to Gemini as an error, so it can tell the teacher instead of crashing.
async function runTool(call: FunctionCall, api: ApiGet) {
  const tool = tools.find((one) => one.name === call.name);
  try {
    if (!tool) throw new Error(`There is no tool called ${call.name}.`);
    return { id: call.id, name: call.name, response: { result: await tool.run(call.args, api) } };
  } catch (error) {
    return { id: call.id, name: call.name, response: { error: (error as Error).message } };
  }
}
