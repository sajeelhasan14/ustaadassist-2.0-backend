import { z } from "zod";
import { query } from "@/lib/db";
import { builtInHolidays } from "@/lib/holidays";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Section = { id: string; name: string; courseId: string; courseCode: string; courseTitle: string };
type Slot = { sectionId: string; startTime: string; endTime: string };
type StoredSession = {
  id: string; sectionId: string; startTime: string; endTime: string; status: string; extra: boolean; note: string | null;
  present: number; absent: number;
};
type Topic = { sectionId: string; id: string; title: string; position: number; classesNeeded: number; classesTaught: number };
type SessionTopic = { id: string; title: string };

// One absence out of fewer classes than this already drops a student below 75%, so warning earlier would flag
// everyone who missed a single class. The app uses the same number after saving attendance.
const MIN_CLASSES_FOR_ALERT = 4;

// GET /api/v1/today?date=YYYY-MM-DD: the teacher's classes on one day, across all sections, in time order.
// date is optional (default: today in Karachi). Same rules as the class calendar: timetable − off days + stored classes.
// Each class also has its topic: what was taught if it's marked, otherwise the next topic from the plan.
export async function GET(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  // "Today" at the university (Karachi), as YYYY-MM-DD. en-CA happens to format dates that way.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const parsedDate = z.iso.date().safeParse(new URL(request.url).searchParams.get("date") ?? today);
  if (!parsedDate.success) return errorResponse(400, "invalid_input", "Use ?date=YYYY-MM-DD.");
  const date = parsedDate.data;
  // getUTCDay() is 0 for Sunday; we number days 1 = Monday … 7 = Sunday.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

  // Only sections whose semester is running on this date.
  const sections = await query<Section>(
    `SELECT sec.id, sec.name, c.id AS "courseId", c.code AS "courseCode", c.title AS "courseTitle"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE s.teacher_id = $1 AND s.start_date <= $2 AND s.end_date >= $2`,
    [teacherId, date],
  );
  const sectionIds = sections.map((section) => section.id);

  // Add a public holiday on this date if the teacher doesn't have it yet (same as GET /off-days).
  const holidays = builtInHolidays(date, date);
  await query(
    `INSERT INTO off_days (teacher_id, holiday_key, name, start_date, end_date, tentative)
     SELECT $1::uuid, * FROM unnest($2::text[], $3::text[], $4::date[], $5::date[], $6::boolean[])
     ON CONFLICT (teacher_id, holiday_key) DO NOTHING`,
    [
      teacherId,
      holidays.map((holiday) => holiday.key),
      holidays.map((holiday) => holiday.name),
      holidays.map((holiday) => holiday.startDate),
      holidays.map((holiday) => holiday.endDate),
      holidays.map((holiday) => holiday.tentative),
    ],
  );
  const [offDay] = await query<{ name: string; tentative: boolean }>(
    `SELECT name, tentative FROM off_days
      WHERE teacher_id = $1 AND NOT removed AND start_date <= $2 AND end_date >= $2
      ORDER BY start_date LIMIT 1`,
    [teacherId, date],
  );

  const slots = await query<Slot>(
    `SELECT section_id AS "sectionId", to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
       FROM timetable_slots WHERE section_id = ANY($1::uuid[]) AND weekday = $2`,
    [sectionIds, weekday],
  );
  // count(...) FILTER (WHERE ...) counts only the rows that match, so one query gives both numbers.
  const stored = await query<StoredSession>(
    `SELECT cs.id, cs.section_id AS "sectionId", to_char(cs.start_time, 'HH24:MI') AS "startTime",
            to_char(cs.end_time, 'HH24:MI') AS "endTime", cs.status, cs.extra, cs.note,
            count(a.student_id) FILTER (WHERE a.present)::int AS present,
            count(a.student_id) FILTER (WHERE NOT a.present)::int AS absent
       FROM class_sessions cs
       LEFT JOIN attendance a ON a.session_id = cs.id
      WHERE cs.section_id = ANY($1::uuid[]) AND cs.date = $2
      GROUP BY cs.id`,
    [sectionIds, date],
  );
  const taughtRows = await query<SessionTopic & { sessionId: string }>(
    `SELECT st.session_id AS "sessionId", t.id, t.title
       FROM session_topics st JOIN topics t ON t.id = st.topic_id
      WHERE st.session_id = ANY($1::uuid[])
      ORDER BY t.position`,
    [stored.map((session) => session.id)],
  );
  // Each section's outline, with how many HELD classes of that section taught each topic.
  const topics = await query<Topic>(
    `SELECT sec.id AS "sectionId", t.id, t.title, t.position, t.classes_needed AS "classesNeeded", count(cs.id)::int AS "classesTaught"
       FROM sections sec
       JOIN topics t ON t.course_id = sec.course_id
       LEFT JOIN (session_topics st JOIN class_sessions cs ON cs.id = st.session_id AND cs.status = 'held')
              ON st.topic_id = t.id AND cs.section_id = sec.id
      WHERE sec.id = ANY($1::uuid[])
      GROUP BY sec.id, t.id
      ORDER BY t.position`,
    [sectionIds],
  );

  // Build the day: each timetable slot, replaced by its stored class if there is one, then extra classes.
  const storedByKey = new Map(stored.map((session) => [`${session.sectionId} ${session.startTime}`, session]));
  const classes = [];
  for (const slot of slots) {
    const saved = storedByKey.get(`${slot.sectionId} ${slot.startTime}`);
    if (saved) {
      classes.push(saved);
      storedByKey.delete(`${slot.sectionId} ${slot.startTime}`);
    } else {
      classes.push({
        id: null, sectionId: slot.sectionId, startTime: slot.startTime, endTime: slot.endTime,
        status: offDay ? "off_day" : "planned", extra: false, note: null, present: 0, absent: 0,
      });
    }
  }
  classes.push(...storedByKey.values());
  classes.sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Topics. Marked classes show what was taught. Planned classes get the section's next unfinished topics in order,
  // using the planner's rule (see docs/flows/planner.md): done = taught in as many classes as it needs, or started
  // and a later topic has been taught.
  const result = classes.map((session) => {
    const section = sections.find((one) => one.id === session.sectionId)!;
    return {
      ...session,
      sectionName: section.name, courseId: section.courseId, courseCode: section.courseCode, courseTitle: section.courseTitle,
      topics: session.id ? taughtRows.filter((row) => row.sessionId === session.id).map(({ id, title }) => ({ id, title })) : [],
    };
  });
  for (const section of sections) {
    const outline = topics.filter((topic) => topic.sectionId === section.id);
    const lastTaughtPosition = Math.max(0, ...outline.filter((topic) => topic.classesTaught > 0).map((topic) => topic.position));
    const queue = outline.flatMap((topic) => {
      const done = topic.classesTaught >= topic.classesNeeded || (topic.classesTaught > 0 && topic.position < lastTaughtPosition);
      return Array<SessionTopic>(done ? 0 : topic.classesNeeded - topic.classesTaught).fill({ id: topic.id, title: topic.title });
    });
    const planned = result.filter((session) => session.sectionId === section.id && session.status === "planned");
    planned.forEach((session, index) => {
      if (queue[index]) session.topics = [queue[index]];
    });
  }

  // Which sections have students below the teacher's line. Same sum as GET /sections/<id>/attendance: held classes
  // only, rounded to one decimal before comparing. Sections with nobody short aren't listed.
  const [teacher] = await query<{ minAttendance: number }>(
    `SELECT min_attendance::float8 AS "minAttendance" FROM teachers WHERE id = $1`,
    [teacherId],
  );
  const min = teacher?.minAttendance ?? 75;
  const short = await query<{ sectionId: string; below: number }>(
    `WITH per_student AS (
       SELECT e.section_id, count(*) FILTER (WHERE a.present) AS present, count(*) AS marked
         FROM enrollments e
         JOIN class_sessions cs ON cs.section_id = e.section_id AND cs.status = 'held'
         JOIN attendance a ON a.session_id = cs.id AND a.student_id = e.student_id
        WHERE e.section_id = ANY($1::uuid[])
        GROUP BY e.section_id, e.student_id
     )
     SELECT section_id AS "sectionId", count(*)::int AS below
       FROM per_student
      WHERE marked >= $3 AND round(present * 100.0 / marked, 1) < $2
      GROUP BY section_id`,
    [sectionIds, min, MIN_CLASSES_FOR_ALERT],
  );
  const attendanceAlerts = short.map(({ sectionId, below }) => {
    const section = sections.find((one) => one.id === sectionId)!;
    return { sectionId, sectionName: section.name, courseId: section.courseId, courseCode: section.courseCode, below, min };
  });

  // Assessments with a date from this day on. Most have no date, so this is often empty, and that's fine.
  const comingUp = await query(
    `SELECT a.id, a.name, a.held_on::text AS date, c.id AS "courseId", c.code AS "courseCode"
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE s.teacher_id = $1 AND a.held_on >= $2
      ORDER BY a.held_on, a.name
      LIMIT 5`,
    [teacherId, date],
  );

  return Response.json({ date, weekday, today: date === today, offDay: offDay ?? null, classes: result, attendanceAlerts, comingUp });
}

// The teacher id inside a valid "Authorization: Bearer <token>" header, or null.
async function getTeacherId(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return null;
  // Passing the token means cookies are ignored; only this token is checked.
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims(token);
  return data?.claims.sub ?? null;
}

// Every API error has the same shape, so the app can handle them all the same way.
function errorResponse(status: number, code: string, message: string, fields?: object) {
  return Response.json({ error: { code, message, fields } }, { status });
}
