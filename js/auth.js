// auth.js — Supabase email magic-link sign-in + household resolution.
import { supabase, currentUser } from './supabase.js';

// Send a magic link to the user's email (passwordless).
export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split('#')[0] },
  });
  if (error) throw error;
}

export async function signOut() { await supabase.auth.signOut(); }

// Find the household this user belongs to. The DB trigger creates one on first
// sign-in; a spouse joins via join_household(<id>). If a user belongs to more
// than one, prefer the one that is NOT their own auto-created empty household by
// picking the earliest-joined membership.
export async function resolveHouseholdId() {
  const { data, error } = await supabase
    .from('household_members')
    .select('household_id, created_at')
    .order('created_at', { ascending: true });
  if (error) { console.warn('household lookup failed', error.message); return null; }
  return data?.[0]?.household_id || null;
}

// Join an existing household using its id as an invite code (spouse flow).
export async function joinHousehold(code) {
  const { error } = await supabase.rpc('join_household', { code });
  if (error) throw error;
}

export { currentUser };
