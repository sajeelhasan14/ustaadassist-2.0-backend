-- Phase 1: how a teacher's work is organised.
-- teacher → semesters → courses → sections + topics; students ↔ sections through enrollments.

-- A teaching term, e.g. "Fall 2026".
create table public.semesters (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  unique (teacher_id, name),
  check (end_date >= start_date)
);

-- A subject taught in one semester, e.g. "CS-101 Data Structures".
-- Teaching it again next semester is a new course row.
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters (id) on delete cascade,
  code text not null,
  title text not null,
  created_at timestamptz not null default now(),
  unique (semester_id, code)
);

-- One class group taking a course, e.g. "BSCS-A".
create table public.sections (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (course_id, name)
);

-- The course outline, in teaching order (position 1, 2, 3, ...).
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  title text not null,
  position integer not null,
  created_at timestamptz not null default now()
);
create index topics_course_id_idx on public.topics (course_id);

-- A student the teacher teaches. One student can be enrolled in several sections.
create table public.students (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  roll_number text not null,
  full_name text not null,
  email text,
  created_at timestamptz not null default now(),
  unique (teacher_id, roll_number)
);

-- Which student is in which section (many-to-many).
create table public.enrollments (
  section_id uuid not null references public.sections (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (section_id, student_id)
);
create index enrollments_student_id_idx on public.enrollments (student_id);

-- Close Supabase's automatic REST API on every table (see the teachers migration).
alter table public.semesters enable row level security;
alter table public.courses enable row level security;
alter table public.sections enable row level security;
alter table public.topics enable row level security;
alter table public.students enable row level security;
alter table public.enrollments enable row level security;
