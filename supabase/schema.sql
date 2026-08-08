-- ============================================================================
-- Spend Insights — Supabase schema + Row-Level Security
-- Run this ONCE in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- ============================================================================
-- Design (mirrors the Family Credits pattern, but relational for scale):
--   households        : one row per household (you + wife share one).
--   household_members : which auth users belong to which household.
--   categories        : editable category config (name, icon, flags).
--   rules             : learned merchant -> category mappings.
--   transactions      : one row per statement transaction (the bulk data).
--   imported_files    : dedupe guard — a file is imported at most once.
--   RLS               : a user can read/write rows ONLY for a household they
--                       are a member of.
--   First sign-in     : a trigger auto-creates a household + membership + a set
--                       of default categories. A second user (your wife) joins
--                       your household via join_household(<code>) using the
--                       household id as the invite code.
-- ============================================================================

-- ---- tables ----------------------------------------------------------------
create table if not exists public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Household',
  created_at  timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'owner',
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index if not exists hm_user_idx on public.household_members(user_id);

create table if not exists public.categories (
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  icon         text not null default '🏷️',
  is_nonspend  boolean not null default false,   -- Transfer/Income/Refund: excluded from spend analysis
  is_eligible  boolean not null default false,   -- 4-mpd-eligible (groceries/dining/etc.)
  sort         int not null default 100,
  primary key (household_id, name)
);

create table if not exists public.rules (
  household_id  uuid not null references public.households(id) on delete cascade,
  merchant_key  text not null,
  category_name text not null,
  updated_at    timestamptz not null default now(),
  primary key (household_id, merchant_key)
);

-- when a built-in category is renamed, map the auto-detected name -> new label
-- so future imports follow the rename too.
create table if not exists public.category_aliases (
  household_id uuid not null references public.households(id) on delete cascade,
  from_name    text not null,
  to_name      text not null,
  primary key (household_id, from_name)
);

create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  account       text not null default 'credit',        -- credit | debit | revolut | ...
  txn_date      date not null,
  post_date     date,
  amount        numeric(14,2) not null,
  direction     text not null default 'out',           -- 'out' (money out) | 'in' (money in)
  refund        boolean not null default false,
  category      text not null default 'Uncategorized',
  channel       text,                                   -- Online | Contactless | Other
  fcy           boolean not null default false,
  fcy_cur       text,
  fcy_amt       numeric(18,2),
  merchant      text,                                   -- normalized merchant key
  raw           text,                                   -- cleaned display description (no card #s)
  src           text,                                   -- dbs_cc | dbs_sav | revolut | generic
  status        text,                                   -- e.g. Revolut REVERTED/PENDING
  review        boolean not null default false,
  pin           boolean not null default false,
  flag          text not null default '',               -- '' | wrong | duplicate | refund
  file          text,                                   -- source filename (provenance)
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists tx_hh_date_idx on public.transactions(household_id, txn_date);
create index if not exists tx_hh_review_idx on public.transactions(household_id, review);

create table if not exists public.imported_files (
  household_id uuid not null references public.households(id) on delete cascade,
  account      text not null,
  filename     text not null,
  imported_at  timestamptz not null default now(),
  primary key (household_id, account, filename)
);

-- ---- enable RLS ------------------------------------------------------------
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.categories        enable row level security;
alter table public.rules             enable row level security;
alter table public.transactions      enable row level security;
alter table public.imported_files    enable row level security;
alter table public.category_aliases  enable row level security;

-- helper: is the current user a member of this household?
create or replace function public.is_household_member(hid uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hid and m.user_id = auth.uid()
  );
$$;

-- ---- policies --------------------------------------------------------------
drop policy if exists "members read household"   on public.households;
drop policy if exists "members update household" on public.households;
drop policy if exists "auth insert household"    on public.households;
create policy "members read household"   on public.households for select using ( public.is_household_member(id) );
create policy "members update household" on public.households for update using ( public.is_household_member(id) ) with check ( public.is_household_member(id) );
create policy "auth insert household"    on public.households for insert with check ( auth.uid() is not null );

drop policy if exists "see own memberships" on public.household_members;
drop policy if exists "join as self"        on public.household_members;
create policy "see own memberships" on public.household_members for select using ( user_id = auth.uid() );
create policy "join as self"        on public.household_members for insert with check ( user_id = auth.uid() );

-- generic member-scoped policies for the data tables
do $$
declare t text;
begin
  foreach t in array array['categories','rules','transactions','imported_files','category_aliases'] loop
    execute format('drop policy if exists "member all %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "member all %1$s" on public.%1$s
        for all using ( public.is_household_member(household_id) )
                with check ( public.is_household_member(household_id) );
    $f$, t);
  end loop;
end $$;

-- ---- default categories seeded for a new household -------------------------
create or replace function public.seed_default_categories(hid uuid)
returns void language plpgsql security definer as $$
begin
  insert into public.categories (household_id, name, icon, is_nonspend, is_eligible, sort) values
    (hid,'Groceries','🛒',false,true,10),
    (hid,'Dining','🍽️',false,true,20),
    (hid,'Transport','🚕',false,true,30),
    (hid,'Shopping','🛍️',false,true,40),
    (hid,'Subscriptions','🔁',false,true,50),
    (hid,'Travel','✈️',false,false,60),
    (hid,'Insurance','🛡️',false,false,70),
    (hid,'Healthcare','🩺',false,false,80),
    (hid,'Utilities/Telco','💡',false,false,90),
    (hid,'Education','🎓',false,false,100),
    (hid,'Auto','🚗',false,false,110),
    (hid,'Rent','🏠',false,false,120),
    (hid,'Tax','🏛️',false,false,130),
    (hid,'Bills/Other','📄',false,false,140),
    (hid,'Transfer','🔄',true,false,150),
    (hid,'Income','💰',true,false,160),
    (hid,'Income (interest)','💰',true,false,170),
    (hid,'Refund','↩️',true,false,180),
    (hid,'Uncategorized','❓',false,false,999)
  on conflict do nothing;
end $$;

-- ---- auto-provision a household for a brand-new user -----------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare new_hh uuid;
begin
  insert into public.households (name) values ('My Household') returning id into new_hh;
  insert into public.household_members (household_id, user_id, role) values (new_hh, new.id, 'owner');
  perform public.seed_default_categories(new_hh);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- join an existing household via its id (invite code) -------------------
create or replace function public.join_household(code uuid)
returns void language plpgsql security definer as $$
begin
  if not exists (select 1 from public.households where id = code) then
    raise exception 'No such household';
  end if;
  insert into public.household_members (household_id, user_id, role)
    values (code, auth.uid(), 'member')
  on conflict do nothing;
end $$;
