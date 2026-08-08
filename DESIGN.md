# Financial Insights — Design (Information Architecture + Theme)

Inherits the global **"Quiet"** theme (`Apple THEME.md`) verbatim: one accent, whitespace over borders, type carries hierarchy, flat & quiet, 980px max, dark-mode toggle. This doc adds only what a finance dashboard needs on top, plus the navigation structure for the many sections.

---

## 1. Information architecture

**Principle:** one **Home** dashboard is the periodic-review surface (the "single view"); everything else is drill-down. ~14 modules are grouped into **6 top-level areas** so the nav stays calm — never a 14-tab bar.

**Top bar (52px, translucent):** `Home · Cash Flow · Wealth · Protection · Plan · Settings`
Right side: **profile switcher** (Mine / Urvi's / Household) + **dark-mode toggle**.

| Top-level | Contains (secondary nav within the section) | Layer |
|---|---|---|
| **Home** | Command-center dashboard: net worth + trend, savings rate, liquidity months, allocation + concentration, protection coverage, goal funding, top flags, data-freshness, "review due" nudges | all |
| **Cash Flow** | Money in/out · Transactions · Categories/Review · Import | operational |
| **Wealth** | Net Worth & Snapshots · Investments · Real Estate · Cash/Liquidity · Liabilities | assets/balance sheet |
| **Protection** | Insurance policies · Coverage & gaps · Premium calendar | protection |
| **Plan** | Goals · Scenarios (FIRE / Retirement / Leave-SAP / custom) · Tax & SRS · Estate · Ask (NL query) | strategic |
| **Settings** | Profiles & kids · FX rates · Tags · Data (export/delete) · Theme | config |

**Within a section:** a secondary **segmented control** (Quiet pill-tabs, ≤5 items) or, when few, just stacked anchored cards. No third level.

**Review cadence baked into Home:** small "Review due" chips — *Monthly* (import statements, quick-update NAVs), *Quarterly* (allocation, goals), *Annual* (insurance, estate, tax). Driven by data-freshness so it self-prompts.

---

## 2. Theme extensions for finance (on top of Quiet)

### 2.1 Value direction (gains / losses) — the money layer
Separate from the purple/pink/navy *highlight* system. Dedicated **deep** money tokens — dark green / blood red, not bright:
```css
:root{
  --pos:#15653f;   /* dark green */
  --neg:#9b1c1c;   /* blood red  */
}
[data-theme="dark"]{
  --pos:#46a67d;   /* lifted just enough to read on black — same deep family, never neon */
  --neg:#d1655c;
}
.val-pos{color:var(--pos)} .val-neg{color:var(--neg)} .val-neutral{color:var(--ink)}
```
- Always pair color with a leading `+ / −`; never rely on color alone (accessibility).
- Never a fill — direction lives in the *number*, like highlights live in *text*.
- Dark mode lightens the two just enough for legibility on black while staying deep/muted.

### 2.2 Status flags (dashboard health) — traffic-light dots
Permitted **only** as an 8px dot + text label, sparingly, on Home. Reuse the deep money tokens for pos/neg, `--warn` (amber) for caution:
```css
.dot-ok{background:var(--pos)} .dot-warn{background:var(--warn)} .dot-danger{background:var(--neg)}
```
e.g. `● Concentration — SAP 62% of wealth` (danger). One dot per KPI, never a colored card.

### 2.3 Data visualization (Quiet has none — this is the addition)
Charts are **monochrome + accent**, never rainbow:
- **Categorical** (allocation, spend-by-category): shades of the accent ramp + grays, max ~6 slices, overflow → "Other" in `--ink-3`.
  Ramp: `#2f6fb2 · #6b9bcb · #9dbfdf · #cfe0f0` then `--ink-3 / --hairline` for the tail.
- **Trend line** (net worth, spend): single `--accent` stroke, `--accent-tint` area fill, latest point a filled `--accent` dot. No gridlines beyond a baseline hairline.
- **In/out bars** (cash flow): money-in `--ok`, money-out `--ink-2` (reserve `--danger` for a net-negative callout only).
- Axis/value labels: `--ink-3`, Caption size, `tabular-nums`.
- No 3D, no gradients, no drop shadows on marks.

### 2.4 Figures & tables
- All monetary/numeric values: `font-variant-numeric: tabular-nums`.
- KPI headline in H1/H2 (weight 600); the local-currency line beneath in `--ink-3` Small (multi-currency SGD-normalised pattern from v3).
- Tables per Quiet: hairline rows inset to text, no zebra, row ≥52px, selected `--accent-tint`.

### 2.5 Icons — replace the emoji
Quiet says "no emoji as UI." So category/section marks become **minimal line icons** (1.5px stroke, currentColor at `--ink-3`, 20px) — or plain text where an icon adds nothing. No emoji anywhere. (This changes the current Spend-Insights build, which used emoji category icons.)

### 2.6 Data-age indicator
Freshness = a status dot + Caption text (`3d` / `4mo`), not a colored pill. Green <90d, amber 90–180d, danger >180d. Pills stay reserved for tags/filters per Quiet.

### 2.7 Dark mode
Ship the toggle (top-right, sun/moon, 20px/1.5 stroke), defaulting to `prefers-color-scheme`, persisted to `localStorage`, via `[data-theme="dark"]` — exactly as the global theme mandates. (The current apps lack it; the comprehensive app adds it.)

---

## 3. Suggested edits to the GLOBAL theme (`Apple THEME.md`) — for your approval
These make Quiet finance-ready without weakening it. I won't touch your global file unless you say so.
1. **Clarify the green rule.** Under *Status* / *Don't*: green/amber/red are permitted strictly as **status & value-direction semantics** (text + tint + ≤8px dot), distinct from the purple/pink/navy highlight system which is for text emphasis only. (Currently the Don't list bans green outright, contradicting the `--ok` token.)
2. **Add a "Data visualization" section** — monochrome accent-ramp for series, no rainbow categories (§2.3 above). The theme currently says nothing about charts.
3. **Add one line to Type:** "Numeric/tabular figures use `font-variant-numeric: tabular-nums`."

Everything else in Quiet is adopted unchanged.
