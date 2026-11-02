-- Phase 4: assessments and marks. The teacher decides everything: which assessments, how many, and how many marks
-- each is worth. A student's total is the plain sum of their marks (no weights).

-- What the course is "out of". Most are 100; the teacher can change it.
alter table public.courses
  add column total_marks numeric(6, 2) not null default 100 check (total_marks > 0);

-- Anything the teacher marks: "Quiz 1", "Assignment 2", "Mid", "Final", "Presentation"…
-- Shared by every section of the course. The sum of max_marks may not go over the course total (checked by the API).
create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  name text not null,
  max_marks numeric(6, 2) not null check (max_marks > 0),
  position integer not null,
  created_at timestamptz not null default now(),
  unique (course_id, name)
);
create index assessments_course_id_idx on public.assessments (course_id);

-- One student's marks in one assessment. No row = not entered yet (which is different from 0).
-- marks <= the assessment's max_marks is checked by the API (a check rule can't look at another table).
create table public.marks (
  assessment_id uuid not null references public.assessments (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  marks numeric(6, 2) not null check (marks >= 0),
  updated_at timestamptz not null default now(),
  primary key (assessment_id, student_id)
);
create index marks_student_id_idx on public.marks (student_id);

-- Close Supabase's automatic REST API (see the teachers migration).
alter table public.assessments enable row level security;
alter table public.marks enable row level security;
