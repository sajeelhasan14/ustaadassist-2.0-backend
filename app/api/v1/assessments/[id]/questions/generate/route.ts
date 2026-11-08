import { z } from "zod";
import { answerShape, askAI, readJsonReply } from "@/lib/ai";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Per model. Writing a whole paper takes longer than reading, so this is more than lib/ai.ts's default.
const MODEL_TIME_LIMIT_MS = 60_000;

// Everything is optional, so one tap on "Generate" works.
// instructions = whatever the teacher wants, in their own words: only MCQs, sections, parts, scenarios…
// topics[].marks = roughly how many marks this topic should carry. Sent as a number, because
// vague wording ("mostly testing") made the AI skip the other topics completely.
const generateRequest = z.object({
  instructions: z.string().trim().max(2000).optional(),
  topics: z
    .array(z.object({ id: z.uuid(), marks: z.number().positive("Must be more than 0.").max(1000).optional() }))
    .min(1)
    .max(50)
    .optional(),
});

// The answer the AI must give. The same schema is sent to the AI (as JSON Schema) and then checks its reply.
const generated = z.object({
  sections: z.array(
    z.object({
      title: z.string().describe("For example 'Section A'. Empty if the teacher didn't ask for sections."),
      instructions: z.string().describe("Instructions printed under the title. Empty if there are none."),
      attemptAny: z.number().int().nullable().describe("If students attempt only some questions of this section, how many. Otherwise null."),
      questions: z.array(
        z.object({
          topicNumber: z.number().int().describe("The number of the topic this question tests, from the numbered list."),
          type: z.string().describe("A short lowercase label: mcq, short, long, scenario, or the kind the teacher asked for."),
          text: z.string().describe("The question, exactly as a student would read it."),
          options: z.array(z.string()).nullable().describe("For mcq: exactly 4 choices, without A/B/C/D labels. Otherwise null."),
          difficulty: z.enum(["easy", "medium", "hard"]),
          marks: z.number().describe("Marks for this question. With parts, the sum of the parts."),
          parts: z
            .array(z.object({ label: z.string().describe("For example (a)."), text: z.string(), marks: z.number() }))
            .describe("Sub-parts, only if the teacher asked for them. Otherwise an empty list."),
        }),
      ),
    }),
  ),
});

const instructions = `You write exam papers for a university teacher, who will review everything before use.
- Write only the questions. Never include answers, model answers, hints or explanations.
- The teacher's request decides the kinds of question, how many, and the structure: sections, "attempt any", parts on any question.
- If the teacher doesn't ask for sections, use one section with an empty title.
- Test only the listed topics, at university level. Where a topic has marks, keep its questions close to that many marks.
- Each question must stand alone and be different from the others.
- Never repeat or reword a question from the "already written" list.
- Multiple choice: exactly 4 plausible options, no "all of the above" or "none of the above".
- Marks a student can earn must add up to the stated total. With "attempt any", count only the questions they attempt.`;

