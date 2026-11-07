import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { z } from "zod";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/v1/sections/<id>/attendance?min=75: each student's attendance in this section.
// percentage = present ÷ classes the student was marked in (so a student who joined late isn't counted absent
// for classes before they joined). shortage = below `min` percent (default: the teacher's own line, set on the Me screen).
// Add &format=xlsx or &format=pdf to download the attendance sheet: one column per class held.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/attendance">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return sectionNotFound();

  // undefined, not null: z.coerce.number() would turn null into 0. A missing or bad ?min uses the teacher's line.
  const minParam = z.coerce.number().min(0).max(100).safeParse(new URL(request.url).searchParams.get("min") ?? undefined);

  const format = new URL(request.url).searchParams.get("format");
  if (format !== null && format !== "xlsx" && format !== "pdf") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { format: ["Use xlsx or pdf, or leave it out."] });
  }

  const [section] = await query<{ held: number; name: string; code: string; title: string; minAttendance: number }>(
    `SELECT (SELECT count(*) FROM class_sessions WHERE section_id = sec.id AND status = 'held')::int AS held,
            sec.name, c.code, c.title, t.min_attendance::float8 AS "minAttendance"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
       JOIN teachers t ON t.id = s.teacher_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!section) return sectionNotFound();
  const min = minParam.success ? minParam.data : section.minAttendance;

  // Only marks from held classes count (a class cancelled after marking keeps its rows, but they're ignored).
  const rows = await query<{ id: string; rollNumber: string; fullName: string; present: number; marked: number }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName",
            count(a.student_id) FILTER (WHERE a.present)::int AS present,
            count(a.student_id)::int AS marked
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       LEFT JOIN (attendance a JOIN class_sessions cs ON cs.id = a.session_id AND cs.status = 'held')
              ON a.student_id = st.id AND cs.section_id = e.section_id
      WHERE e.section_id = $1
      GROUP BY st.id
      ORDER BY st.roll_number`,
    [sectionId],
  );

  const students = rows.map((row) => {
    // One decimal place: 13 of 15 → 86.7. null when no class has been marked yet.
    const percentage = row.marked > 0 ? Math.round((row.present / row.marked) * 1000) / 10 : null;
    return { ...row, percentage, shortage: percentage !== null && percentage < min };
  });
  if (format === null) {
    // The whole section's attendance: every present mark ÷ every mark. null until a class has been marked.
    const presentMarks = rows.reduce((sum, row) => sum + row.present, 0);
    const allMarks = rows.reduce((sum, row) => sum + row.marked, 0);
    const average = allMarks > 0 ? Math.round((presentMarks / allMarks) * 1000) / 10 : null;
    return Response.json({ held: section.held, min, average, students });
  }

  // The file needs every class, not just the totals. Dates as text, so timezones can't shift them.
  const classes = await query<{ id: string; date: string }>(
    `SELECT id, to_char(date, 'DD/MM') AS date FROM class_sessions WHERE section_id = $1 AND status = 'held' ORDER BY date, start_time`,
    [sectionId],
  );
  const marked = await query<{ sessionId: string; studentId: string; present: boolean }>(
    `SELECT a.session_id AS "sessionId", a.student_id AS "studentId", a.present
       FROM attendance a JOIN class_sessions cs ON cs.id = a.session_id
      WHERE cs.section_id = $1 AND cs.status = 'held'`,
    [sectionId],
  );
  const presentOn = new Map(marked.map((row) => [`${row.studentId} ${row.sessionId}`, row.present]));

  const title = `Attendance Sheet: ${section.code} ${section.title}, Section ${section.name}`;
  const columns = ["S.#", "Seat No.", "Student's Name", ...classes.map((item) => item.date), "%"];
  const body = students.map((student, index) => [
    index + 1,
    student.rollNumber,
    student.fullName,
    // Blank = not marked for that class, for example a student who joined later.
    ...classes.map((item) => {
      const present = presentOn.get(`${student.id} ${item.id}`);
      return present === undefined ? "" : present ? "P" : "A";
    }),
    student.percentage ?? "",
  ]);
  const fileName = `Attendance ${section.code} Sec ${section.name}.${format}`;

  if (format === "xlsx") {
    const worksheet = XLSX.utils.aoa_to_sheet([[title], [], columns, ...body, [], ["Signature of Course Superior: ____________"]]);
    worksheet["!cols"] = columns.map((column) => ({ wch: column === "Student's Name" ? 32 : column === "Seat No." ? 18 : 6 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");
    return download(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), fileName, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  // Landscape legal, like the real sheet: a semester has many class dates.
  const pdf = new jsPDF({ unit: "pt", format: "legal", orientation: "landscape" });
  autoTable(pdf, {
    head: [columns],
    body,
    margin: { top: 60, left: 24, right: 24, bottom: 50 },
    styles: { fontSize: 7, cellPadding: 2, lineWidth: 0.5, lineColor: 0, textColor: 0 },
    headStyles: { fillColor: [235, 235, 235], textColor: 0 },
    columnStyles: { 1: { cellWidth: 72 }, 2: { cellWidth: 120 } },
    didDrawPage: () => {
      pdf.setFont("helvetica", "bold").setFontSize(12).text(title, 24, 38);
    },
  });
  const height = pdf.internal.pageSize.getHeight();
  pdf.setPage(pdf.getNumberOfPages()).setFont("helvetica", "normal").setFontSize(10);
  pdf.text("Signature of Course Superior: ____________", 24, height - 22);
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
