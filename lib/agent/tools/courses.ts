import { z } from "zod";
import { defineTool } from "../types";

type Semester = { id: string; name: string; startDate: string; endDate: string };

// Reads GET /api/v1/semesters, then GET /api/v1/semesters/<id>/courses for each one.
export const listCourses = defineTool({
  name: "list_courses",
  description: "All of the teacher's semesters, newest first, each with its courses (code, title, total marks).",
  input: z.object({}),
  run: async (_args, api) => {
    const { semesters } = (await api("/semesters")) as { semesters: Semester[] };
    return Promise.all(
      semesters.map(async (semester) => {
        const { courses } = (await api(`/semesters/${semester.id}/courses`)) as { courses: unknown[] };
        return { ...semester, courses };
      }),
    );
  },
});
