import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/v1/sections/<id>/marks: the gradebook. One row per student, one column per assessment, plus the total.
// total = plain sum of the marks entered (no weights). percentage = total ÷ the course total.
// Add ?format=xlsx or ?format=pdf to download it as a marksheet. Grades are on /sections/<id>/results.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/marks">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  const format = new URL(request.url).searchParams.get("format");
  if (format !== null && format !== "xlsx" && format !== "pdf") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { format: ["Use xlsx or pdf, or leave it out."] });
  }

  const [course] = await query<{ id: string; totalMarks: number; code: string; title: string; sectionName: string }>(
    `SELECT c.id, c.total_marks::float8 AS "totalMarks", c.code, c.title, sec.name AS "sectionName"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!course) return sectionNotFound();

  const assessments = await query<{ id: string; name: string; maxMarks: number }>(
    `SELECT id, name, max_marks::float8 AS "maxMarks" FROM assessments WHERE course_id = $1 ORDER BY position`,
    [course.id],
  );
  const students = await query<{ id: string; rollNumber: string; fullName: string }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName"
       FROM enrollments e JOIN students st ON st.id = e.student_id
      WHERE e.section_id = $1
      ORDER BY st.roll_number`,
    [sectionId],
  );
  const marks = await query<{ assessmentId: string; studentId: string; marks: number }>(
    `SELECT m.assessment_id AS "assessmentId", m.student_id AS "studentId", m.marks::float8 AS marks
       FROM marks m
       JOIN assessments a ON a.id = m.assessment_id
       JOIN enrollments e ON e.student_id = m.student_id AND e.section_id = $2
      WHERE a.course_id = $1`,
    [course.id, sectionId],
  );
  const markOf = new Map(marks.map((mark) => [`${mark.studentId} ${mark.assessmentId}`, mark.marks]));

  const rows = students.map((student) => {
    // Same order as `assessments`, so column 1 is always the first assessment. null = not entered.
    const studentMarks = assessments.map((assessment) => markOf.get(`${student.id} ${assessment.id}`) ?? null);
    const entered = studentMarks.filter((mark) => mark !== null);
    // Rounded to 2 decimals so 7.1 + 0.2 shows as 7.3, not 7.299999.
    const total = Math.round(entered.reduce((sum, mark) => sum + mark, 0) * 100) / 100;
    return {
      ...student,
      marks: studentMarks,
      total,
      percentage: Math.round((total / course.totalMarks) * 1000) / 10,
      missing: studentMarks.length - entered.length,
    };
  });

  if (format === null) {
    return Response.json({
      totalMarks: course.totalMarks,
      allocated: Math.round(assessments.reduce((sum, assessment) => sum + assessment.maxMarks, 0) * 100) / 100,
      // average = the class's mean as a % of this assessment's marks. null until someone has a mark in it.
      assessments: assessments.map((assessment, index) => {
        const entered = rows.flatMap((row) => row.marks[index] ?? []);
        const mean = entered.reduce((sum, mark) => sum + mark, 0) / entered.length;
        return { ...assessment, average: entered.length > 0 ? Math.round((mean / assessment.maxMarks) * 1000) / 10 : null };
      }),
      students: rows,
    });
  }

  const title = `Marksheet: ${course.code} ${course.title}, Section ${course.sectionName}`;
  const columns = ["S.#", "Seat No.", "Student's Name", ...assessments.map((a) => `${a.name} (${a.maxMarks})`), `Total (${course.totalMarks})`, "%"];
  // A blank cell means "not entered", which is different from a 0.
  const body = rows.map((row, index) => [index + 1, row.rollNumber, row.fullName, ...row.marks.map((mark) => mark ?? ""), row.total, row.percentage]);
  const fileName = `Marksheet ${course.code} Sec ${course.sectionName}.${format}`;

  if (format === "xlsx") {
    const worksheet = XLSX.utils.aoa_to_sheet([[title], [], columns, ...body]);
    worksheet["!cols"] = columns.map((column) => ({ wch: column === "Student's Name" ? 32 : column === "Seat No." ? 18 : 12 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Marksheet");
    return download(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), fileName, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  // Landscape: a course can have many assessments.
  const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  autoTable(pdf, {
    head: [columns],
    body,
    margin: { top: 60, left: 30, right: 30, bottom: 30 },
    styles: { fontSize: 8, cellPadding: 3, lineWidth: 0.5, lineColor: 0, textColor: 0 },
    headStyles: { fillColor: [235, 235, 235], textColor: 0 },
    didDrawPage: () => {
      pdf.setFont("helvetica", "bold").setFontSize(12).text(title, 30, 38);
    },
  });
  return download(Buffer.from(pdf.output("arraybuffer")), fileName, "application/pdf");
}

// Send a file. The browser or app saves it under this name.
function download(file: Buffer, fileName: string, type: string) {
  return new Response(new Uint8Array(file), {
    headers: { "content-type": type, "content-disposition": `attachment; filename="${fileName}"` },
  });
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function sectionNotFound() {
  return errorResponse(404, "not_found", "Section not found.");
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
