-- ============================================================================
-- Policy tracking fields (run AFTER schema-financial.sql)
-- Premium-paid-to, next renewal (premium due), and maturity dates.
-- 'as_of' already exists on policies and is used as "updated on".
-- ============================================================================
alter table public.policies add column if not exists premium_paid_to date;  -- premiums paid up to this date
alter table public.policies add column if not exists renewal_date   date;   -- next premium due
alter table public.policies add column if not exists maturity_date  date;   -- policy matures / ends
