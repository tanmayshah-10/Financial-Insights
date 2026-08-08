# P10 — Market Intelligence (agentic, market-aware advisory)

> STATUS: **DESIGN — for review before building.**

Turn "Ask" from *reading your data* into *reasoning about your data against live markets* — e.g. *"My ICICI sleeve is 46% Sun Pharma; given pharma valuations and the rate outlook, should I trim?"* This requires live market data + LLM reasoning + tool use. Rule-based logic cannot do this; it is deliberately the AI tier.

Everyday, privacy-preserving questions stay on the **rule-based structured answers** (no external send). P10 is the opt-in, market-aware layer.

---

## 1. Core architecture — agentic, keys server-side

```
App (question + auth token)
   │
   ▼
Supabase Edge Function  "market-ask"
   ├─ verify caller (Supabase JWT) → resolve household (RLS)
   ├─ load positions + holdings for that household  (server-side, never via browser)
   ├─ run the Claude agentic loop with tools:
   │     • get_quote(symbol, exchange)        → market-data adapter
   │     • get_fundamentals(symbol)           → market-data adapter (P10 phase b)
   │     • web_search(query)                  → Claude native web-search tool (macro/news)
   ├─ Claude decides which tools to call, iterates, then answers
   ▼
returns { answer, dataUsed:[{symbol,price,asOf}], disclaimer }
```

**Why an Edge Function, not the browser:** it reads the portfolio *directly from Supabase* using the caller's session, so the client only ever sends the **question** — the full portfolio never round-trips through the browser, and both the Claude key and the market-data key stay server-side.

**Why tool use (not a static snapshot):** giving Claude `get_quote` / `get_fundamentals` / `web_search` lets it pull exactly what a question needs and reason over it — that is what produces *market-aware* answers instead of a frozen data dump.

---

## 2. Data-model prerequisite — positions (the real dependency)

Today `holdings` are **account-level aggregates** ("Tiger Brokers" = 13 stocks). Market analysis needs **security-level positions**. New table:

```
positions(
  id, household_id, holding_id → holdings.id,
  symbol text,            -- e.g. AAPL, NVDA, RELIANCE, ETH
  exchange text,          -- NASDAQ | NSE | BSE | CRYPTO | SGX ...
  quantity numeric,
  cost_basis numeric, currency text,
  as_of date
)  -- RLS: household member
```

- **Entry:** manual add, or parse brokerage exports (Tiger / ICICI / Crypto.com CSVs) in a later step.
- Positions roll up into their parent `holding` for net-worth; market data prices them individually.
- **Coverage reality:** direct equity (Tiger, ICICI) + crypto price cleanly. **Fund/ILP wrappers** (iFAST wrap, Utmost, SAP EquatePlus, ICICI MF) are NAV-based and not in stock APIs — those stay manually valued; market analysis is strongest on the direct-security + crypto portion. The app must show which holdings are "market-linked" vs "manual NAV".

---

## 3. Market-data adapter

Pick providers (server-side keys):
- **Equities + indices + India (NSE/BSE):** Twelve Data (global, generous free tier) — recommended. Alt: Finnhub (better fundamentals/news, weaker India free tier).
- **Crypto:** CoinGecko (free).
- **Macro/news/context:** Claude's native **web_search** tool (no separate news API needed to start).

Adapter interface (so providers are swappable):
```
getQuote(symbol, exchange) -> { price, changePct, currency, asOf }
getFundamentals(symbol)    -> { pe, marketCap, sector, ... }   // phase b
```
Cache quotes per request (a question may reference many holdings). Respect free-tier rate limits (batch / throttle).

---

## 4. Tool schema (Claude tool use)

```json
[
 {"name":"get_quote","description":"Latest price for a security",
  "input_schema":{"type":"object","properties":{"symbol":{"type":"string"},"exchange":{"type":"string"}},"required":["symbol"]}},
 {"name":"get_fundamentals","description":"Valuation/fundamentals for a security",
  "input_schema":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}},
 {"name":"web_search","description":"Search the web for market context/news"}  // native tool
]
```
The Edge Function runs the loop: send messages + tools → if Claude returns `tool_use`, execute and return `tool_result` → repeat until a final text answer.

---

## 5. UI — Plan → "Market" tab

- Free-form question box + suggested prompts:
  - *"Am I overexposed to US tech given current valuations?"*
  - *"How did my direct holdings move this week?"*
  - *"Given rates, is my India equity concentration a risk?"*
  - *"If SAP dropped 20%, what happens to my net worth?"* (ties to Leave-SAP scenario)
- Answer panel shows: the response, a **"Prices used"** list (symbol · price · as-of), and a persistent **disclaimer**.
- Ties into **Scenarios**: a market-aware "what should I rebalance" that feeds the FIRE / Leave-SAP sims.

---

## 6. Security, privacy & guardrails

- **Keys server-side only** (Edge Function secrets): `ANTHROPIC_API_KEY`, `TWELVEDATA_API_KEY` (+ CoinGecko if keyed).
- **Auth-scoped:** function reads only the caller's household (RLS); no cross-household access.
- **Data leaves at query time** (portfolio summary + fetched prices + web results → Claude) — inherent to any LLM answer. Show an explicit "what gets sent" note; make P10 opt-in.
- **Not advice:** system prompt frames output as *analysis and considerations, with trade-offs and uncertainty* — never "buy/sell X now." Must cite the prices/data it used. Prominent "not licensed financial advice" line.
- **Rate-limit per user** to control cost + provider quotas.

---

## 7. Build phases

- **P10a — Positions layer:** `positions` table + RLS, manual add UI, mark holdings market-linked vs manual-NAV.
- **P10b — Market adapter:** Twelve Data + CoinGecko adapter in the Edge Function; `get_quote` live; a "live prices" view on Wealth.
- **P10c — Agentic Ask:** Edge Function tool-use loop (get_quote + web_search) → Plan → Market tab with disclaimer + "prices used".
- **P10d — Fundamentals + scenarios:** `get_fundamentals`; market-aware rebalancing hooks into FIRE / Leave-SAP.
- **P10e — (optional) Position import:** parse Tiger / ICICI / Crypto.com exports into positions.

---

## 8. Secrets to provision (when building)
- Supabase Edge Function secrets: `ANTHROPIC_API_KEY`, `TWELVEDATA_API_KEY`.
- Supabase service role used inside the function only (never shipped to client).

## 9. Open decisions for you
1. **Provider:** Twelve Data (global + India) vs Finnhub (fundamentals/news) — or both?
2. **Positions:** manual entry first, or go straight to importing Tiger/ICICI/Crypto CSVs?
3. **Scope of "advice":** analysis-only (recommended) vs suggested actions with explicit caveats?
4. **Host:** Supabase Edge Function (recommended, data-proximate) vs keep everything on Netlify Functions?
