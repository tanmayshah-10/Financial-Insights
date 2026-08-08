// app.js — Spend Insights UI. Auth gate -> load household data from Supabase ->
// render tabs. Rendering reads an in-memory cache (M); mutations write through
// to Supabase then reload the cache.
import { CONFIGURED } from './supabase.js';
import { supabase } from './supabase.js';
import { sendMagicLink, signOut, resolveHouseholdId, joinHousehold, currentUser } from './auth.js';
import * as db from './db.js';
import { parseFile, merchKey } from './parse.js';
import * as NW from './networth.js';
import { importV3 } from './migrate.js';

const ROUTER_URL = 'https://spend-router.netlify.app';

const $ = s => document.querySelector(s);
const app = $('#app');
let M = { tx:[], cats:[], rules:{}, aliases:{}, files:new Set(), fileHashes:new Set(),
          holdings:[], policies:[], goals:[], realEstate:[], cashAccounts:[], liabilities:[],
          snapshots:[], tags:[], accounts:[], valuations:[], positions:[], fx:{}, tax:null, estate:null };
// Yahoo symbol from (symbol, exchange)
function ysym(symbol,exchange){ symbol=(symbol||'').toUpperCase().trim(); const ex=(exchange||'').toUpperCase();
  if(ex==='CRYPTO') return symbol.includes('-')?symbol:symbol+'-USD';
  if(ex==='NSE') return symbol+'.NS'; if(ex==='BSE') return symbol+'.BO'; if(ex==='SGX') return symbol+'.SI';
  return symbol; }
let catIcon={}, catFlags={}, HHID=null;
let AREA='home', profile='tanmay';
let TAB='overview', acct='all', month='all', txSearch='', txFlag='all', drillCat='';
// ---- balance-sheet / money helpers ----
const toSGD=(a,c)=>NW.toSGD(a,c,M.fx);
// abbreviated currency: SGD 1.34M / 933K / 940
function abbr(n){const s=n<0?'−':'';n=Math.abs(Math.round(n));
  if(n>=1e6) return s+'SGD '+(n/1e6).toFixed(2).replace(/\.?0+$/,'')+'M';
  if(n>=1e4) return s+'SGD '+Math.round(n/1e3).toLocaleString('en-SG')+'K';
  if(n>=1e3) return s+'SGD '+(n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return s+'SGD '+n.toLocaleString('en-SG');}
const sgd0=abbr;
const signed=n=>(n<0?'−':'+')+abbr(Math.abs(n));
const valCls=n=>n>0?'val-pos':n<0?'val-neg':'val-neutral';
const profLabel=p=>p==='tanmay'?'Mine':p==='urvi'?"Urvi's":'Household';
// cash-flow profile scoping (accounts carry the owner; default to tanmay)
const acctOwner=k=>{const a=(M.accounts||[]).find(x=>x.key===k);return a?a.owner:'tanmay';};
const pMatch=t=>profile==='household'||acctOwner(t.account)===profile||acctOwner(t.account)==='joint';

// ---- format helpers ----
const money = n => (n<0?'-':'')+'SGD '+Math.abs(Math.round(n*100)/100).toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2});
const money0 = abbr;
const pct = (a,b)=> b?Math.round(a/b*100):0;
const MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtMonth=m=>{const[y,mo]=m.split('-');return MN[+mo-1]+' '+y;};
const dfull=d=>{const[y,m,dd]=d.split('-');return +dd+' '+MN[+m-1]+' '+y;};
const ic=c=>catIcon[c]||'🏷️';
const FXFEE_PCT=0.0325, MLOW=1.3, MHIGH=3.5;
const ACCT=a=>({credit:{label:'DBS Credit',color:'#0071e3',bg:'#eef5ff'},debit:{label:'DBS Multi-Currency',color:'#34c759',bg:'#eafaf0'},revolut:{label:'Revolut',color:'#af52de',bg:'#f6eefe'}}[a]||{label:a,color:'#8e8e93',bg:'#eeeeee'});
const feeOf=a=>({credit:0.0325,debit:0.0325,revolut:0.005}[a]??0.0325);
const fxFee=t=>t.fcy?t.amount*(feeOf(t.account)/(1+feeOf(t.account))):0;
const milesRange=m=>`${Math.round(m).toLocaleString()} miles (≈ ${money0(m*MLOW/100)}–${money0(m*MHIGH/100)})`;
const aliased=n=>M.aliases[n]||n;
const EMOJIS=['🛒','🍽️','☕','🍺','🍔','🍷','🚕','🚌','⛽','🅿️','✈️','🏨','🌍','🛍️','👕','🎁','🛡️','🩺','💊','🏋️','🎬','🎮','🎟️','🎉','📚','🎓','👶','🐶','🏠','💡','📱','💻','🔧','⚙️','🏛️','🧾','💳','🏦','📈','💰','🔄','📄','💼','🏷️','❓'];

const catList=()=>M.cats.map(c=>c.name);
const nonspendSet=()=>new Set(M.cats.filter(c=>c.is_nonspend).map(c=>c.name));
const eligSet=()=>new Set(M.cats.filter(c=>c.is_eligible).map(c=>c.name));
const isSpend=t=>t.direction==='out'&&!nonspendSet().has(t.category);
const counted=()=>M.tx.filter(t=>!t.review);
const inScope=t=>(acct==='all'||t.account===acct)&&(month==='all'||t.txn_date.slice(0,7)===month)&&pMatch(t);

// ============================ BOOT ============================
async function boot(){
  if(!CONFIGURED){ app.innerHTML=`<div class="center"><div class="card" style="max-width:520px"><h2>Setup needed</h2><p class="muted">Open <code>js/supabase.js</code> and paste your finance project's URL and anon key, then reload. (See README.)</p></div></div>`; return; }
  supabase.auth.onAuthStateChange((_e,session)=>{ if(session) start(); else renderSignIn(); });
  try{ const u=await currentUser(); if(u) start(); else renderSignIn(); }
  catch(e){ showError(e); }
}
function showError(e){ app.innerHTML=`<div class="center"><div class="card" style="max-width:560px"><h3>Something went wrong</h3><p class="muted">${esc(e&&e.message||e)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`; console.error('start error',e); }
function renderSignIn(){
  app.innerHTML=`<div class="center"><div class="card" style="max-width:420px;text-align:center">
    <h3 style="margin-top:0">Shah Financial Insights</h3>
    <p class="muted" style="margin:8px 0 16px">Sign in with your email — we'll send a one-tap magic link. Your household shares the same data.</p>
    <input id="email" type="email" placeholder="you@email.com" style="width:100%;margin:8px 0">
    <button class="btn pri" style="width:100%" onclick="SI.signIn()">Send magic link</button>
    <div id="authmsg" class="muted" style="margin-top:10px"></div>
  </div></div>`;
}
async function signIn(){
  const email=$('#email').value.trim(); if(!email){return;}
  try{ await sendMagicLink(email); $('#authmsg').textContent='Check your email for the sign-in link.'; }
  catch(e){ $('#authmsg').textContent='Error: '+e.message; }
}
let STARTED=false;
async function start(){
  if(STARTED) return; STARTED=true;
  try{
    const u=await currentUser();
    if(!u){ STARTED=false; renderSignIn(); return; }
    HHID=await resolveHouseholdId();
    if(!HHID) HHID=await createHousehold(u.id);        // self-heal if the DB trigger didn't provision
    if(!HHID){ app.innerHTML=`<div class="center"><div class="card" style="max-width:560px"><h3>Couldn't set up your household</h3><p class="muted">Make sure <code>schema.sql</code> ran fully in Supabase, then reload.</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`; STARTED=false; return; }
    db.init(HHID, u.id);
    await reload();
    renderShell(); render();
  }catch(e){ STARTED=false; showError(e); }
}
async function createHousehold(uid){
  const { data:hh, error } = await supabase.from('households').insert({name:'My Household'}).select('id').single();
  if(error){ console.warn('createHousehold', error.message); return null; }
  await supabase.from('household_members').insert({household_id:hh.id, user_id:uid, role:'owner'});
  return hh.id;   // categories get seeded by db.loadAll() when it finds none
}
async function reload(){
  M=await db.loadAll();
  catIcon={}; catFlags={}; M.cats.forEach(c=>{catIcon[c.name]=c.icon; catFlags[c.name]=c;});
}

const AREAS=[['home','Home'],['cashflow','Cash Flow'],['wealth','Wealth'],['protection','Protection'],['plan','Plan'],['ask','Ask'],['settings','Settings']];
const CF_TABS=['overview','insights','transactions','review','import'];
const mountEl=()=>AREA==='cashflow'?'#cfbody':'#view';
function renderShell(){
  app.innerHTML=`<div class="top"><div class="topin">
      <div class="brand">Shah Financial Insights</div>
      <nav id="nav"></nav>
      <div class="topright">
        <button class="btn sm" style="background:rgba(255,255,255,.1);color:var(--bar-ink)" onclick="SI.go('ask')">✦ Ask</button>
        <div class="seg profiles">${['tanmay','urvi','household'].map(p=>`<button class="${profile===p?'on':''}" onclick="SI.setProfile('${p}')">${p==='tanmay'?'Mine':p==='urvi'?'Urvi':'Household'}</button>`).join('')}</div>
        <button class="icon-btn" title="Theme" onclick="SI.theme()">${themeIcon()}</button>
        <button class="btn sm ghost" onclick="SI.signOut()">Sign out</button>
      </div>
    </div></div>
    <div class="wrap"><div id="view"></div></div>
    <div class="ov" id="ov"><div class="sheet" id="sheet"></div></div>`;
  $('#ov').addEventListener('click',e=>{ if(e.target.id==='ov') closeSheet(); });
  buildNav();
}
function buildNav(){ const rc=M.tx.filter(t=>t.review).length;
  $('#nav').innerHTML=AREAS.map(([a,l])=>`<button class="${AREA===a?'on':''}" onclick="SI.go('${a}')">${l}${a==='cashflow'&&rc?`<span class="badge">${rc}</span>`:''}</button>`).join('');
}
function go(x){
  if(CF_TABS.includes(x)){ AREA='cashflow'; TAB=x; }
  else { AREA=x; if(x==='cashflow' && !CF_TABS.includes(TAB)) TAB='overview'; }
  renderShell(); render(); window.scrollTo(0,0);
}
function setProfile(p){ profile=p; renderShell(); render(); }

// ============================ RENDER ============================
const AREA_ACCENT={home:'#2f6fb2',cashflow:'#b5701a',wealth:'#3a5bd0',protection:'#1f8a5b',plan:'#6f43c0',settings:'#56565b'};
function render(){
  buildNav();
  document.documentElement.style.setProperty('--area', AREA_ACCENT[AREA]||'#2f6fb2');
  ({home:homeView, cashflow:cashflowView, wealth:wealthView, protection:protectionView, plan:planView, ask:askView, settings:settingsView}[AREA]||homeView)();
}
function cashflowView(){
  const rc=M.tx.filter(t=>t.review).length;
  const sub=[['overview','Money in/out'],['insights','Insights'],['transactions','Transactions'],['review','Review'],['import','Import']];
  $('#view').innerHTML=`<div class="subnav">${sub.map(([t,l])=>`<button class="${TAB===t?'on':''}" onclick="SI.go('${t}')">${l}${t==='review'&&rc?` · ${rc}`:''}</button>`).join('')}</div><div id="cfbody"></div>`;
  if(!M.tx.length && TAB!=='import' && TAB!=='review'){ $('#cfbody').innerHTML=empty(); return; }
  ({overview:overviewView,insights:insightsView,transactions:txView,review:reviewView,import:importView}[TAB]||overviewView)();
}
const empty=()=>`<div class="card" style="text-align:center;padding:44px"><h3>No transactions yet</h3><p class="muted" style="margin:6px 0 18px">Import your statements to see where your money goes.</p><button class="btn pri" onclick="SI.go('import')">Import statements</button></div>`;
const monthOpts=()=>{const ms=[...new Set(counted().map(t=>t.txn_date.slice(0,7)))].sort().reverse();return `<option value="all">All months</option>`+ms.map(m=>`<option value="${m}" ${month===m?'selected':''}>${fmtMonth(m)}</option>`).join('');};
const acctOpts=()=>{const ts=[...new Set(counted().map(t=>t.account))];return `<option value="all">All accounts</option>`+ts.map(t=>`<option value="${t}" ${acct===t?'selected':''}>${ACCT(t).label}</option>`).join('');};

