-- Phase 7: course materials. The file itself lives in Supabase Storage; this table remembers what it is,
-- so listing a course's files never has to touch storage.

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Which topic it belongs to. Optional: deleting a topic must not delete the file.
  topic_id uuid references public.topics (id) on delete set null,
  -- The name the teacher sees, usually the original file name.
  name text not null,
  -- Where it is inside the storage bucket: <teacher id>/<course id>/<random id>.
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  created_at timestamptz not null default now()
);
create index materials_course_id_idx on public.materials (course_id);
create index materials_topic_id_idx on public.materials (topic_id);

-- Close Supabase's automatic REST API (see the teachers migration).
alter table public.materials enable row level security;
