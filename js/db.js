// db.js — Supabase data-access layer, scoped to one household.
// Strategy: load everything into memory once (fast, synchronous rendering),
// then write-through to Supabase on every mutation and keep the cache in sync.
import { supabase } from './supabase.js';

let HH = null;      // household id
let UID = null;     // current user id

export function init(householdId, userId){ HH = householdId; UID = userId; }

const DEFAULT_CATS = [
  ['Groceries','🛒',false,true],['Dining','🍽️',false,true],['Transport','🚕',false,true],
  ['Shopping','🛍️',false,true],['Subscriptions','🔁',false,true],['Travel','✈️',false,false],
  ['Insurance','🛡️',false,false],['Healthcare','🩺',false,false],['Utilities/Telco','💡',false,false],
  ['Education','🎓',false,false],['Auto','🚗',false,false],['Rent','🏠',false,false],
  ['Tax','🏛️',false,false],['Bills/Other','📄',false,false],['Transfer','🔄',true,false],
  ['Income','💰',true,false],['Income (interest)','💰',true,false],['Refund','↩️',true,false],
  ['Uncategorized','❓',false,false],
];

const q = (t,cols='*')=>supabase.from(t).select(cols).eq('household_id',HH);
export async function loadAll(){
  const [tx, cats, rules, files, aliases,
         holdings, policies, goals, realEstate, cashAccounts, liabilities,
         settings, taxState, estateState, snapshots, tags] = await Promise.all([
    q('transactions').order('txn_date',{ascending:false}),
    q('categories').order('sort'), q('rules'),
    supabase.from('imported_files').select('account,filename,content_hash').eq('household_id',HH),
    q('category_aliases','from_name,to_name'),
    q('holdings'), q('policies'), q('goals'), q('real_estate'), q('cash_accounts'), q('liabilities'),
    q('household_settings').maybeSingle(), q('tax_state').maybeSingle(), q('estate_state').maybeSingle(),
    q('snapshots').order('created_at'), q('tags'),
  ]);
  let categories = cats.data || [];
  if (!categories.length) categories = await seedCategories();
  const s = settings.data || {};
  return {
    tx: tx.data || [],
    cats: categories,
    rules: Object.fromEntries((rules.data||[]).map(r=>[r.merchant_key, r.category_name])),
    aliases: Object.fromEntries((aliases.data||[]).map(a=>[a.from_name, a.to_name])),
    files: new Set((files.data||[]).map(f=>f.account+'/'+f.filename)),
    fileHashes: new Set((files.data||[]).map(f=>f.content_hash).filter(Boolean)),
    holdings: holdings.data||[], policies: policies.data||[], goals: goals.data||[],
    realEstate: realEstate.data||[], cashAccounts: cashAccounts.data||[], liabilities: liabilities.data||[],
    snapshots: snapshots.data||[], tags: tags.data||[],
    fx: s.fx || {USD_SGD:1.275,EUR_SGD:1.47,INR_SGD:0.0156,GBP_SGD:1.72},
    profiles: s.profiles || {}, kids: s.kids || [], emergencyMonths: s.emergency_fund_months ?? 6,
    tax: taxState.data || null, estate: estateState.data || null,
  };
}

// ---- generic helpers for the v3 importer + balance-sheet CRUD ----
export async function insertRows(table, rows){
  if(!rows || !rows.length) return [];
  const payload = rows.map(r=>({...r, household_id:HH}));
  const { data, error } = await supabase.from(table).insert(payload).select();
  if(error) throw error; return data||[];
}
export async function upsertSingle(table, row){
  const { error } = await supabase.from(table).upsert({...row, household_id:HH},{onConflict:'household_id'});
  if(error) throw error;
}
export async function upsertSettings(row){ return upsertSingle('household_settings', row); }
export async function wipeBalanceSheet(){
  for(const t of ['holdings','policies','goals','real_estate','cash_accounts','liabilities','snapshots','tags']){
    await supabase.from(t).delete().eq('household_id',HH);
  }
}

