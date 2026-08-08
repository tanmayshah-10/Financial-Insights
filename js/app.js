// app.js — Spend Insights UI. Auth gate -> load household data from Supabase ->
// render tabs. Rendering reads an in-memory cache (M); mutations write through
// to Supabase then reload the cache.
import { CONFIGURED } from './supabase.js';
import { supabase } from './supabase.js';
import { sendMagicLink, signOut, resolveHouseholdId, joinHousehold, currentUser } from './auth.js';
import * as db from './db.js';
import { parseFile, merchKey } from './parse.js';

// Where the Spend Router app is deployed (separate repo). Update after you deploy it.
const ROUTER_URL = 'https://spend-router.netlify.app';

const $ = s => document.querySelector(s);
const app = $('#app');
let M = { tx:[], cats:[], rules:{}, aliases:{}, files:new Set() };
let catIcon={}, catFlags={}, HHID=null;
let TAB='overview', acct='all', month='all', txSearch='', txFlag='all', drillCat='';

// ---- format helpers ----
const money = n => (n<0?'-':'')+'SGD '+Math.abs(Math.round(n*100)/100).toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2});
const money0 = n => 'SGD '+Math.round(Math.abs(n)).toLocaleString('en-SG');
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
const inScope=t=>(acct==='all'||t.account===acct)&&(month==='all'||t.txn_date.slice(0,7)===month);

// ============================ BOOT ============================
async function boot(){
  if(!CONFIGURED){ app.innerHTML=`<div class="center"><div class="card" style="max-width:520px"><h2>Setup needed</h2><p class="muted">Open <code>js/supabase.js</code> and paste your finance project's URL and anon key, then reload. (See README.)</p></div></div>`; return; }
  supabase.auth.onAuthStateChange((_e,session)=>{ if(session) start(); });
  const u=await currentUser();
  if(u) start(); else renderSignIn();
}
function renderSignIn(){
  app.innerHTML=`<div class="center"><div class="card" style="max-width:420px;text-align:center">
    <h2 style="margin-top:0">Spend Insights</h2>
    <p class="muted">Sign in with your email — we'll send a one-tap magic link. Your household (you + wife) shares the same data.</p>
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
async function start(){
  const u=await currentUser(); HHID=await resolveHouseholdId();
  if(!HHID){ app.innerHTML=`<div class="center"><div class="card">Setting up your household… reload in a moment.</div></div>`; return; }
  db.init(HHID, u.id);
  await reload();
  renderShell(); render();
}
async function reload(){
  M=await db.loadAll();
  catIcon={}; catFlags={}; M.cats.forEach(c=>{catIcon[c.name]=c.icon; catFlags[c.name]=c;});
}

function renderShell(){
  const NAV=[['overview','Money in/out'],['insights','Insights'],['transactions','Transactions'],['review','Review'],['import','Import']];
  app.innerHTML=`<div class="top"><div class="topin">
      <div class="brand">Spend Insights</div>
      <nav id="nav"></nav>
      <button class="btn sm" onclick="SI.signOut()">Sign out</button>
    </div></div>
    <div class="wrap"><div id="view"></div></div>
    <div class="ov" id="ov"><div class="sheet" id="sheet"></div></div>`;
  $('#ov').addEventListener('click',e=>{ if(e.target.id==='ov') closeSheet(); });
  buildNav(NAV);
}
function buildNav(NAV){ const rc=M.tx.filter(t=>t.review).length;
  $('#nav').innerHTML=NAV.map(([t,l])=>`<button class="${TAB===t?'on':''}" onclick="SI.go('${t}')">${l}${t==='review'&&rc?`<span class="badge">${rc}</span>`:''}</button>`).join('');
}
function go(t){ TAB=t; renderShell(); render(); window.scrollTo(0,0); }

// ============================ RENDER ============================
function render(){
  buildNav([['overview','Money in/out'],['insights','Insights'],['transactions','Transactions'],['review','Review'],['import','Import']]);
  if(!M.tx.length && TAB!=='import' && TAB!=='review'){ $('#view').innerHTML=empty(); return; }
  ({overview:overviewView,insights:insightsView,transactions:txView,review:reviewView,import:importView}[TAB]||overviewView)();
}
const empty=()=>`<div class="card" style="text-align:center;padding:50px"><div style="font-size:40px">📊</div><h3>No data yet</h3><div class="muted" style="margin:6px 0 18px">Import statements to see where your money goes.</div><button class="btn pri" onclick="SI.go('import')">Import statements</button></div>`;
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
    <div class="cash"><div class="lbl">Net cashflow</div><div class="v" style="color:${net<0?'var(--txt)':'var(--green)'}">${money(net)}</div>${asOf?`<div class="as">As of ${dfull(asOf)}</div>`:''}</div>
    ${svgInOut(ms)}
    <div class="io"><div><div class="k"><span class="dot" style="background:var(--green)"></span>Money in</div><div class="n">${money0(totIn)}</div></div><div><div class="k"><span class="dot" style="background:var(--red)"></span>Money out</div><div class="n">${money0(totOut)}</div></div></div>
    <div class="io"><div><div class="k">🇸🇬 Local (SGD)</div><div class="n">${money0(localOut)}</div></div><div style="background:var(--fc-bg)"><div class="k">🌏 Foreign (FX)</div><div class="n">${money0(fcOut)}</div></div></div></div>
    <div class="card"><h2>Spending by category</h2>`;
  if(!cats.length)left+=`<div class="muted">No spending in this period.</div>`;
  cats.forEach(([c,v])=>left+=`<div class="catrow" onclick="SI.drill('${enc(c)}')"><div class="ic" style="background:var(--bg2)">${ic(c)}</div><div class="nm">${c}</div><div class="am">${money0(v)}</div><div class="chev">›</div></div>`);
  left+=`</div><div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Latest transactions</h2><button class="btn sm" onclick="SI.go('transactions')">View all</button></div><div style="margin-top:8px">`;
  latest.forEach(t=>left+=txRow(t)); if(!latest.length)left+=`<div class="muted">No transactions.</div>`;
  left+=`</div></div>`;
  const right=`<div class="card"><h2>Quick insights</h2>${mini(scope,totOut,fcOut)}<button class="btn pri" style="width:100%;margin-top:8px" onclick="SI.go('insights')">See all insights →</button></div>`;
  $('#view').innerHTML=`<div class="grid gridmain"><div class="grid">${left}</div><div class="grid" style="align-content:start">${right}</div></div>`;
}
function mini(scope,totOut,fcOut){const P=scope.filter(isSpend);if(!P.length)return '<div class="muted">Import data for insights.</div>';
  const ES=eligSet();const fxf=P.reduce((s,t)=>s+fxFee(t),0);let elig=0;P.forEach(t=>{if(ES.has(t.category))elig+=t.amount;});const gap=elig*(4-1.6);
  return `<div class="flag warn"><span class="ic2">🌏</span><span><b>${money0(fxf)}</b> est. FX fees on ${money0(fcOut)} foreign spend. Route via Revolut to cut most of it.</span></div>
    <div class="flag good"><span class="ic2">✈️</span><span><b>~${milesRange(gap)}</b> left on the table — move 4-mpd-eligible spend off this card.</span></div>`;}

