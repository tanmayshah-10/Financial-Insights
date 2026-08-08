# Financial Insights — Comprehensive Design (Shah Family CFO)

> STATUS: **FINAL — all decisions resolved, v3 data received. Ready to build on your "GO".**


Goal: **one dashboard, minimal maintenance, periodic review** — a single source of truth for what's going well and where to pivot. Combines the two halves of personal finance:
- **Cash-flow statement** (operational) — from the new transaction engine (auto-ingested).
- **Balance sheet** (strategic) — ported from `finance_framework_v3` (net worth, holdings, insurance, real estate, goals, liabilities, tax, estate).

Stack stays: vanilla-JS PWA · Supabase (household RLS, multi-user) · Netlify.

## Ownership model (Shah Family CFO)
You operate as household admin, managing on Urvi's behalf; her login is optional. One household, shared data.
- **Balance-sheet entities** (holdings, policies, real estate, goals, liabilities): each carries `owner` = `tanmay` / `urvi` / `joint`. The profile toggle (Mine / Urvi's / Household) filters them, exactly like v3.
- **Cash flow / transactions**: owner is set at the **account** level and inherited by its transactions (overridable per-row). Your accounts default to `tanmay` → most cash flow is auto-attributed to you with no extra work. Adding Urvi's card later = one account set to `urvi`.
- Aggregations (net worth, cover, savings rate) recompute per active profile.

## Data integrity & duplicate protection (required)
Three layers, so nothing is double-counted — and nothing legitimate is silently dropped:
1. **Exact file dedupe** — store a SHA-256 `content_hash` per import; a re-uploaded statement is skipped even if renamed. (filename check stays as the fast first pass.)
2. **Probable-duplicate transactions** — fingerprint = `account + date + amount + direction + merchant`. On import, matches (especially from a *different* file → overlapping periods) are **flagged `duplicate` and sent to Review**, never auto-deleted (real same-day/same-amount charges exist). Bulk confirm/delete in a "Possible duplicates" view.
3. **Overlapping-period warning** — importing a file whose date range overlaps an already-imported file for the same account raises a warning before insert.
Manual entries (holdings/policies) warn on same name+owner match.

---

## Why merge (not two apps)
Wealth management needs both statements. The Supabase app already fixes the old app's 3 biggest gaps: **no backend → Supabase**, **single-device → household sync**, **manual cash-flow → real ledger**. The old app brings the balance sheet the new one lacks. Merged, each fixes the other:
- Cash-flow & savings rate compute **from real transactions** (was manual).
- Insurance premiums **auto-link** to policies (already in the data — Great Eastern etc.).
- **XIRR/real returns** possible (we have the contribution ledger).
- **Auto monthly snapshot** → net-worth trend with no manual effort.

## The dashboard (Home) — planning-pyramid order
Top KPI + top flag from each layer, green/amber/red:
1. **Cash flow & liquidity** — net worth (headline) + trend · this-month in/out · savings rate · emergency-fund months
2. **Protection** — total life / CI / hospitalisation cover vs target; gaps
3. **Debt** — debt-to-asset, debt-to-income
4. **Wealth** — allocation donut · concentration flag (e.g. SAP stock >40%) · since-inception / XIRR
5. **Tax** — SRS utilisation vs cap
6. **Estate** — will / nomination / guardianship checklist status
7. **Goals** — retirement & education funding %
Plus a **data-freshness** strip and a consolidated **Flags & insights** list (rule-based now, LLM later).

## Modules (tabs behind the dashboard)
Ported from v3 + powered by the new engine:
- **Cashflow** — auto from transactions (income vs expense, savings rate, category trends) — *replaces v3's manual cashflow*
- **Transactions** — operational drill-down, categories, flags, review (Phase 0, done)
- **Wealth / Investments** — holdings, allocation, returns (XIRR), dividends; monthly Quick-Update modal
- **Protection** — policies, coverage totals, renewals calendar, gap analysis; premiums auto-linked
- **Real Estate** — watchlist → under-contract → owned; equity
- **Liabilities** — loans/mortgage, amortization
- **Goals** — earmark holdings, auto-compute funding
- **Tax & Retirement** — SRS/CPF, projections (4/6/8/10%)
- **Estate** — wills, nominations, guardianship checklist
- **Net Worth / Snapshots** — trend, snapshot compare (auto-snapshot monthly)
- **Scenarios & Planning** — see dedicated section below
- **Import** / **Tags** / settings

## Scenarios & Planning (first-class module)
Strategic "what should I do" layer, driven by the real data already in the app.
- **FIRE / Coast-FIRE** — FI number (annual expenses × chosen multiple, e.g. 25×), % to FI, years-to-FI at variable savings-rate + return assumptions; Coast-FIRE age (when existing corpus alone reaches the target).
- **Retirement readiness** — projected corpus vs need at retirement age; drawdown/withdrawal-rate check (e.g. 4%); shortfall/surplus.
- **"What if I leave SAP"** — models the combined hit: lose SAP salary (cash-flow), SAP EquatePlus stock (concentration + net worth), and **SAP group insurance** (the standing hospitalisation-gap flag) → shows new savings rate, protection gap, and runway. High-signal for you specifically.
- **Custom what-ifs** — adjustable levers (income change, one-off expense, market ±%, extra monthly contribution) → live impact on net worth, goals, FI date.
- **Natural-language queries** — ask "how much do I have in India?", "what's my savings-rate trend?", "am I over-concentrated?" Answered by an LLM (Claude API) over the household data via a small serverless function (Netlify/Supabase Edge) — **later phase**, keys server-side, never in the client.
- Assumptions are explicit and editable; everything labelled "projection, not advice."

## Data model (extend Supabase, household-scoped, `owner` field)
Reuse v3's clean schema as relational tables:
`accounts`, `balances`, `holdings` + `holding_valuations`, `policies`, `real_estate`, `liabilities`, `goals` (+ earmark links), `cash_accounts`, `tax`, `estate`, `snapshots`, `fx_rates`, `tags`. Plus existing `transactions`, `categories`, `rules`. Auto-capture balances from statement headers on import.

## Reuse directly from v3 (proven patterns)
- `toSGD()` multi-currency helper + editable FX rates
- Data-age pills (fresh <90d / amber / red >180d)
- SVG snapshot trend chart (no library)
- Goal earmarking (tag holdings → goal auto-values)
- Tag library with auto-colour
- Rule-based flag engine (concentration, stale, protection gap, estate gap) — later swappable for an LLM insight pass

## Upgrades the merge enables (minimal-maintenance wins)
- **Auto cash-flow & savings rate** from transactions
- **Auto monthly net-worth snapshot** (scheduled) → trend self-builds
- **Auto-link premiums → policies**; **XIRR** from contributions
- Optional later: price feeds (Yahoo/CoinGecko) via an edge function to auto-refresh NAVs; LLM natural-language queries ("how much in India?") and model-based insights

## Phasing (parallel to Phase 0 testing)
- **P1 — Foundation**: ownership model, Accounts + balances, **duplicate-protection subsystem**, v3 JSON migration importer, Net Worth backbone + dashboard shell
- **P2 — Wealth/Investments** (holdings, allocation, returns, Quick-Update)
- **P3 — Protection** (policies, gaps, premium-linking)
- **P4 — Cashflow auto-derive** (savings rate, budgets) from transactions
- **P5 — Real Estate, Liabilities, Goals**
- **P6 — Tax, Estate, Projections**
- **P7 — Home command-center dashboard + auto monthly snapshot + flag engine**
- **P8 — Scenarios & Planning** (FIRE, retirement, leave-SAP, custom what-ifs)
- **P9 — Natural-language queries** (LLM via serverless function)

## Decisions — ALL RESOLVED
1. **Ownership:** ✅ profiles for balance-sheet entities; cash-flow owned at account level (defaults to tanmay).
2. **Duplicate protection:** ✅ 3-layer (file-hash + txn-fingerprint→Review + overlap warning).
3. **Scenarios:** ✅ first-class module incl. leave-SAP + NL queries.
4. **A — v3 migration:** ✅ JSON + TS schema received. Build a one-time importer mapping the v3 shape → relational tables (holdings, policies, goals, tax, estate, snapshots, fx, tags, profiles, kids).
5. **B — NAV refresh:** ✅ manual monthly Quick-Update; price-feeds later.
6. **C — first modules:** ✅ **Investments AND Protection together** (P2 covers both).
7. **D — returns:** ✅ simple point-to-point now; XIRR once a contribution ledger exists.
8. **E — NL queries:** ✅ proper relational DB + security-first; NL query runs via a serverless function with the Claude API key **server-side only** (P9).

## Security & data protection (financial-grade, built in from P1)
- **Row-Level Security on every table**, household-scoped — a user reads/writes only their household's rows.
- **Client holds only the publishable/anon key**; the `service_role`/secret key never ships to the browser.
- **Statement parsing stays client-side**; raw statement files are never uploaded — only parsed rows. Card, account & policy numbers are **masked** before storage.
- **NL queries (P9):** Claude API key lives in a serverless function's env vars; the function enforces the caller's household scope before querying — the key and cross-household data never reach the client.
- **Transport & at rest:** HTTPS (Netlify) + Supabase Postgres encryption at rest. No secrets in the git repo.
- **PII minimization:** store only what analysis needs; provide export + delete.

## v3 data mapping (importer)
`holdings[]`→`holdings`, `policies[]`→`policies`, `goals[]`→`goals` (+earmark links), `properties[]`→`real_estate`, `liquidity.cashAccounts[]`→`cash_accounts`, `liabilities[]`→`liabilities`, `cashflow`→ seeds manual items (later superseded by real transactions), `tax`→`tax`, `estate`→`estate`, `snapshots[]`→`snapshots`, `fx`→`fx_rates`, `tagLibrary`→`tags`, `profiles`/`kids`→ household settings. Owner + tags + asOf carried across; the `toSGD`, `dataFreshness`, `sinceInceptionReturn`, `netWorthSGD` helpers port from the TS file.