function overviewView(){
  const scope=counted().filter(inScope);
  const out=scope.filter(t=>t.direction==='out'), inn=scope.filter(t=>t.direction==='in');
  const totOut=out.reduce((s,t)=>s+t.amount,0), totIn=inn.reduce((s,t)=>s+t.amount,0), net=totIn-totOut;
  const ms={};counted().filter(t=>acct==='all'||t.account===acct).forEach(t=>{const k=t.txn_date.slice(0,7);ms[k]=ms[k]||{in:0,out:0};ms[k][t.direction]+=t.amount;});
  const byCat={};out.forEach(t=>byCat[t.category]=(byCat[t.category]||0)+t.amount);const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const latest=scope.slice().sort((a,b)=>b.txn_date.localeCompare(a.txn_date)).slice(0,6);
  const asOf=scope.length?scope.map(t=>t.txn_date).sort().slice(-1)[0]:'';
  const fcOut=out.filter(t=>t.fcy).reduce((s,t)=>s+t.amount,0), localOut=totOut-fcOut;
  let left=`<div class="card"><div class="filters"><select onchange="SI.setAcct(this.value)">${acctOpts()}</select><select onchange="SI.setMonth(this.value)">${monthOpts()}</select></div>
    <div class="cash"><div class="lbl">Net cashflow</div><div class="v" style="color:${net<0?'var(--txt)':'var(--pos)'}">${money(net)}</div>${asOf?`<div class="as">As of ${dfull(asOf)}</div>`:''}</div>
    ${svgInOut(ms)}
    <div class="io"><div><div class="k"><span class="dot" style="background:var(--pos)"></span>Money in</div><div class="n">${money0(totIn)}</div></div><div><div class="k"><span class="dot" style="background:var(--neg)"></span>Money out</div><div class="n">${money0(totOut)}</div></div></div>
    <div class="io"><div><div class="k">🇸🇬 Local (SGD)</div><div class="n">${money0(localOut)}</div></div><div style="background:var(--fc-bg)"><div class="k">🌏 Foreign (FX)</div><div class="n">${money0(fcOut)}</div></div></div></div>
    <div class="card"><h2>Spending by category</h2>`;
  if(!cats.length)left+=`<div class="muted">No spending in this period.</div>`;
  cats.forEach(([c,v])=>left+=`<div class="catrow" onclick="SI.drill('${enc(c)}')"><div class="ic" style="background:var(--bg2)">${ic(c)}</div><div class="nm">${c}</div><div class="am">${money0(v)}</div><div class="chev">›</div></div>`);
  left+=`</div><div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Latest transactions</h2><button class="btn sm" onclick="SI.go('transactions')">View all</button></div><div style="margin-top:8px">`;
  latest.forEach(t=>left+=txRow(t)); if(!latest.length)left+=`<div class="muted">No transactions.</div>`;
  left+=`</div></div>`;
  const right=`<div class="card"><h2>Quick insights</h2>${mini(scope,totOut,fcOut)}<button class="btn pri" style="width:100%;margin-top:8px" onclick="SI.go('insights')">See all insights →</button></div>`;
  $(mountEl()).innerHTML=`<div class="grid gridmain"><div class="grid">${left}</div><div class="grid" style="align-content:start">${right}</div></div>`;
}
function mini(scope,totOut,fcOut){const P=scope.filter(isSpend);if(!P.length)return '<div class="muted">Import data for insights.</div>';
  const ES=eligSet();const fxf=P.reduce((s,t)=>s+fxFee(t),0);let elig=0;P.forEach(t=>{if(ES.has(t.category))elig+=t.amount;});const gap=elig*(4-1.6);
  return `<div class="flag warn"><span class="ic2">🌏</span><span><b>${money0(fxf)}</b> est. FX fees on ${money0(fcOut)} foreign spend. Route via Revolut to cut most of it.</span></div>
    <div class="flag good"><span class="ic2">✈️</span><span><b>~${milesRange(gap)}</b> left on the table — move 4-mpd-eligible spend off this card.</span></div>`;}

function insightsView(){
  const P=counted().filter(inScope).filter(isSpend);
  if(!P.length){$(mountEl()).innerHTML='<div class="card"><div class="muted">No spending in scope. Adjust filters.</div></div>';return;}
  const gross=P.reduce((s,t)=>s+t.amount,0);
  const byMon={};counted().filter(t=>isSpend(t)&&(acct==='all'||t.account===acct)).forEach(t=>byMon[t.txn_date.slice(0,7)]=(byMon[t.txn_date.slice(0,7)]||0)+t.amount);
  const avgMo=Object.keys(byMon).length?Object.values(byMon).reduce((a,b)=>a+b,0)/Object.keys(byMon).length:0;
  const spike=Object.entries(byMon).sort((a,b)=>b[1]-a[1])[0];
  const fc=P.filter(t=>t.fcy),fcSGD=fc.reduce((s,t)=>s+t.amount,0),fxf=fc.reduce((s,t)=>s+fxFee(t),0);
  const byCat={};P.forEach(t=>byCat[t.category]=(byCat[t.category]||0)+t.amount);const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const ES=eligSet();let elig=0;P.forEach(t=>{if(ES.has(t.category))elig+=t.amount;});const gap=elig*(4-1.6);
  let h=`<div class="card"><div class="filters"><select onchange="SI.setAcct(this.value)">${acctOpts()}</select><select onchange="SI.setMonth(this.value)">${monthOpts()}</select></div><h2>Headline</h2>`;
  if(spike)h+=fl('📅',`<b>${fmtMonth(spike[0])}</b> was your biggest month at <b>${money0(spike[1])}</b> — ${Math.round(spike[1]/avgMo*100-100)}% above average.`,'info');
  if(cats[0])h+=fl(ic(cats[0][0]),`Top category: <b>${cats[0][0]}</b> — ${money0(cats[0][1])} (${pct(cats[0][1],gross)}%).`,'info');
  h+=fl('✈️',`<b>${milesRange(gap)}</b> left on the table — route eligible spend to a 4-mpd card. (Decide the exact mile value in Spend Router.)`,'good');
  h+=`</div><div class="card"><h2>What you can do better — routing by category</h2>`;
  cats.slice(0,7).forEach(([c,v])=>h+=rec(c,v,P.filter(t=>t.category===c)));
  h+=`</div>`;
  // FX
  h+=`<div class="card"><h2>Foreign currency & forex charges</h2><div class="flag warn"><span class="ic2">💱</span><span>You spent <b>${money0(fcSGD)}</b> in foreign currency and paid an estimated <b>${money0(fxf)}</b> in FX fees (~3.25% card markup, validated against your statements).</span></div>`;
  const byCur={};fc.forEach(t=>{const k=t.fcy_cur||'??';byCur[k]=byCur[k]||{sgd:0,fee:0,n:0};byCur[k].sgd+=t.amount;byCur[k].fee+=fxFee(t);byCur[k].n++;});
  if(Object.keys(byCur).length){h+=`<table><thead><tr><th>Currency</th><th class="num">Txns</th><th class="num">SGD charged</th><th class="num">Est. FX fee</th></tr></thead><tbody>`;
    Object.entries(byCur).sort((a,b)=>b[1].sgd-a[1].sgd).forEach(([k,v])=>h+=`<tr><td>${k}</td><td class="num">${v.n}</td><td class="num">${money0(v.sgd)}</td><td class="num" style="color:var(--warn)">${money0(v.fee)}</td></tr>`);h+=`</tbody></table>`;}
  const milesGiven=fcSGD*2.2, be=(FXFEE_PCT*100)/2.2;
  h+=`<div class="rec"><h4>💳 Multi-currency / Revolut vs credit card on foreign spend</h4>
    <div class="muted">Charging in the foreign currency (multi-currency debit or Revolut) avoids the ~3.25% markup — but you forgo ~2.2 mpd of credit-card miles.</div>
    <table style="margin-top:8px"><tbody>
    <tr><td>FX fees avoided</td><td class="num" style="color:var(--pos)">${money0(fxf)}</td></tr>
    <tr><td>Miles given up (credit @2.2 mpd)</td><td class="num">${milesRange(milesGiven)}</td></tr>
    <tr><td><b>Break-even</b></td><td class="num"><b>${be.toFixed(2)}¢ / mile</b></td></tr></tbody></table>
    <div class="muted" style="margin-top:6px">Value miles <b>below ${be.toFixed(2)}¢</b> → multi-currency/Revolut wins. <b>Above</b> (business-class redeemers) → keep the credit card. Confirm a case in Spend Router.</div></div></div>`;
  // recurring
  const bm={};P.forEach(t=>{if(!bm[t.merchant])bm[t.merchant]={amt:0,n:0,mo:new Set()};bm[t.merchant].amt+=t.amount;bm[t.merchant].n++;bm[t.merchant].mo.add(t.txn_date.slice(0,7));});
  const rec2=Object.entries(bm).map(([k,v])=>({m:k,...v})).sort((a,b)=>b.amt-a.amt).filter(x=>x.mo.size>=3&&x.n>=3);
  h+=`<div class="card"><h2>Recurring — subscriptions & regulars</h2>`;
  if(rec2.length){h+=`<table><thead><tr><th>Merchant</th><th class="num">Months</th><th class="num">Total</th><th class="num">~/mo</th></tr></thead><tbody>`;rec2.slice(0,12).forEach(x=>h+=`<tr><td>${x.m}</td><td class="num">${x.mo.size}</td><td class="num">${money0(x.amt)}</td><td class="num muted">${money0(x.amt/x.mo.size)}</td></tr>`);h+=`</tbody></table>`;}else h+=`<div class="muted">Need a few months of data.</div>`;
  h+=`</div>`;
  $(mountEl()).innerHTML=h;
}
function rec(cat,v,rows){const fcShare=rows.filter(t=>t.fcy).reduce((s,t)=>s+t.amount,0);
  const A={Groceries:['Move to a 4-mpd card','~1.6 mpd now. HSBC Revolution / Citi Rewards earn 4 mpd online/contactless (≤S$1k/mo).'],Dining:['Move to a 4-mpd card','Online & contactless dining earns 4 mpd.'],Shopping:['Move online spend to 4-mpd card','Online retail is the 4-mpd sweet spot.'],Subscriptions:['Put on a 4-mpd online card','Recurring online charges → 4-mpd card; review unused subs.'],Transport:['4-mpd contactless card','Grab/transit are online/contactless → 4 mpd.'],Travel:['Optimise FX + consider redeeming','Big-ticket & often foreign. Best FCY card or Revolut; consider KrisFlyer/Bonvoy redemption.'],Insurance:['Check card-payable + big-ticket route','Large recurring; weigh CardUp fee vs miles, else GIRO.'],'Utilities/Telco':['GIRO at economy mile value','Platform fees usually beat the miles unless business-class redeemer.'],Education:['Default to GIRO','GIRO wins at economy value.']}[cat]||['Open in Spend Router','Compare routes.'];
  return `<div class="rec"><h4>${ic(cat)} ${cat} — ${money0(v)}${fcShare>0?` · ${money0(fcShare)} foreign`:''}</h4><div class="muted"><b>${A[0]}.</b> ${A[1]}</div><div class="act"><button class="btn sm pri" onclick="SI.routeCat('${enc(cat)}',${Math.round(v)},${fcShare>v/2})">↗ Route in Spend Router</button></div></div>`;}