function insightsView(){
  const P=counted().filter(inScope).filter(isSpend);
  if(!P.length){$('#view').innerHTML='<div class="card"><div class="muted">No spending in scope. Adjust filters.</div></div>';return;}
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
    Object.entries(byCur).sort((a,b)=>b[1].sgd-a[1].sgd).forEach(([k,v])=>h+=`<tr><td>${k}</td><td class="num">${v.n}</td><td class="num">${money0(v.sgd)}</td><td class="num" style="color:var(--orange)">${money0(v.fee)}</td></tr>`);h+=`</tbody></table>`;}
  const milesGiven=fcSGD*2.2, be=(FXFEE_PCT*100)/2.2;
  h+=`<div class="rec"><h4>💳 Multi-currency / Revolut vs credit card on foreign spend</h4>
    <div class="muted">Charging in the foreign currency (multi-currency debit or Revolut) avoids the ~3.25% markup — but you forgo ~2.2 mpd of credit-card miles.</div>
    <table style="margin-top:8px"><tbody>
    <tr><td>FX fees avoided</td><td class="num" style="color:var(--green)">${money0(fxf)}</td></tr>
    <tr><td>Miles given up (credit @2.2 mpd)</td><td class="num">${milesRange(milesGiven)}</td></tr>
    <tr><td><b>Break-even</b></td><td class="num"><b>${be.toFixed(2)}¢ / mile</b></td></tr></tbody></table>
    <div class="muted" style="margin-top:6px">Value miles <b>below ${be.toFixed(2)}¢</b> → multi-currency/Revolut wins. <b>Above</b> (business-class redeemers) → keep the credit card. Confirm a case in Spend Router.</div></div></div>`;
  // recurring
  const bm={};P.forEach(t=>{if(!bm[t.merchant])bm[t.merchant]={amt:0,n:0,mo:new Set()};bm[t.merchant].amt+=t.amount;bm[t.merchant].n++;bm[t.merchant].mo.add(t.txn_date.slice(0,7));});
  const rec2=Object.entries(bm).map(([k,v])=>({m:k,...v})).sort((a,b)=>b.amt-a.amt).filter(x=>x.mo.size>=3&&x.n>=3);
  h+=`<div class="card"><h2>Recurring — subscriptions & regulars</h2>`;
  if(rec2.length){h+=`<table><thead><tr><th>Merchant</th><th class="num">Months</th><th class="num">Total</th><th class="num">~/mo</th></tr></thead><tbody>`;rec2.slice(0,12).forEach(x=>h+=`<tr><td>${x.m}</td><td class="num">${x.mo.size}</td><td class="num">${money0(x.amt)}</td><td class="num muted">${money0(x.amt/x.mo.size)}</td></tr>`);h+=`</tbody></table>`;}else h+=`<div class="muted">Need a few months of data.</div>`;
  h+=`</div>`;
  $('#view').innerHTML=h;
}
function rec(cat,v,rows){const fcShare=rows.filter(t=>t.fcy).reduce((s,t)=>s+t.amount,0);
  const A={Groceries:['Move to a 4-mpd card','~1.6 mpd now. HSBC Revolution / Citi Rewards earn 4 mpd online/contactless (≤S$1k/mo).'],Dining:['Move to a 4-mpd card','Online & contactless dining earns 4 mpd.'],Shopping:['Move online spend to 4-mpd card','Online retail is the 4-mpd sweet spot.'],Subscriptions:['Put on a 4-mpd online card','Recurring online charges → 4-mpd card; review unused subs.'],Transport:['4-mpd contactless card','Grab/transit are online/contactless → 4 mpd.'],Travel:['Optimise FX + consider redeeming','Big-ticket & often foreign. Best FCY card or Revolut; consider KrisFlyer/Bonvoy redemption.'],Insurance:['Check card-payable + big-ticket route','Large recurring; weigh CardUp fee vs miles, else GIRO.'],'Utilities/Telco':['GIRO at economy mile value','Platform fees usually beat the miles unless business-class redeemer.'],Education:['Default to GIRO','GIRO wins at economy value.']}[cat]||['Open in Spend Router','Compare routes.'];
  return `<div class="rec"><h4>${ic(cat)} ${cat} — ${money0(v)}${fcShare>0?` · ${money0(fcShare)} foreign`:''}</h4><div class="muted"><b>${A[0]}.</b> ${A[1]}</div><div class="act"><button class="btn sm pri" onclick="SI.routeCat('${enc(cat)}',${Math.round(v)},${fcShare>v/2})">↗ Route in Spend Router</button></div></div>`;}
