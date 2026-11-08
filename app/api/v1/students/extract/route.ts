import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import * as XLSX from "xlsx";
import { z } from "zod";
import { aiIsOpenAI, answerShape, askAI, readJsonReply } from "@/lib/ai";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Per model. Reading several pages takes longer than lib/ai.ts's default.
const MODEL_TIME_LIMIT_MS = 45_000;

const MAX_FILES = 10;
// Gemini accepts about 20 MB of files inside one request (OpenAI 50 MB), so 20 MB works with both.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// Accepted files, by extension: phones and browsers report file types inconsistently (Windows often calls a CSV "Excel").
// "document" files go to the AI as they are; "sheet" files are turned into text first.
const fileTypes: Record<string, { kind: "document" | "sheet"; mimeType: string }> = {
  pdf: { kind: "document", mimeType: "application/pdf" },
  jpg: { kind: "document", mimeType: "image/jpeg" },
  jpeg: { kind: "document", mimeType: "image/jpeg" },
  png: { kind: "document", mimeType: "image/png" },
  webp: { kind: "document", mimeType: "image/webp" },
  heic: { kind: "document", mimeType: "image/heic" },
  heif: { kind: "document", mimeType: "image/heif" },
  xlsx: { kind: "sheet", mimeType: "" },
  xls: { kind: "sheet", mimeType: "" },
  csv: { kind: "sheet", mimeType: "" },
};

// The answer the AI must give. The same schema is sent to the AI (as JSON Schema) and then checks its reply.
const extraction = z.object({
  courseCode: z.string().nullable().describe('Course code or number printed on the list, e.g. "SE-454". null if not printed.'),
  courseTitle: z.string().nullable().describe("Course name printed on the list. null if not printed."),
  classLabel: z
    .string()
    .nullable()
    .describe('The line naming the class, e.g. "BS(Software Engineering) 2nd Year 3rd Semester". null if not printed.'),
  sectionName: z.string().nullable().describe('Section, e.g. "A" for "Section A". null if not printed.'),
  students: z.array(
    z.object({
      rollNumber: z.string().describe("Seat / roll / registration number exactly as printed. Empty string if unreadable."),
      fullName: z.string().describe("Student's name exactly as printed. Empty string if unreadable."),
      fatherName: z.string().nullable().describe("Father's name if the list has one for this student, else null."),
    }),
  ),
});

const instructions = `You read class lists (lists of students) from a university and return them as data.
- Find every student in the files, in the order they appear.
- The files can be a PDF, photos of printed pages, or spreadsheet text, in any layout and with any column names.
- Several files or pages can be one list. A wide table can be split across pages (for example names on one page and fathers' names on a later page): join the parts back together by row order or serial number.
- Copy seat numbers and names exactly as printed. Never correct, guess or invent a value. If something is unreadable, return an empty string (or null for fatherName).
- Ignore empty rows, signatures, dates, attendance marks, percentages and anything else that is not a student.`;

// Letters from other alphabets that look exactly like English ones. PDF text often contains them (e.g. Greek "ΑΚΗΤΑR").
const lookAlikes: Record<string, string> = {
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X",
  ο: "o", а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y",
};

// "NASIR  ΑΚΗΤΑR " → "NASIR AKHTAR": normal letters, single spaces, no spaces at the ends.
function cleanText(value: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[Ͱ-ϿЀ-ӿ]/g, (letter) => lookAlikes[letter] ?? letter)
    .replace(/\s+/g, " ")
    .trim();
}

