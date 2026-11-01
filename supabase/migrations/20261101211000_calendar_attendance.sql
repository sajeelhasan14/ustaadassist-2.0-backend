-- Phase 2: when classes happen, and who attended.
-- Ordinary classes are NOT stored: they are worked out from timetable_slots + the semester dates − off_days.
-- Only classes worth remembering (held, cancelled, extra) become class_sessions rows.

-- Days with no classes for any of the teacher's sections: public holidays (pre-filled) and days the teacher adds.
create table public.off_days (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  -- Pre-filled holidays only, e.g. 'eid-ul-fitr-1448' or 'independence-day-2026': each is added once, never twice.
  -- null for days the teacher adds (several nulls are allowed by the unique rule).
  holiday_key text,
  -- Islamic holidays depend on the moon, so their dates are a guess until the teacher confirms or shifts them.
  tentative boolean not null default false,
  -- A pre-filled holiday the teacher deleted. Kept, hidden, so it isn't added back.
  removed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (teacher_id, holiday_key),
  check (end_date >= start_date)
);
create index off_days_teacher_dates_idx on public.off_days (teacher_id, start_date);

-- The weekly timetable of a section, e.g. Monday 09:00–10:30.
create table public.timetable_slots (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.sections (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7), -- 1 = Monday … 7 = Sunday
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  unique (section_id, weekday, start_time),
  check (end_time > start_time)
);

-- A class that needs remembering: held (attendance taken), cancelled, or an extra class added by the teacher.
create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.sections (id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  status text not null check (status in ('planned', 'held', 'cancelled')),
  -- true = not in the timetable (a make-up or extra class).
  extra boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  unique (section_id, date, start_time),
  check (end_time > start_time)
);

-- Who was present at a held class. One row per enrolled student.
create table public.attendance (
  session_id uuid not null references public.class_sessions (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  present boolean not null,
  primary key (session_id, student_id)
);
create index attendance_student_id_idx on public.attendance (student_id);

-- Close Supabase's automatic REST API on every table (see the teachers migration).
alter table public.off_days enable row level security;
alter table public.timetable_slots enable row level security;
alter table public.class_sessions enable row level security;
alter table public.attendance enable row level security;
