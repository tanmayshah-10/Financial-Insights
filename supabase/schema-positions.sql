-- ============================================================================
-- Market positions (run AFTER schema-financial.sql)
-- Security-level holdings (ticker + quantity) that market data can price.
-- ============================================================================
create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  holding_id   uuid references public.holdings(id) on delete set null,  -- optional link to a parent holding
  label        text,
  symbol       text not null,
  exchange     text,               -- US | NSE | BSE | SGX | CRYPTO
  quantity     numeric,
  cost_basis   numeric,
  currency     text default 'USD',
  owner        text not null default 'tanmay',
  as_of        date,
  created_at   timestamptz not null default now()
);
create index if not exists pos_hh_idx on public.positions(household_id);

alter table public.positions enable row level security;
drop policy if exists "member all positions" on public.positions;
create policy "member all positions" on public.positions
  for all using ( public.is_household_member(household_id) )
          with check ( public.is_household_member(household_id) );
