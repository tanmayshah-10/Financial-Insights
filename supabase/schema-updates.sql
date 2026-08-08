-- schema-updates.sql — run once in Supabase SQL Editor.
-- Adds: (1) statement-derived account balances, (2) holding liquidity + vesting schedule.
-- All idempotent — safe to re-run.

-- (1) Current balances captured from imported statements (cash on hand, card outstanding).
--     Stored as JSON on the single settings row: { debit:{kind:'cash',balance,currency,as_of},
--     credit:{kind:'card',outstanding,limit,available,currency,as_of}, ... }
alter table public.household_settings
  add column if not exists balances jsonb not null default '{}'::jsonb;

-- (2) Liquidity classification + vesting schedule per holding.
--     liquidity: null/'liquid' = sellable now · 'vesting' = equity comp that unlocks over time · 'locked' = CPF/SRS/retirement
--     vesting  : [{ date:'YYYY-MM-DD', value:<number>, currency:'SGD', label? }] — tranches; date<=today counts as available now
alter table public.holdings
  add column if not exists liquidity text;
alter table public.holdings
  add column if not exists vesting jsonb not null default '[]'::jsonb;