// Only letters and digits, in capitals: "SE - 454" and "se454" compare as equal.
function compact(value: string): string {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// POST /api/v1/students/extract: read students from PDFs, photos or Excel/CSV files. Nothing is saved.
// Body: multipart/form-data with "files" (1–10) and optional "sectionId" (the section the teacher is importing into).
export async function POST(request: Request) {
  const teacherId = await getTeacherId(request);
  if (!teacherId) return errorResponse(401, "unauthorized", "Missing or invalid login token.");

  const form = await request.formData().catch(() => null);
  if (!form) return errorResponse(400, "invalid_input", "Send the files as multipart/form-data.");

  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  if (files.length === 0) return errorResponse(400, "invalid_input", "Add at least one file.");
  if (files.length > MAX_FILES) return errorResponse(400, "invalid_input", `Send at most ${MAX_FILES} files at once.`);
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    return errorResponse(400, "file_too_large", "The files are too large together (20 MB at most).");
  }

  // If the teacher is importing into a section, it must be theirs. We also need its course code to compare with the file.
  const sectionId = form.get("sectionId");
  let section: { id: string; name: string; courseId: string; courseCode: string } | undefined;
  if (sectionId) {
    if (typeof sectionId !== "string" || !z.uuid().safeParse(sectionId).success) return sectionNotFound();
    [section] = await query<{ id: string; name: string; courseId: string; courseCode: string }>(
      `SELECT sec.id, sec.name, c.id AS "courseId", c.code AS "courseCode"
         FROM sections sec
         JOIN courses c ON c.id = sec.course_id
         JOIN semesters s ON s.id = c.semester_id
        WHERE sec.id = $1 AND s.teacher_id = $2`,
      [sectionId, teacherId],
    );
    if (!section) return sectionNotFound();
  }

  // Build what the AI will read. Sheets become text, and that text is also kept to check the AI's answer against.
  const parts: ChatCompletionContentPart[] = [];
  let sheetText = "";
  for (const file of files) {
    const type = fileTypes[file.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!type) {
      return errorResponse(400, "unsupported_file", `"${file.name}" isn't a PDF, photo, Excel or CSV file.`);
    }
    // OpenAI reads PNG, JPEG, WEBP and GIF photos, not the iPhone's HEIC. Gemini reads HEIC too.
    if (type.mimeType.startsWith("image/hei") && aiIsOpenAI()) {
      return errorResponse(400, "unsupported_file", `"${file.name}" is a HEIC photo. Please share it as JPG instead.`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (type.kind === "document") {
      const dataUrl = `data:${type.mimeType};base64,${bytes.toString("base64")}`;
      // The two companies take a PDF differently: OpenAI as a "file" part, Gemini in the image field.
      if (type.mimeType === "application/pdf" && aiIsOpenAI()) {
        parts.push({ type: "file", file: { filename: file.name, file_data: dataUrl } });
      } else {
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
      }
      continue;
    }
    try {
      // CSV is read as UTF-8 text so names in other scripts survive; xlsx/xls are read as bytes.
      const workbook = file.name.toLowerCase().endsWith(".csv")
        ? XLSX.read(bytes.toString("utf8"), { type: "string" })
        : XLSX.read(bytes, { type: "buffer" });
      const text = workbook.SheetNames.map(
        (name) => `Sheet "${name}":\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false })}`,
      ).join("\n\n");
      sheetText += text + "\n";
      parts.push({ type: "text", text: `File "${file.name}":\n${text}` });
    } catch {
      return errorResponse(400, "unreadable_file", `"${file.name}" couldn't be opened. Is it damaged?`);
    }
  }
  // Seat numbers can only be checked against the file when every file was a sheet (photos and PDFs have no text we keep).
  const canCheckAgainstFile = files.every((file) => fileTypes[file.name.split(".").pop()!.toLowerCase()].kind === "sheet");

  // The AI step: it reads the files and fills in the `extraction` shape. It never sees our database.
  // lib/ai.ts picks the company and model from .env.local, and tries the next model if one is busy.
  // Copying a list needs little reasoning, so lib/ai.ts's default "low" is kept.
  let answer: unknown;
  try {
    const completion = await askAI(
      {
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: parts },
        ],
        response_format: answerShape("class_list", extraction),
      },
      MODEL_TIME_LIMIT_MS,
    );
    answer = readJsonReply(completion);
  } catch (error) {
    console.error("Student list extraction failed:", error);
    return errorResponse(502, "ai_failed", "Couldn't read the file right now. Please try again.");
  }
  const parsed = extraction.safeParse(answer);
  if (!parsed.success) {
    return errorResponse(502, "ai_failed", "Couldn't read this file. Try a clearer photo or another format.");
  }

  // From here on, no AI: clean every row, then check it.
  const students = parsed.data.students.map((student, index) => ({
    row: index + 1,
    rollNumber: cleanText(student.rollNumber).replace(/\s/g, "").toUpperCase(),
    fullName: cleanText(student.fullName),
    fatherName: cleanText(student.fatherName) || null,
  }));

  const timesInFile = new Map<string, number>();
  for (const { rollNumber } of students) timesInFile.set(rollNumber, (timesInFile.get(rollNumber) ?? 0) + 1);
  const fileSeatNumbers = compact(sheetText);

  // Which of these seat numbers the teacher already has, and (when importing into a section) which section of
  // this course they're in. A student sits in only one section of a course, so the LEFT JOIN finds at most one.
  const existing = await query<{ id: string; rollNumber: string; fullName: string; sectionId: string | null; sectionName: string | null }>(
    `SELECT st.id, st.roll_number AS "rollNumber", st.full_name AS "fullName", sec.id AS "sectionId", sec.name AS "sectionName"
       FROM students st
       LEFT JOIN (enrollments e JOIN sections sec ON sec.id = e.section_id AND sec.course_id = $3)
              ON e.student_id = st.id
      WHERE st.teacher_id = $1 AND st.roll_number = ANY($2::text[])`,
    [teacherId, students.map((student) => student.rollNumber), section?.courseId ?? null],
  );
  const bySeatNumber = new Map(existing.map((student) => [student.rollNumber, student]));

  // One status per row. "new" and "existing" are ready to add; "already_enrolled" and "in_other_section" are skipped;
  // everything else needs the teacher to look.
  const rows = students.map((student) => {
    const found = bySeatNumber.get(student.rollNumber);
    if (!student.rollNumber || !student.fullName) {
      return { ...student, status: "missing_data", message: "Seat number or name is missing." };
    }
    if (timesInFile.get(student.rollNumber)! > 1) {
      return { ...student, status: "duplicate_in_file", message: `Seat number ${student.rollNumber} appears more than once in this list.` };
    }
    if (canCheckAgainstFile && !fileSeatNumbers.includes(compact(student.rollNumber))) {
      return { ...student, status: "not_in_file", message: "This seat number wasn't found in the file. Please check it." };
    }
    if (found && found.fullName.toUpperCase() !== student.fullName.toUpperCase()) {
      return { ...student, status: "seat_number_taken", message: `Seat number ${student.rollNumber} already belongs to ${found.fullName}.` };
    }
    if (found?.sectionId && found.sectionId === section?.id) {
      return { ...student, status: "already_enrolled", message: "Already in this section." };
    }
    if (found?.sectionId) {
      return { ...student, status: "in_other_section", message: `Already in section ${found.sectionName} of this course.` };
    }
    if (found) return { ...student, status: "existing", message: "Already your student; will be reused." };
    return { ...student, status: "new", message: null };
  });

  const { courseCode, courseTitle, classLabel, sectionName } = parsed.data;
  const list = {
    courseCode: cleanText(courseCode).replace(/\s*-\s*/g, "-") || null, // "SE - 454" → "SE-454"
    courseTitle: cleanText(courseTitle) || null,
    classLabel: cleanText(classLabel) || null,
    sectionName: cleanText(sectionName).replace(/^section\s*/i, "") || null, // "Section A" → "A"
  };

  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("No students were found in these files.");
  if (section && list.courseCode && compact(list.courseCode) !== compact(section.courseCode)) {
    warnings.push(`This list is for ${list.courseCode}, but you're importing into ${section.courseCode}.`);
  }
  if (section && list.sectionName && compact(list.sectionName) !== compact(section.name)) {
    warnings.push(`This list is for section ${list.sectionName}, but you're importing into section ${section.name}.`);
  }

  return Response.json({ list, students: rows, warnings });
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
