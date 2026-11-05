import { jsPDF } from "jspdf";
import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// A new order for the whole paper: sections in this order, each holding these questions in this order.
const newOrder = z.object({
  sections: z.array(z.object({ id: z.uuid(), questionIds: z.array(z.uuid()).max(500) })).min(1).max(50),
});

// What a valid "add my own question" body looks like. No sectionId = the last section.
const newQuestion = z
  .object({
    sectionId: z.uuid().optional(),
    type: z.string().trim().toLowerCase().min(1, "Question type is required.").max(30),
    text: z.string().trim().min(1, "Question text is required.").max(4000),
    options: z.array(z.string().trim().min(1).max(500)).min(2, "Add at least 2 options.").max(6).optional(),
    parts: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(20),
          text: z.string().trim().min(1).max(4000),
          marks: z.number().positive("Must be more than 0.").max(1000),
        }),
      )
      .min(1)
      .max(10)
      .optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
    marks: z.number().positive("Must be more than 0.").max(1000).optional(),
    topicId: z.uuid().optional(),
  })
  // Zod checks each field alone; these two rules compare fields with each other.
  .refine((question) => question.type !== "mcq" || question.options !== undefined, {
    path: ["options"],
    message: "A multiple-choice question needs options.",
  })
  .refine((question) => question.marks !== undefined || question.parts !== undefined, {
    path: ["marks"],
    message: "Give the marks, or parts with marks.",
  });

// numeric columns arrive in JavaScript as text ("7.50"), so marks are cast to float8 to get a real number.
const questionColumns = `id, section_id AS "sectionId", topic_id AS "topicId", type, text, options, parts, difficulty,
  marks::float8 AS marks, status, source, position`;

// GET /api/v1/assessments/<id>/questions: the whole paper in order, section by section, with how its marks are used so far.
// Add ?format=pdf to download the printable paper, with ?time=3 hours if it should show the time allowed.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const search = new URL(request.url).searchParams;
  const format = search.get("format");
  if (format !== null && format !== "pdf") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { format: ["Use pdf, or leave it out."] });
  }

  // The JOINs up to semesters are the ownership check.
  const [assessment] = await query<{ id: string; name: string; maxMarks: number; code: string; title: string; university: string | null }>(
    `SELECT a.id, a.name, a.max_marks::float8 AS "maxMarks", c.code, c.title, c.result_header ->> 'university' AS university
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE a.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  if (!assessment) return notFound();

  const sections = await query<{ id: string; title: string; instructions: string; attemptAny: number | null }>(
    `SELECT id, title, instructions, attempt_any AS "attemptAny", position
       FROM paper_sections WHERE assessment_id = $1 ORDER BY position`,
    [id],
  );
  const questions = await query<{
    sectionId: string;
    marks: number;
    status: string;
    text: string;
    options: string[] | null;
    parts: { label: string; text: string; marks: number }[] | null;
  }>(
    `SELECT ${questionColumns} FROM questions WHERE assessment_id = $1 ORDER BY position`,
    [id],
  );

  // Each question also needs its section's "attempt any" to work out the marks.
  const attemptAnyOf = new Map(sections.map((section) => [section.id, section.attemptAny]));
  const marksOf = (status: string) =>
    countableMarks(
      questions
        .filter((question) => question.status === status)
        .map((question) => ({ ...question, attemptAny: attemptAnyOf.get(question.sectionId) ?? null })),
    );
  if (format === null) {
    const { id: assessmentId, name, maxMarks } = assessment;
    return Response.json({
      assessment: { id: assessmentId, name, maxMarks },
      approvedMarks: marksOf("approved"),
      draftMarks: marksOf("draft"),
      sections: sections.map((section) => ({
        ...section,
        questions: questions.filter((question) => question.sectionId === section.id),
      })),
    });
  }

  // Only approved questions reach a paper: an unchecked AI draft must never be printed.
  const approved = questions.filter((question) => question.status === "approved");
  if (approved.length === 0) return errorResponse(400, "no_approved_questions", "Approve some questions first, so there's a paper to print.");

  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const left = 50;
  const right = pageWidth - 50;
  const lineHeight = 14;
  let y = 56;

  // Writes wrapped text, moving to a new page when it runs out of room.
  const write = (text: string, x: number, options: { bold?: boolean; size?: number; marks?: string; gapAfter?: number } = {}) => {
    pdf.setFont("helvetica", options.bold ? "bold" : "normal").setFontSize(options.size ?? 11);
    const room = right - x - (options.marks ? 60 : 0);
    const lines: string[] = pdf.splitTextToSize(text, room);
    if (y + lines.length * lineHeight > pageHeight - 50) {
      pdf.addPage();
      y = 56;
    }
    pdf.text(lines, x, y, { lineHeightFactor: 1.27 });
    if (options.marks) pdf.text(options.marks, right, y, { align: "right" });
    y += lines.length * lineHeight + (options.gapAfter ?? 0);
  };
  const centred = (text: string, size: number) => {
    pdf.setFont("helvetica", "bold").setFontSize(size).text(text, pageWidth / 2, y, { align: "center" });
    y += size + 5;
  };

  centred(assessment.university || "University of Karachi", 14);
  centred(`${assessment.code} ${assessment.title}`, 12);
  centred(assessment.name, 12);
  y += 4;
  const time = search.get("time")?.trim().slice(0, 40);
  pdf.setFont("helvetica", "normal").setFontSize(10);
  if (time) pdf.text(`Time allowed: ${time}`, left, y);
  const paperMarks = countableMarks(approved.map((question) => ({ ...question, attemptAny: attemptAnyOf.get(question.sectionId) ?? null })));
  pdf.text(`Total marks: ${paperMarks}`, right, y, { align: "right" });
  y += 8;
  pdf.setLineWidth(0.7).line(left, y, right, y);
  y += 22;

  // Numbered straight through the paper. An empty section (nothing approved in it) isn't printed.
  let number = 0;
  for (const section of sections) {
    const inSection = approved.filter((question) => question.sectionId === section.id);
    if (inSection.length === 0) continue;
    if (section.title) write(section.title, left, { bold: true, size: 12, gapAfter: 2 });
    if (section.instructions) write(section.instructions, left, { size: 10, gapAfter: 2 });
    if (section.attemptAny) write(`Attempt any ${section.attemptAny} of the following ${inSection.length} questions.`, left, { size: 10, gapAfter: 2 });
    y += 6;
    for (const question of inSection) {
      number += 1;
      write(`Q${number}. ${question.text}`, left, { marks: `[${question.marks}]`, gapAfter: 3 });
      (question.options ?? []).forEach((option, index) => write(`(${String.fromCharCode(97 + index)}) ${option}`, left + 22));
      for (const part of question.parts ?? []) write(`${part.label} ${part.text}`, left + 22, { marks: `[${part.marks}]`, gapAfter: 2 });
      y += 9;
    }
    y += 6;
  }

  return new Response(new Uint8Array(Buffer.from(pdf.output("arraybuffer"))), {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${assessment.code} ${assessment.name}.pdf"` },
  });
}

