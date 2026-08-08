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

export async function loadAll(){
  const [tx, cats, rules, files, aliases] = await Promise.all([
    supabase.from('transactions').select('*').eq('household_id',HH).order('txn_date',{ascending:false}),
    supabase.from('categories').select('*').eq('household_id',HH).order('sort'),
    supabase.from('rules').select('*').eq('household_id',HH),
    supabase.from('imported_files').select('account,filename').eq('household_id',HH),
    supabase.from('category_aliases').select('from_name,to_name').eq('household_id',HH),
  ]);
  let categories = cats.data || [];
  if (!categories.length) categories = await seedCategories();     // fallback if trigger didn't seed
  return {
    tx: tx.data || [],
    cats: categories,
    rules: Object.fromEntries((rules.data||[]).map(r=>[r.merchant_key, r.category_name])),
    aliases: Object.fromEntries((aliases.data||[]).map(a=>[a.from_name, a.to_name])),
    files: new Set((files.data||[]).map(f=>f.account+'/'+f.filename)),
  };
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

// ---- imported files ----
export async function recordImported(account, filename){
  await supabase.from('imported_files').upsert({household_id:HH,account,filename},{onConflict:'household_id,account,filename'});
}
