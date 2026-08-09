-- schema-hidden.sql — run once in Supabase SQL Editor (or via the API).
-- Lets you hide a transaction's details: it still counts in cash-flow totals,
-- but its merchant/description is masked in the UI and it's bucketed as "Others".
alter table public.transactions
  add column if not exists hidden boolean not null default false;
