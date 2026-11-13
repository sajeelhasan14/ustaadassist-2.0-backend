-- Every course is fully separate (decision of 2026-11-09): its own attendance line, its own holidays,
-- and its own grade scale. Existing data is moved, not lost.

-- 1. Attendance line per course. Each existing course starts with the line its teacher had.
alter table public.courses
  add column min_attendance numeric(5, 2) not null default 75
  check (min_attendance >= 0 and min_attendance <= 100);

update public.courses c
   set min_attendance = t.min_attendance
  from public.semesters s
  join public.teachers t on t.id = s.teacher_id
 where s.id = c.semester_id;

-- 2. Grade scale per course: a list of {"grade": "A+", "min": 90}, highest first. Below the lowest = F.
--    null means the default scale (the University of Karachi one, kept in lib/grades.ts).
alter table public.courses add column grade_scale jsonb;

-- 3. Holidays per course. Until now an off day belonged to the teacher and applied to every course.
--    Each one is copied into every course whose semester it touches, keeping the teacher's edits
--    (moved dates, confirmed Eid, deleted public holidays stay deleted).
alter table public.off_days add column course_id uuid references public.courses (id) on delete cascade;

insert into public.off_days (teacher_id, course_id, name, start_date, end_date, holiday_key, tentative, removed, created_at)
select o.teacher_id, c.id, o.name, o.start_date, o.end_date, o.holiday_key, o.tentative, o.removed, o.created_at
  from public.off_days o
  join public.semesters s on s.teacher_id = o.teacher_id
  join public.courses c on c.semester_id = s.id
 where o.course_id is null
   and o.start_date <= s.end_date
   and o.end_date >= s.start_date;

-- The old teacher-wide rows are now copied, so they go.
delete from public.off_days where course_id is null;

alter table public.off_days alter column course_id set not null;

-- A public holiday is added once per course now, not once per teacher.
alter table public.off_days drop constraint if exists off_days_teacher_id_holiday_key_key;
alter table public.off_days add constraint off_days_course_id_holiday_key_key unique (course_id, holiday_key);

drop index if exists public.off_days_teacher_dates_idx;
create index off_days_course_dates_idx on public.off_days (course_id, start_date);
