import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { askAI } from "../ai";
import { buildInstructions } from "./instructions";
import { tools } from "./tools";
import type { ApiGet, PageContext, Proposal, Stat } from "./types";

// Limits, so a confused agent can't loop forever or keep the teacher waiting.
const MAX_ROUNDS = 6;
const RUN_TIME_LIMIT_MS = 90_000;
const GAVE_UP_REPLY = "Sorry, that took too long. Please try asking in a simpler way.";

export type ChatMessage = { role: "user" | "assistant"; text: string };

// The tool list in the form the AI reads. It sees the names, descriptions and input shapes, never the code.
const toolDefinitions: ChatCompletionFunctionTool[] = tools.map((tool) => {
  const { $schema, ...parameters } = z.toJSONSchema(tool.input); // $schema is only a label; the AI needs the shape
  void $schema;
  return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
});

// The agent: ask the AI, run the tools it wants, give it the results, and repeat until it answers.
export async function runAgent(message: string, history: ChatMessage[], api: ApiGet, page: PageContext = {}) {
  // "Today" at the university (Karachi), as YYYY-MM-DD. en-CA happens to format dates that way.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildInstructions(today, page) },
    ...history.map((turn): ChatCompletionMessageParam => ({ role: turn.role, content: turn.text })),
    { role: "user", content: message },
  ];
  const toolsUsed: string[] = [];
  // Tools hand these over beside their result, because the app shows them itself, outside the AI's words.
  const proposals: Proposal[] = [];
  let stats: Stat[] = [];
  const deadline = Date.now() + RUN_TIME_LIMIT_MS;

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round++) {
    const reply = (await askAI({ messages, tools: toolDefinitions })).choices[0]?.message;
    const calls = (reply?.tool_calls ?? []).filter((call) => call.type === "function");

    // No tool requested: this is the final answer.
    if (!reply || calls.length === 0) return { reply: reply?.content?.trim() || GAVE_UP_REPLY, toolsUsed, proposals, stats };

    // Keep the AI's turn exactly as it came (Gemini hides a "thought signature" in it and needs it back),
    // then add one result per tool it asked for, matched by the call's id.
    messages.push(reply);
    const results = await Promise.all(calls.map((call) => runTool(call, api)));
    for (const { id, output } of results) {
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(output) });
      const result = output.result as { proposal?: Proposal; stats?: Stat[] } | undefined;
      if (result?.proposal) proposals.push(result.proposal);
      if (result?.stats) stats = result.stats;
    }
    // The AI sometimes asks for a tool that doesn't exist, so only real ones are reported.
    toolsUsed.push(...calls.map((call) => call.function.name).filter((name) => tools.some((tool) => tool.name === name)));
  }
  return { reply: GAVE_UP_REPLY, toolsUsed, proposals, stats };
}

// Runs one tool. A failure goes back to the AI as an error, so it can tell the teacher instead of crashing.
async function runTool(
  call: ChatCompletionMessageFunctionToolCall,
  api: ApiGet,
): Promise<{ id: string; output: { result?: unknown; error?: string } }> {
  const tool = tools.find((one) => one.name === call.function.name);
  try {
    if (!tool) throw new Error(`There is no tool called ${call.function.name}.`);
    // The AI sends the tool's input as JSON text, not as an object.
    const args = JSON.parse(call.function.arguments || "{}");
    return { id: call.id, output: { result: await tool.run(args, api) } };
  } catch (error) {
    return { id: call.id, output: { error: (error as Error).message } };
  }
}