const fl=(i,t,c)=>`<div class="flag ${c}"><span class="ic2">${i}</span><span>${t}</span></div>`;
function svgInOut(ms){const keys=Object.keys(ms).sort();if(!keys.length)return '';const max=Math.max(1,...keys.map(k=>Math.max(ms[k].in,ms[k].out)));
  const W=Math.max(380,keys.length*64),H=170,pad=28,slot=(W-pad*2)/keys.length,bw=Math.min(13,slot/3.2);let s='';
  keys.forEach((k,i)=>{const cx=pad+i*slot+slot/2;if(k===month)s+=`<rect x="${cx-slot/2+4}" y="6" width="${slot-8}" height="${H-12}" rx="8" fill="#f0f0f2"/>`;
    const ih=(ms[k].in/max)*(H-pad*2),oh=(ms[k].out/max)*(H-pad*2);
    s+=`<rect x="${cx-bw-2}" y="${H-pad-ih}" width="${bw}" height="${ih}" rx="3" fill="var(--green)"/><rect x="${cx+2}" y="${H-pad-oh}" width="${bw}" height="${oh}" rx="3" fill="var(--red)"/><text x="${cx}" y="${H-9}" fill="var(--txt2)" font-size="11" text-anchor="middle">${MN[+k.slice(5,7)-1]}</text>`;});
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:200px">${s}</svg>`;}

function txRow(t){const sign=t.direction==='in'?'+':'-';const A=ACCT(t.account);const col=t.direction==='in'?'var(--green)':'var(--txt)';const flg=t.pin?'📌 ':t.flag==='wrong'?'⚠️ ':t.flag==='duplicate'?'⧉ ':t.flag==='refund'?'⏳ ':'';
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
  h+=`</div>`;$('#view').innerHTML=h;
}

function reviewView(){
  const rows=M.tx.filter(t=>t.review).sort((a,b)=>b.amount-a.amount);
  let h=`<div class="card"><h2>Review queue</h2>`;
  if(!rows.length){h+=`<div class="flag good"><span class="ic2">✓</span><span>Nothing to review. Best-effort imports (unrecognized formats, reverted/pending) land here for you to confirm before they count.</span></div></div>`;$('#view').innerHTML=h;return;}
  const tot=rows.reduce((s,t)=>s+t.amount,0);
  h+=`<div class="muted" style="margin-bottom:12px">${rows.length} rows (${money0(tot)}) <b>excluded from totals</b> until approved. Fix the category, then approve. Choices are remembered for the merchant.</div>
    <button class="btn pri" onclick="SI.approveAll()">Approve all</button> <button class="btn danger" onclick="SI.deleteReview()">Delete all</button>
    <table style="margin-top:14px"><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead><tbody>`;
  rows.forEach(t=>h+=`<tr><td class="muted" style="white-space:nowrap">${t.txn_date}</td><td>${esc(t.raw||t.merchant||'')}${t.fcy?` <span class="chip fc">${t.fcy_cur}</span>`:''}</td><td>${catSelect(t.id,t.category)}</td><td class="num">${money(t.amount)}</td><td style="white-space:nowrap"><button class="btn sm pri" onclick="SI.approve('${t.id}')">Approve</button> <button class="btn sm" onclick="SI.open('${t.id}')">Details</button></td></tr>`);
  h+=`</tbody></table></div>`;$('#view').innerHTML=h;
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
  let fx='';if(t.fcy){const rate=t.fcy_amt?(t.amount/t.fcy_amt):0;fx=row('Foreign amount',`${t.fcy_cur} ${t.fcy_amt?(+t.fcy_amt).toLocaleString():'—'}`)+row('SGD charged',money(t.amount))+(rate?row('Implied rate',`${rate.toFixed(4)} SGD/${t.fcy_cur}`):'')+row('Est. FX fee (~3.25%)',`<span style="color:var(--orange)">${money(fxFee(t))}</span>`);}
  $('#sheet').innerHTML=`<button class="x" onclick="SI.close()">✕</button>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px"><div class="ic" style="width:48px;height:48px;font-size:22px;background:${A.bg}">${ic(t.category)}<span class="acctdot" style="background:${A.color};width:14px;height:14px"></span></div><div><h3 style="margin:0">${t.direction==='in'?'+':'-'}${money(t.amount)}</h3><div class="muted">${esc(t.raw||t.merchant||'')}</div></div></div>
    <div style="margin:10px 0"><span class="acctchip" style="background:${A.bg};color:${A.color}"><span class="dot" style="background:${A.color}"></span>${A.label}</span> ${t.fcy?'<span class="chip fc">Foreign currency</span>':'<span class="chip">🇸🇬 Local SGD</span>'}</div>
    <div class="drow"><span class="k">Category</span><span class="v2">${catSelect(t.id,t.category)}</span></div>
    ${row('Date',dfull(t.txn_date))}${t.post_date&&t.post_date!==t.txn_date?row('Posted',dfull(t.post_date)):''}
    ${row('Direction',t.direction==='in'?'Money in':'Money out')}${row('Channel',t.channel||'—')}${fx}
    ${t.status?row('Status',t.status):''}${row('Source',(t.src||'')+(t.review?' · needs review':''))}
    <div class="fbtns"><button class="fb ${t.pin?'on':''}" onclick="SI.toggle('${t.id}','pin')">📌 Pin</button><button class="fb ${t.flag==='wrong'?'on':''}" onclick="SI.toggle('${t.id}','wrong')">⚠️ Wrong</button><button class="fb ${t.flag==='duplicate'?'on':''}" onclick="SI.toggle('${t.id}','duplicate')">⧉ Dup</button><button class="fb ${t.flag==='refund'?'on':''}" onclick="SI.toggle('${t.id}','refund')">⏳ Refund</button></div>
    <div class="fbtns">${t.review?`<button class="fb" style="background:var(--green);color:#fff;border-color:var(--green)" onclick="SI.approve('${t.id}',true)">✓ Approve</button>`:''}<button class="fb" style="background:var(--accent);color:#fff;border-color:var(--accent)" onclick="SI.routeTx('${t.id}')">↗ Route</button><button class="fb" style="color:var(--red)" onclick="SI.del('${t.id}')">🗑 Delete</button></div>`;
  $('#ov').classList.add('show');}
const closeSheet=()=>$('#ov').classList.remove('show');

// ---- import ----
function importView(){
  $('#view').innerHTML=`<div class="card"><h2>Import statements</h2>
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
  if(M.files.has(key)){logLine(`<span class="muted">• ${key}: already imported</span>`);return 0;}
  let r;try{r=parseFile(text);}catch(e){logLine(`<span class="err">✗ ${key}: ${e.message}</span>`);return 0;}
  if(!r.rows.length){logLine(`<span class="err">✗ ${key}: no usable rows</span>`);return 0;}
  const payload=prep(r.rows).map(row=>({...row,account:type,file:name}));
  try{ await db.insertTransactions(payload); await db.recordImported(type,name); M.files.add(key); }
  catch(e){ logLine(`<span class="err">✗ ${key}: DB error ${e.message}</span>`); return 0; }
  logLine(`<span class="ok">✓ ${key}: ${payload.length} txns (${r.rows[0].src})${r.confident?'':' <b style="color:var(--orange)">⚠ needs review</b>'}</span>`);return payload.length;}
async function ingest(fileList){const files=[...fileList];if(!files.length)return;const type=$('#manualType').value;$('#log').innerHTML='';logLine(`<span class="spinner"></span>Reading ${files.length} file(s) as ${type}…`);
  let a=0;for(const f of files)a+=await importText(await f.text(),f.name,type);await finishImport(a);}
async function finishImport(a){logLine(`<b>Done.</b> ${a} new.`);await reload();render();/* re-render import view to keep log */ if(TAB==='import'){/*keep log visible*/}}

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
async function deleteReview(){if(confirm('Delete all review-queue rows?')){await db.deleteWhereReview();await reload();render();}}
async function clearAll(){if(confirm('Clear ALL transactions for the household? (Categories kept.)')){await db.clearAllTransactions();M.files=new Set();await reload();render();}}

// ---- routing handoff ----
const catToRouter=c=>({Groceries:'groceries',Dining:'dining',Shopping:'online',Subscriptions:'online',Transport:'groceries','Utilities/Telco':'utilities',Education:'education'}[c]||'general');
function routeTx(id){const t=M.tx.find(x=>x.id===id);if(!t)return;const p=new URLSearchParams({mode:'earn',amt:t.amount,cat:catToRouter(t.category),cur:t.fcy?'fcy':'sgd'});window.open(ROUTER_URL+'/?'+p,'_blank');}
function routeCat(cat,amt,fcy){const p=new URLSearchParams({mode:'earn',amt,cat:catToRouter(cat),cur:fcy?'fcy':'sgd'});window.open(ROUTER_URL+'/?'+p,'_blank');}

// ---- misc ----
function toast(m){let e=$('#toast');if(!e){e=document.createElement('div');e.id='toast';document.body.appendChild(e);}e.textContent=m;e.className='show';clearTimeout(e._t);e._t=setTimeout(()=>e.className='',2200);}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const enc=s=>String(s).replace(/'/g,"\\'");

// expose handlers for inline onclick
window.SI={ go, signIn, signOut:()=>signOut().then(()=>location.reload()),
  setAcct:v=>{acct=v;render();}, setMonth:v=>{month=v;render();}, search:v=>{txSearch=v.toLowerCase();txView();}, flag:v=>{txFlag=v;txView();}, drill:c=>{drillCat=c;go('transactions');},
  open:openSheet, close:closeSheet, setCat, addCat:addCatAssign, toggle:toggleFlag, del, approve, approveAll, deleteReview, clearAll,
  connect:connectFolder, scan:scanDelta, manageCats:openCatManager, saveCats:saveCatManager, routeTx, routeCat };

// temporary spouse-join helper (used from console until a Join UI is added)
window.__join = async (code)=>{ await joinHousehold(code); location.reload(); };

boot();
