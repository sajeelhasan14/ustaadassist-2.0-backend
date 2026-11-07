import type { z } from "zod";

// Reads one of our own API routes as the logged-in teacher, e.g. api("/today").
export type ApiGet = (path: string) => Promise<unknown>;

// The screen the teacher asked from. Home sends neither; a course screen sends both.
export type PageContext = { courseId?: string; sectionId?: string };

// A change the agent prepared. The agent never sends it: the app shows it, and sends it after the teacher taps Confirm.
export type Proposal = {
  title: string;
  detail: string;
  method: "POST" | "PATCH";
  path: string;
  body: Record<string, unknown>;
};

// A small number shown under a reply. tone picks its colour in the app.
export type Stat = { value: string; label: string; tone: "normal" | "warning" | "good" };

// One thing the agent can do. Gemini sees the name, description and input; only our code runs `run`.
export type AgentTool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (args: unknown, api: ApiGet) => Promise<unknown>;
};

// Creates a tool. Gemini's arguments are checked against `input` first, so `run` only ever gets valid values.
export function defineTool<Input extends z.ZodObject>(tool: {
  name: string;
  description: string;
  input: Input;
  run: (args: z.infer<Input>, api: ApiGet) => Promise<unknown>;
}): AgentTool {
  return { ...tool, run: (args, api) => tool.run(tool.input.parse(args), api) };
}