const fl=(i,t,c)=>`<div class="flag ${c}"><span class="ic2">${i}</span><span>${t}</span></div>`;
function svgInOut(ms){const keys=Object.keys(ms).sort();if(!keys.length)return '';const max=Math.max(1,...keys.map(k=>Math.max(ms[k].in,ms[k].out)));
  const W=Math.max(380,keys.length*64),H=170,pad=28,slot=(W-pad*2)/keys.length,bw=Math.min(13,slot/3.2);let s='';
  keys.forEach((k,i)=>{const cx=pad+i*slot+slot/2;if(k===month)s+=`<rect x="${cx-slot/2+4}" y="6" width="${slot-8}" height="${H-12}" rx="8" fill="#f0f0f2"/>`;
    const ih=(ms[k].in/max)*(H-pad*2),oh=(ms[k].out/max)*(H-pad*2);
    s+=`<rect x="${cx-bw-2}" y="${H-pad-ih}" width="${bw}" height="${ih}" rx="3" fill="var(--pos)"/><rect x="${cx+2}" y="${H-pad-oh}" width="${bw}" height="${oh}" rx="3" fill="var(--neg)"/><text x="${cx}" y="${H-9}" fill="var(--ink-3)" font-size="11" text-anchor="middle">${MN[+k.slice(5,7)-1]}</text>`;});
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:200px">${s}</svg>`;}

function txRow(t){const sign=t.direction==='in'?'+':'-';const A=ACCT(t.account);const col=t.direction==='in'?'var(--pos)':'var(--txt)';const flg=t.pin?'📌 ':t.flag==='wrong'?'⚠️ ':t.flag==='duplicate'?'⧉ ':t.flag==='refund'?'⏳ ':'';
  return `<div class="txrow" onclick="SI.open('${t.id}')"><div class="ic" style="background:${A.bg}">${ic(t.category)}<span class="acctdot" style="background:${A.color}"></span></div>
    <div class="nm"><div class="t">${flg}${esc(t.raw||t.merchant||'')}</div><div class="s">${t.category}${t.fcy?` · <span style="color:#9a5b00">${t.fcy_cur} ${t.fcy_amt?(+t.fcy_amt).toLocaleString():''}</span>`:''}${t.review?' · review':''}</div></div>
    <div class="am" style="color:${col}">${sign}${money0(t.amount)}</div><div class="chev">›</div></div>`;}

function txView(){
  let rows=counted().filter(inScope);
  if(drillCat)rows=rows.filter(t=>t.category===drillCat);
  if(txSearch)rows=rows.filter(t=>((t.merchant||'')+' '+(t.raw||'')+' '+t.category).toLowerCase().includes(txSearch));
  if(txFlag==='pin')rows=rows.filter(t=>t.pin);else if(txFlag!=='all')rows=rows.filter(t=>t.flag===txFlag);
  rows.sort((a,b)=>b.txn_date.localeCompare(a.txn_date));
  let h=`<div class="card"><div class="filters"><select onchange="SI.setAcct(this.value)">${acctOpts()}</select><select onchange="SI.setMonth(this.value)">${monthOpts()}</select>
    <input placeholder="Search" value="${esc(txSearch)}" oninput="SI.search(this.value)" style="flex:1;min-width:150px">
    <div class="seg">${['all','pin','wrong','duplicate','refund'].map(f=>`<button class="${txFlag===f?'on':''}" onclick="SI.flag('${f}')">${({all:'All',pin:'📌',wrong:'⚠️',duplicate:'⧉',refund:'⏳'})[f]}</button>`).join('')}</div></div>`;
  if(drillCat)h+=`<div style="margin-bottom:10px"><span class="chip">${ic(drillCat)} ${drillCat} <span style="cursor:pointer" onclick="SI.drill('')">✕</span></span></div>`;
  let last='';rows.slice(0,300).forEach(t=>{if(t.txn_date!==last){h+=`<div class="daygroup">${dfull(t.txn_date)}</div>`;last=t.txn_date;}h+=txRow(t);});
  if(!rows.length)h+=`<div class="muted" style="padding:20px 0">No transactions match.</div>`;
  if(rows.length>300)h+=`<div class="muted" style="margin-top:10px">Showing 300 of ${rows.length}.</div>`;
  h+=`</div>`;$(mountEl()).innerHTML=h;
}

function reviewView(){
  const rows=M.tx.filter(t=>t.review).sort((a,b)=>b.amount-a.amount);
  let h=`<div class="card"><h2>Review queue</h2>`;
  if(!rows.length){h+=`<div class="flag good"><span class="ic2">✓</span><span>Nothing to review. Best-effort imports (unrecognized formats, reverted/pending) land here for you to confirm before they count.</span></div></div>`;$(mountEl()).innerHTML=h;return;}
  const tot=rows.reduce((s,t)=>s+t.amount,0);
  h+=`<div class="muted" style="margin-bottom:12px">${rows.length} rows (${money0(tot)}) <b>excluded from totals</b> until approved. Fix the category, then approve. Choices are remembered for the merchant.</div>
    <button class="btn pri" onclick="SI.approveAll()">Approve all</button> <button class="btn danger" onclick="SI.deleteReview()">Delete all</button>
    <table style="margin-top:14px"><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead><tbody>`;
  rows.forEach(t=>h+=`<tr><td class="muted" style="white-space:nowrap">${t.txn_date}</td><td>${esc(t.raw||t.merchant||'')}${t.fcy?` <span class="chip fc">${t.fcy_cur}</span>`:''}</td><td>${catSelect(t.id,t.category)}</td><td class="num">${money(t.amount)}</td><td style="white-space:nowrap"><button class="btn sm pri" onclick="SI.approve('${t.id}')">Approve</button> <button class="btn sm" onclick="SI.open('${t.id}')">Details</button></td></tr>`);
  h+=`</tbody></table></div>`;$(mountEl()).innerHTML=h;
}

// ---- category select + management ----
function catSelect(id,cur){const list=catList().includes(cur)?catList():[cur,...catList()];
  return `<select onchange="SI.setCat('${id}',this.value)">`+list.map(c=>`<option ${c===cur?'selected':''}>${ic(c)} ${c}</option>`).join('')+`<option value="__add__">➕ Add new category…</option></select>`;}
function iconSelect(id,cur){const opts=[cur,...EMOJIS.filter(e=>e!==cur)];return `<select id="${id}" style="width:62px;text-align:center;padding:8px;font-size:18px">`+opts.map(e=>`<option value="${e}">${e}</option>`).join('')+`</select>`;}
function openAddCat(txId){$('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button><h3>Add category</h3><div class="muted" style="margin-bottom:10px">Pick an icon and name it. It'll be assigned to this transaction and remembered for the merchant.</div><div class="drow" style="gap:8px;align-items:center">${iconSelect('acIcon','🏷️')}<input id="acName" placeholder="Category name" style="flex:1"></div><div class="fbtns"><button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.addCat('${txId}')">Add & assign</button></div>`;$('#ov').classList.add('show');setTimeout(()=>$('#acName')&&$('#acName').focus(),50);}
async function addCatAssign(txId){const n=($('#acName').value||'').trim();if(!n){toast('Enter a name');return;}await db.addCategory(n,$('#acIcon').value);await setCat(txId,n,true);}
function openCatManager(){const list=catList();const rows=list.map((c,i)=>`<div class="drow" style="gap:8px;align-items:center">${iconSelect('ce'+i,ic(c))}<input id="cn${i}" value="${esc(c)}" style="flex:1"></div>`).join('');
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button><h3>Manage categories</h3><div class="muted" style="margin-bottom:10px">Pick icons or rename any category — renames update existing transactions and future imports. Add one in the blank row.</div><div style="max-height:50vh;overflow:auto">${rows}<div class="drow" style="gap:8px;align-items:center">${iconSelect('ceNew','🏷️')}<input id="cnNew" placeholder="Add new category…" style="flex:1"></div></div><div class="fbtns"><button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.saveCats(${list.length})">Save changes</button></div>`;
  $('#ov').classList.add('show');}
async function saveCatManager(nOld){const old=catList().slice();
  for(let i=0;i<nOld;i++){const nn=($('#cn'+i).value||'').trim()||old[i];const em=($('#ce'+i).value||'').trim();
    if(nn!==old[i])await db.renameCategory(old[i],nn); if(em)await db.setCategoryIcon(nn,em);}
  const nv=($('#cnNew').value||'').trim();if(nv&&!old.includes(nv))await db.addCategory(nv,($('#ceNew').value||'').trim()||'🏷️');
  closeSheet();await reload();render();toast('Categories updated');}

// ---- detail sheet ----
function openSheet(id){const t=M.tx.find(x=>x.id===id);if(!t)return;const A=ACCT(t.account);
  const row=(k,v)=>`<div class="drow"><span class="k">${k}</span><span class="v2">${v}</span></div>`;
  let fx='';if(t.fcy){const rate=t.fcy_amt?(t.amount/t.fcy_amt):0;fx=row('Foreign amount',`${t.fcy_cur} ${t.fcy_amt?(+t.fcy_amt).toLocaleString():'—'}`)+row('SGD charged',money(t.amount))+(rate?row('Implied rate',`${rate.toFixed(4)} SGD/${t.fcy_cur}`):'')+row('Est. FX fee (~3.25%)',`<span style="color:var(--warn)">${money(fxFee(t))}</span>`);}
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px"><div class="ic" style="width:48px;height:48px;font-size:22px;background:${A.bg}">${ic(t.category)}<span class="acctdot" style="background:${A.color};width:14px;height:14px"></span></div><div><h3 style="margin:0">${t.direction==='in'?'+':'-'}${money(t.amount)}</h3><div class="muted">${esc(t.raw||t.merchant||'')}</div></div></div>
    <div style="margin:10px 0"><span class="acctchip" style="background:${A.bg};color:${A.color}"><span class="dot" style="background:${A.color}"></span>${A.label}</span> ${t.fcy?'<span class="chip fc">Foreign currency</span>':'<span class="chip">🇸🇬 Local SGD</span>'}</div>
    <div class="drow"><span class="k">Category</span><span class="v2">${catSelect(t.id,t.category)}</span></div>
    ${row('Date',dfull(t.txn_date))}${t.post_date&&t.post_date!==t.txn_date?row('Posted',dfull(t.post_date)):''}
    ${row('Direction',t.direction==='in'?'Money in':'Money out')}${row('Channel',t.channel||'—')}${fx}
    ${t.status?row('Status',t.status):''}${row('Source',(t.src||'')+(t.review?' · needs review':''))}
    <div class="fbtns"><button class="fb ${t.pin?'on':''}" onclick="SI.toggle('${t.id}','pin')">📌 Pin</button><button class="fb ${t.flag==='wrong'?'on':''}" onclick="SI.toggle('${t.id}','wrong')">⚠️ Wrong</button><button class="fb ${t.flag==='duplicate'?'on':''}" onclick="SI.toggle('${t.id}','duplicate')">⧉ Dup</button><button class="fb ${t.flag==='refund'?'on':''}" onclick="SI.toggle('${t.id}','refund')">⏳ Refund</button></div>
    <div class="fbtns">${t.review?`<button class="fb" style="background:var(--pos);color:#fff;border-color:var(--pos)" onclick="SI.approve('${t.id}',true)">✓ Approve</button>`:''}<button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.routeTx('${t.id}')">↗ Route</button><button class="fb" style="color:var(--neg)" onclick="SI.del('${t.id}')">🗑 Delete</button></div>`;
  $('#ov').classList.add('show');}
const closeSheet=()=>$('#ov').classList.remove('show');

// ---- import ----
function importView(){
  $(mountEl()).innerHTML=`<div class="card"><h2>Import statements</h2>
    <div class="muted" style="margin-bottom:14px">Connect the <b>transactions/</b> folder once; each subfolder (credit/debit/revolut) is an account. Press Done — only new files import. Or drop files manually. Card numbers are masked before anything is saved.</div>
    <div class="filters"><button class="btn" onclick="SI.connect()">📂 Connect transactions folder</button><button class="btn pri" onclick="SI.scan()">✓ Done — scan for new files</button><span class="status" id="folderStatus">${DIRNAME?'Connected: '+DIRNAME:''}</span></div>
    <div class="muted" style="margin:16px 0 8px">or drop files manually</div>
    <div class="filters"><select id="manualType"><option value="credit">DBS Credit</option><option value="debit">DBS Multi-Currency (debit)</option><option value="revolut">Revolut</option></select></div>
    <div id="drop">Drop CSV files here, or <span style="color:var(--accent);cursor:pointer;font-weight:600" onclick="document.getElementById('file').click()">choose files</span><input id="file" type="file" accept=".csv,.txt,.rtf" multiple style="display:none"></div>
    <div class="filters" style="margin-top:16px"><button class="btn" onclick="SI.manageCats()">🏷️ Manage categories</button><div style="flex:1"></div><button class="btn danger" onclick="SI.clearAll()">Clear all</button></div>
    <div id="log" class="log"></div></div>
    <div class="card"><h2>Recognized formats</h2><div class="muted">✓ DBS credit · ✓ DBS savings/multi-currency · ✓ Revolut (incl. .rtf) · ⚠ Others → best-effort → Review.</div></div>
    ${FS_OK?'':'<div class="card"><div class="muted">⚠ Folder scan needs Chrome/Edge. In Safari/Firefox use manual drop.</div></div>'}`;
  const drop=$('#drop'),fileIn=$('#file');fileIn.onchange=e=>{ingest(e.target.files);e.target.value='';};
  ['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('hot');}));
  drop.addEventListener('dragleave',e=>{e.preventDefault();drop.classList.remove('hot');});
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('hot');if(e.dataTransfer.files.length)ingest(e.dataTransfer.files);});
}
function logLine(h){const l=$('#log');if(!l)return;l.style.display='block';l.insertAdjacentHTML('beforeend',h+'<br>');l.scrollTop=l.scrollHeight;}

// apply learned rules + aliases, prep rows for insert
function prep(rows){return rows.map(r=>{let cat=M.rules[r.merchant]||r.category;cat=aliased(cat);return {...r,category:cat};});}
async function importText(text,name,type){const key=type+'/'+name;
  if(M.files.has(key)){logLine(`<span class="muted">• ${key}: already imported (filename)</span>`);return 0;}
  const hash=await db.sha256(text);
  if(M.fileHashes.has(hash)){logLine(`<span class="muted">• ${key}: identical file already imported (content hash) — skipped</span>`);return 0;}
  let r;try{r=parseFile(text);}catch(e){logLine(`<span class="err">✗ ${key}: ${e.message}</span>`);return 0;}
  if(!r.rows.length){logLine(`<span class="err">✗ ${key}: no usable rows</span>`);return 0;}
  // duplicate protection: fingerprint against existing txns + overlapping-period check
  const seen=new Set(M.tx.map(t=>db.fingerprint(t)));
  const acctDates=M.tx.filter(t=>t.account===type).map(t=>t.txn_date);
  const payload=prep(r.rows).map(row=>{const t={...row,account:type,file:name}; t.fingerprint=db.fingerprint(t);
    if(seen.has(t.fingerprint)){ t.review=true; t.flag='duplicate'; } return t;});
  const dups=payload.filter(t=>t.flag==='duplicate').length;
  // overlap warning
  if(acctDates.length){ const lo=payload.reduce((m,t)=>t.txn_date<m?t.txn_date:m,payload[0].txn_date), hi=payload.reduce((m,t)=>t.txn_date>m?t.txn_date:m,payload[0].txn_date);
    const overlap=acctDates.some(d=>d>=lo&&d<=hi); if(overlap) logLine(`<span style="color:var(--warn)">⚠ ${key}: date range overlaps an earlier ${type} import — probable duplicates flagged for Review.</span>`); }
  try{ await db.insertTransactions(payload); await db.recordImported(type,name,hash); M.files.add(key); M.fileHashes.add(hash); }
  catch(e){ logLine(`<span class="err">✗ ${key}: DB error — ${e.message}</span>`); _importErrors.push(`${key}: ${e.message}`); return 0; }
  logLine(`<span class="ok">✓ ${key}: ${payload.length} txns (${r.rows[0].src})${dups?` · <b style="color:var(--warn)">${dups} probable duplicates → Review</b>`:''}${r.confident?'':' <b style="color:var(--warn)">⚠ needs review</b>'}</span>`);return payload.length;}
let _importErrors=[];
async function ingest(fileList){const files=[...fileList];if(!files.length)return;const type=$('#manualType').value;_importErrors=[];$('#log').innerHTML='';logLine(`<span class="spinner"></span>Reading ${files.length} file(s) as ${type}…`);
  let a=0;for(const f of files)a+=await importText(await f.text(),f.name,type);await finishImport(a);}
async function finishImport(a){ logLine(`<b>Done.</b> ${a} new.`); await reload();
  if(_importErrors.length){ render(); toast('Import failed — '+_importErrors[0]); return; }
  if(a>0){ toast(`Imported ${a} new transaction(s)`); go('overview'); }        // jump to the dashboard so you see them
  else { render(); toast('No new transactions — files already imported, or all flagged as duplicates (see Review).'); }
}

// folder (File System Access API)
let DIR=null,DIRNAME='';const FS_OK=('showDirectoryPicker'in window);
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('spend_insights',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function idbSet(k,v){const d=await idb();return new Promise((res,rej)=>{const t=d.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);});}
async function idbGet(k){const d=await idb();return new Promise((res,rej)=>{const t=d.transaction('kv','readonly');const q=t.objectStore('kv').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}
async function ensurePerm(h){const o={mode:'read'};if((await h.queryPermission(o))==='granted')return true;return (await h.requestPermission(o))==='granted';}
async function connectFolder(){if(!FS_OK){alert('Folder scan needs Chrome/Edge. Use manual drop otherwise.');return;}try{DIR=await window.showDirectoryPicker({mode:'read'});await idbSet('dir',DIR);DIRNAME=DIR.name;if($('#folderStatus'))$('#folderStatus').textContent='Connected: '+DIRNAME;scanDelta();}catch(e){}}
async function scanDelta(){if(!DIR){logLine('<span class="err">Connect the folder first.</span>');return;}if(!(await ensurePerm(DIR))){logLine('<span class="err">Permission denied.</span>');return;}
  $('#log').innerHTML='';logLine('<span class="spinner"></span>Scanning subfolders…');let a=0,seen=false;
  for await(const sub of DIR.values()){if(sub.kind!=='directory')continue;const type=sub.name.toLowerCase();
    for await(const e of sub.values()){if(e.kind!=='file'||!/\.(csv|txt|rtf)$/i.test(e.name))continue;seen=true;const f=await e.getFile();a+=await importText(await f.text(),e.name,type);}}
  if(!seen)logLine('<span class="muted">No CSV files found in subfolders.</span>');await finishImport(a);}
(async()=>{if(!FS_OK)return;try{const h=await idbGet('dir');if(h){DIR=h;DIRNAME=h.name;}}catch(e){}})();

// ---- mutations (write-through then reload) ----
async function setCat(id,newCat,fromAdd){const t=M.tx.find(x=>x.id===id);if(!t)return;
  if(newCat==='__add__'){openAddCat(id);return;}
  await db.setMerchantCategory(t.merchant,newCat);await reload();
  if(TAB==='review')render();else{render();if($('#ov').classList.contains('show'))openSheet(id);}
  toast(`Set to ${newCat} · remembered for future`);}
async function toggleFlag(id,type){const t=M.tx.find(x=>x.id===id);if(!t)return;const patch=type==='pin'?{pin:!t.pin}:{flag:t.flag===type?'':type};await db.patchTransaction(id,patch);await reload();openSheet(id);render();}
async function del(id){await db.deleteTransaction(id);await reload();closeSheet();render();}
async function approve(id,close){await db.patchTransaction(id,{review:false});await reload();if(close)closeSheet();render();}
async function approveAll(){await db.approveAllReview();await reload();render();}
function deleteReview(){ confirmSheet('Delete all review-queue rows?', async()=>{ await db.deleteWhereReview(); await reload(); render(); }); }
function clearAll(){ confirmSheet('Clear ALL transactions for the household? (Categories are kept.)', async()=>{ await db.clearAllTransactions(); M.files=new Set(); M.fileHashes=new Set(); await reload(); render(); }); }
// in-app confirm (native confirm() is blocked in the embedded browser)
function confirmSheet(msg,onYes){
  $('#sheet').innerHTML=`<h3 style="margin-bottom:8px">Confirm</h3><p class="muted">${esc(msg)}</p>
    <div class="fbtns"><button class="fb" onclick="SI.close()">Cancel</button>
    <button class="fb" id="cfmYes" style="background:var(--neg);color:#fff;border-color:var(--neg)">Yes, proceed</button></div>`;
  $('#ov').classList.add('show');
  $('#cfmYes').onclick=async()=>{ closeSheet(); await onYes(); };
}
function exportCSV(){ const head='date,amount,direction,category,account,merchant\n';
  const body=M.tx.map(t=>`${t.txn_date},${t.amount},${t.direction},${t.category},${t.account},"${(t.merchant||'').replace(/"/g,'')}"`).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([head+body],{type:'text/csv'})); a.download='transactions.csv'; a.click(); }

// ---- routing handoff ----
const catToRouter=c=>({Groceries:'groceries',Dining:'dining',Shopping:'online',Subscriptions:'online',Transport:'groceries','Utilities/Telco':'utilities',Education:'education'}[c]||'general');
function routeTx(id){const t=M.tx.find(x=>x.id===id);if(!t)return;const p=new URLSearchParams({mode:'earn',amt:t.amount,cat:catToRouter(t.category),cur:t.fcy?'fcy':'sgd'});window.open(ROUTER_URL+'/?'+p,'_blank');}
function routeCat(cat,amt,fcy){const p=new URLSearchParams({mode:'earn',amt,cat:catToRouter(cat),cur:fcy?'fcy':'sgd'});window.open(ROUTER_URL+'/?'+p,'_blank');}

// ============================ BALANCE-SHEET AREAS ============================
const pf=items=>NW.byProfile(items||[],profile);
const kpi=(l,v,s,cls='')=>`<div class="kpi"><div class="l">${l}</div><div class="v ${cls}">${v}</div>${s?`<div class="s">${s}</div>`:''}</div>`;
const freshPill=asOf=>{const f=NW.dataFreshness(asOf);const c=f.status==='old'?'neg':f.status==='stale'?'warn':'ok';return `<span class="age age-${c}">${f.label}</span>`;};
// vivid categorical palette for charts (bright but coordinated)
const RAMP=['#3a5bd0','#17a673','#e8873a','#8a4fd6','#12a5c4','#d64b8a','#e0b23a','#5a8f2e','#c0453a','#6b7280'];
function donut(entries,total){ if(!entries.length)return '';
  const R=54,C=64,circ=2*Math.PI*R; let off=0;
  const arcs=entries.map(([c,v],i)=>{const frac=total?v/total:0;const dash=frac*circ;const seg=`<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${RAMP[i%RAMP.length]}" stroke-width="18" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-off}" transform="rotate(-90 ${C} ${C})"/>`;off+=dash;return seg;}).join('');
  const legend=entries.map(([c,v],i)=>`<div class="lg"><span class="sw" style="background:${RAMP[i%RAMP.length]}"></span><span class="lg-l">${c}</span><span class="lg-v">${sgd0(v)} · ${pct(v,total)}%</span></div>`).join('');
  return `<div class="donutwrap"><svg viewBox="0 0 128 128" width="128" height="128">${arcs}<text x="64" y="60" text-anchor="middle" font-size="10" fill="var(--ink-3)">Total</text><text x="64" y="76" text-anchor="middle" font-size="13" font-weight="600" fill="var(--heading)">${sgd0(total).replace('SGD ','')}</text></svg><div class="legend">${legend}</div></div>`; }

// ---- generic entity editor (cash / property / liability / goal) ----
const CCYS=['SGD','USD','EUR','INR','GBP','AUD','JPY','KRW','HKD','THB'];
const OWNERS=[['tanmay','Mine'],['urvi','Urvi'],['joint','Joint']];
function fld(f,val){ val=val==null?'':val;
  if(f.t==='ccy') return `<select id="ed_${f.k}">${CCYS.map(c=>`<option ${c===(val||'SGD')?'selected':''}>${c}</option>`).join('')}</select>`;
  if(f.t==='owner') return `<select id="ed_${f.k}">${OWNERS.map(([o,l])=>`<option value="${o}" ${o===(val||'tanmay')?'selected':''}>${l}</option>`).join('')}</select>`;
  if(f.t==='select') return `<select id="ed_${f.k}">${f.opts.map(o=>`<option ${o===val?'selected':''}>${o}</option>`).join('')}</select>`;
  return `<input id="ed_${f.k}" type="${f.t}" value="${esc(String(val))}" style="width:160px${f.t==='number'?';text-align:right':''}">`;
}
const EDITORS={
  cash:{table:'cash_accounts',coll:'cashAccounts',title:'Cash account',nameKey:'nickname',fields:[
    {k:'nickname',l:'Nickname',t:'text'},{k:'institution',l:'Institution',t:'text'},{k:'account_type',l:'Type (Savings/FD…)',t:'text'},
    {k:'balance',l:'Balance',t:'number'},{k:'currency',l:'Currency',t:'ccy'},{k:'yield_rate',l:'Yield % p.a.',t:'number'},
    {k:'owner',l:'Owner',t:'owner'},{k:'as_of',l:'As of',t:'date'}]},
  property:{table:'real_estate',coll:'realEstate',title:'Property',nameKey:'name',fields:[
    {k:'name',l:'Name',t:'text'},{k:'location',l:'Location',t:'text'},{k:'property_type',l:'Type',t:'text'},
    {k:'status',l:'Status',t:'select',opts:['watchlist','under-contract','owned']},
    {k:'property_value',l:'Value',t:'number'},{k:'loan_outstanding',l:'Loan outstanding',t:'number'},
    {k:'emi',l:'EMI / mo',t:'number'},{k:'currency',l:'Currency',t:'ccy'},{k:'owner',l:'Owner',t:'owner'}]},
  liability:{table:'liabilities',coll:'liabilities',title:'Liability',nameKey:'name',fields:[
    {k:'name',l:'Name',t:'text'},{k:'liability_type',l:'Type (Mortgage/Loan…)',t:'text'},{k:'lender',l:'Lender',t:'text'},
    {k:'outstanding',l:'Outstanding',t:'number'},{k:'interest_rate',l:'Rate % p.a.',t:'number'},
    {k:'emi',l:'EMI / mo',t:'number'},{k:'currency',l:'Currency',t:'ccy'},{k:'owner',l:'Owner',t:'owner'}]},
  goal:{table:'goals',coll:'goals',title:'Goal',nameKey:'name',fields:[
    {k:'name',l:'Name',t:'text'},{k:'target',l:'Target',t:'number'},{k:'current_override',l:'Current (leave blank to auto)',t:'number'},
    {k:'horizon',l:'Target date',t:'date'},{k:'owner',l:'Owner',t:'owner'}]},
  position:{table:'positions',coll:'positions',title:'Market position',nameKey:'symbol',fields:[
    {k:'symbol',l:'Ticker (e.g. NVDA, SUNPHARMA, ETH)',t:'text'},
    {k:'exchange',l:'Exchange',t:'select',opts:['US','NSE','BSE','SGX','CRYPTO']},
    {k:'quantity',l:'Quantity',t:'number'},{k:'cost_basis',l:'Cost basis (total)',t:'number'},
    {k:'currency',l:'Currency',t:'ccy'},{k:'label',l:'Label (optional)',t:'text'},{k:'owner',l:'Owner',t:'owner'}]},
};
function openEditor(type,id){ const spec=EDITORS[type]; const row= id?M[spec.coll].find(x=>x.id===id):{};
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button><h3>${id?'Edit':'Add'} ${spec.title.toLowerCase()}</h3>
    ${spec.fields.map(f=>`<div class="drow"><span class="k">${f.l}</span><span>${fld(f,row?.[f.k])}</span></div>`).join('')}
    <div class="fbtns"><button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.saveEditor('${type}','${id||''}')">Save</button>
    ${id?`<button class="fb" style="color:var(--neg)" onclick="SI.deleteEntity('${type}','${id}')">Delete</button>`:''}</div>
    <div id="edMsg" class="caption" style="margin-top:6px"></div>`;
  $('#ov').classList.add('show');
}
async function saveEditor(type,id){ const spec=EDITORS[type]; const patch={};
  spec.fields.forEach(f=>{ let v=$('#ed_'+f.k)?.value; if(f.t==='number') v=(v===''?null:parseFloat(v)); else if(v==='') v=null; patch[f.k]=v; });
  if(spec.fields.some(f=>f.k==='as_of') && !patch.as_of) patch.as_of=today();
  if(!id){ const nm=(patch[spec.nameKey]||'').toString().toLowerCase();
    const dup=M[spec.coll].find(x=>(x[spec.nameKey]||'').toString().toLowerCase()===nm && x.owner===patch.owner && nm);
    if(dup){ $('#edMsg').textContent=`A ${spec.title.toLowerCase()} named “${patch[spec.nameKey]}” already exists for this owner — edit that instead of adding a duplicate.`; $('#edMsg').className='caption val-neg'; return; } }
  try{ if(id) await db.updateRow(spec.table,id,patch); else await db.insertOne(spec.table,patch); await reload(); render(); closeSheet(); toast(`${spec.title} ${id?'updated':'added'}`); }
  catch(e){ $('#edMsg').textContent='Error: '+(e.message||e); $('#edMsg').className='caption val-neg'; }
}
function deleteEntity(type,id){ const spec=EDITORS[type]; confirmSheet(`Delete this ${spec.title.toLowerCase()}?`, async()=>{ await db.deleteRow(spec.table,id); await reload(); render(); toast(`${spec.title} deleted`); }); }
async function toggleEstate(field){ const base={...(M.estate||{})}; delete base.household_id; base[field]=!base[field]; await db.upsertSingle('estate_state', base); await reload(); render(); }
async function saveTax(){ const v=$('#taxSrs').value===''?null:parseFloat($('#taxSrs').value); const base={...(M.tax||{})}; delete base.household_id; base.srs_contributed_ytd=v; if(base.srs_cap==null)base.srs_cap=35700; await db.upsertSingle('tax_state', base); await reload(); render(); toast('SRS updated'); }
// section card with rows + Add button
function bsSection(title, coll, type, rowFn, accent){ const items=pf(M[coll]);
  let h=`<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${items.length?'8px':'0'}"><h2 style="margin:0">${title}${items.length?' · '+items.length:''}</h2><button class="btn sm" onclick="SI.addEntity('${type}')">+ Add</button></div>`;
  if(items.length){ h+=`<table><tbody>`; items.forEach(it=>h+=rowFn(it)); h+=`</tbody></table>`; }
  else h+=`<p class="caption muted" style="margin-top:8px">None yet — add one to include it in your net worth.</p>`;
  return h+`</div>`;
}

// ---- per-tab insights: "what the data shows & what to consider" ----
function insightCard(area){ const items=insightsFor(area); if(!items.length) return '';
  return `<div class="card"><h2><span class="dotmark" style="background:var(--accent)"></span>Insights — what to consider</h2>`+
    items.map(i=>`<div class="flagline"><span class="dot dot-${i.sev||'ok'}"></span><span>${i.text}</span></div>`).join('')+`</div>`; }
function insightsFor(area){ const out=[], nw=NW.netWorth(M,profile);
  if(area==='wealth'){
    pf(M.holdings).forEach(hd=>{ const p=nw.holdings?toSGD(hd.value_local,hd.currency)/nw.holdings*100:0;
      if(p>40) out.push({sev:'danger',text:`<b>${esc(hd.platform.split(' (')[0])}</b> is ${Math.round(p)}% of your wealth — trim single-name risk.`}); });
    const alloc=NW.wealthByCategory(M.holdings,profile,M.fx); const eq=(alloc.equity||0)+(alloc.growth||0); const eqPct=nw.holdings?Math.round(eq/nw.holdings*100):0;
    if(eqPct>=80) out.push({sev:'warn',text:`<b>${eqPct}% in equity/growth</b> — a strong growth tilt. Add defensive ballast as goals near.`});
    const stale=pf(M.holdings).filter(h=>{const a=NW.dataFreshness(h.as_of);return a.days!=null&&a.days>180;});
    if(stale.length) out.push({sev:'warn',text:`<b>${stale.length} holding(s)</b> are 180+ days stale — run <b>Quick-update values</b> for an accurate net worth.`});
    out.push({sev:'ok',text:`Cash is <b>${sgd0(nw.cash)}</b> — keep ~6 months of expenses liquid; the rest can work harder.`});
  } else if(area==='protection'){
    const ps=pf(M.policies), co=ps.filter(isCompanyPolicy), coHosp=coverSum(co,'hospital');
    if(coHosp>0) out.push({sev:'danger',text:`Hospitalisation cover of <b>${sgd0(coHosp)}</b> is employer-provided and <b>lapses when you leave SAP</b> — secure a standalone Integrated Shield Plan first.`});
    const selfDeath=coverSum(ps.filter(p=>!isCompanyPolicy(p)),'death');
    out.push({sev:selfDeath>=1000000?'ok':'warn',text:`You personally fund <b>${sgd0(selfDeath)}</b> of life cover — the part that survives leaving your employer.`});
  }
  return out;
}

function homeView(){
  if(!M.holdings.length && !M.tx.length){ $('#view').innerHTML=`<div class="card" style="text-align:center;padding:44px"><h3>Welcome to your financial command centre</h3><p class="muted" style="margin:6px 0 18px">Import your investments &amp; insurance (Settings → Import v3 data) and your statements (Cash Flow → Import) to light this up.</p><button class="btn pri" onclick="SI.go('settings')">Import my data</button></div>`; return; }
  const nw=NW.netWorth(M,profile);
  const alloc=Object.entries(NW.wealthByCategory(M.holdings,profile,M.fx)).sort((a,b)=>b[1]-a[1]);
  const fl=NW.flags(M,profile);
  const cover=NW.coverTotals(M.policies,profile,M.fx);
  const goals=pf(M.goals).filter(g=>g.target);
  const ct=counted().filter(pMatch);
  const months=[...new Set(ct.map(t=>t.txn_date.slice(0,7)))].sort();
  const lm=months[months.length-1];
  const mt=lm?ct.filter(t=>t.txn_date.slice(0,7)===lm):[];
  const NOFLOW=new Set(['Transfer','Refund']);   // internal movements excluded; Income counts as money-in
  const inn=mt.filter(t=>t.direction==='in'&&!NOFLOW.has(t.category)).reduce((s,t)=>s+t.amount,0);
  const out=mt.filter(t=>t.direction==='out'&&!nonspendSet().has(t.category)).reduce((s,t)=>s+t.amount,0);
  const save= inn? Math.round((inn-out)/inn*100):null;
  const topAlloc=alloc[0], topPct=nw.holdings?Math.round(topAlloc?.[1]/nw.holdings*100):0;

  let h=`<div class="pagehead"><h1>${profLabel(profile)}</h1><p class="muted">Your position at a glance — reviewed periodically, pivoted deliberately.</p></div>`;
  h+=`<div class="kpis">
    ${kpi('Net worth', sgd0(nw.total), `${sgd0(nw.holdings)} invested`)}
    ${kpi('Savings rate', save==null?'—':save+'%', lm?`${fmtMonth(lm)} · in ${sgd0(inn)} / out ${sgd0(out)}`:'import statements')}
    ${kpi('Cash &amp; liquidity', sgd0(nw.cash), nw.cash?`emergency buffer${nw.debt?' · debt '+sgd0(nw.debt):''}`:'liquid savings — none recorded yet')}
    ${kpi('Life cover', sgd0(cover.death), `CI ${sgd0(cover.ci)}`)}
  </div>`;
  // flags
  if(fl.length){ h+=`<div class="card"><h2>Flags</h2>${fl.map(f=>`<div class="flagline"><span class="dot dot-${f.severity==='danger'?'danger':f.severity==='warn'?'warn':'ok'}"></span><span><b>${f.title}.</b> ${f.detail}</span></div>`).join('')}</div>`; }
  // allocation
  if(alloc.length){ h+=`<div class="card"><h2>Wealth allocation</h2>${donut(alloc, nw.holdings)}
    ${topPct>40?`<p class="caption" style="margin-top:10px"><span class="dotmark" style="background:${RAMP[0]}"></span><span class="val-neg">${topAlloc[0]}</span> is ${topPct}% of invested wealth — concentration to watch.</p>`:''}</div>`; }
  // goals
  if(goals.length){ h+=`<div class="card"><h2>Goals</h2>${goals.map(g=>goalBar(g)).join('')}</div>`; }
  // net worth trend
  h+=`<div class="card"><h2>Net-worth trend</h2>${trendNW(M.snapshots)}</div>`;
  $('#view').innerHTML=h;
}
function allocBars(entries,total){ const max=entries[0][1]||1;
  return entries.map(([c,v],i)=>`<div class="bar-row"><div class="bar-l">${c}</div><div class="barbg"><div class="bar" style="width:${v/max*100}%;background:${RAMP[i%RAMP.length]}"></div></div><div class="bar-v">${sgd0(v)} <span class="muted">${pct(v,total)}%</span></div></div>`).join(''); }
function goalBar(g){ const cur=NW.goalCurrentSGD(g,M.holdings,M.fx); const p=g.target?Math.min(100,cur/g.target*100):0;
  return `<div class="bar-row"><div class="bar-l">${esc(g.name)}</div><div class="barbg"><div class="bar" style="width:${p}%"></div></div><div class="bar-v">${sgd0(cur)} / ${sgd0(g.target)} <span class="muted">${Math.round(p)}%</span></div></div>`; }
function trendNW(snaps){ const s=snaps.slice().sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''));
  if(s.length<2) return `<p class="muted">One snapshot so far (${s.length?sgd0(s[0].net_worth_sgd):'—'}). Snapshots are taken monthly — the trend line appears once there are two.</p>`;
  const W=640,H=180,pad=30,max=Math.max(...s.map(x=>x.net_worth_sgd)),min=Math.min(...s.map(x=>x.net_worth_sgd));
  const x=i=>pad+i*(W-2*pad)/(s.length-1), y=v=>H-pad-((v-min)/((max-min)||1))*(H-2*pad);
  const pts=s.map((p,i)=>`${x(i)},${y(p.net_worth_sgd)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>${s.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.net_worth_sgd)}" r="${i===s.length-1?4:3}" fill="var(--accent)"/>`).join('')}</svg>`; }

function wealthView(){
  const nw=NW.netWorth(M,profile);
  const hs=pf(M.holdings).sort((a,b)=>toSGD(b.value_local,b.currency)-toSGD(a.value_local,a.currency));
  let h=`<div class="pagehead" style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px"><h1>Wealth · ${profLabel(profile)}</h1>
    <div style="display:flex;gap:8px"><button class="btn" onclick="SI.quickUpdate()">Quick-update values</button><button class="btn pri" onclick="SI.snapshot()">Take snapshot</button></div></div>
    <div class="kpis">${kpi('Net worth',sgd0(nw.total))}${kpi('Investments',sgd0(nw.holdings))}${kpi('Cash',sgd0(nw.cash))}${kpi('Property equity',sgd0(nw.realEstate))}</div>`;
  h+=insightCard('wealth');
  const stale=hs.filter(hd=>{const a=NW.dataFreshness(hd.as_of);return a.days!=null&&a.days>180;}).length;
  const oldest=hs.map(hd=>hd.as_of).filter(Boolean).sort()[0];
  h+=`<div class="card"><h2>Investments · ${hs.length}</h2>
    <p class="caption" style="margin:-6px 0 10px">${oldest?`Oldest value from ${dfull(oldest)}.`:''} ${stale?`<span class="val-neg">${stale} not refreshed in 180+ days</span> — click a holding to update.`:'All values reasonably fresh.'}</p>
    <table><thead><tr><th>Holding</th><th>Owner</th><th class="num">Value (SGD)</th><th class="num">Since inception</th><th>Updated</th></tr></thead><tbody>`;
  hs.forEach(hd=>{ const v=toSGD(hd.value_local,hd.currency); const si=NW.sinceInception(hd,M.fx);
    h+=`<tr style="cursor:pointer" onclick="SI.holding('${hd.id}')"><td>${esc(hd.platform)}<div class="caption muted">${hd.category||''}${hd.currency!=='SGD'?' · '+hd.currency+' '+Math.round(hd.value_local).toLocaleString():''}</div></td>
      <td class="caption">${hd.owner}</td><td class="num">${sgd0(v)}</td>
      <td class="num ${si?valCls(si.gain):''}">${si?signed(si.gain)+' · '+(si.pct>=0?'+':'')+si.pct.toFixed(0)+'%':'—'}</td>
      <td>${freshPill(hd.as_of)}</td></tr>`; });
  h+=`</tbody></table></div>`;
  // cash accounts
  h+=bsSection('Cash &amp; deposits','cashAccounts','cash', a=>`<tr style="cursor:pointer" onclick="SI.editEntity('cash','${a.id}')"><td>${esc(a.nickname||a.institution||'Account')}<div class="caption muted">${esc(a.account_type||'')}${a.as_of?' · updated '+dfull(a.as_of):''}</div></td><td class="caption">${a.owner}</td><td class="num">${sgd0(toSGD(a.balance,a.currency))}</td></tr>`);
  // real estate
  h+=bsSection('Property','realEstate','property', p=>{const eq=(p.status!=='watchlist')?toSGD(p.property_value,p.currency)-toSGD(p.loan_outstanding,p.currency):0;
    return `<tr style="cursor:pointer" onclick="SI.editEntity('property','${p.id}')"><td>${esc(p.name||'Property')}<div class="caption muted">${esc(p.location||'')} · ${p.status}</div></td><td class="caption">${p.owner}</td><td class="num">${p.status==='watchlist'?'<span class="muted">watchlist</span>':sgd0(eq)+' <span class="caption muted">equity</span>'}</td></tr>`;});
  // liabilities
  h+=bsSection('Liabilities','liabilities','liability', l=>`<tr style="cursor:pointer" onclick="SI.editEntity('liability','${l.id}')"><td>${esc(l.name||l.liability_type||'Liability')}<div class="caption muted">${esc(l.lender||'')}${l.interest_rate?' · '+l.interest_rate+'%':''}</div></td><td class="caption">${l.owner}</td><td class="num val-neg">−${sgd0(toSGD(l.outstanding,l.currency))}</td></tr>`);
  // market positions (tickers for live-market analysis → Plan → Market)
  h+=bsSection('Market positions <span class="caption muted" style="text-transform:none;letter-spacing:0">(tickers for live analysis)</span>','positions','position', p=>`<tr style="cursor:pointer" onclick="SI.editEntity('position','${p.id}')"><td>${esc(p.symbol)}<div class="caption muted">${p.exchange||''}${p.label?' · '+esc(p.label):''}</div></td><td class="caption">${p.owner}</td><td class="num">${p.quantity!=null?(+p.quantity).toLocaleString()+' units':''}</td></tr>`);
  $('#view').innerHTML=h;
}
// holding detail sheet
const valsFor=id=>M.valuations.filter(v=>v.holding_id===id).sort((a,b)=>a.as_of.localeCompare(b.as_of));
function sparkline(vals){ if(vals.length<2)return '';
  const W=180,H=36,xs=vals.map((v,i)=>i),ys=vals.map(v=>+v.value_local),max=Math.max(...ys),min=Math.min(...ys);
  const x=i=>i*(W-4)/(vals.length-1)+2, y=v=>H-2-((v-min)/((max-min)||1))*(H-4);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block"><polyline points="${vals.map((v,i)=>x(i)+','+y(+v.value_local)).join(' ')}" fill="none" stroke="var(--area)" stroke-width="1.5"/></svg>`;}
