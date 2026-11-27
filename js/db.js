// The app's data: where it's kept and how it stays in step between devices.
//
// Everything is a "record": one envelope, one transaction, one debt...
// Records live in memory while the app is open, are copied to this browser
// so the app opens instantly and survives a dropped connection, and are
// synced with Supabase so every family device sees the same thing. Because
// each record syncs on its own, two people can work at once without
// overwriting each other (unless they edit the very same record).

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const KEY = 'finance-v1';
const OFFLINE = "Can't reach the server. Changes are kept on this device and will upload when it's back.";

export const configured = !!(SUPABASE_URL && SUPABASE_KEY);
const client =
  configured && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;
export const ready = !!client;

const rows = new Map(); // id -> { id, kind, data, deleted }
const dirty = new Set(); // ids changed here and not yet uploaded
let cursor = null; // the newest server change we've seen
let user = null;
let onChange = () => {};
let onStatus = () => {};

export const listen = (changeFn, statusFn) => { onChange = changeFn; onStatus = statusFn; };

// ---------- Reading and changing records ----------

export function all(kind) {
  const out = [];
  for (const r of rows.values()) {
    if (r.kind === kind && !r.deleted) out.push({ id: r.id, ...r.data });
  }
  return out;
}

export function get(id) {
  const r = rows.get(id);
  return r && !r.deleted ? { id: r.id, ...r.data } : null;
}

// Saves a record. Leave out `id` to create a new one. Returns the id.
export function put(kind, record) {
  const { id = crypto.randomUUID(), ...data } = record;
  rows.set(id, { id, kind, data, deleted: false });
  changed(id);
  return id;
}

export function remove(id) {
  const r = rows.get(id);
  if (!r) return;
  // Kept as a "deleted" marker so other devices learn it's gone.
  rows.set(id, { ...r, deleted: true });
  changed(id);
}

function changed(id) {
  dirty.add(id);
  persist();
  if (!user) return;
  onStatus('Saving…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(sync, 600); // one upload for a burst of changes
}

// ---------- The copy in this browser ----------

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 100);
}

function persistNow() {
  clearTimeout(persistTimer);
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ user: user?.id ?? null, rows: [...rows.values()], dirty: [...dirty], cursor })
    );
  } catch {
    if (!user) onStatus("Couldn't save on this device. Changes will be lost when you close the page.");
  }
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    // Never show one login's cached data to a different login.
    if (!saved || saved.user !== (user?.id ?? null)) return;
    for (const r of saved.rows) rows.set(r.id, r);
    for (const id of saved.dirty) dirty.add(id);
    cursor = saved.cursor;
  } catch {
    // Nothing saved yet.
  }
}

// ---------- Syncing with Supabase ----------

let pushTimer = null;
let busy = false;

async function pull() {
  // Re-read a few seconds of overlap so nothing saved at the same instant
  // as our last check can slip through.
  const since = cursor ? new Date(Date.parse(cursor) - 5000).toISOString() : '1970-01-01T00:00:00Z';
  let anyChange = false;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('records')
      .select('id, kind, data, deleted, updated_at')
      .gt('updated_at', since)
      .order('updated_at')
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data) {
      if (!cursor || Date.parse(r.updated_at) > Date.parse(cursor)) cursor = r.updated_at;
      if (dirty.has(r.id)) continue; // our own newer edit is waiting to upload
      const next = { id: r.id, kind: r.kind, data: r.data, deleted: r.deleted };
      const old = rows.get(r.id);
      if (!old || old.deleted !== next.deleted || !sameData(old.data, next.data)) anyChange = true;
      rows.set(r.id, next);
    }
    if (data.length < 1000) break;
  }
  return anyChange;
}

// Compare regardless of the order the database stores a record's fields in.
function sameData(a, b) {
  const sorted = (x) =>
    JSON.stringify(x, (_, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1)))
        : v
    );
  return sorted(a) === sorted(b);
}

// Upload our changes, then download everyone else's.
export async function sync() {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (!user || busy) return; // a sync already running picks up the rest when it ends
  busy = true;
  let synced = false;
  try {
    const sending = [...dirty].map((id) => rows.get(id));
    for (let i = 0; i < sending.length; i += 500) {
      const { error } = await client.from('records').upsert(sending.slice(i, i + 500));
      if (error) throw error;
    }
    // Only "uploaded" if it wasn't changed again while the upload ran.
    for (const r of sending) if (rows.get(r.id) === r) dirty.delete(r.id);
    const anyChange = await pull();
    synced = true;
    persistNow();
    onStatus(dirty.size ? 'Saving…' : `Synced · ${user.email}`);
    if (anyChange) onChange();
  } catch (err) {
    // A database error carries a code; a dropped connection doesn't.
    onStatus(err?.code ? `Couldn't sync: ${err.message}` : OFFLINE);
  } finally {
    busy = false;
    // Changes made while this ran (or that failed to upload): go again soon.
    if (dirty.size && !pushTimer) pushTimer = setTimeout(sync, synced ? 600 : 10000);
  }
}

export const hasUnsaved = () => dirty.size > 0;

// Who is signed in on this device (null when running without sign-in).
export const userId = () => user?.id ?? null;

// ---------- Signing in ----------

export async function start() {
  if (client) {
    const { data } = await client.auth.getSession();
    user = data.session?.user ?? null;
  }
  loadLocal();
  if (!configured) onStatus('Saved on this device only.');
  return user;
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  user = data.user;
  rows.clear();
  dirty.clear();
  cursor = null;
  loadLocal();
  return user;
}

// Is this login on the family list? (See supabase/setup-finance.sql.)
export async function isMember() {
  const { data, error } = await client.from('members').select('user_id');
  if (error) throw error;
  return data.length > 0;
}

export async function signOut() {
  await client.auth.signOut();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

// Ask a server-side function (supabase/functions/) to do something.
export async function callFunction(name, body) {
  const { data, error } = await client.functions.invoke(name, { body });
  if (!error) return data;
  // The function explains what went wrong in its reply; dig that out.
  let detail = null;
  try {
    detail = await error.context.json();
  } catch {
    // No readable reply (for example, the function doesn't exist yet).
  }
  const err = new Error(detail?.error || detail?.message || error.message);
  err.code = detail?.code;
  throw err;
}

// The grocery list saved by the first version of the app, if there is one.
export async function oldGroceryList() {
  const { data } = await client.from('households').select('data').eq('user_id', user.id).maybeSingle();
  return data?.data ?? null;
}
