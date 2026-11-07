import { z } from "zod";
import { defineTool, type Stat } from "../types";

// Every tool here reads one section, so they all take the same input.
const input = z.object({ sectionId: z.uuid().describe("The section's id, from list_courses.") });

type Gradebook = {
  totalMarks: number;
  allocated: number;
  assessments: { name: string; maxMarks: number; average: number | null }[];
  students: { rollNumber: string; fullName: string; marks: (number | null)[]; total: number; percentage: number; missing: number }[];
};

type Sessions = {
  today: string;
  summary: unknown;
  plan: { topicsDone: number; topicsLeft: number; classesShort: number };
  sessions: { date: string; startTime: string; status: string; extra: boolean; note: string | null; present: number; absent: number; offDayName: string | null; topics: { title: string }[] }[];
};

// Reads GET /api/v1/sections/<id>/students.
export const getStudents = defineTool({
  name: "get_students",
  description: "The students in a section: seat number, name, father's name and email. The app stores nothing else about them.",
  input,
  run: ({ sectionId }, api) => api(`/sections/${sectionId}/students`),
});

// Reads GET /api/v1/sections/<id>/attendance.
export const getAttendance = defineTool({
  name: "get_attendance",
  description:
    "Attendance for a section: classes held, the section's average, the minimum percentage, and for each student present, " +
    "marked, percentage and shortage. shortage true means below the minimum. A null percentage means no class marked yet.",
  input,
  run: ({ sectionId }, api) => api(`/sections/${sectionId}/attendance`),
});

// Reads GET /api/v1/sections/<id>/sessions, which holds both the plan and every class of the semester.
// Each class is trimmed to what a question could need, because a semester can have about 50 of them.
export const getPlan = defineTool({
  name: "get_plan",
  description:
    "The teaching plan of a section: classes held, cancelled and remaining, topics done and left, the next topic, " +
    "classesShort (extra classes needed to finish on time, 0 means on track), each topic's status and planned dates, " +
    "and every class of the semester with its date, status and what was taught.",
  input,
  run: async ({ sectionId }, api) => {
    const { today, summary, plan, sessions } = (await api(`/sections/${sectionId}/sessions`)) as Sessions;
    const stats: Stat[] = [
      { value: `${plan.topicsDone}/${plan.topicsDone + plan.topicsLeft}`, label: "TOPICS DONE", tone: "normal" },
      { value: `${plan.classesShort}`, label: "BEHIND", tone: plan.classesShort > 0 ? "warning" : "normal" },
      { value: `${plan.topicsLeft}`, label: "LEFT", tone: "good" },
    ];
    return {
      today,
      stats,
      summary,
      plan,
      classes: sessions.map((session) => ({
        date: session.date,
        time: session.startTime,
        status: session.status,
        extra: session.extra,
        note: session.note,
        offDay: session.offDayName,
        present: session.present,
        absent: session.absent,
        topics: session.topics.map((topic) => topic.title),
      })),
    };
  },
});

// Reads GET /api/v1/sections/<id>/marks.
// The route gives marks as a bare list that lines up with the assessments by position. Gemini could easily
// match a number to the wrong assessment, so here every mark is labelled with its assessment's name.
export const getMarks = defineTool({
  name: "get_marks",
  description:
    "Marks for a section: each assessment with its class average (as a percentage of that assessment), and each student's " +
    "marks by assessment, total and percentage of the course total. A null mark means not entered yet, which is not the same as zero.",
  input,
  run: async ({ sectionId }, api) => {
    const book = (await api(`/sections/${sectionId}/marks`)) as Gradebook;
    return {
      totalMarks: book.totalMarks,
      allocated: book.allocated,
      assessments: book.assessments,
      students: book.students.map(({ marks, ...student }) => ({
        ...student,
        marks: Object.fromEntries(book.assessments.map((assessment, index) => [assessment.name, marks[index]])),
      })),
    };
  },
});

// Reads GET /api/v1/sections/<id>/results, without the sheet's printed header, which no question needs.
export const getResults = defineTool({
  name: "get_results",
  description:
    "The result sheet of a section: pass, fail and absent counts, and each student's total, grade and remarks. " +
    "summary.incomplete counts students with marks still missing, so the sheet is not final while it is above 0.",
  input,
  run: async ({ sectionId }, api) => {
    const { summary, hasLab, theoryMax, labMax, students } = (await api(`/sections/${sectionId}/results`)) as Record<string, unknown>;
    return { summary, hasLab, theoryMax, labMax, students };
  },
});