async function seedCategories(){
  const rows = DEFAULT_CATS.map(([name,icon,ns,el],i)=>({household_id:HH,name,icon,is_nonspend:ns,is_eligible:el,sort:(i+1)*10}));
  await supabase.from('categories').upsert(rows,{onConflict:'household_id,name'});
  return rows;
}

// ---- transactions ----
export async function insertTransactions(rows){
  const payload = rows.map(r=>({...r, household_id:HH, created_by:UID}));
  // chunk to stay well under request limits
  const out=[];
  for(let i=0;i<payload.length;i+=400){
    const { data, error } = await supabase.from('transactions').insert(payload.slice(i,i+400)).select();
    if(error) throw error; out.push(...(data||[]));
  }
  return out;
}
export async function patchTransaction(id, patch){
  const { error } = await supabase.from('transactions').update(patch).eq('id',id); if(error) throw error;
}
export async function deleteTransaction(id){
  const { error } = await supabase.from('transactions').delete().eq('id',id); if(error) throw error;
}
export async function deleteWhereReview(){
  const { error } = await supabase.from('transactions').delete().eq('household_id',HH).eq('review',true); if(error) throw error;
}
export async function approveAllReview(){
  const { error } = await supabase.from('transactions').update({review:false}).eq('household_id',HH).eq('review',true); if(error) throw error;
}
export async function clearAllTransactions(){
  await supabase.from('transactions').delete().eq('household_id',HH);
  await supabase.from('imported_files').delete().eq('household_id',HH);
}

// set category for all txns of a merchant + remember the rule
export async function setMerchantCategory(merchant, category){
  await supabase.from('transactions').update({category}).eq('household_id',HH).eq('merchant',merchant);
  await supabase.from('rules').upsert({household_id:HH,merchant_key:merchant,category_name:category,updated_at:new Date().toISOString()},{onConflict:'household_id,merchant_key'});
}

// ---- categories ----
export async function addCategory(name, icon){
  const { error } = await supabase.from('categories').upsert({household_id:HH,name,icon:icon||'🏷️',sort:500},{onConflict:'household_id,name'}); if(error) throw error;
}
export async function setCategoryIcon(name, icon){
  await supabase.from('categories').update({icon}).eq('household_id',HH).eq('name',name);
}
export async function renameCategory(oldName, newName){
  if(oldName===newName) return;
  // carry the row, migrate data, and alias so future imports follow
  const { data } = await supabase.from('categories').select('*').eq('household_id',HH).eq('name',oldName).maybeSingle();
  await supabase.from('categories').upsert({household_id:HH,name:newName,icon:data?.icon||'🏷️',is_nonspend:data?.is_nonspend||false,is_eligible:data?.is_eligible||false,sort:data?.sort||500},{onConflict:'household_id,name'});
  await supabase.from('categories').delete().eq('household_id',HH).eq('name',oldName);
  await supabase.from('transactions').update({category:newName}).eq('household_id',HH).eq('category',oldName);
  await supabase.from('rules').update({category_name:newName}).eq('household_id',HH).eq('category_name',oldName);
  await supabase.from('category_aliases').upsert({household_id:HH,from_name:oldName,to_name:newName},{onConflict:'household_id,from_name'});
  // repoint any existing aliases that pointed to oldName
  await supabase.from('category_aliases').update({to_name:newName}).eq('household_id',HH).eq('to_name',oldName);
}

// ---- imported files + duplicate protection ----
export async function recordImported(account, filename, contentHash){
  await supabase.from('imported_files').upsert({household_id:HH,account,filename,content_hash:contentHash||null},{onConflict:'household_id,account,filename'});
}
// SHA-256 of file text → hex (catches the same statement re-uploaded even if renamed)
export async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function fingerprint(t){ return [t.account,t.txn_date,t.amount,t.direction,t.merchant].join('|'); }
