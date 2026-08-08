// networth.js — balance-sheet analytics ported from the v3 TS helpers.
// All values stored in native currency + code; converted to SGD at read time.

export function toSGD(amount, ccy, fx){
  if(!amount) return 0;
  if(ccy==='SGD') return amount;
  const r = fx?.[`${ccy}_SGD`];
  return typeof r==='number' ? amount*r : amount;   // fail-visible, not silent
}

export function byProfile(items, profile){
  if(profile==='joint'||profile==='household') return items;
  return items.filter(i => i.owner===profile || i.owner==='joint');
}

export function dataFreshness(asOf, now=new Date()){
  if(!asOf) return {label:'no date', status:'unknown', days:null};
  const days = Math.floor((now - new Date(asOf))/86400000);
  if(days<0) return {label:'future?', status:'unknown', days};
  const status = days>180 ? 'old' : days>90 ? 'stale' : 'fresh';
  const label = days>365 ? `${Math.floor(days/30)}mo` : `${days}d`;
  return {label, status, days};
}

export function sinceInception(h, fx){
  if(!h.inception_contribution || !h.contribution_currency) return null;
  const current = toSGD(h.value_local, h.currency, fx);
  const cost = toSGD(h.inception_contribution, h.contribution_currency, fx);
  if(!cost) return null;
  return {current, cost, gain:current-cost, pct:(current-cost)/cost*100};
}

export function holdingsSGD(holdings, profile, fx){
  return byProfile(holdings, profile).reduce((s,h)=>s+toSGD(h.value_local,h.currency,fx),0);
}

export function netWorth(M, profile){
  const fx=M.fx;
  const hold = holdingsSGD(M.holdings, profile, fx);
  const re = byProfile(M.realEstate, profile).filter(p=>p.status!=='watchlist')
    .reduce((s,p)=>s + (toSGD(p.property_value,p.currency,fx) - toSGD(p.loan_outstanding,p.currency,fx)),0);
  const cash = byProfile(M.cashAccounts, profile).reduce((s,a)=>s+toSGD(a.balance,a.currency,fx),0);
  const debt = byProfile(M.liabilities, profile).reduce((s,l)=>s+toSGD(l.outstanding,l.currency,fx),0);
  return {total: hold+re+cash-debt, holdings:hold, realEstate:re, cash, debt};
}

// --- liquidity: when can this money actually be sold? ---
// explicit h.liquidity wins; otherwise infer from platform/subtype/category/notes.
export function liquidityOf(h){
  if(h.liquidity) return h.liquidity;
  const s=((h.platform||'')+' '+(h.subtype||'')+' '+(h.category||'')+' '+(h.notes||'')).toLowerCase();
  if(/\bcpf\b|\bsrs\b|provident|pension|retirement|401k|superann|medisave/.test(s)) return 'locked';
  if(/\brsu\b|\bespp\b|vest|option grant|\bgrant\b|equity award|restricted stock|deferred|carry/.test(s)) return 'vesting';
  return 'liquid';
}
// Split wealth into what you can sell today vs what unlocks later (with a dated timeline).
// For a 'vesting' holding with a schedule, each tranche dated on/before `today` counts as available now.
export function liquidityBuckets(holdings, profile, fx, today){
  const out={availableNow:0, vestingLater:0, locked:0, schedule:[], needsSchedule:[]};
  byProfile(holdings, profile).forEach(h=>{
    const total=toSGD(h.value_local,h.currency,fx);
    const liq=liquidityOf(h);
    const vest=Array.isArray(h.vesting)?h.vesting:[];
    if(liq==='locked'){ out.locked+=total; return; }
    if(liq==='vesting' && vest.length){
      vest.forEach(t=>{ const val=toSGD(t.value,t.currency||h.currency,fx); if(!val) return;
        if(t.date && t.date>today){ out.vestingLater+=val; out.schedule.push({date:t.date, amount:val, label:h.platform, owner:h.owner}); }
        else { out.availableNow+=val; } });
      return;
    }
    if(liq==='vesting'){ out.availableNow+=total; out.needsSchedule.push(h.platform); return; } // marked vesting, no schedule yet
    out.availableNow+=total;
  });
  out.schedule.sort((a,b)=>a.date.localeCompare(b.date));
  return out;
}

export function wealthByCategory(holdings, profile, fx){
  const out={};
  byProfile(holdings, profile).forEach(h=>{ const c=h.category||'other'; out[c]=(out[c]||0)+toSGD(h.value_local,h.currency,fx); });
  return out;
}

export function coverTotals(policies, profile, fx){
  const t={death:0,tpd:0,ci:0,earlyCi:0,hospital:0};
  byProfile(policies, profile).forEach(p=>{ const c=p.covers||{}; for(const k in t){ t[k]+= toSGD(c[k]||0, p.currency, fx); } });
  return t;
}

export function goalCurrentSGD(goal, holdings, fx){
  if(goal.current_override!=null) return goal.current_override;
  const ids = goal.earmarked_holdings||[];
  return ids.reduce((s,eid)=>{ const h=holdings.find(x=>x.ext_id===eid||x.id===eid); return s + (h?toSGD(h.value_local,h.currency,fx):0); },0);
}

// Rule-based flag engine (severity: danger|warn|ok). Returns [{severity,title,detail}]
export function flags(M, profile){
  const fx=M.fx, out=[];
  const wealth = holdingsSGD(M.holdings, profile, fx);
  // concentration
  byProfile(M.holdings, profile).forEach(h=>{
    const v=toSGD(h.value_local,h.currency,fx); const pct = wealth? v/wealth*100 : 0;
    if(pct>40) out.push({severity:'danger', title:'Concentration risk', detail:`${h.platform.split(' (')[0]} is ${Math.round(pct)}% of wealth.`});
  });
  // stale data
  const stale = byProfile(M.holdings, profile).filter(h=>{const a=dataFreshness(h.as_of); return a.days!=null && a.days>180;});
  if(stale.length) out.push({severity:'warn', title:'Stale data', detail:`${stale.length} holding(s) not refreshed in 180+ days.`});
  // protection: hospitalisation dependency on SAP
  if(byProfile(M.policies, profile).some(p=>/hospital/i.test(p.type)&&/SAP|employer/i.test((p.insurer||'')+(p.notes||''))))
    out.push({severity:'warn', title:'Hospitalisation dependency', detail:'Cover relies on SAP group plan — lapses on leaving SAP.'});
  // estate
  if(M.estate && !M.estate.will_sg) out.push({severity:'danger', title:'Estate gap', detail:'No SG will recorded — overdue with minor kids + cross-border assets.'});
  return out;
}
