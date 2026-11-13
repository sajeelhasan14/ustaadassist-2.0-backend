import { z } from "zod";
import { defineTool } from "../types";

type Semester = { id: string; name: string; startDate: string; endDate: string };
type Course = { id: string };

// Reads GET /api/v1/semesters, then each semester's courses, then each course's sections.
// The sections are included because almost every question needs a section id, and this saves Gemini a whole round.
export const listCourses = defineTool({
  name: "list_courses",
  description:
    "All of the teacher's semesters, newest first, each with its courses (code, title, total marks) and each course's " +
    "sections (name, student count). Use this first to find the ids the other tools need.",
  input: z.object({}),
  run: async (_args, api) => {
    const { semesters } = (await api("/semesters")) as { semesters: Semester[] };
    return Promise.all(
      semesters.map(async (semester) => {
        const { courses } = (await api(`/semesters/${semester.id}/courses`)) as { courses: Course[] };
        const withSections = await Promise.all(
          courses.map(async (course) => {
            const { sections } = (await api(`/courses/${course.id}/sections`)) as { sections: unknown[] };
            return { ...course, sections };
          }),
        );
        return { ...semester, courses: withSections };
      }),
    );
  },
});

// Reads GET /api/v1/courses/<id>/assessments.
export const getAssessments = defineTool({
  name: "get_assessments",
  description:
    "The assessments a course has so far (name, marks, how many students have a mark), and how much of the course total " +
    "is allocated. Teachers add assessments whenever they like, so a short list or unallocated marks is normal, not a problem.",
  input: z.object({ courseId: z.uuid() }),
  run: ({ courseId }, api) => api(`/courses/${courseId}/assessments`),
});

// Reads GET /api/v1/courses/<id>/materials. Only names and sizes: the assistant can't open the files.
export const getMaterials = defineTool({
  name: "get_materials",
  description: "The files uploaded to a course, newest first: name, type, size and date. It cannot read what is inside them.",
  input: z.object({ courseId: z.uuid() }),
  run: ({ courseId }, api) => api(`/courses/${courseId}/materials`),
});

// Reads GET /api/v1/off-days. Each course has its own holidays.
export const getOffDays = defineTool({
  name: "get_off_days",
  description: "The holidays and off days of one course, inside its semester. Islamic holidays stay tentative until the teacher confirms them.",
  input: z.object({ courseId: z.uuid() }),
  run: ({ courseId }, api) => api(`/off-days?courseId=${courseId}`),
});

// Reads GET /api/v1/assessments/<id>/questions.
export const getPaper = defineTool({
  name: "get_paper",
  description:
    "The question paper of one assessment: its sections and questions, each marked draft or approved, and the marks used. " +
    "Assessment ids come from get_assessments.",
  input: z.object({ assessmentId: z.uuid() }),
  run: ({ assessmentId }, api) => api(`/assessments/${assessmentId}/questions`),
});