// POST /api/v1/assessments/<id>/questions/generate: The AI writes a paper, saved as drafts for the teacher to review.
// Body (all optional): { instructions, topics: [{ id, marks? }] }. No topics = the ones already taught.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions/generate">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  // No body at all is fine here: it means "use the defaults".
  const parsed = generateRequest.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { instructions: teacherRequest, topics: picked } = parsed.data;

  // The JOINs up to semesters are the ownership check.
  const [assessment] = await query<{ name: string; maxMarks: number; courseId: string; courseCode: string; courseTitle: string }>(
    `SELECT a.name, a.max_marks::float8 AS "maxMarks", c.id AS "courseId", c.code AS "courseCode", c.title AS "courseTitle"
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE a.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  if (!assessment) return notFound();

  // Which topics to test: the teacher's choice, else what's been taught, else the whole outline.
  const outline = await query<{ id: string; title: string; taught: boolean }>(
    `SELECT t.id, t.title,
            EXISTS (SELECT 1 FROM session_topics st JOIN class_sessions cs ON cs.id = st.session_id
                     WHERE st.topic_id = t.id AND cs.status = 'held') AS taught
       FROM topics t
      WHERE t.course_id = $1
      ORDER BY t.position`,
    [assessment.courseId],
  );
  if (outline.length === 0) {
    return errorResponse(400, "no_topics", "Add topics to this course first, so there's something to write questions about.");
  }
  const askedMarks = new Map(picked?.map((topic) => [topic.id, topic.marks]));
  const chosen = outline.filter((topic) => askedMarks.has(topic.id));
  if (picked && chosen.length !== askedMarks.size) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { topics: ["Some of these topics aren't in this course."] });
  }
  const taught = outline.filter((topic) => topic.taught);
  const topics = picked ? chosen : taught.length > 0 ? taught : outline;

  // Existing questions: so the AI doesn't repeat them, and to work out how many marks are still to fill.
  const existing = await query<{ text: string; marks: number; status: string; sectionId: string; attemptAny: number | null }>(
    `SELECT q.text, q.marks::float8 AS marks, q.status, q.section_id AS "sectionId", ps.attempt_any AS "attemptAny"
       FROM questions q
       JOIN paper_sections ps ON ps.id = q.section_id
      WHERE q.assessment_id = $1
      ORDER BY ps.position, q.position`,
    [id],
  );
  const approvedMarks = countableMarks(existing.filter((question) => question.status === "approved"));
  const marksLeft = (cents(assessment.maxMarks) - cents(approvedMarks)) / 100;
  // A full paper can still ask for more, as spares to swap in.
  const targetMarks = marksLeft > 0 ? marksLeft : assessment.maxMarks;

  // Checked before the AI, so a mistake here doesn't use up a request.
  const topicMarksCents = topics.reduce((sum, topic) => sum + cents(askedMarks.get(topic.id) ?? 0), 0);
  if (topicMarksCents > cents(targetMarks)) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", {
      topics: [`These topics add up to ${topicMarksCents / 100} marks, but the paper has ${targetMarks}.`],
    });
  }

  const describeTopic = (title: string, marks: number | undefined) => (marks ? `${title}: about ${marks} marks` : title);
  const prompt = [
    `Course: ${assessment.courseCode} ${assessment.courseTitle}`,
    `Assessment: ${assessment.name}`,
    `Total marks: ${targetMarks}`,
    `Topics:\n${topics.map((topic, index) => `${index + 1}. ${describeTopic(topic.title, askedMarks.get(topic.id))}`).join("\n")}`,
    existing.length > 0 ? `Already written, don't repeat:\n${existing.map((question) => `- ${question.text}`).join("\n")}` : "",
    `Teacher's request: ${teacherRequest || "A balanced paper of multiple-choice and short questions."}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // The AI step: it sees only the course name, topic titles and old questions. It never sees student data.
  // lib/ai.ts picks the company and model from .env.local, and tries the next model if one is busy.
  let answer: unknown;
  try {
    const completion = await askAI(
      {
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: prompt },
        ],
        response_format: answerShape("paper", generated),
        // Unlike copying a list, writing good questions needs some reasoning.
        reasoning_effort: "medium",
      },
      MODEL_TIME_LIMIT_MS,
    );
    answer = readJsonReply(completion);
  } catch (error) {
    console.error("Question generation failed:", error);
    return errorResponse(502, "ai_failed", "Couldn't write questions right now. Please try again.");
  }
  const reply = generated.safeParse(answer);
  if (!reply.success) return errorResponse(502, "ai_failed", "Couldn't write questions right now. Please try again.");

  // From here on, no AI: keep only questions that follow the rules. A broken one is dropped, not saved.
  const sections = reply.data.sections
    .map((section) => {
      const questions = section.questions
        .map((question) => ({ ...question, type: question.type.trim().toLowerCase() }))
        .filter((question) => {
          if (!question.type || !question.text.trim()) return false;
          if (question.parts.some((part) => !part.text.trim() || part.marks <= 0)) return false;
          if (question.parts.length === 0 && question.marks <= 0) return false;
          if (question.type !== "mcq") return true;
          const options = question.options ?? [];
          return options.length >= 2 && new Set(options).size === options.length;
        });
      // "Attempt any 5 of 5" means nothing, and dropped questions can make that happen.
      const attemptAny = section.attemptAny && section.attemptAny > 0 && section.attemptAny < questions.length ? section.attemptAny : null;
      return { ...section, questions, attemptAny };
    })
    .filter((section) => section.questions.length > 0);
  const written = reply.data.sections.reduce((sum, section) => sum + section.questions.length, 0);
  const kept = sections.reduce((sum, section) => sum + section.questions.length, 0);
  if (kept === 0) return errorResponse(502, "ai_failed", "Couldn't write questions right now. Please try again.");

  const saved = await withTransaction(async (client) => {
    // Lock the assessment, so two requests at once can't use the same positions.
    await client.query(`SELECT 1 FROM assessments WHERE id = $1 FOR UPDATE`, [id]);
    const rows = [];
    for (const section of sections) {
      const inserted = await client.query(
        `INSERT INTO paper_sections (assessment_id, title, instructions, attempt_any, position)
         VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM paper_sections WHERE assessment_id = $1))
         RETURNING id, title, instructions, attempt_any AS "attemptAny", position`,
        [id, section.title.trim(), section.instructions.trim(), section.attemptAny],
      );
      const questions = section.questions.map((question, index) => ({
        topic_id: topics[question.topicNumber - 1]?.id ?? null,
        type: question.type,
        text: question.text.trim(),
        options: question.type === "mcq" ? question.options : null,
        parts: question.parts.length > 0 ? question.parts : null,
        difficulty: question.difficulty,
        // With parts, the total is always the sum of the parts, so the two can't disagree.
        marks: question.parts.length > 0 ? question.parts.reduce((sum, part) => sum + cents(part.marks), 0) / 100 : cents(question.marks) / 100,
        offset: index + 1,
      }));
      // One insert for all rows: the list goes in as one JSON value and Postgres unpacks it into rows.
      const added = await client.query(
        `INSERT INTO questions (assessment_id, section_id, topic_id, type, text, options, parts, difficulty, marks, status, source, position)
         SELECT $1::uuid, $2::uuid, q.topic_id, q.type, q.text, q.options, q.parts, q.difficulty, q.marks, 'draft', 'ai',
                (SELECT COALESCE(MAX(position), 0) FROM questions WHERE assessment_id = $1::uuid) + q."offset"
           FROM jsonb_to_recordset($3::jsonb) AS q(topic_id uuid, type text, text text, options jsonb, parts jsonb,
                                                   difficulty text, marks numeric, "offset" integer)
         RETURNING id, section_id AS "sectionId", topic_id AS "topicId", type, text, options, parts, difficulty,
                   marks::float8 AS marks, status, source, position`,
        [id, inserted.rows[0].id, JSON.stringify(questions)],
      );
      rows.push({ ...inserted.rows[0], questions: added.rows.sort((a, b) => a.position - b.position) });
    }
    return rows;
  });

  // The AI can miss the total or a topic's marks. We report it rather than change its work: the teacher decides.
  const allQuestions = saved.flatMap((section) => section.questions.map((question: { marks: number }) => ({ ...question, attemptAny: section.attemptAny })));
  const topicPlan = topics.map((topic) => ({
    topicId: topic.id,
    title: topic.title,
    askedMarks: askedMarks.get(topic.id) ?? null,
    writtenMarks:
      allQuestions.filter((question) => question.topicId === topic.id).reduce((sum, question) => sum + cents(question.marks), 0) / 100,
  }));
  return Response.json(
    { sections: saved, targetMarks, marksTotal: countableMarks(allQuestions), topicPlan, dropped: written - kept },
    { status: 201 },
  );
}

// The marks a student can really earn. In an "attempt any N" section only the N best-paid questions count,
// so a paper showing 66 marks of questions can correctly be a 50-mark paper.
function countableMarks(questions: { sectionId: string; attemptAny: number | null; marks: number }[]) {
  const sections = new Map<string, typeof questions>();
  for (const question of questions) sections.set(question.sectionId, [...(sections.get(question.sectionId) ?? []), question]);
  let total = 0;
  for (const section of sections.values()) {
    const highestFirst = section.map((question) => cents(question.marks)).sort((a, b) => b - a);
    const counted = highestFirst.slice(0, section[0].attemptAny ?? highestFirst.length);
    total += counted.reduce((sum, marks) => sum + marks, 0);
  }
  return total / 100;
}

// 7.5 → 750. Whole numbers add up exactly; decimals don't.
function cents(marks: number) {
  return Math.round(marks * 100);
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
  return errorResponse(404, "not_found", "Assessment not found.");
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
