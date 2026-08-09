-- schema-commitments.sql — run once in Supabase SQL Editor (or via the API).
-- Planned/recurring big payments with typical timing + funding source.
-- Drives the commitment calendar (plan 2 months ahead) and the flexible funding Sankey.
create table if not exists public.commitments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  label       text not null,                       -- "Rudran school fees", "Family holiday"
  category    text,                                -- maps to a spend category
  amount      numeric(14,2) not null default 0,    -- typical amount PER occurrence
  currency    text not null default 'SGD',
  cadence     text not null default 'yearly',      -- monthly | quarterly | half-yearly | yearly | one-off
  months      jsonb not null default '[]'::jsonb,  -- typical month numbers, e.g. [1] Jan, [1,4,7,10] quarterly
  due_date    date,                                -- optional exact date for one-offs (e.g. a specific trip)
  funding     text not null default 'salary',      -- salary | bonus | investments | other
  owner       text not null default 'tanmay',
  source      text not null default 'manual',      -- manual | auto (seeded from trend)
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now()
);
alter table public.commitments enable row level security;
drop policy if exists "member all commitments" on public.commitments;
create policy "member all commitments" on public.commitments
  for all using ( public.is_household_member(household_id) )
          with check ( public.is_household_member(household_id) );
