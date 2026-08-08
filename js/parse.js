// parse.js — client-side statement parsers (validated against real DBS credit,
// DBS savings/multi-currency, and Revolut exports). Nothing leaves the browser
// except the parsed, card-number-masked rows the app then inserts to Supabase.

const AMOUNT_CAP = 200000;   // used only by the generic fallback's smallest-amount heuristic
const PAN = /\b(?:\d[ -]*?){13,19}\b/g;
const MONTH = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
const FCY_CODES = 'USD|EUR|GBP|AUD|JPY|KRW|HKD|THB|MYR|IDR|CNY|CAD|CHF|NZD|INR|VND|PHP|TWD|AED|SAR|QAR';
export const FCY = new RegExp('\\b(' + FCY_CODES + ')\\b');

function tokenize(line){const o=[];let c='',q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){c+='"';i++;}else q=!q;}else if(ch===','&&!q){o.push(c);c='';}else c+=ch;}o.push(c);return o.map(s=>s.trim());}
function pdate(s){s=String(s).trim();
  // "03 Jun 2026" / "3 Jun 26" (DBS's newer export format) — keep before the T/space split
  let m=s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})$/);if(m&&MONTH[m[2].slice(0,3).toLowerCase()]){let y=m[3].length===2?'20'+m[3]:m[3];return `${y}-${MONTH[m[2].slice(0,3).toLowerCase()]}-${m[1].padStart(2,'0')}`;}
  s=s.split(/[ T]/)[0];m=s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);if(m){let y=m[3].length===2?'20'+m[3]:m[3];return `${y}-${MONTH[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;}m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(m)return s;m=s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);if(m){let y=m[3].length===2?'20'+m[3]:m[3];return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;}return null;}
function num(s){if(s==null||s==='')return null;const n=parseFloat(String(s).replace(/[^0-9.\-]/g,''));return isNaN(n)?null:n;}
function isAmtCell(s){return /^-?(?:S?\$)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(String(s).trim());}

export function extractFC(desc){const m=desc.match(new RegExp('\\b('+FCY_CODES+')\\s+([\\d,]+(?:\\.\\d{1,2})?)'));if(!m)return null;const a=parseFloat(m[2].replace(/,/g,''));if(isNaN(a)||a<=0)return null;return{cur:m[1],amt:a};}

const CATS=[
['Insurance',/GREAT EASTERN|\bAIA\b|PRUDENTIAL|NTUC INCOME|MANULIFE|AVIVA|SINGLIFE|INSURANCE|LIFE SINGAPORE|\bFWD\b|ETIQA|TOKIO MARINE/i],
['Healthcare',/CLINIC|DENTAL|TOOTHBAR|HOSPITAL|MEDICAL|PHARMACY|GUARDIAN|WATSONS|UNITY|POLYCLINIC|HEALTH|OPTIC|LENSKART|SURGERY|PHYSIO|DERMA|RAFFLES MED|HEALTHWAY|BABY & CHILD|CHILD CLIN/i],
['Auto',/ACCORD AUTO|AUTO SERVICE|MOTOR|WORKSHOP|SERVICING|\bTYRE\b|CARRO|VICOM|\bLTA\b/i],
['Groceries',/REDMART|FAIRPRICE|NTUC FP|COLD STORAGE|SHENG SIONG|GIANT|7-ELEVEN|CHEERS|LITTLE FARMS|MARKETPLACE|DON DON|MUSTAFA|PRIME SUPER/i],
['Transport',/GRAB|UBER|GOJEK|COMFORT|\bTADA\b|SMRT|EZ-LINK|EZLINK|SIMPLYGO|ESSO|SHELL|CALTEX|PARKING|CARPARK|TNG-EWALLET|TRANSITLINK|FLASHPAY|NETS FLASHPAY|FAST FERRY|BUS\/MRT/i],
['Dining',/RESTAURANT|CAFE|COFFEE|STARBUCKS|MCDONALD|KFC|BURGER|KOPITIAM|PLAIN VANILLA|BAKER|TANDOORI|SARAVANA|GUZMAN|\bGYG\b|BISTRO|EATERY|KITCHEN|PIZZA|SUSHI|NANDOS|SUBWAY|TOAST|DIN TAI|PARADISE|CRYSTAL JADE|\bBAR\b|FOOD|HAWKER|\bDELI\b|\bBBQ\b|GRILL|ZAIKA|DEMPSEY|ITALIANO|CHUPITOS|GOTTI|IJOOZ|\bCLUB\b/i],
['Subscriptions',/APPLE.COM\/BILL|OPENAI|CHATGPT|NETFLIX|SPOTIFY|ICLOUD|GOOGLE\s|YOUTUBE|DISNEY|AMAZON PRIME|MICROSOFT|ADOBE|NOTION|LINKEDIN|CLAUDE|ANTHROPIC|CURSOR/i],
['Shopping',/LAZADA|SHOPEE|AMAZON|QOO10|APPLE\.COM|2C2P|UNIQLO|DECATHLON|IKEA|COURTS|CHALLENGER|ZALORA|TAOBAO|CAT SOCRATES|POPULAR|KINOKUNIYA|\bMUJI\b|SEPHORA|SHILLA|\bDFS\b|KRISSHOP|KPAY/i],
['Travel',/MARRIOTT|COURTYARD|SHERATON|DOUBLETREE|HILTON|HYATT|WESTIN|RITZ|FOUR SEASONS|SHANGRI|MANDARIN|HOLIDAY INN|\bTAJ\b|SAMHI|HOTEL|RESORT|RESIDENCE|MYTRIP|QEEQ|AIRBNB|AGODA|BOOKING|EXPEDIA|KLOOK|AIRLINE|SINGAPORE AIR|SCOOT|EMIRATES|QATAR|VIETJET|AIR INDIA|INDIGO|MASWIK|BONAVI|LANDS END|\bW BANGKOK\b|MELBOURNE|BINTAN|VIAGOGO/i],
['Utilities/Telco',/SINGTEL|STARHUB|\bM1\b|CIRCLES|SP SERVICES|SP GROUP|SP DIGITAL|GENECO|KEPPEL ELECT|SENOKO|PACIFIC LIGHT/i],
['Education',/SCHOOL|TUITION|UNIVERSITY|COLLEGE|POLYTECHNIC|ACADEMY|\bSJI\b|MINDCHAMPS|KUMON|PRESCHOOL|ENRICHMENT/i],
['Bills/Other',/\bAXS\b|\bIRAS\b|INCOME TAX|GIRO/i]];
export function autoCat(d){for(const[c,re]of CATS)if(re.test(d))return c;return 'Uncategorized';}
function channel(pt){if(/contactless/i.test(pt))return 'Contactless';if(/online|in-app/i.test(pt))return 'Online';return 'Other';}
function merchClean(d){return d.replace(PAN,'').replace(/\s{2,}/g,' ').trim().slice(0,80);}
export function merchKey(d){let s=d.toUpperCase().replace(PAN,'');s=s.replace(new RegExp('\\b('+FCY_CODES+')\\s+[\\d,]+(?:\\.\\d{1,2})?','g'),'').replace(/[\d,]+\.\d{2}/g,'').replace(/\b\d{4,}\b/g,'');s=s.replace(/\bSINGAPORE\b|\bSG\b|\bSGP\b/g,'').replace(/\*[A-Z0-9\-]+/g,'');s=s.replace(/\s{2,}/g,' ').trim();return s.split(' ').slice(0,3).join(' ').replace(/[^A-Z0-9 &\.\/]/g,'').trim()||d.slice(0,18);}

function mk(o){const fc=o.fcy?extractFC(o.desc):null;
  return {txn_date:o.date,post_date:o.post||o.date,amount:+o.amount.toFixed(2),direction:o.dir,refund:!!o.refund,
    category:o.cat||autoCat(o.desc),channel:o.channel||'Other',status:o.status||'',
    fcy:!!o.fcy,fcy_cur:fc?fc.cur:null,fcy_amt:fc?fc.amt:null,
    merchant:o.mk,raw:merchClean(o.desc),src:o.src,review:!!o.review};}

function rtfToText(s){s=s.replace(/\{\\(?:fonttbl|colortbl|\*\\expandedcolortbl)[\s\S]*?\}/g,'');s=s.replace(/\\'[0-9a-fA-F]{2}/g,'');s=s.replace(/\\[a-zA-Z]+-?\d* ?/g,'');s=s.replace(/[{}]/g,'');s=s.replace(/\\\r?\n/g,'\n');return s.trim();}

const deq=l=>l.replace(/"/g,'');   // strip CSV quotes so header detection works on both old and new DBS exports

// Pull the current balance out of a statement header:
//   cash (debit/savings): Available / Ledger Balance
//   card (credit): outstanding = Credit Limit − Available Limit
function extractBalance(text){
  const L=text.split(/\r?\n/).slice(0,18).map(deq);
  const grab=re=>{for(const l of L){const m=l.match(re);if(m)return m[1];}return null;};
  const amt=s=>{if(s==null)return null;const n=parseFloat(String(s).replace(/[^0-9.\-]/g,''));return isNaN(n)?null:n;};
  const ccy=s=>{const m=(s||'').match(/\b([A-Z]{3})\b/);return m?m[1]:'SGD';};
  const asOfRaw=grab(/as at:?,?\s*(.+?)\s*,*\s*$/i);
  const asOf=asOfRaw?pdate(asOfRaw):null;
  const limitRaw=grab(/Credit Limit:?,?\s*([^,]+)/i);
  if(limitRaw!=null){
    const limit=amt(limitRaw), avail=amt(grab(/Available Limit:?,?\s*([^,]+)/i));
    const outstanding=(limit!=null&&avail!=null)?+(limit-avail).toFixed(2):null;
    return {kind:'card', currency:ccy(limitRaw), outstanding, limit, available:avail, as_of:asOf};
  }
  const ledgerRaw=grab(/Ledger Balance:?,?\s*([^,]+)/i);
  const availBalRaw=grab(/Available Balance:?,?\s*([^,]+)/i);
  const bal=amt(ledgerRaw!=null?ledgerRaw:availBalRaw);
  if(bal!=null) return {kind:'cash', currency:ccy(ledgerRaw||availBalRaw), balance:bal, available:amt(availBalRaw), as_of:asOf};
  return null;
}
function isDBScc(t){return /Transaction Date,Transaction Posting Date,Transaction Description/.test(deq(t));}
function parseDBScc(text){const L=text.split(/\r?\n/);const hi=L.findIndex(l=>/^Transaction Date,/.test(deq(l)));const out=[];let masked=0,skipped=0;
  for(let i=hi+1;i<L.length;i++){if(!L[i].trim())continue;if(PAN.test(L[i]))masked++;PAN.lastIndex=0;
    const c=tokenize(L[i]);const date=pdate(c[0]),post=pdate(c[1]),desc=c[2]||'',ttype=c[3]||'',ptype=c[4]||'',debit=num(c[6]),credit=num(c[7]);
    if(!date){skipped++;continue;}
    let amt,dir,refund=false,cat;if(debit){amt=debit;dir='out';}else if(credit){amt=credit;dir='in';refund=true;cat='Refund';}else{skipped++;continue;}
    if(/PAYMENT/i.test(ttype)){cat='Transfer';refund=false;}
    out.push(mk({date,post,amount:amt,dir,refund,cat,desc,channel:channel(ptype),fcy:FCY.test(desc),mk:merchKey(desc),src:'dbs_cc'}));}
  return{rows:out,masked,skipped,confident:true};}

function isDBSsavings(t){return /Transaction Date,Value Date,Statement Code/.test(deq(t));}
function savingsCat(desc,code,dir){
  if(dir==='in')return /INT/.test(code)?'Income (interest)':'Income';
  if(/BILL DBSC|I-BANK|TOP-UP|PAYLAH|REVOLUT|PAYNOW|\bTRF\b|SI TO :UTMOST|\bICT\b/i.test(desc))return 'Transfer';
  if(/RENT/i.test(desc))return 'Rent';
  if(/IRAS|\bITX\b|FWLEVY|MANPOWER|INCOME TAX/i.test(desc))return 'Tax';
  if(/BUS\/MRT|\bMRT\b|\bBUS\b/i.test(desc))return 'Transport';
  const a=autoCat(desc);return a==='Uncategorized'?'Transfer':a;}
function parseDBSsavings(text){const L=text.split(/\r?\n/);const hi=L.findIndex(l=>/^Transaction Date,Value Date,Statement Code/.test(deq(l)));const out=[];let masked=0,skipped=0;
  for(let i=hi+1;i<L.length;i++){if(!L[i].trim())continue;if(PAN.test(L[i]))masked++;PAN.lastIndex=0;
    const c=tokenize(L[i]);const date=pdate(c[0]),code=c[2]||'',desc=c[3]||'',debit=num(c[10]),credit=num(c[11]);
    if(!date){skipped++;continue;}let amt,dir;if(debit){amt=debit;dir='out';}else if(credit){amt=credit;dir='in';}else{skipped++;continue;}
    out.push(mk({date,amount:amt,dir,refund:false,cat:savingsCat(desc,code,dir),desc,channel:'Other',fcy:false,mk:merchKey(desc),src:'dbs_sav'}));}
  return{rows:out,masked,skipped,confident:true};}

function isRevolut(t){const h=t.split(/\r?\n/)[0]||'';return /Started Date/i.test(h)&&/Currency/i.test(h)&&/Amount/i.test(h);}
function parseRevolut(text){const L=text.split(/\r?\n/);const H=tokenize(L[0]).map(x=>x.toLowerCase());const ci=n=>H.findIndex(h=>h.includes(n));
  const ty=ci('type'),dci=ci('completed'),sci=ci('started'),ai=ci('amount'),cur=ci('currency'),desc=ci('description'),st=ci('state');const out=[];let skipped=0;
  for(let i=1;i<L.length;i++){if(!L[i].trim())continue;const c=tokenize(L[i]);const date=pdate(c[dci])||pdate(c[sci]);const amt=num(c[ai]);const type=c[ty]||'';
    if(!date||amt==null){skipped++;continue;}const state=(st>=0?c[st]:'').toUpperCase();const notDone=!!state&&!/COMPLETED/.test(state);
    const a=Math.abs(amt);if(a===0){skipped++;continue;}const ccy=(c[cur]||'SGD').toUpperCase();const d=c[desc]||'';const isFC=ccy!=='SGD';
    let cat,refund=false;if(/exchange|topup|^transfer/i.test(type))cat='Transfer';else if(/refund/i.test(type)){cat='Refund';refund=true;}else cat=undefined;
    out.push(mk({date,amount:a,dir:amt<0?'out':'in',refund,cat,status:state,review:notDone,desc:d+(isFC?` ${ccy} ${a}`:''),channel:'Online',fcy:isFC,mk:merchKey(d),src:'revolut'}));}
  return{rows:out,skipped,masked:0,confident:true};}

function parseGeneric(text){let masked=0,skipped=0;const out=[];const L=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  for(const raw of L){if(PAN.test(raw))masked++;PAN.lastIndex=0;const cells=tokenize(raw);let date=null,amts=[],mp=[];
    for(const cell of cells){const d=pdate(cell);if(d&&!date){date=d;continue;}if(isAmtCell(cell)){const v=num(cell);if(v!=null)amts.push(v);continue;}mp.push(cell);}
    if(!date){skipped++;continue;}const pos=amts.filter(v=>v>0);if(!pos.length){skipped++;continue;}
    const amount=Math.min(...pos);const desc=mp.join(' ');if(/payment|reversal|autopay|opening|closing balance|b\/f|c\/f/i.test(desc)){skipped++;continue;}
    out.push(mk({date,amount,dir:'out',desc,channel:'Other',fcy:FCY.test(desc),mk:merchKey(desc),src:'generic',review:true}));}
  return{rows:out,masked,skipped,confident:false};}

// Public entry: returns { rows:[{...transaction fields...}], masked, skipped, confident }
export function parseFile(text){
  if(/^\s*\{\\rtf/.test(text)) text = rtfToText(text);
  text = text.replace(PAN, m => m.replace(/\d/g, '•'));   // mask card numbers before anything else
  const res = isDBScc(text) ? parseDBScc(text)
       : isDBSsavings(text) ? parseDBSsavings(text)
       : isRevolut(text) ? parseRevolut(text)
       : parseGeneric(text);
  res.balance = extractBalance(text);   // current cash balance / card outstanding, if the statement carries one
  return res;
}
