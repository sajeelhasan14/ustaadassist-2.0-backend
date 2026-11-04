import type { AgentTool } from "../types";
import { listCourses } from "./courses";
import { getClassesOnDate } from "./today";

// Everything the agent can do. To add a tool: create its file, then add it here.
export const tools: AgentTool[] = [getClassesOnDate, listCourses];
