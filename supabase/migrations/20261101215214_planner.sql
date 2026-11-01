-- Phase 3: the teaching planner. The plan itself is NOT stored: it is worked out from the class calendar,
-- the topics in order, and what has been taught so far (below).

-- How many classes a topic takes. Most take one; a big topic can take 2 or 3.
alter table public.topics
  add column classes_needed integer not null default 1 check (classes_needed between 1 and 50);

-- Which topics were taught in a held class. Recorded on the attendance screen (pre-filled from the plan).
-- A table, not a column: one class can cover two topics, and one topic can take several classes.
create table public.session_topics (
  session_id uuid not null references public.class_sessions (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  primary key (session_id, topic_id)
);
create index session_topics_topic_id_idx on public.session_topics (topic_id);

-- Close Supabase's automatic REST API (see the teachers migration).
alter table public.session_topics enable row level security;