const today=()=>{const d=new Date(); const p=n=>String(n).padStart(2,'0'); return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate());};
function openHolding(id){ const hd=M.holdings.find(x=>x.id===id); if(!hd)return; const si=NW.sinceInception(hd,M.fx); const v=toSGD(hd.value_local,hd.currency);
  const row=(k,val)=>`<div class="drow"><span class="k">${k}</span><span class="v2">${val}</span></div>`;
  const vals=valsFor(id);
  const hist=vals.length?`<div class="card" style="box-shadow:none;border:none;padding:0;margin-top:14px"><h2>Value history</h2>${sparkline(vals)}
    <table style="margin-top:6px"><tbody>${vals.slice().reverse().slice(0,6).map((x,i,arr)=>{const prev=arr[i+1];const chg=prev?(+x.value_local-+prev.value_local):0;
      return `<tr><td class="caption">${dfull(x.as_of)}</td><td class="num">${x.currency||hd.currency} ${(+x.value_local).toLocaleString()}</td><td class="num ${valCls(chg)}">${prev?signed(chg).replace('SGD ',''):''}</td></tr>`;}).join('')}</tbody></table></div>`:'';
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button>
    <h3 style="margin-bottom:2px">${esc(hd.platform)}</h3><div class="muted" style="margin-bottom:10px">${hd.subtype||''}</div>
    ${row('Value', `${sgd0(v)}${hd.currency!=='SGD'?` <span class="muted">(${hd.currency} ${Math.round(hd.value_local).toLocaleString()})</span>`:''}`)}
    ${si?row('Since inception', `<span class="${valCls(si.gain)}">${signed(si.gain)} · ${si.pct>=0?'+':''}${si.pct.toFixed(1)}%</span>`):''}
    ${si?row('Contributed', sgd0(si.cost)):''}
    ${row('Owner', hd.owner)}${row('Category', hd.category||'—')}${hd.account?row('Account', esc(hd.account)):''}
    ${row('Updated on', hd.as_of?dfull(hd.as_of)+' · '+freshPill(hd.as_of):'—')}
    ${hd.tags?.length?row('Tags', hd.tags.map(t=>`<span class="chip">${t}</span>`).join(' ')):''}
    ${hd.notes?`<p class="caption" style="margin-top:12px;color:var(--ink-2)">${esc(hd.notes)}</p>`:''}
    <div class="card" style="box-shadow:none;border:1px solid var(--hairline);margin-top:14px"><h2>Update value</h2>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div><label class="caption">New value (${hd.currency})</label><br><input id="hvVal" type="number" value="${hd.value_local??''}" style="width:140px;text-align:right"></div>
        <div><label class="caption">As of</label><br><input id="hvDate" type="date" value="${today()}" style="width:150px"></div>
        <button class="btn pri" onclick="SI.saveHoldingValue('${id}')">Save</button>
      </div><div id="hvMsg" class="caption" style="margin-top:8px"></div></div>
    ${hist}`;
  $('#ov').classList.add('show');
}
async function saveHoldingValue(id){ const hd=M.holdings.find(x=>x.id===id); if(!hd)return;
  const val=parseFloat($('#hvVal').value), d=$('#hvDate').value;
  if(isNaN(val)||!d){ $('#hvMsg').textContent='Enter a value and date.'; $('#hvMsg').className='caption val-neg'; return; }
  const dup=valsFor(id).find(x=>x.as_of===d && +x.value_local===val);
  if(dup){ $('#hvMsg').textContent='Same value already recorded for that date — no change.'; $('#hvMsg').className='caption'; return; }
  try{ await db.addValuation(id, d, val, hd.currency); await reload(); render(); openHolding(id); toast('Value updated · '+dfull(d)); }
  catch(e){ $('#hvMsg').textContent='Error: '+(e.message||e); $('#hvMsg').className='caption val-neg'; }
}
// Quick-update NAVs (bulk) — the monthly refresh workflow
function openQuickUpdate(focusId){ const hs=pf(M.holdings);
  const rows=hs.map(hd=>`<div class="drow" style="gap:10px"><span style="flex:1">${esc(hd.platform)}<div class="caption muted">${hd.currency}</div></span>
    <input id="qv_${hd.id}" type="number" value="${hd.value_local??''}" style="width:120px;text-align:right" placeholder="value">
    <input id="qd_${hd.id}" type="date" value="${hd.as_of||''}" style="width:150px"></div>`).join('');
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button><h3>Quick-update values</h3>
    <p class="muted" style="margin:4px 0 12px">Enter latest value + date for each holding, then save. This is your monthly refresh.</p>
    <div style="max-height:56vh;overflow:auto">${rows}</div>
    <div class="fbtns"><button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.saveQuickUpdate()">Save all</button></div>`;
  $('#ov').classList.add('show');
}
async function saveQuickUpdate(){ const hs=pf(M.holdings); let n=0;
  for(const hd of hs){ const vEl=$('#qv_'+hd.id), dEl=$('#qd_'+hd.id); if(!vEl)continue;
    const nv=vEl.value===''?null:parseFloat(vEl.value); const nd=dEl.value||null;
    if(nv!=null && nd && (nv!==hd.value_local || nd!==hd.as_of)){ await db.addValuation(hd.id, nd, nv, hd.currency); n++; } }
  closeSheet(); await reload(); render(); toast(n?`Updated ${n} holding value(s)`:'No changes');
}
async function takeSnapshot(){ const nw=NW.netWorth(M,'household');
  const holdings=M.holdings.map(h=>({id:h.ext_id||h.id, platform:h.platform, owner:h.owner, valueLocal:h.value_local, currency:h.currency, valueSGD:toSGD(h.value_local,h.currency), asOf:h.as_of}));
  const goals=M.goals.map(g=>({id:g.ext_id||g.id, target:g.target, current:NW.goalCurrentSGD(g,M.holdings,M.fx)}));
  await db.createSnapshot({label:'Snapshot', total_wealth_sgd:nw.holdings, net_worth_sgd:nw.total, holdings, goals});
  await reload(); render(); toast('Snapshot saved · net worth '+sgd0(nw.total));
}

