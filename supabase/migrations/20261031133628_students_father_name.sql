-- The university's student lists have a "Father's Name" column. Optional: some rows leave it blank.
alter table public.students add column father_name text;
