import type { AgentTool } from "../types";
import { getAssessments, getMaterials, getOffDays, getPaper, listCourses } from "./courses";
import { getAttendance, getMarks, getPlan, getResults, getStudents } from "./sections";
import { getClassesOnDate } from "./today";

// Everything the agent can do. To add a tool: write it, then add it here.
export const tools: AgentTool[] = [
  getClassesOnDate,
  listCourses,
  getAssessments,
  getMaterials,
  getOffDays,
  getPaper,
  getStudents,
  getAttendance,
  getPlan,
  getMarks,
  getResults,
];
