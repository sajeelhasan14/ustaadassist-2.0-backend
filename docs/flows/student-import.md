# Flow: student import (read a list → teacher confirms → save)

Files: [app/api/v1/students/extract/route.ts](../../app/api/v1/students/extract/route.ts) (step 1, POST) ·
[app/api/v1/sections/[id]/import/route.ts](../../app/api/v1/sections/[id]/import/route.ts) (step 2, POST) · uses Gemini, SheetJS (`xlsx`), tables `students`, `enrollments`, `sections`

```
teacher picks files ──► step 1: POST /students/extract ──► preview with ✅ / ⚠️ per row
                                                                  │ teacher fixes or removes ⚠️ rows, taps "Add"
                                                                  ▼
                        step 2: POST /sections/<id>/import ──► { added, created, reused, skipped }
```

# Step 1: reading a list (preview, nothing saved)

The teacher uploads a class list in **any format** (PDF, phone photos, Excel, CSV) and gets back a checked list of students to confirm.

## The idea: AI reads, our code checks

| Who | Does |
|---|---|
| **Gemini** | Turns the file into a list of `{ rollNumber, fullName, fatherName }`, plus header info (course code, class line, section). Reads by meaning, not by column position, so any layout works. Never sees our database. |
| **Our code** | Security, file limits, cleaning, checking every row against the file and the database. |
| **Teacher** | Looks at the ⚠️ rows and confirms. |

## Trace

```
POST /api/v1/students/extract   (multipart/form-data: files = 1–10 files, sectionId = optional)
 1. token → 401
 2. no files / more than 10 / over 20 MB together → 400
 3. sectionId given but not yours → 404   (we also load its course code, to compare with the file)
 4. each file, by extension:
      pdf, jpg, jpeg, png, webp, heic, heif → sent to Gemini as they are (base64)
      xlsx, xls, csv → SheetJS turns every sheet into CSV text → sent as text, and the text is KEPT
      anything else → 400 unsupported_file
 5. Gemini call:
      systemInstruction = how to read class lists (any layout, join split pages, copy exactly, never invent)
      responseJsonSchema = z.toJSONSchema(extraction) → it MUST answer in our JSON shape
      thinking = LOW (faster), 45 s limit per model
      models tried in order: gemini-3.8-flash → gemini-3.7-flash → gemini-3.5-flash
        (next one on busy / quota / too slow / network error; stop on 400/401/403)
      all fail → 502 ai_failed
 6. extraction.safeParse(answer): the same Zod schema checks the reply → 502 if the shape is wrong
 ── no AI from here ──
 7. clean each row: Greek/Cyrillic look-alikes → English letters, single spaces, seat number in CAPITALS without spaces
 8. one SQL query: which seat numbers do I already have, and in which section of THIS course
 9. one status per row (first match wins):
      missing_data        no seat number or name                          needs a look
      duplicate_in_file   seat number appears twice in this list           needs a look
      not_in_file         (Excel/CSV only) seat number not in the file     needs a look
      seat_number_taken   I already have this seat number, other name      needs a look
      already_enrolled    already in this section                          skipped
      in_other_section    already in another section of this course        skipped
      existing            already my student (another course), same name   ready (reused)
      new                                                                  ready
10. warnings: no students found; file's course code or section ≠ the section being imported into
   ▼
200 { "list": { courseCode, courseTitle, classLabel, sectionName },
      "students": [ { row, rollNumber, fullName, fatherName, status, message } ],
      "warnings": [ "..." ] }
```

`list` is used to **pre-fill a new course** (code, title, class line, section) and later for the **result sheet header**.

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

Test data: a CSV in the university's layout (title lines, `S#, Seat No:, Student Name, Father's Name`, rows 21/22 sharing `…056`, a Greek "ΑΚΗΤΑR", empty rows 66/67, signature line) and an Excel file in a **completely different layout** (title, `Name of Student, Email, Reg #, Father / Guardian`, lowercase reg no, double space, total line).

| Case | Result |
|---|---|
| no token / `.txt` file / unknown section | 401 / 400 unsupported_file / 404 |
| university CSV, no section | header read as SE-454, "BS(Software Engineering) 2nd Year 3rd Semester 2025", section A; 9 students; `…056` twice → both `duplicate_in_file`; "NASIR ΑΚΗΤΑR" → "NASIR AKHTAR"; blank father → null; empty rows and signature ignored |
| same CSV, seat no `…005` already mine as "SOMEONE ELSE" | `seat_number_taken` |
| same CSV into CS-201 section B (Ghani is in CS-201 A) | 2 warnings (course and section differ); Ghani `in_other_section` |
| same CSV into CS-201 section A | Ghani `already_enrolled` |
| different-layout Excel | all 3 students found, `cs-2025-022` → `CS-2025-022`, "Bilal  Ahmed" → "Bilal Ahmed", email and total line ignored, header CS-201 / Data Structures / section B |
| newest models busy (503) or 5-minute slow answer, network timeout | fell back to the next model; answer in 5–47 s |

## Try it (PowerShell, in `backend/`, dev server running)

Log in as in [courses.md](courses.md) so `$login` and `$api` are set. Windows PowerShell 5.1 can't upload files easily, so we use `curl.exe` (built into Windows 10). Each `-F` is one form field; `@` means "attach this file".