function isCompanyPolicy(p){ return /group|employer|SAP/i.test((p.insurer||'')+' '+(p.type||'')+' '+(p.notes||'')) || !((p.premium||0)>0); }
function coverSum(list,key){ return list.reduce((s,p)=>s+toSGD(p.covers?.[key]||0, p.currency),0); }
function protectionView(){
  const ps=pf(M.policies);
  const company=ps.filter(isCompanyPolicy), self=ps.filter(p=>!isCompanyPolicy(p));
  const selfDeath=coverSum(self,'death'), coDeath=coverSum(company,'death');
  const annualPrem=self.reduce((s,p)=>s+premYr(p),0);
  let h=`<div class="pagehead"><h1>Protection · ${profLabel(profile)}</h1></div>
    <div class="kpis">
      ${kpi('Life cover you fund', sgd0(selfDeath), `${self.length} self-paid`)}
      ${kpi('Company cover', sgd0(coDeath), `${company.length} employer — lapses on exit`)}
      ${kpi('Critical illness', sgd0(coverSum(ps,'ci')))}
      ${kpi('Premiums you pay / yr', sgd0(annualPrem))}
    </div>`;
  h+=insightCard('protection');
  h+=renewalsCard(ps);
  h+=policyTable('You maintain (self-funded)', self, '#15653f');
  h+=policyTable('From company (SAP group — lapses on exit)', company, '#9a6a12');
  $('#view').innerHTML=h;
}
function renewalsCard(ps){
  const now=new Date(), soon=d=>d && (new Date(d)-now)/86400000 <= 90;
  const due=ps.filter(p=>p.renewal_date).map(p=>({p, d:p.renewal_date, days:Math.floor((new Date(p.renewal_date)-now)/86400000)})).filter(x=>x.days<=90).sort((a,b)=>a.days-b.days);
  const mat=ps.filter(p=>p.maturity_date).map(p=>({p, d:p.maturity_date, days:Math.floor((new Date(p.maturity_date)-now)/86400000)})).filter(x=>x.days<=365).sort((a,b)=>a.days-b.days);
  if(!due.length && !mat.length) return '';
  let h=`<div class="card"><h2>Renewals &amp; maturities</h2>`;
  due.forEach(x=>h+=`<div class="flagline"><span class="dot dot-${x.days<0?'danger':'warn'}"></span><span><b>${esc(x.p.insurer)} ${esc(x.p.product||'')}</b> premium ${sgd0(premYr(x.p))}/yr ${x.days<0?`<span class="val-neg">${Math.abs(x.days)}d overdue</span>`:`due in ${x.days}d`} (${dfull(x.d)}).</span></div>`);
  mat.forEach(x=>h+=`<div class="flagline"><span class="dot dot-ok"></span><span><b>${esc(x.p.insurer)} ${esc(x.p.product||'')}</b> matures ${dfull(x.d)} (${x.days<0?'passed':'in '+Math.round(x.days/30)+' mo'}).</span></div>`);
  return h+`</div>`;
}
function policyTable(title, list, dot){
  if(!list.length) return '';
  let h=`<div class="card"><h2><span class="dotmark" style="background:${dot}"></span>${title} · ${list.length}</h2><table><thead><tr><th>Policy</th><th>Owner</th><th>Type</th><th class="num">Cover</th><th class="num">Premium/yr</th></tr></thead><tbody>`;
  list.forEach(p=>{ const c=p.covers||{}; const main=Math.max(c.death||0,c.ci||0,c.hospital||0);
    h+=`<tr style="cursor:pointer" onclick="SI.policy('${p.id}')"><td>${esc(p.insurer)} <span class="muted">${esc(p.product||'')}</span></td><td class="caption">${p.owner}</td><td class="caption">${p.type}</td><td class="num">${sgd0(toSGD(main,p.currency))}</td><td class="num">${premYr(p)?sgd0(premYr(p)):'—'}</td></tr>`; });
  return h+`</tbody></table></div>`;
}
function premYr(p){ const mult=p.premium_freq==='monthly'?12:p.premium_freq==='quarterly'?4:p.premium_freq==='semi-annual'?2:1; return NW.toSGD((p.premium||0)*mult, p.premium_currency, M.fx); }
function dstat(d,label){ if(!d)return ''; const days=Math.floor((new Date(d)-new Date())/86400000);
  const cls=days<0?'val-neg':days<60?'val-neg':days<180?'val-neutral':'val-neutral';
  return `${dfull(d)} <span class="caption ${days<0?'val-neg':''}">(${days<0?Math.abs(days)+'d overdue':'in '+days+'d'})</span>`; }