// PUT /api/v1/assessments/<id>/questions: put the paper in a new order. Body: { sections: [{ id, questionIds }] }
// It must list every section and every question exactly once, so nothing can be lost by accident.
// A question listed under a different section moves there.
export async function PUT(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = newOrder.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const order = parsed.data.sections;

  const result = await withTransaction(async (client) => {
    const owned = await client.query(
      `SELECT 1
         FROM assessments a
         JOIN courses c ON c.id = a.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE a.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF a`,
      [id, teacherId],
    );
    if (owned.rowCount === 0) return "not_found" as const;

    const savedSections = await client.query<{ id: string }>(`SELECT id FROM paper_sections WHERE assessment_id = $1`, [id]);
    const savedQuestions = await client.query<{ id: string }>(`SELECT id FROM questions WHERE assessment_id = $1`, [id]);
    const sectionIds = order.map((section) => section.id);
    const questionIds = order.flatMap((section) => section.questionIds);
    const sameItems = (sent: string[], saved: { id: string }[]) =>
      sent.length === saved.length && new Set(sent).size === sent.length && saved.every((row) => sent.includes(row.id));
    if (!sameItems(sectionIds, savedSections.rows) || !sameItems(questionIds, savedQuestions.rows)) return "mismatch" as const;

    // Numbered 1, 2, 3… straight through, so sorting by position alone gives the paper's order.
    let position = 0;
    for (const [index, section] of order.entries()) {
      await client.query(`UPDATE paper_sections SET position = $1 WHERE id = $2`, [index + 1, section.id]);
      for (const questionId of section.questionIds) {
        position += 1;
        await client.query(`UPDATE questions SET section_id = $1, position = $2 WHERE id = $3`, [section.id, position, questionId]);
      }
    }
    return "ok" as const;
  });

  if (result === "not_found") return notFound();
  if (result === "mismatch") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { sections: ["Must list every section and question of this paper exactly once."] });
  }
  return new Response(null, { status: 204 });
}

