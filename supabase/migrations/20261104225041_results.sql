-- Phase 6: results. What the result sheet needs that the marks alone can't tell us.

-- Which assessments are lab work. Theory and Lab on the sheet are the sums of each kind, so the
-- split (80 + 20, or anything else) comes from what the teacher set up and is never fixed here.
alter table public.assessments
  add column is_lab boolean not null default false;

alter table public.courses
  -- As printed on the sheet: "3+0", "2+1".
  add column credit_hours text not null default '3+0',
  -- Department, class, exam date… printed at the top of the sheet. As JSON because nothing
  -- ever filters on these, and "there is no fixed format". Empty = copy the teacher's latest course.
  add column result_header jsonb;