```powershell
$token = $login.access_token
# a PDF, a photo, or an Excel/CSV file
$r = curl.exe -s -X POST "$api/students/extract" -H "Authorization: Bearer $token" -F "files=@C:\path\to\Sec A 2026.pdf" | ConvertFrom-Json
# several photos of one list: repeat -F files=@...
# $r = curl.exe -s -X POST "$api/students/extract" -H "Authorization: Bearer $token" -F "files=@page1.jpg" -F "files=@page2.jpg" | ConvertFrom-Json
$r.list
$r.warnings
$r.students | Format-Table row, status, rollNumber, fullName, fatherName, message
```

To also compare with an existing section, add `-F "sectionId=<section id>"`.

# Step 2: saving the confirmed rows

File: [app/api/v1/sections/[id]/import/route.ts](../../app/api/v1/sections/[id]/import/route.ts) (POST)

The app sends the rows the teacher kept (the ✅ ones, plus any ⚠️ rows they fixed). Everything is saved in **one transaction**, so the list is either fully saved or not saved at all. A half-saved class is never left behind.

**Why not call `POST /sections/<id>/students` once per student?** 60 calls would be slow, and if call 40 failed, 39 students would be saved and the rest not. That route stays for adding one forgotten student by hand.

## Trace

```
POST /api/v1/sections/<sectionId>/import
{ "students": [ { "rollNumber": "EB24210106003", "fullName": "ABDUL GHANI", "fatherName": "MUHAMMAD AFZAL" }, ... ] }
 1. token → 401
 2. sectionId not a UUID → 404
 3. Zod (same cleaning as the single-student route: trim, single spaces, seat no in CAPITALS, blank father → null)
      empty list, more than 500, blank seat no / name → 400 invalid_input, with { problems: [{ row, field, message }] }
 4. same seat number twice in the body → 400 duplicate_in_list   (the teacher must fix rows like 21/22 "…056" first)
 ── one transaction from here ──
 5. section not yours → 404
 6. ONE SELECT: which of these seat numbers I already have, and which section of THIS course each one is in
 7. any seat number that belongs to a DIFFERENT name → 409 seat_number_taken, { conflicts: [...] }   NOTHING is saved
 8. split the rows:
      already in this section             → skipped (already_enrolled)
      in another section of this course   → skipped (in_other_section)
      everyone else                       → to add
 9. ONE INSERT … SELECT FROM unnest(seat nos, names, fathers) ON CONFLICT DO NOTHING
      creates every new student; students I already have (from another course) are left as they are
10. ONE INSERT INTO enrollments … WHERE roll_number = ANY(seat nos) ON CONFLICT DO NOTHING
      enrolls new and reused students together
   ▼
200 { "added": 3, "created": 2, "reused": 1,
      "skipped": [ { rollNumber, fullName, fatherName, reason: "in_other_section", message: "Already in section B of this course." } ] }
```

- `added` = students now in this section, `created` = brand-new students, `reused` = students you already had from another course.
- Skipped rows are **not errors**. The preview already showed them as "skipped", so the import doesn't fail because of them.
- Importing the same list twice is harmless: the second time everyone is skipped as `already_enrolled`.
- An existing student's details (name, father's name) are **never changed** by an import. Editing a student is Step 1.6c.

## Tested (real HTTP calls, temporary teacher, deleted afterwards)

Setup: SE-454 with sections A and B, plus CS-201. ABDUL GHANI (…003) already in CS-201; MUHAMMAD AFZAL (…056) already in SE-454 section B.

| Case | Result |
|---|---|
| bad token / unknown section / empty list | 401 / 404 / 400 |
| row 2 has a blank name | 400, `problems[0].row = 2` |
| `EB24210106005` and `eb24210106005` in one body | 400 duplicate_in_list (seen as the same seat no) |
| …005 plus …056 as "MUHAMMAD AHMED AFRIDI" | 409 seat_number_taken; section A still empty (…005 was **not** saved either) |
| real list into section A: `" eb24210106003 "`/`"abdul  ghani"`, …005 (father `"  "`), …007, …056 | `added 3, created 2, reused 1`; Afzal skipped `in_other_section`; Nasir's father stored as `null` |
| same list again | `added 0`, all 4 skipped |
| 70 students in one call | all created, about 1.6 s |

## Try it (PowerShell, in `backend/`, dev server running)

Log in and create a course as in [sections.md](sections.md), so `$r.section` is section "A".

```powershell
$sec = $r.section.id
$body = @{ students = @(
  @{ rollNumber = "EB24210106003"; fullName = "ABDUL GHANI"; fatherName = "MUHAMMAD AFZAL" },
  @{ rollNumber = "EB24210106005"; fullName = "NASIR AKHTAR" }
) } | ConvertTo-Json
$res = Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/import" -Headers $auth -ContentType "application/json" -Body $body
$res                       # added / created / reused
$res.skipped               # rows that were already in this course
# run the same two lines again: added = 0, both skipped as already_enrolled

# the whole flow: read a file, keep the ready rows, save them
$x = curl.exe -s -X POST "$api/students/extract" -H "Authorization: Bearer $($login.access_token)" -F "files=@C:\path\to\Sec A 2026.pdf" -F "sectionId=$sec" | ConvertFrom-Json
$ready = $x.students | Where-Object { $_.status -in "new", "existing" } | Select-Object rollNumber, fullName, fatherName
Invoke-RestMethod -Method Post -Uri "$api/sections/$sec/import" -Headers $auth -ContentType "application/json" -Body (@{ students = @($ready) } | ConvertTo-Json)
```
