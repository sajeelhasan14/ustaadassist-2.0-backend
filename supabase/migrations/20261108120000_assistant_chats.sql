-- Saved assistant conversations, like ChatGPT's history: the teacher reopens the chat and sees what was said.
-- One row per chat. The messages live together in one JSON list, because a chat is always loaded whole.

create table public.assistant_chats (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  -- The first question, shortened. Shown in the History list.
  title text not null check (char_length(title) between 1 and 120),
  -- [{ "role": "user" | "assistant", "text": "...", "stats": [...], "at": "<time>" }, ...] in order.
  -- Confirm cards are not kept: an old change could be confirmed days later, when it is no longer right.
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  -- Last question asked in this chat. History is sorted by it, newest first.
  updated_at timestamptz not null default now()
);
create index assistant_chats_teacher_updated_idx on public.assistant_chats (teacher_id, updated_at desc);

-- Close Supabase's automatic REST API (see the teachers migration). Only our backend reads this table.
alter table public.assistant_chats enable row level security;