function openPolicy(id){ const p=M.policies.find(x=>x.id===id); if(!p)return; const c=p.covers||{};
  const row=(k,v)=>`<div class="drow"><span class="k">${k}</span><span class="v2">${v}</span></div>`;
  const cov=[['Death',c.death],['TPD',c.tpd],['Critical illness',c.ci],['Early CI',c.earlyCi],['Hospitalisation',c.hospital]].filter(([,v])=>v>0);
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button>
    <h3 style="margin-bottom:2px">${esc(p.insurer)}</h3><div class="muted" style="margin-bottom:10px">${esc(p.product||'')} · ${p.type}</div>
    ${cov.map(([k,v])=>row(k, sgd0(toSGD(v,p.currency)))).join('')}
    ${row('Premium', premYr(p)?sgd0(premYr(p))+' / yr':'—')}
    ${row('Premium paid to', p.premium_paid_to?dstat(p.premium_paid_to):'—')}
    ${row('Next premium due', p.renewal_date?dstat(p.renewal_date):(p.expiry?esc(p.expiry):'—'))}
    ${row('Maturity', p.maturity_date?dstat(p.maturity_date):(p.expiry?esc(p.expiry):'—'))}
    ${row('Owner', p.owner)}${p.policy_number?row('Policy no.', esc(p.policy_number)):''}
    ${row('Updated on', p.as_of?dfull(p.as_of)+' · '+freshPill(p.as_of):'—')}
    ${p.notes?`<p class="caption" style="margin:10px 0 0;color:var(--ink-2)">${esc(p.notes)}</p>`:''}
    <div class="card" style="box-shadow:none;border:1px solid var(--hairline);margin-top:14px"><h2>Update policy</h2>
      <div class="drow"><span class="k">Premium (${p.premium_currency||p.currency} / ${p.premium_freq||'annual'})</span><span><input id="ppPrem" type="number" value="${p.premium??''}" style="width:130px;text-align:right"></span></div>
      <div class="drow"><span class="k">Premium paid to</span><span><input id="ppPaid" type="date" value="${p.premium_paid_to||''}" style="width:150px"></span></div>
      <div class="drow"><span class="k">Next premium due</span><span><input id="ppRenew" type="date" value="${p.renewal_date||''}" style="width:150px"></span></div>
      <div class="drow"><span class="k">Maturity date</span><span><input id="ppMat" type="date" value="${p.maturity_date||''}" style="width:150px"></span></div>
      <div class="fbtns"><button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.savePolicy('${id}')">Save</button></div>
      <div id="ppMsg" class="caption" style="margin-top:6px"></div></div>`;
  $('#ov').classList.add('show');
}
async function savePolicy(id){ const p=M.policies.find(x=>x.id===id); if(!p)return;
  const patch={ premium: $('#ppPrem').value===''?null:parseFloat($('#ppPrem').value),
    premium_paid_to: $('#ppPaid').value||null, renewal_date: $('#ppRenew').value||null,
    maturity_date: $('#ppMat').value||null, as_of: today() };
  try{ await db.updatePolicy(id, patch); await reload(); render(); openPolicy(id); toast('Policy updated'); }
  catch(e){ $('#ppMsg').textContent='Error: '+(e.message||e); $('#ppMsg').className='caption val-neg'; }
}

let PLAN_TAB='goals';
const SCEN={ fire:{expenses:null,mult:25,ret:5,contrib:5000,invested:0}, sap:{stock:1,salary:1,ins:1}, goal:{target:200000,monthly:null,ret:4} };
function planTab(t){ PLAN_TAB=t; planBody(); }
function scenIn(g,k,v){ SCEN[g][k]= v===''?0:parseFloat(v); if(PLAN_TAB==='fire')computeFire(); else if(PLAN_TAB==='leavesap')computeSap(); else if(PLAN_TAB==='goals')computeGoal(); }
function annualExpenses(){ // from real transactions (household), avg monthly spend × 12
  const P=counted().filter(t=>t.direction==='out'&&!nonspendSet().has(t.category));
  const ms=[...new Set(P.map(t=>t.txn_date.slice(0,7)))]; if(!ms.length) return 120000;
  const total=P.reduce((s,t)=>s+t.amount,0); return Math.round(total/ms.length*12);
}
function monthlySurplus(){ const P=counted().filter(pMatch);
  const ms=[...new Set(P.map(t=>t.txn_date.slice(0,7)))]; if(!ms.length) return 0;
  const NOFLOW=new Set(['Transfer','Refund']);
  const inc=P.filter(t=>t.direction==='in'&&!NOFLOW.has(t.category)).reduce((s,t)=>s+t.amount,0);
  const exp=P.filter(t=>t.direction==='out'&&!nonspendSet().has(t.category)).reduce((s,t)=>s+t.amount,0);
  return Math.round((inc-exp)/ms.length);
}
function selfPremiums(){ return pf(M.policies).filter(p=>!isCompanyPolicy(p)).reduce((s,p)=>s+premYr(p),0); }
function planView(){
  const sub=[['goals','Goals'],['fire','FIRE'],['leavesap','Leave SAP'],['ask','Market']];
  $('#view').innerHTML=`<div class="pagehead"><h1>Plan · ${profLabel(profile)}</h1><p class="muted">Simulations only — your data never changes.</p></div>
    <div class="subnav">${sub.map(([t,l])=>`<button class="${PLAN_TAB===t?'on':''}" onclick="SI.planTab('${t}')">${l}</button>`).join('')}</div><div id="planbody"></div>`;
  planBody();
}
function planBody(){ document.querySelectorAll('.subnav button').forEach(b=>{}); ({goals:planGoals,fire:planFire,leavesap:planSap,ask:planAsk}[PLAN_TAB]||planGoals)(); }

function planGoals(){
  const goals=pf(M.goals).filter(g=>g.target);
  const surplus=monthlySurplus(), prem=selfPremiums();
  if(SCEN.goal.monthly==null) SCEN.goal.monthly=Math.max(0,surplus);
  let h=`<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${goals.length?'6px':'0'}"><h2 style="margin:0">Goals — funding progress</h2><button class="btn sm" onclick="SI.addEntity('goal')">+ Add</button></div>${goals.length?goals.map(g=>`<div style="cursor:pointer" onclick="SI.editEntity('goal','${g.id}')">${goalBar(g)}</div>`).join(''):'<p class="muted" style="margin-top:8px">No goals yet.</p>'}</div>`;
  // goal-seek planner
  h+=`<div class="card"><h2>Goal planner — how long to reach a target</h2>
    <p class="muted" style="margin-bottom:12px">Your current monthly surplus (income − spending) is <b class="${valCls(surplus)}">${(surplus<0?'−':'+')+sgd0(Math.abs(surplus))}</b> across your statement history. Enter a target and see how long it takes.</p>
    <div class="drow"><span class="k">Target amount</span><span>${nInput('goal','target',SCEN.goal.target,5000)}</span></div>
    <div class="drow"><span class="k">Monthly contribution</span><span>${nInput('goal','monthly',SCEN.goal.monthly,250)}</span></div>
    <div class="drow"><span class="k">Expected return % / yr</span><span>${nInput('goal','ret',SCEN.goal.ret,0.5)}</span></div>
    <div id="goalOut" style="margin-top:14px"></div>
    ${prem>0?`<div class="flagline" style="margin-top:12px"><span class="dot dot-warn"></span><span>You commit <b>${sgd0(prem)}/yr</b> in insurance premiums — keep these funded on time so cover doesn’t lapse before you fund this goal.</span></div>`:''}
  </div>`;
  h+=`<div class="card"><h2>Tax &amp; SRS</h2>
    <div class="drow"><span class="k">SRS contributed this year</span><span><input id="taxSrs" type="number" value="${M.tax?.srs_contributed_ytd??''}" style="width:130px;text-align:right"> <button class="btn sm" onclick="SI.saveTax()">Save</button></span></div>
    <p class="caption muted" style="margin-top:6px">Cap ${sgd0(M.tax?.srs_cap||35700)}/yr. ${esc(M.tax?.notes||'')}</p></div>`;
  { const e=M.estate||{}; const item=(ok,l,f)=>`<div class="flagline" style="cursor:pointer" onclick="SI.toggleEstate('${f}')"><span class="dot dot-${ok?'ok':'danger'}"></span><span>${l} <span class="caption muted">${ok?'✓ done':'tap when done'}</span></span></div>`;
    h+=`<div class="card"><h2>Estate — tap to update</h2>${item(e.will_sg,'SG will','will_sg')}${item(e.will_india,'India will','will_india')}${item(e.guardianship_documented,'Guardianship documented','guardianship_documented')}${item(e.beneficiaries_checked,'Beneficiaries checked','beneficiaries_checked')}<p class="caption muted" style="margin-top:6px">${esc(e.notes||'')}</p></div>`; }
  $('#planbody').innerHTML=h;
  computeGoal();
}
function computeGoal(){ const g=SCEN.goal; const r=(g.ret||0)/100; let bal=0, months=null;
  for(let m=1;m<=1200;m++){ bal=bal*(1+r/12)+(g.monthly||0); if(bal>=g.target){months=m;break;} }
  const out=$('#goalOut'); if(!out)return;
  if(!g.monthly||g.monthly<=0){ out.innerHTML=`<div class="flagline"><span class="dot dot-danger"></span><span>With no monthly contribution you’ll never reach ${sgd0(g.target)} — free up cash flow or add a lump sum.</span></div>`; return; }
  const yrs=months?Math.floor(months/12):null, mo=months?months%12:null;
  out.innerHTML=`<div class="kpis" style="margin:0">
    ${kpi('Time to reach', months==null?'100+ yrs':(yrs?yrs+'y ':'')+mo+'m', sgd0(g.monthly)+'/mo at '+g.ret+'%')}
    ${kpi('Target', sgd0(g.target))}
    ${kpi('Total contributed', sgd0((g.monthly||0)*(months||0)), months?`over ${months} months`:'')}</div>`;
}
const nInput=(g,k,v,step)=>`<input type="number" step="${step||1}" value="${v}" oninput="SI.scenIn('${g}','${k}',this.value)" style="width:130px;text-align:right">`;
function planFire(){
  if(SCEN.fire.expenses==null) SCEN.fire.expenses=annualExpenses();
  SCEN.fire.invested=Math.round(NW.netWorth(M,'household').holdings);
  const f=SCEN.fire;
  $('#planbody').innerHTML=`<div class="card"><h2>FIRE — financial independence</h2>
    <p class="muted" style="margin-bottom:14px">When your investments can cover your spending forever. Adjust the levers — nothing is saved.</p>
    <div class="drow"><span class="k">Annual expenses</span><span>${nInput('fire','expenses',f.expenses,1000)}</span></div>
    <div class="drow"><span class="k">Target multiple (25 = 4% rule)</span><span>${nInput('fire','mult',f.mult,1)}</span></div>
    <div class="drow"><span class="k">Expected return % / yr</span><span>${nInput('fire','ret',f.ret,0.5)}</span></div>
    <div class="drow"><span class="k">Monthly contribution</span><span>${nInput('fire','contrib',f.contrib,500)}</span></div>
    <div class="drow"><span class="k">Currently invested</span><span class="v2">${sgd0(f.invested)}</span></div>
    <div id="fireOut" style="margin-top:16px"></div></div>`;
  computeFire();
}
function computeFire(){ const f=SCEN.fire; const fiNum=f.expenses*f.mult; const progress=fiNum?Math.min(100,f.invested/fiNum*100):0;
  const r=(f.ret||0)/100; let bal=f.invested, years=null; for(let m=1;m<=1200;m++){ bal=bal*(1+r/12)+(f.contrib||0); if(bal>=fiNum){years=(m/12);break;} }
  const coastYrs=r>0? Math.log(fiNum/Math.max(1,f.invested))/Math.log(1+r):null; // years for current pot alone to reach FI
  const out=$('#fireOut'); if(!out)return;
  out.innerHTML=`<div class="kpis" style="margin:0">
    ${kpi('FI number', sgd0(fiNum), `${f.mult}× expenses`)}
    ${kpi('Progress', Math.round(progress)+'%', sgd0(f.invested)+' of '+sgd0(fiNum))}
    ${kpi('Years to FI', years==null?'30+':years.toFixed(1), `at ${f.ret}% + ${sgd0(f.contrib)}/mo`)}
    ${kpi('Coast-FIRE', coastYrs==null?'—':coastYrs.toFixed(1)+' yrs', 'pot alone reaches FI')}</div>
    <div class="flagline" style="margin-top:12px"><span class="dot dot-${progress>=100?'ok':progress>=50?'warn':'danger'}"></span><span>${progress>=100?'You are financially independent at this spend level.':`You're ${Math.round(progress)}% of the way. Raising contributions or trimming expenses moves the date most.`}</span></div>`;
}
function planSap(){
  const s=SCEN.sap;
  $('#planbody').innerHTML=`<div class="card"><h2>What if I leave SAP</h2>
    <p class="muted" style="margin-bottom:14px">The triple hit: salary stops, SAP stock is no longer employer-linked, and SAP group insurance lapses. Toggle what to model.</p>
    <div class="drow"><span class="k">Remove SAP EquatePlus from net worth</span><span><label class="tgl"><input type="checkbox" ${s.stock?'checked':''} onchange="SI.scenIn('sap','stock',this.checked?1:0)"> exclude</label></span></div>
    <div class="drow"><span class="k">Drop SAP group insurance cover</span><span><label class="tgl"><input type="checkbox" ${s.ins?'checked':''} onchange="SI.scenIn('sap','ins',this.checked?1:0)"> lapse</label></span></div>
    <div id="sapOut" style="margin-top:16px"></div></div>`;
  computeSap();
}
function computeSap(){ const s=SCEN.sap; const nw=NW.netWorth(M,'household');
  const sap=M.holdings.find(h=>/equateplus|SAP/i.test(h.platform)); const sapVal=sap?toSGD(sap.value_local,sap.currency):0;
  const newNW = nw.total - (s.stock? sapVal:0);
  const ps=M.policies; const coHosp=ps.filter(isCompanyPolicy).reduce((a,p)=>a+toSGD(p.covers?.hospital||0,p.currency),0);
  const coDeath=ps.filter(isCompanyPolicy).reduce((a,p)=>a+toSGD(p.covers?.death||0,p.currency),0);
  const selfDeath=ps.filter(p=>!isCompanyPolicy(p)).reduce((a,p)=>a+toSGD(p.covers?.death||0,p.currency),0);
  const expenses=annualExpenses(); const runway= nw.cash? (nw.cash/(expenses/12)).toFixed(1):'0';
  const out=$('#sapOut'); if(!out)return;
  out.innerHTML=`<div class="kpis" style="margin:0">
    ${kpi('Net worth after', sgd0(newNW), s.stock?`−${sgd0(sapVal)} SAP stock`:'stock kept')}
    ${kpi('Life cover after', sgd0(selfDeath + (s.ins?0:coDeath)), s.ins?`−${sgd0(coDeath)} group`:'group kept')}
    ${kpi('Cash runway', runway+' mo', 'cash ÷ monthly spend')}
    ${kpi('Concentration removed', sap?Math.round(sapVal/nw.holdings*100)+'%':'—','of invested wealth')}</div>
    ${s.ins&&coHosp>0?`<div class="flagline" style="margin-top:12px"><span class="dot dot-danger"></span><span>You lose <b>${sgd0(coHosp)}</b> hospitalisation cover — <b>buy an Integrated Shield Plan before resigning</b>.</span></div>`:''}
    <div class="flagline"><span class="dot dot-warn"></span><span>With no salary, you'd draw on cash/investments — a <b>${runway}-month</b> runway before touching long-term assets.</span></div>`;
}
function planAsk(){ const pos=pf(M.positions);
  $('#planbody').innerHTML=`<div class="card"><h2>Market — live prices</h2>
    <p class="muted" style="margin-bottom:12px">Live prices for your tickers (add them in <b>Wealth → Market positions</b>). For market-aware questions, use <b>Ask</b>.</p>
    <div id="mktPrices">${pos.length?'<span class="muted"><span class="spinner"></span>Loading live prices…</span>':'<span class="muted">No market positions yet — add tickers in Wealth → Market positions (e.g. NVDA · SUNPHARMA on NSE · ETH on CRYPTO).</span>'}</div>
    <div style="margin-top:16px"><button class="btn pri" onclick="SI.go('ask')">✦ Open Ask — market-aware analysis</button></div>
    <p class="caption muted" style="margin-top:10px">Prices from Yahoo Finance (deployed site only). Not licensed financial advice.</p></div>`;
  if(pos.length) loadPrices(pos);
}
async function loadPrices(pos){ const syms=[...new Set(pos.map(p=>ysym(p.symbol,p.exchange)))];
  try{ const r=await fetch('/.netlify/functions/quotes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:syms})});
    if(!r.ok) throw 0; const {quotes}=await r.json(); const el=$('#mktPrices'); if(!el)return;
    let h=`<table><thead><tr><th>Ticker</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Day</th><th class="num">Value</th></tr></thead><tbody>`;
    pos.forEach(p=>{const q=quotes[ysym(p.symbol,p.exchange)]||{}; const val=(q.price&&p.quantity)?q.price*p.quantity:null;
      h+=`<tr><td>${esc(p.symbol)} <span class="caption muted">${p.exchange||''}</span></td><td class="num">${p.quantity??''}</td><td class="num">${q.price!=null?(q.currency||'')+' '+(+q.price).toLocaleString(undefined,{maximumFractionDigits:2}):'—'}</td><td class="num ${q.changePct>=0?'val-pos':'val-neg'}">${q.changePct!=null?(q.changePct>=0?'+':'')+q.changePct.toFixed(1)+'%':''}</td><td class="num">${val!=null?(q.currency||'')+' '+Math.round(val).toLocaleString():''}</td></tr>`;});
    el.innerHTML=h+`</tbody></table>`;
  }catch(e){ const el=$('#mktPrices'); if(el) el.innerHTML=`<span class="caption">Live prices need the deployed site — the market function isn't running on localhost. Positions still save; deploy to Netlify to see prices.</span>`; }
}
const SUGGESTED=[
  "How is my wealth split across India, US and Singapore?",
  "Is my SAP EquatePlus concentration a risk given the current share price?",
  "Am I overexposed to US tech given current valuations?",
  "How did my direct holdings move this week?",
  "Is my India equity (Sun Pharma heavy) a concentration risk right now?",
  "Am I on track to retire at 60?",
  "If SAP stock fell 20%, what happens to my net worth?",
  "Where should I focus next quarter to improve my position?",
];
function promptChips(target){ return `<div class="chips">`+SUGGESTED.map((s,i)=>`<button class="chip-btn" onclick="SI.askPrompt(${i},'${target}')">${esc(s)}</button>`).join('')+`</div>`; }
async function askRun(qval, outEl){ const q=(qval||'').trim(); if(!q||!outEl)return;
  outEl.innerHTML='<span class="muted"><span class="spinner"></span>Analysing against your data + live market prices…</span>';
  const pos=pf(M.positions).map(p=>({symbol:p.symbol,exchange:p.exchange,ysym:ysym(p.symbol,p.exchange),quantity:p.quantity,currency:p.currency,label:p.label}));
  try{ const r=await fetch('/.netlify/functions/market-ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q, positions:pos, summary:dataSummary()})});
    if(!r.ok) throw new Error('fn'); const d=await r.json(); outEl.innerHTML=esc(d.answer||'').replace(/\n/g,'<br>');
  }catch(e){ outEl.innerHTML='<span class="muted">Ask isn’t active yet — deploy to Netlify and set <b>ANTHROPIC_API_KEY</b> in env vars (see README).</span>'; }
}
function ask(){ askRun($('#askq')?.value, $('#askOut')); }
function askPrompt(i){ const inp=$('#askq'); if(inp){ inp.value=SUGGESTED[i]; } sendChat(); }

// ---------- full-screen Ask chat (history sidebar + conversation) ----------
let CHATS=JSON.parse(localStorage.getItem('si_chats')||'[]');
let CHAT={id:null, title:'', messages:[]};
function saveChats(){ localStorage.setItem('si_chats', JSON.stringify(CHATS.slice(0,50))); }
function uid(){ return 'c'+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function newChat(){ CHAT={id:null,title:'',messages:[]}; askView(); }
function selectChat(id){ const c=CHATS.find(x=>x.id===id); if(c){ CHAT=JSON.parse(JSON.stringify(c)); askView(); } }
function deleteChat(id){ CHATS=CHATS.filter(c=>c.id!==id); saveChats(); if(CHAT.id===id) newChat(); else askView(); }
function askView(){
  const side=`<div class="chatside"><button class="btn pri" style="width:100%" onclick="SI.newChat()">+ New chat</button>
    <div class="chatlist">${CHATS.length?CHATS.map(c=>`<div class="chatitem ${c.id===CHAT.id?'on':''}" onclick="SI.selectChat('${c.id}')"><span>${esc(c.title||'Untitled')}</span><button class="chatdel" onclick="event.stopPropagation();SI.deleteChat('${c.id}')">✕</button></div>`).join(''):'<p class="caption muted" style="padding:8px">No conversations yet.</p>'}</div></div>`;
  let main;
  if(!CHAT.messages.length){
    main=`<div class="chatmain"><div class="chatempty"><h1>Ask anything about your finances</h1>
      <p class="muted">One assistant over your whole dashboard + live market prices. Analysis, not advice.</p>
      <div class="chips" style="justify-content:center;max-width:640px">${SUGGESTED.map((s,i)=>`<button class="chip-btn" onclick="SI.askPrompt(${i})">${esc(s)}</button>`).join('')}</div></div>
      ${chatInput()}</div>`;
  } else {
    const msgs=CHAT.messages.map(m=>`<div class="bubble ${m.role}">${m.role==='assistant'?esc(m.content).replace(/\n/g,'<br>'):esc(m.content)}</div>`).join('');
    main=`<div class="chatmain"><div class="msgs" id="msgs">${msgs}</div>${chatInput()}</div>`;
  }
  $('#view').innerHTML=`<div class="chatwrap">${side}${main}</div>`;
  const m=$('#msgs'); if(m) m.scrollTop=m.scrollHeight;
  setTimeout(()=>$('#askq')?.focus(),30);
}
const chatInput=()=>`<div class="chatbar"><input id="askq" placeholder="Ask a question…" onkeydown="if(event.key==='Enter')SI.send()"><button class="btn pri" onclick="SI.send()">Ask</button></div>`;
async function sendChat(){ const q=($('#askq')?.value||'').trim(); if(!q)return;
  CHAT.messages.push({role:'user',content:q});
  if(!CHAT.id){ CHAT.id=uid(); CHAT.title=q.slice(0,48); CHATS.unshift(CHAT); }
  CHAT.messages.push({role:'assistant',content:'…'}); askView();
  const pos=pf(M.positions).map(p=>({symbol:p.symbol,exchange:p.exchange,ysym:ysym(p.symbol,p.exchange),quantity:p.quantity,currency:p.currency,label:p.label}));
  let answer;
  try{ const r=await fetch('/.netlify/functions/market-ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:CHAT.messages.filter(m=>m.content!=='…'), positions:pos, summary:dataSummary()})});
    if(!r.ok) throw new Error('fn'); answer=(await r.json()).answer||'No answer.';
  }catch(e){ answer='Ask isn’t active yet — deploy to Netlify and set ANTHROPIC_API_KEY (and optionally FI_MODEL=claude-sonnet-5). Live prices in Plan → Market work once deployed.'; }
  CHAT.messages[CHAT.messages.length-1]={role:'assistant',content:answer};
  const idx=CHATS.findIndex(c=>c.id===CHAT.id); if(idx>=0) CHATS[idx]=CHAT; saveChats(); askView();
}
function dataSummary(){ const nw=NW.netWorth(M,'household');
  return { netWorth:Math.round(nw.total), invested:Math.round(nw.holdings), cash:Math.round(nw.cash),
    holdings:M.holdings.map(h=>({name:h.platform,valueSGD:Math.round(toSGD(h.value_local,h.currency)),ccy:h.currency,category:h.category,tags:h.tags,owner:h.owner})),
    cover:NW.coverTotals(M.policies,'household',M.fx), goals:M.goals.map(g=>({name:g.name,target:g.target,current:Math.round(NW.goalCurrentSGD(g,M.holdings,M.fx))})),
    positions:M.positions.map(p=>({symbol:p.symbol,exchange:p.exchange,quantity:p.quantity,currency:p.currency})),
    monthlySpend:Math.round(annualExpenses()/12) };
}

function settingsView(){
  const p=M.profiles||{};
  let h=`<div class="pagehead"><h1>Settings</h1></div>`;
  h+=`<div class="card"><h2>Import v3 data</h2>
    <p class="muted" style="margin-bottom:12px">Load your <code>finance-framework-state.json</code> — holdings, policies, goals, tax, estate, snapshots. Replaces existing balance-sheet data.</p>
    <input type="file" accept=".json,application/json" onchange="SI.importV3File(this)">
    <p class="caption muted" style="margin:14px 0 6px">…or if the file picker doesn’t respond, paste the JSON contents here and import:</p>
    <textarea id="v3paste" rows="4" placeholder="{ &quot;version&quot;: 3, ... }" style="width:100%;font-family:var(--font-mono);font-size:12px"></textarea>
    <button class="btn pri" style="margin-top:8px" onclick="SI.importV3Paste()">Import pasted JSON</button>
    <div id="v3status" class="caption" style="margin-top:10px"></div>
  </div>`;
  h+=`<div class="card"><h2>Profiles</h2><table><tbody>${Object.entries(p).map(([k,v])=>`<tr><td>${esc(v.name||k)}</td><td class="caption muted">${esc(v.residency||'')}${v.employer?' · '+esc(v.employer):''}</td></tr>`).join('')||'<tr><td class="muted">Imported with your v3 data.</td></tr>'}</tbody></table></div>`;
  h+=`<div class="card"><h2>FX rates (SGD per unit)</h2><table><tbody>${Object.entries(M.fx).map(([k,v])=>`<tr><td>${k.replace('_SGD','')}</td><td class="num mono">${v}</td></tr>`).join('')}</tbody></table><p class="caption muted" style="margin-top:6px">Editable rates come in a later pass; imported from v3 for now.</p></div>`;
  h+=`<div class="card"><h2>Appearance</h2><button class="btn" onclick="SI.theme()">Toggle ${document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark'} mode</button></div>`;
  h+=`<div class="card"><h2>Data</h2><button class="btn" onclick="SI.exportCsv()">Export transactions CSV</button> <button class="btn danger" onclick="SI.clearAll()">Clear all transactions</button></div>`;
  $('#view').innerHTML=h;
}
function v3status(msg,cls){ const el=$('#v3status'); if(el){ el.textContent=msg; el.className='caption '+(cls||''); } else toast(msg); }
async function doImportV3(j){
  if(!j || j.version==null){ v3status('That doesn’t look like a finance-framework v3 export.','val-neg'); return; }
  v3status('Importing…');
  try{
    const c=await importV3(j,{replace:true});
    await reload(); AREA='home'; render();
    toast(`Imported ${c.holdings} holdings · ${c.policies} policies · ${c.goals} goals`);
  }catch(e){ console.error('v3 import',e); v3status('Import failed: '+(e?.message||e),'val-neg'); }
}
async function importV3File(el){
  const f=el.files&&el.files[0]; if(!f) return;
  let j; try{ j=JSON.parse(await f.text()); }catch(e){ v3status('That file isn’t valid JSON.','val-neg'); return; }
  await doImportV3(j);
}
async function importV3Paste(){
  const t=($('#v3paste')?.value||'').trim(); if(!t){ v3status('Paste the JSON first.','val-neg'); return; }
  let j; try{ j=JSON.parse(t); }catch(e){ v3status('The pasted text isn’t valid JSON.','val-neg'); return; }
  await doImportV3(j);
}

// ---- theme ----
function currentTheme(){ return document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'); }
function applyTheme(){ const t=localStorage.getItem('fi_theme') || (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'); document.documentElement.setAttribute('data-theme',t); }
function themeIcon(){ return currentTheme()==='dark'
  ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`
  : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`; }
function toggleTheme(){ const next=currentTheme()==='dark'?'light':'dark'; document.documentElement.setAttribute('data-theme',next); localStorage.setItem('fi_theme',next); renderShell(); render(); }

// ---- misc ----
function toast(m){let e=$('#toast');if(!e){e=document.createElement('div');e.id='toast';document.body.appendChild(e);}e.textContent=m;e.className='show';clearTimeout(e._t);e._t=setTimeout(()=>e.className='',2200);}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const enc=s=>String(s).replace(/'/g,"\\'");

// expose handlers for inline onclick
window.SI={ go, signIn, signOut:()=>signOut().then(()=>location.reload()),
  setAcct:v=>{acct=v;render();}, setMonth:v=>{month=v;render();}, search:v=>{txSearch=v.toLowerCase();txView();}, flag:v=>{txFlag=v;txView();}, drill:c=>{drillCat=c;go('transactions');},
  open:openSheet, close:closeSheet, setCat, addCat:addCatAssign, toggle:toggleFlag, del, approve, approveAll, deleteReview, clearAll,
  connect:connectFolder, scan:scanDelta, manageCats:openCatManager, saveCats:saveCatManager, routeTx, routeCat,
  setProfile, theme:toggleTheme, importV3File, importV3Paste, exportCsv:exportCSV,
  holding:openHolding, policy:openPolicy, quickUpdate:openQuickUpdate, saveQuickUpdate, snapshot:takeSnapshot,
  saveHoldingValue, savePolicy, planTab, scenIn, ask, askPrompt,
  newChat, selectChat, deleteChat, send:sendChat,
  addEntity:t=>openEditor(t), editEntity:(t,id)=>openEditor(t,id), saveEditor, deleteEntity, toggleEstate, saveTax };

// temporary spouse-join helper (used from console until a Join UI is added)
window.__join = async (code)=>{ await joinHousehold(code); location.reload(); };

applyTheme();
boot();
