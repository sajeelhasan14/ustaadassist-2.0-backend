import { query } from "@/lib/db";

// Pakistan's public holidays, worked out for any dates, so teachers never type them in.
// Used by the off-days list, the class calendar and Today (all add the missing ones to the off_days table).
// Holidays belong to one course: each course has its own list (decision of 2026-11-09).

// Same date every year.
const nationalHolidays = [
  { date: "02-05", key: "kashmir-day", name: "Kashmir Solidarity Day" },
  { date: "03-23", key: "pakistan-day", name: "Pakistan Day" },
  { date: "05-01", key: "labour-day", name: "Labour Day" },
  { date: "05-28", key: "youm-e-takbeer", name: "Youm-e-Takbeer" },
  { date: "08-14", key: "independence-day", name: "Independence Day" },
  { date: "11-09", key: "iqbal-day", name: "Iqbal Day" },
  { date: "12-25", key: "quaid-day", name: "Quaid-e-Azam Day" },
];

// Islamic (Hijri) month and day. The real date depends on the moon sighting, so these are tentative.
const islamicHolidays = [
  { month: 1, day: 9, days: 2, key: "ashura", name: "Ashura" },
  { month: 3, day: 12, days: 1, key: "eid-milad-un-nabi", name: "Eid Milad-un-Nabi" },
  { month: 10, day: 1, days: 3, key: "eid-ul-fitr", name: "Eid ul Fitr" },
  { month: 12, day: 10, days: 3, key: "eid-ul-adha", name: "Eid ul Adha" },
];

// Built into Node: turns a date into the Umm al-Qura Hijri calendar (the one Saudi Arabia publishes in advance).
const hijri = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });

export type BuiltInHoliday = { key: string; name: string; startDate: string; endDate: string; tentative: boolean };

// Every holiday that touches the days from..to (both "YYYY-MM-DD").
export function builtInHolidays(from: string, to: string): BuiltInHoliday[] {
  const holidays: BuiltInHoliday[] = [];
  // Start 3 days early, so a 3-day Eid that began just before `from` is still found.
  for (let date = addDays(from, -3); date <= to; date = addDays(date, 1)) {
    const year = date.slice(0, 4);
    for (const holiday of nationalHolidays) {
      if (date.slice(5) === holiday.date) {
        holidays.push({ key: `${holiday.key}-${year}`, name: holiday.name, startDate: date, endDate: date, tentative: false });
      }
    }

    const parts = Object.fromEntries(hijri.formatToParts(new Date(`${date}T00:00:00Z`)).map((part) => [part.type, part.value]));
    for (const holiday of islamicHolidays) {
      if (Number(parts.month) === holiday.month && Number(parts.day) === holiday.day) {
        // Keyed by the Hijri year: some Gregorian years have the same Eid twice.
        holidays.push({
          key: `${holiday.key}-${parseInt(parts.year)}`,
          name: holiday.name,
          startDate: date,
          endDate: addDays(date, holiday.days - 1),
          tentative: true,
        });
      }
    }
  }
  return holidays.filter((holiday) => holiday.endDate >= from);
}

// "2026-08-31" + 1 → "2026-09-01". Works in UTC so the server's timezone can't shift the day.
export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// Adds the public holidays between from..to that this course doesn't have yet.
// ON CONFLICT on (course_id, holiday_key) skips ones already there, including ones the teacher moved or
// deleted (deleted ones stay as removed = true), so their choice is kept.
export async function addPublicHolidays(teacherId: string, courseId: string, from: string, to: string): Promise<void> {
  const holidays = builtInHolidays(from, to);
  if (holidays.length === 0) return;
  await query(
    `INSERT INTO off_days (teacher_id, course_id, holiday_key, name, start_date, end_date, tentative)
     SELECT $1::uuid, $2::uuid, * FROM unnest($3::text[], $4::text[], $5::date[], $6::date[], $7::boolean[])
     ON CONFLICT (course_id, holiday_key) DO NOTHING`,
    [
      teacherId,
      courseId,
      holidays.map((holiday) => holiday.key),
      holidays.map((holiday) => holiday.name),
      holidays.map((holiday) => holiday.startDate),
      holidays.map((holiday) => holiday.endDate),
      holidays.map((holiday) => holiday.tentative),
    ],
  );
}

