// supabase.js — Supabase client for the NEW dedicated finance project.
// The anon key is meant to live in client code; Row-Level Security protects data.
//
// ⚠️ SETUP: after you create the finance Supabase project, paste its values below.
//    Supabase dashboard -> Project Settings -> API -> Project URL + anon/public key.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://bxpffrvwwqxskjwsjaxx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_yMzhp6svXpWoxUCHyGaA_Q_hBlH7--t';  // publishable (client-safe) key

export const CONFIGURED =
  SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 40;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export async function currentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user || null;
}
