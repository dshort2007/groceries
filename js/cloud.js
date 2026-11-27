// Talks to Supabase: signing in, and loading/saving the household's data.
// The whole list, stores and prices are stored together as one record per
// login, which keeps this simple.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const configured = !!(SUPABASE_URL && SUPABASE_KEY);

const client =
  configured && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

export const ready = !!client;

export async function currentUser() {
  const { data } = await client.auth.getSession();
  return data.session?.user ?? null;
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  await client.auth.signOut();
}

// Returns { data, updated_at }, or null if nothing has been saved yet.
export async function pull(userId) {
  const { data, error } = await client
    .from('households')
    .select('data, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Saves everything and returns the time it was saved.
export async function push(userId, state) {
  const updated_at = new Date().toISOString();
  const { error } = await client
    .from('households')
    .upsert({ user_id: userId, data: state, updated_at });
  if (error) throw error;
  return updated_at;
}
