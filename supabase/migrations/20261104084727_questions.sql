-- Phase 5: questions. Each one belongs to an assessment ("Quiz 1", "Mid"…), written by Gemini or by the teacher.
-- AI questions start as drafts: only the teacher can approve them, and only approved questions go on a paper.

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments (id) on delete cascade,
  -- Which topic it tests. Kept optional: deleting a topic from the outline must not delete questions.
  topic_id uuid references public.topics (id) on delete set null,
  type text not null check (type in ('mcq', 'short', 'long')),
  text text not null,
  -- The choices of a multiple-choice question, as a JSON list. Other types have none.
  options jsonb,
  answer text not null,
  explanation text,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  marks numeric(6, 2) not null check (marks > 0),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  source text not null check (source in ('ai', 'manual')),
  position integer not null,
  created_at timestamptz not null default now(),
  -- Multiple choice must have options, and nothing else may.
  check ((type = 'mcq') = (options is not null))
);
create index questions_assessment_id_idx on public.questions (assessment_id);
create index questions_topic_id_idx on public.questions (topic_id);

-- Close Supabase's automatic REST API (see the teachers migration).
alter table public.questions enable row level security;
