# Spend Insights

See where your money goes across **DBS credit, DBS multi-currency (debit) and Revolut** — plus miles/FX opportunities. Vanilla-JS PWA, **Supabase** for data (shared household via Row-Level Security), **Netlify** hosting. No build step. Not financial advice.

Statements are parsed **in your browser**; card numbers are masked before anything is saved. Raw statement files never leave your machine — only parsed rows go to Supabase.

## First-time setup

### 1. Supabase (database)
1. Create a **new** Supabase project (dedicated to finance) at supabase.com.
2. Dashboard → **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
3. Dashboard → **Project Settings → API** → copy the **Project URL** and **anon/public key**.
4. Paste both into `js/supabase.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
5. Dashboard → **Authentication → Providers → Email** → ensure **Email** (magic link) is enabled.

### 2. GitHub (code)
Create a **private** repo `spend-insights`, then from this folder:
```
git init
git add .
git commit -m "Spend Insights v1"
git branch -M main
git remote add origin https://github.com/tanmayshah-10/spend-insights.git
git push -u origin main
```

### 3. Netlify (hosting)
- Netlify → **Add new site → Import from Git** → pick the repo. Build command: *(empty)*, publish dir: `.`.
- Or drag-and-drop this folder onto Netlify.

### 4. Sign in & share with your wife
- Open the site, enter your email, click the magic link. A household is created for you automatically.
- For your wife: she signs in with her own email once (creates her own empty household), then to **join yours** run this in the browser console on the site while signed in, using YOUR household id:
  `await window.__join('<your-household-id>')` — (a small Join UI can be added later; for now the RPC `join_household` does it).
- Find your household id in Supabase → Table editor → `households`.

## Import
- **Import** tab → **Connect transactions folder** (Chrome/Edge) → point at your `transactions/` folder with `credit/`, `debit/`, `revolut/` subfolders → **Done**. Only new files import.
- Or drop files manually (pick the account type first). `.csv`, `.txt`, `.rtf` accepted.

## Notes
- Recognized formats: DBS credit, DBS savings/multi-currency, Revolut (incl. `.rtf`). Anything else → best-effort → **Review** tab for manual confirmation.
- The **↗ Route** buttons open the Spend Router app (`ROUTER_URL` in `js/app.js`) — set that once the router is deployed.
