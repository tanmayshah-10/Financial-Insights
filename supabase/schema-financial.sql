-- ============================================================================
-- Financial Insights — Phase 1 schema extension (run AFTER schema.sql)
-- Adds the balance-sheet entities (from finance_framework_v3) + duplicate
-- protection. All household-scoped, RLS via is_household_member().
-- ============================================================================

-- ---- household settings (profiles, kids, FX, emergency-fund target) --------
create table if not exists public.household_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  profiles     jsonb not null default '{}'::jsonb,   -- {tanmay:{...}, urvi:{...}}
  kids         jsonb not null default '[]'::jsonb,
  fx           jsonb not null default '{"USD_SGD":1.275,"EUR_SGD":1.47,"INR_SGD":0.0156,"GBP_SGD":1.72}'::jsonb,
  emergency_fund_months int not null default 6,
  updated_at   timestamptz not null default now()
);

-- ---- tags (library) --------------------------------------------------------
create table if not exists public.tags (
  household_id uuid not null references public.households(id) on delete cascade,
  tag_id       text not null,
  label        text not null,
  color        text not null default 'gray',
  primary key (household_id, tag_id)
);

-- ---- holdings (investments) ------------------------------------------------
create table if not exists public.holdings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  ext_id text,                          -- original v3 id (for goal earmark mapping)
  owner text not null default 'tanmay', -- tanmay | urvi | joint
  platform text not null,
  account text,
  value_local numeric(18,2),
  currency text not null default 'SGD',
  as_of date,
  inception_date date,
  inception_contribution numeric(18,2),
  contribution_currency text,
  category text,                        -- equity|growth|defensive|alternative|cash
  subtype text,
  goal_tag text,                        -- holdings' primary goal ext_id
  tags jsonb not null default '[]'::jsonb,
  notes text,
  pending boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists holdings_hh_idx on public.holdings(household_id);

-- ---- policies (insurance) --------------------------------------------------
create table if not exists public.policies (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner text not null default 'tanmay',
  insurer text, product text, policy_number text, type text,
  covers jsonb not null default '{}'::jsonb,   -- {death,tpd,ci,earlyCi,pa,terminal,hospital}
  currency text not null default 'SGD',
  premium numeric(14,2), premium_freq text, premium_currency text,
  expiry text, as_of date,
  tags jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists policies_hh_idx on public.policies(household_id);

-- ---- goals -----------------------------------------------------------------
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  ext_id text, owner text not null default 'joint',
  name text not null, description text,
  target numeric(18,2), currency text not null default 'SGD',
  horizon date, current_override numeric(18,2),
  earmarked_holdings jsonb not null default '[]'::jsonb,  -- array of holding ext_id
  tags jsonb not null default '[]'::jsonb, notes text,
  created_at timestamptz not null default now()
);
create index if not exists goals_hh_idx on public.goals(household_id);

-- ---- real estate -----------------------------------------------------------
create table if not exists public.real_estate (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner text not null default 'joint',
  name text, location text, property_type text,
  status text not null default 'watchlist',   -- watchlist|under-contract|owned
  currency text not null default 'SGD',
  property_value numeric(18,2) default 0, amount_paid numeric(18,2) default 0,
  loan_outstanding numeric(18,2) default 0, emi numeric(14,2) default 0,
  possession_date date, tags jsonb not null default '[]'::jsonb, notes text,
  created_at timestamptz not null default now()
);

-- ---- cash accounts ---------------------------------------------------------
create table if not exists public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner text not null default 'tanmay',
  institution text, nickname text, account_type text,
  balance numeric(18,2) default 0, currency text not null default 'SGD',
  yield_rate numeric(8,4), as_of date,
  tags jsonb not null default '[]'::jsonb, notes text,
  created_at timestamptz not null default now()
);

-- ---- liabilities -----------------------------------------------------------
create table if not exists public.liabilities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner text not null default 'tanmay',
  name text, liability_type text, lender text,
  outstanding numeric(18,2) default 0, currency text not null default 'SGD',
  interest_rate numeric(8,4), emi numeric(14,2) default 0,
  tags jsonb not null default '[]'::jsonb, notes text,
  created_at timestamptz not null default now()
);

-- ---- tax + estate (single row each per household) --------------------------
create table if not exists public.tax_state (
  household_id uuid primary key references public.households(id) on delete cascade,
  srs_contributed_ytd numeric(14,2), srs_cap numeric(14,2) default 35700,
  srs_balance numeric(14,2), notes text
);
create table if not exists public.estate_state (
  household_id uuid primary key references public.households(id) on delete cascade,
  will_sg boolean default false, will_india boolean default false,
  guardianship_documented boolean default false, beneficiaries_checked boolean default false,
  cpf_nomination text, notes text
);

-- ---- snapshots (net-worth trend) ------------------------------------------
create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  label text, created_at timestamptz not null default now(),
  total_wealth_sgd numeric(18,2), net_worth_sgd numeric(18,2),
  holdings jsonb not null default '[]'::jsonb, goals jsonb not null default '[]'::jsonb
);
create index if not exists snapshots_hh_idx on public.snapshots(household_id, created_at);

-- ---- accounts (for cash-flow ownership + balances) -------------------------
create table if not exists public.accounts (
  household_id uuid not null references public.households(id) on delete cascade,
  key text not null,                 -- credit | debit | revolut | ...
  label text, owner text not null default 'tanmay',
  fx_markup_pct numeric(6,4) default 0.0325,
  primary key (household_id, key)
);

-- ---- duplicate protection --------------------------------------------------
-- file-level: content hash so a renamed re-upload is caught
alter table public.imported_files add column if not exists content_hash text;
-- transaction-level: a fingerprint for probable-duplicate detection
alter table public.transactions add column if not exists fingerprint text;
create index if not exists tx_fp_idx on public.transactions(household_id, fingerprint);

-- ---- enable RLS + member policies on all new tables ------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'household_settings','tags','holdings','policies','goals','real_estate',
    'cash_accounts','liabilities','tax_state','estate_state','snapshots','accounts'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "member all %1$s" on public.%1$I;', t);
    execute format($f$
      create policy "member all %1$s" on public.%1$I
        for all using ( public.is_household_member(household_id) )
                with check ( public.is_household_member(household_id) );
    $f$, t);
  end loop;
end $$;
