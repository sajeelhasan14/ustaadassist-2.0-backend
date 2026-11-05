-- Phase 5b: real question papers. The teacher decides the structure, so nothing here fixes a layout.
-- A paper is: assessment → sections → questions → parts. Questions only: answers are no longer stored.

-- A part of the paper: "Section B: attempt any 4". A plain list of questions is one untitled section.
create table public.paper_sections (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments (id) on delete cascade,
  title text not null default '',
  instructions text not null default '',
  -- "Attempt any N" of this section's questions. Empty = all are compulsory.
  attempt_any integer check (attempt_any > 0),
  position integer not null,
  created_at timestamptz not null default now()
);
create index paper_sections_assessment_id_idx on public.paper_sections (assessment_id);

-- Close Supabase's automatic REST API (see the teachers migration).
alter table public.paper_sections enable row level security;

-- The table was empty when this ran, so section_id can be required straight away.
alter table public.questions
  drop column answer,
  drop column explanation,
  -- Any kind the teacher asks for (true/false, scenario…). Only 'mcq' is special: it must have options.
  drop constraint questions_type_check,
  add column section_id uuid not null references public.paper_sections (id) on delete cascade,
  -- Sub-parts as a JSON list: [{ label, text, marks }]. Empty = the question has no parts.
  -- A column, not a table, because parts are always read and edited together with their question.
  add column parts jsonb;
create index questions_section_id_idx on public.questions (section_id);