// POST /api/v1/assessments/<id>/questions: add a question the teacher wrote.
// It's approved straight away: the approval step exists to check AI work, and the teacher wrote this one.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = newQuestion.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }
  const { sectionId, type, text, options, parts, difficulty, marks, topicId } = parsed.data;
  // With parts, the total is always the sum of the parts, so the two can't disagree.
  const questionMarks = parts ? parts.reduce((sum, part) => sum + cents(part.marks), 0) / 100 : marks;

  const result = await withTransaction(async (client) => {
    // Lock the assessment, so two adds at once can't get the same position.
    const owned = await client.query<{ courseId: string }>(
      `SELECT a.course_id AS "courseId"
         FROM assessments a
         JOIN courses c ON c.id = a.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE a.id = $1 AND s.teacher_id = $2
        FOR UPDATE OF a`,
      [id, teacherId],
    );
    if (!owned.rows[0]) return { outcome: "not_found" } as const;

    // The topic must come from this assessment's own course.
    if (topicId) {
      const topic = await client.query(`SELECT 1 FROM topics WHERE id = $1 AND course_id = $2`, [topicId, owned.rows[0].courseId]);
      if (topic.rowCount === 0) return { outcome: "bad_topic" } as const;
    }

    // The section the teacher chose, else the last one. A brand new paper gets its first, untitled section.
    const section = await client.query<{ id: string }>(
      `SELECT id FROM paper_sections
        WHERE assessment_id = $1 AND ($2::uuid IS NULL OR id = $2)
        ORDER BY position DESC LIMIT 1`,
      [id, sectionId ?? null],
    );
    if (sectionId && !section.rows[0]) return { outcome: "bad_section" } as const;
    const section_id =
      section.rows[0]?.id ??
      (await client.query<{ id: string }>(`INSERT INTO paper_sections (assessment_id, position) VALUES ($1, 1) RETURNING id`, [id])).rows[0].id;

    const inserted = await client.query(
      `INSERT INTO questions (assessment_id, section_id, topic_id, type, text, options, parts, difficulty, marks, status, source, position)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, 'approved', 'manual',
               (SELECT COALESCE(MAX(position), 0) + 1 FROM questions WHERE assessment_id = $1))
       RETURNING ${questionColumns}`,
      [
        id,
        section_id,
        topicId ?? null,
        type,
        text,
        type === "mcq" ? JSON.stringify(options) : null,
        parts ? JSON.stringify(parts) : null,
        difficulty,
        questionMarks,
      ],
    );
    return { outcome: "ok", question: inserted.rows[0] } as const;
  });

  if (result.outcome === "not_found") return notFound();
  if (result.outcome === "bad_topic") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { topicId: ["This topic isn't in this course."] });
  }
  if (result.outcome === "bad_section") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { sectionId: ["This section isn't on this paper."] });
  }
  return Response.json({ question: result.question }, { status: 201 });
}

// PATCH /api/v1/assessments/<id>/questions: approve every draft in one tap. Body: { status: "approved" }
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = z.object({ status: z.literal("approved") }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", z.flattenError(parsed.error).fieldErrors);
  }

  if (!(await ownsAssessment(id, teacherId))) return notFound();
  const approved = await query(`UPDATE questions SET status = 'approved' WHERE assessment_id = $1 AND status = 'draft' RETURNING id`, [id]);
  return Response.json({ approved: approved.length });
}

// DELETE /api/v1/assessments/<id>/questions: clear the whole paper, so the teacher can start again.
// ?status=draft clears only the drafts, which keeps what the teacher wrote or already approved.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/assessments/[id]/questions">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && status !== "draft") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { status: ["Leave it out to clear everything, or use draft."] });
  }

  // Checked first because "0 deleted" alone can't tell an empty paper from someone else's assessment.
  if (!(await ownsAssessment(id, teacherId))) return notFound();
  const deleted = await withTransaction(async (client) => {
    const questions = await client.query(
      `DELETE FROM questions WHERE assessment_id = $1 AND ($2::text IS NULL OR status = $2) RETURNING id`,
      [id, status],
    );
    // Sections left with nothing in them would print as empty headings.
    await client.query(
      `DELETE FROM paper_sections ps
        WHERE ps.assessment_id = $1 AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.section_id = ps.id)`,
      [id],
    );
    return questions.rowCount;
  });
  return Response.json({ deleted });
}

// True if this assessment belongs to this teacher. The JOINs up to semesters are the ownership check.
async function ownsAssessment(id: string, teacherId: string) {
  const rows = await query(
    `SELECT 1
       FROM assessments a
       JOIN courses c ON c.id = a.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE a.id = $1 AND s.teacher_id = $2`,
    [id, teacherId],
  );
  return rows.length > 0;
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
