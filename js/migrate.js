// migrate.js — one-time importer for a finance_framework_v3 JSON export.
// Maps the v3 shape into the relational tables. Idempotent via replace=true
// (wipes the balance-sheet tables for the household first).
import * as db from './db.js';

export async function importV3(v3, { replace=true } = {}){
  if(!v3 || v3.version==null) throw new Error('Not a finance-framework v3 export.');
  const counts = {};

  if(replace) await db.wipeBalanceSheet();

  // settings (profiles, kids, fx, emergency fund)
  await db.upsertSettings({
    profiles: v3.profiles || {},
    kids: v3.kids || [],
    fx: v3.fx || {},
    emergency_fund_months: v3.liquidity?.emergencyFundMonthsTarget ?? 6,
  });

  // tags
  const tags = Object.entries(v3.tagLibrary||{}).map(([tag_id,t])=>({tag_id, label:t.label, color:t.color}));
  counts.tags = (await db.insertRows('tags', tags)).length;

  // holdings
  const holdings = (v3.holdings||[]).map(h=>({
    ext_id:h.id, owner:h.owner||'tanmay', platform:h.platform, account:h.account,
    value_local:h.valueLocal, currency:h.currency, as_of:h.asOf,
    inception_date:h.inceptionDate, inception_contribution:h.inceptionContribution, contribution_currency:h.contributionCurrency,
    category:h.category, subtype:h.subtype, goal_tag:h.goalTag, tags:h.tags||[], notes:h.notes||'', pending:!!h.pending,
  }));
  counts.holdings = (await db.insertRows('holdings', holdings)).length;

  // policies
  const policies = (v3.policies||[]).map(p=>({
    owner:p.owner||'tanmay', insurer:p.insurer, product:p.product, policy_number:p.policyNumber, type:p.type,
    covers:p.covers||{}, currency:p.currency, premium:p.premium, premium_freq:p.premiumFreq, premium_currency:p.premiumCurrency,
    expiry:p.expiry, as_of:p.asOf, tags:p.tags||[], notes:p.notes||'',
  }));
  counts.policies = (await db.insertRows('policies', policies)).length;

  // goals
  const goals = (v3.goals||[]).map(g=>({
    ext_id:g.id, owner:g.owner||'joint', name:g.name, description:g.description,
    target:g.target, currency:g.currency||'SGD', horizon:g.horizon,
    current_override:g.currentOverride, earmarked_holdings:g.earmarkedHoldings||[], tags:g.tags||[], notes:g.notes||'',
  }));
  counts.goals = (await db.insertRows('goals', goals)).length;

  // real estate
  const re = (v3.properties||[]).map(p=>({
    owner:p.owner||'joint', name:p.name, location:p.location, property_type:p.propertyType, status:p.status,
    currency:p.currency, property_value:p.propertyValue, amount_paid:p.amountPaid, loan_outstanding:p.loanOutstanding,
    emi:p.emi, possession_date:p.possessionDate, tags:p.tags||[], notes:p.notes||'',
  }));
  counts.real_estate = (await db.insertRows('real_estate', re)).length;

  // cash accounts
  const cash = (v3.liquidity?.cashAccounts||[]).map(a=>({
    owner:a.owner||'tanmay', institution:a.institution, nickname:a.nickname, account_type:a.accountType,
    balance:a.balance, currency:a.currency, yield_rate:a.yieldRate, as_of:a.asOf, tags:a.tags||[], notes:a.notes||'',
  }));
  counts.cash_accounts = (await db.insertRows('cash_accounts', cash)).length;

  // liabilities
  const liab = (v3.liabilities||[]).map(l=>({
    owner:l.owner||'tanmay', name:l.name, liability_type:l.liabilityType, lender:l.lender,
    outstanding:l.outstanding, currency:l.currency, interest_rate:l.interestRate, emi:l.emi, tags:l.tags||[], notes:l.notes||'',
  }));
  counts.liabilities = (await db.insertRows('liabilities', liab)).length;

  // tax + estate (single rows)
  if(v3.tax) await db.upsertSingle('tax_state', {
    srs_contributed_ytd:v3.tax.srsContributedYTD, srs_cap:v3.tax.srsCap, srs_balance:v3.tax.srsBalance, notes:v3.tax.notes });
  if(v3.estate) await db.upsertSingle('estate_state', {
    will_sg:v3.estate.willSG, will_india:v3.estate.willIndia, guardianship_documented:v3.estate.guardianshipDocumented,
    beneficiaries_checked:v3.estate.beneficiariesChecked, cpf_nomination:v3.estate.cpfNomination, notes:v3.estate.notes });

  // snapshots
  const snaps = (v3.snapshots||[]).map(s=>({
    label:s.label, created_at:s.createdAt, total_wealth_sgd:s.totalWealthSGD, net_worth_sgd:s.netWorthSGD,
    holdings:s.holdings||[], goals:s.goals||[],
  }));
  counts.snapshots = (await db.insertRows('snapshots', snaps)).length;

  return counts;
}
