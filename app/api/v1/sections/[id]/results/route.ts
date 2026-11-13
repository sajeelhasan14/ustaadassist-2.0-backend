import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { z } from "zod";
import { query } from "@/lib/db";
import { DEFAULT_GRADE_SCALE, gradeFor, type GradeBand } from "@/lib/grades";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Header = {
  university?: string;
  examination?: string;
  faculty?: string;
  programme?: string;
  department?: string;
  majorDepartment?: string;
  className?: string;
  year?: string;
  semester?: string;
  examDate?: string;
};

// GET /api/v1/sections/<id>/results: the result sheet, worked out from the marks.
// Add ?format=xlsx or ?format=pdf to download it. Nothing is stored: change a mark and the sheet follows.
// Theory = marks from non-lab assessments, Lab = marks from lab assessments (assessments.is_lab).
// Pass rule: a component fails below half of its own maximum. So 40/80 and 10/20 on a 2+1 course, 50/100 on a 3+0.
// The grade comes from the total only, so a failed component can still show a passing letter, as on the real sheets.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/sections/[id]/results">) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const { id: sectionId } = await ctx.params;
  if (!z.uuid().safeParse(sectionId).success) return notFound();

  const format = new URL(request.url).searchParams.get("format");
  if (format !== null && format !== "xlsx" && format !== "pdf") {
    return errorResponse(400, "invalid_input", "Some fields are invalid.", { format: ["Use xlsx or pdf, or leave it out."] });
  }

  // The JOINs up to semesters are the ownership check.
  const [course] = await query<{
    id: string;
    code: string;
    title: string;
    creditHours: string;
    totalMarks: number;
    resultHeader: Header | null;
    gradeScale: GradeBand[] | null;
    sectionName: string;
    teacherName: string;
  }>(
    `SELECT c.id, c.code, c.title, c.credit_hours AS "creditHours", c.total_marks::float8 AS "totalMarks",
            c.result_header AS "resultHeader", c.grade_scale AS "gradeScale", sec.name AS "sectionName", t.full_name AS "teacherName"
       FROM sections sec
       JOIN courses c ON c.id = sec.course_id
       JOIN semesters s ON s.id = c.semester_id
       JOIN teachers t ON t.id = s.teacher_id
      WHERE sec.id = $1 AND s.teacher_id = $2`,
    [sectionId, teacherId],
  );
  if (!course) return notFound();

  // Not filled in for this course yet: reuse the teacher's latest one, so nobody types the department twice.
  const [latest] = course.resultHeader
    ? []
    : await query<{ resultHeader: Header }>(
        `SELECT c.result_header AS "resultHeader"
           FROM courses c JOIN semesters s ON s.id = c.semester_id
          WHERE s.teacher_id = $1 AND c.result_header IS NOT NULL
          ORDER BY c.created_at DESC LIMIT 1`,
        [teacherId],
      );
  const header: Header = { ...(course.resultHeader ?? latest?.resultHeader ?? {}) };

  const assessments = await query<{ id: string; maxMarks: number; isLab: boolean }>(
    `SELECT id, max_marks::float8 AS "maxMarks", is_lab AS "isLab" FROM assessments WHERE course_id = $1`,
    [course.id],
  );
  const students = await query<{ id: string; rollNumber: string; fullName: string; fatherName: string | null }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName", st.father_name AS "fatherName"
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

  const labMax = assessments.filter((assessment) => assessment.isLab).reduce((sum, assessment) => sum + cents(assessment.maxMarks), 0) / 100;
  const hasLab = labMax > 0;
  const theoryMax = (cents(course.totalMarks) - cents(labMax)) / 100;

  const rows = students.map((student) => {
    const entered = assessments.flatMap((assessment) => {
      const mark = markOf.get(`${student.id} ${assessment.id}`);
      return mark === undefined ? [] : [{ isLab: assessment.isLab, mark }];
    });
    const sumOf = (isLab: boolean) => entered.filter((item) => item.isLab === isLab).reduce((sum, item) => sum + cents(item.mark), 0) / 100;
    const theory = sumOf(false);
    const lab = sumOf(true);
    const total = (cents(theory) + cents(lab)) / 100;
    const missing = assessments.length - entered.length;
    // No mark at all means the student didn't appear. A real 0 has a row, so it isn't absent.
    const absent = entered.length === 0;
    const percentage = Math.round((total / course.totalMarks) * 1000) / 10;

    const failedTheory = cents(theory) * 2 < cents(theoryMax);
    const failedLab = hasLab && cents(lab) * 2 < cents(labMax);
    const remarks = absent
      ? "Absent"
      : !hasLab
        ? failedTheory
          ? "Fail"
          : "Passes"
        : failedTheory && failedLab
          ? "Fail in Th. & Pr."
          : failedTheory
            ? "Fail in Theory"
            : failedLab
              ? "Fail in Pract."
              : "Passes";

    return {
      ...student,
      theory: absent ? null : theory,
      lab: absent || !hasLab ? null : lab,
      total: absent ? null : total,
      totalInWords: absent ? null : totalInWords(total),
      percentage: absent ? null : percentage,
      // The course's own grade scale; a course that never changed it uses the default one.
      grade: absent ? null : gradeFor(course.gradeScale ?? DEFAULT_GRADE_SCALE, percentage),
      remarks,
      absent,
      missing,
    };
  });

  const count = (remark: (text: string) => boolean) => rows.filter((row) => remark(row.remarks)).length;
  const sheet = {
    course: { id: course.id, code: course.code, title: course.title, creditHours: course.creditHours, totalMarks: course.totalMarks },
    section: course.sectionName,
    teacher: course.teacherName,
    header,
    hasLab,
    theoryMax,
    labMax,
    summary: {
      students: rows.length,
      passed: count((text) => text === "Passes"),
      failed: count((text) => text.startsWith("Fail")),
      absent: count((text) => text === "Absent"),
      // Students with some marks but not all: the sheet isn't final until these are entered.
      incomplete: rows.filter((row) => !row.absent && row.missing > 0).length,
    },
    students: rows,
  };

  if (format === null) return Response.json(sheet);

  // Same name twice in a class: the father's name tells them apart, as on the real sheets.
  const nameCount = new Map<string, number>();
  for (const row of rows) nameCount.set(row.fullName, (nameCount.get(row.fullName) ?? 0) + 1);
  const shownName = (row: (typeof rows)[number]) =>
    (nameCount.get(row.fullName) ?? 0) > 1 && row.fatherName ? `${row.fullName} S/o ${row.fatherName}` : row.fullName;

  const titleLines = [
    header.university || "University of Karachi",
    header.examination || "(SEMESTER EXAMINATION)",
    header.faculty || "FACULTY OF SCIENCE",
    header.programme || "(EVENING PROGRAMME)",
  ];
  const details: [string, string][] = [
    ["Department", header.department ?? ""],
    ["Major Department", header.majorDepartment ?? ""],
    ["Class", header.className ?? ""],
    ["Year", header.year ?? ""],
    ["Semester", header.semester ?? ""],
    ["Teacher's Name", course.teacherName],
    ["Date of Examination held", header.examDate ?? ""],
    ["Course No.", course.code],
    ["Course Title", course.title],
    ["Credit Hours", course.creditHours],
    ["Section", course.sectionName],
  ];
  const columns = [
    "S.#",
    "Seat No.",
    "Student's Name",
    ...(hasLab ? [`Theory (${theoryMax})`, `Lab (${labMax})`] : []),
    "Total in Words",
    "NG",
    "AG",
    "Remarks",
  ];
  const dash = "----";
  const body = rows.map((row, index) => [
    index + 1,
    row.rollNumber,
    shownName(row),
    ...(hasLab ? [row.theory ?? dash, row.lab ?? dash] : []),
    row.totalInWords ?? dash,
    row.total ?? dash,
    row.grade ?? dash,
    row.absent ? dash : row.remarks,
  ]);
  const fileName = `Result ${course.code} Sec ${course.sectionName}.${format}`;

  if (format === "xlsx") {
    const sheetRows = [
      ...titleLines.map((line) => [line]),
      [],
      ...details,
      [],
      columns,
      ...body,
      [],
      ["Dated:", "", "Signature of Teacher:", "", "Chairman:"],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
    worksheet["!cols"] = columns.map((column) => ({ wch: column === "Student's Name" ? 32 : column === "Total in Words" ? 24 : column === "Seat No." ? 18 : 10 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `Section ${course.sectionName}`.slice(0, 31));
    return download(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), fileName, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  // Legal size, like the real sheet. The header repeats on every page.
  const pdf = new jsPDF({ unit: "pt", format: "legal" });
  const width = pdf.internal.pageSize.getWidth();
  const drawHeader = () => {
    pdf.setFont("helvetica", "bold").setFontSize(13);
    titleLines.forEach((line, index) => {
      if (index === 1) pdf.setFontSize(10);
      pdf.text(line, width / 2, 34 + index * 13, { align: "center" });
    });
    pdf.setFontSize(9);
    details.forEach(([label, value], index) => {
      const x = index % 2 === 0 ? 40 : width / 2 + 10;
      const y = 96 + Math.floor(index / 2) * 13;
      pdf.setFont("helvetica", "bold").text(`${label}:`, x, y);
      // Measured while still bold, because that's how the label was printed.
      const labelWidth = pdf.getTextWidth(`${label}:`);
      pdf.setFont("helvetica", "normal").text(value, x + labelWidth + 5, y);
    });
  };
  autoTable(pdf, {
    head: [columns],
    body,
    margin: { top: 180, left: 40, right: 40, bottom: 70 },
    styles: { fontSize: 8, cellPadding: 3, lineWidth: 0.5, lineColor: 0, textColor: 0 },
    headStyles: { fillColor: [235, 235, 235], textColor: 0 },
    didDrawPage: drawHeader,
    // Absent students are highlighted, as on the real sheet.
    didParseCell: (cell) => {
      if (cell.section === "body" && rows[cell.row.index]?.absent) cell.cell.styles.fillColor = [255, 245, 150];
    },
  });
  const pages = pdf.getNumberOfPages();
  const height = pdf.internal.pageSize.getHeight();
  pdf.setPage(pages).setFont("helvetica", "normal").setFontSize(10);
  pdf.text("Dated: ____________", 40, height - 34);
  pdf.text("Signature of Teacher: ____________", width / 2, height - 34, { align: "center" });
  pdf.text("Chairman: ____________", width - 40, height - 34, { align: "right" });
  return download(Buffer.from(pdf.output("arraybuffer")), fileName, "application/pdf");
}

// 72 → "Seventy Two", 70 → "Seventy only", 100 → "One Hundred", 0 → "Zero", 72.5 → "Seventy Two Point Five".
function totalInWords(total: number) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const digits = ["Zero", ...ones.slice(1, 10)];

  const whole = Math.floor(total);
  const decimals = String(Math.round((total - whole) * 100)).padStart(2, "0").replace(/0+$/, "");
  const belowHundred = whole % 100;
  const words = [
    whole >= 100 ? `${ones[Math.floor(whole / 100)]} Hundred` : "",
    belowHundred < 20 ? ones[belowHundred] : `${tens[Math.floor(belowHundred / 10)]} ${ones[belowHundred % 10]}`.trim(),
  ]
    .filter(Boolean)
    .join(" ");

  if (decimals !== "") return `${words || "Zero"} Point ${[...decimals].map((digit) => digits[Number(digit)]).join(" ")}`;
  if (whole === 0) return "Zero";
  // Only tens end in "only" on the real sheets: "Seventy only", but "One Hundred" and "Seventy Two".
  return belowHundred !== 0 && belowHundred % 10 === 0 ? `${words} only` : words;
}

// Send a file. The browser or app saves it under this name.
function download(file: Buffer, fileName: string, type: string) {
  return new Response(new Uint8Array(file), {
    headers: { "content-type": type, "content-disposition": `attachment; filename="${fileName}"` },
  });
}

// 7.5 → 750. Whole numbers add up exactly; decimals don't.
function cents(marks: number) {
  return Math.round(marks * 100);
}

// Same answer for "doesn't exist" and "belongs to someone else", so ids can't be probed.
function notFound() {
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
