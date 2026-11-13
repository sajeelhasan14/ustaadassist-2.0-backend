import { z } from "zod";
import { defineTool, type ApiGet, type Proposal } from "../types";

// These tools change nothing. Each one checks the request against real data, then describes the change.
// The app shows that description with a Confirm button, and only the app, after the tap, sends it.
// The title, detail and request are all built here from checked values, so Gemini can't show one thing and send another.

const time = z.string().regex(/^\d{2}:\d{2}$/, "Use 24-hour time like 09:00.");
const WAITING = "Shown to the teacher with a Confirm button. Nothing has changed yet, so say it is ready to confirm, not that it is done.";

type Session = { date: string; startTime: string; status: string };

function propose(proposal: Proposal) {
  return { proposal, status: WAITING };
}

// "2026-11-10" → "Tue 10 Nov".
function readable(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// "SE-454 · Section A". The result sheet is the one route that names both.
async function sectionLabel(sectionId: string, api: ApiGet) {
  const { course, section } = (await api(`/sections/${sectionId}/results`)) as { course: { code: string }; section: string };
  return `${course.code} · Section ${section}`;
}

export const proposeCancelClass = defineTool({
  name: "propose_cancel_class",
  description: "Prepare cancelling one class, for the teacher to confirm. Leave startTime out if the section has one class that day.",
  input: z.object({ sectionId: z.uuid(), date: z.iso.date(), startTime: time.optional() }),
  run: async ({ sectionId, date, startTime }, api) => {
    const { sessions } = (await api(`/sections/${sectionId}/sessions`)) as { sessions: Session[] };
    const onDate = sessions.filter((session) => session.date === date && (!startTime || session.startTime === startTime));
    const open = onDate.filter((session) => session.status === "planned");
    if (onDate.length === 0) throw new Error(`This section has no class on ${date}${startTime ? ` at ${startTime}` : ""}.`);
    if (open.length === 0) throw new Error(`That class can't be cancelled: its status is ${onDate[0].status}.`);
    if (open.length > 1) throw new Error(`There are classes at ${open.map((session) => session.startTime).join(" and ")} that day. Ask which one.`);

    const [session] = open;
    return propose({
      title: "Cancel class",
      detail: `${await sectionLabel(sectionId, api)} · ${readable(date)} · ${session.startTime}`,
      method: "POST",
      path: `/sections/${sectionId}/sessions`,
      body: { date, startTime: session.startTime, status: "cancelled" },
    });
  },
});

export const proposeExtraClass = defineTool({
  name: "propose_extra_class",
  description: "Prepare adding an extra class outside the timetable, for the teacher to confirm. Needs a start and end time.",
  input: z.object({ sectionId: z.uuid(), date: z.iso.date(), startTime: time, endTime: time }),
  run: async ({ sectionId, date, startTime, endTime }, api) => {
    if (endTime <= startTime) throw new Error("The end time must be after the start time.");
    return propose({
      title: "Add extra class",
      detail: `${await sectionLabel(sectionId, api)} · ${readable(date)} · ${startTime} to ${endTime}`,
      method: "POST",
      path: `/sections/${sectionId}/sessions`,
      body: { date, startTime, endTime },
    });
  },
});

export const proposeAddAssessment = defineTool({
  name: "propose_add_assessment",
  description:
    "Prepare adding an assessment to a course, for the teacher to confirm. The date is optional: leave it out unless the teacher gave one.",
  input: z.object({
    courseId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    maxMarks: z.number().positive().max(1000),
    isLab: z.boolean().default(false),
    date: z.iso.date().optional(),
  }),
  run: async ({ courseId, name, maxMarks, isLab, date }, api) => {
    const { courseCode, totalMarks, unallocated, assessments } = (await api(`/courses/${courseId}/assessments`)) as {
      courseCode: string;
      totalMarks: number;
      unallocated: number;
      assessments: { name: string }[];
    };
    if (maxMarks > unallocated) throw new Error(`Only ${unallocated} of ${totalMarks} marks are left in this course.`);
    if (assessments.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new Error(`This course already has "${name}".`);
    return propose({
      title: "Add assessment",
      detail: [courseCode, name, `${maxMarks} marks`, ...(date ? [readable(date)] : [])].join(" · "),
      method: "POST",
      path: `/courses/${courseId}/assessments`,
      body: { name, maxMarks, isLab, ...(date ? { date } : {}) },
    });
  },
});

export const proposeAssessmentDate = defineTool({
  name: "propose_assessment_date",
  description: "Prepare setting the date of an existing assessment, for the teacher to confirm. Ids come from get_assessments.",
  input: z.object({ courseId: z.uuid(), assessmentId: z.uuid(), date: z.iso.date() }),
  run: async ({ courseId, assessmentId, date }, api) => {
    const { courseCode, assessments } = (await api(`/courses/${courseId}/assessments`)) as {
      courseCode: string;
      assessments: { id: string; name: string }[];
    };
    const assessment = assessments.find((item) => item.id === assessmentId);
    if (!assessment) throw new Error("That assessment isn't in this course.");
    return propose({
      title: "Set assessment date",
      detail: `${courseCode} · ${assessment.name} · ${readable(date)}`,
      method: "PATCH",
      path: `/assessments/${assessmentId}`,
      body: { date },
    });
  },
});

export const proposeOffDay = defineTool({
  name: "propose_off_day",
  description: "Prepare adding a day or range of days with no classes to one course, for the teacher to confirm. Other courses keep their own holidays.",
  input: z.object({ courseId: z.uuid(), name: z.string().trim().min(1).max(100), startDate: z.iso.date(), endDate: z.iso.date().optional() }),
  run: async ({ courseId, name, startDate, endDate }) => {
    if (endDate && endDate < startDate) throw new Error("The end date must be on or after the start date.");
    const days = endDate && endDate !== startDate ? `${readable(startDate)} to ${readable(endDate)}` : readable(startDate);
    return propose({
      title: "Add off day",
      detail: `${name} · ${days} · this course`,
      method: "POST",
      path: "/off-days",
      body: { courseId, name, startDate, ...(endDate ? { endDate } : {}) },
    });
  },
});

export const proposeAttendanceLine = defineTool({
  name: "propose_attendance_line",
  description: "Prepare changing one course's attendance percentage below which students are short, for the teacher to confirm. Other courses keep their own line.",
  input: z.object({ courseId: z.uuid(), minAttendance: z.number().min(0).max(100) }),
  run: async ({ courseId, minAttendance }) =>
    propose({
      title: "Change attendance line",
      detail: `Students below ${minAttendance}% count as short · this course`,
      method: "PATCH",
      path: `/courses/${courseId}`,
      body: { minAttendance },
    }),
});
