-- The percentage below which a student is short of attendance. One line per teacher, set on the Me screen.
alter table public.teachers
  add column min_attendance numeric(5, 2) not null default 75
  check (min_attendance >= 0 and min_attendance <= 100);

-- When an assessment happens, if the teacher chooses to say. Empty is normal: assessments are added any time,
-- and most never get a date.
alter table public.assessments add column held_on date;
