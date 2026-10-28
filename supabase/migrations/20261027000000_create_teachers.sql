-- One row per teacher. The id is the same as their Supabase login id (auth.users.id).
create table public.teachers (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  created_at timestamptz not null default now()
);

-- Close Supabase's automatic REST API for this table. Our server connects as the
-- database owner, which bypasses RLS, so only our API can read or write teachers.
alter table public.teachers enable row level security;

-- When someone signs up (web or Flutter), create their teacher row automatically.
-- The signup form sends full_name in the user's metadata.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.teachers (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
