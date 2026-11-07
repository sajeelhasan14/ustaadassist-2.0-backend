import { z } from "zod";
import { defineTool } from "../types";

// Reads GET /api/v1/today.
export const getClassesOnDate = defineTool({
  name: "get_classes_on_date",
  description:
    "The teacher's classes on one day, across all courses: time, course, section, status, attendance counts and topic. " +
    "Also says if the day is a holiday or off day, which sections have students short on attendance, and any dated " +
    "assessments coming up.",
  input: z.object({
    date: z.iso.date().optional().describe("The day as YYYY-MM-DD. Leave out for today."),
  }),
  run: ({ date }, api) => api(date ? `/today?date=${date}` : "/today"),
});
