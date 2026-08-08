-- ============================================================================
-- Holding value history (run AFTER schema-financial.sql)
-- Every manual value update is recorded here → per-holding trend + dedup.
-- ============================================================================
create table if not exists public.holding_valuations (
  household_id uuid not null references public.households(id) on delete cascade,
  holding_id   uuid not null references public.holdings(id) on delete cascade,
  as_of        date not null,
  value_local  numeric(18,2),
  currency     text,
  created_at   timestamptz not null default now(),
  primary key (holding_id, as_of)          -- one value per holding per date → dedup
);
create index if not exists hv_hh_idx on public.holding_valuations(household_id);

alter table public.holding_valuations enable row level security;
drop policy if exists "member all holding_valuations" on public.holding_valuations;
create policy "member all holding_valuations" on public.holding_valuations
  for all using ( public.is_household_member(household_id) )
          with check ( public.is_household_member(household_id) );
