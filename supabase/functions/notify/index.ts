// Server-side helper that sends notifications to the family's phones and
// computers. It runs on Supabase because it holds the key that proves the
// notifications come from this app, and because it has to run on a timer
// when nobody has the app open.
//
// Called two ways:
//   - by the database's daily timer (see supabase/setup-notify.sql), to send
//     each device a short summary of what needs attention;
//   - by the app, with { action: ... }:
//       config   the public key a device needs in order to subscribe
//       test     send a test notification to every subscribed device
//       preview  say what today's summary would be, without sending it
//
// Optional setting (Supabase > Edge Functions > Secrets):
//   NOTIFY_TZ   the family's time zone, default America/New_York

export const VERSION = 2;

// Where the family's alert choices, and the function's own notes on what it
// has already told people, are kept among the app's records.
const ALERT_SETTINGS = '00000000-0000-4000-8000-000000000008';
const ALERT_STATE = '00000000-0000-4000-8000-000000000009';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const text = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- Web Push: proving who we are, and scrambling the message ----------
//
// Phones only accept a notification if it is (1) signed with a key the
// device was given when it subscribed ("VAPID") and (2) encrypted so that
// only that device can read it. Both are done here with the runtime's
// built-in cryptography.

export async function generateKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
  };
}

// The signed pass that goes in the Authorization header.
export async function vapidHeader(endpoint, keys, subject, nowSeconds = Math.floor(Date.now() / 1000)) {
  const head = b64u(text.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(text.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(keys.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, text.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(signature)}, k=${keys.publicKey}`;
}

async function hkdf(salt, secret, info, length) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// Encrypts a message for one device (the "aes128gcm" scheme of RFC 8291).
// `salt` and `local` are only passed in by tests.
export async function encryptFor(subscription, message, salt = crypto.getRandomValues(new Uint8Array(16)), local = null) {
  const devicePublic = unb64u(subscription.keys.p256dh);
  const deviceAuth = unb64u(subscription.keys.auth);
  const ours = local || (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const ourPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ours.publicKey));
  const theirs = await crypto.subtle.importKey('raw', devicePublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, ours.privateKey, 256));

  const material = await hkdf(deviceAuth, shared, concat(text.encode('WebPush: info\0'), devicePublic, ourPublic), 32);
  const contentKey = await hkdf(salt, material, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, material, text.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  // The single byte 2 marks this as the last (only) chunk.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(text.encode(message), new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + ourPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = ourPublic.length;
  header.set(ourPublic, 21);
  return concat(header, sealed);
}

// Sends one notification. Returns the push service's status code.
export async function sendPush(subscription, payload, keys, subject, fetchFn = fetch) {
  const res = await fetchFn(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'normal',
      Authorization: await vapidHeader(subscription.endpoint, keys, subject),
    },
    body: await encryptFor(subscription, JSON.stringify(payload)),
  });
  return res.status;
}

// ---------- Deciding what's worth a notification ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (list) => (list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`);

// Today's date where the family lives, as YYYY-MM-DD.
export function localDate(zone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const dayAfter = (date) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);

// The daily summary, from the app's records. Returns { title, body } or
// null when there's nothing worth interrupting anyone for.
export function digest(records, today) {
  const of = (kind) => records.filter((r) => r.kind === kind && !r.deleted).map((r) => ({ id: r.id, ...r.data }));
  const bills = of('bill').filter((b) => b.nextDue);
  const tomorrow = dayAfter(today);
  const overdue = bills.filter((b) => b.nextDue < today).map((b) => b.name);
  const dueToday = bills.filter((b) => b.nextDue === today).map((b) => b.name);
  const dueTomorrow = bills.filter((b) => b.nextDue === tomorrow).map((b) => b.name);

  // What's in each envelope: everything assigned to it so far, less what's
  // been spent from it. (A simpler copy of the app's own sum.)
  const balance = new Map();
  const add = (id, amount) => balance.set(id, (balance.get(id) || 0) + (Number(amount) || 0));
  for (const a of of('assign')) if ((a.week || '') <= today) add(a.envelopeId, a.amount);
  for (const t of of('tx')) {
    if ((t.date || '') > today) continue;
    for (const p of Array.isArray(t.splits) && t.splits.length ? t.splits : [t]) add(p.envelopeId, p.amount);
  }
  const overspent = of('envelope').filter((e) => !e.archived && (balance.get(e.id) || 0) < -0.004).map((e) => e.name);

  const lines = [];
  if (overdue.length) lines.push(`Overdue: ${names(overdue)}.`);
  if (dueToday.length) lines.push(`Due today: ${names(dueToday)}.`);
  if (dueTomorrow.length) lines.push(`Due tomorrow: ${names(dueTomorrow)}.`);
  if (overspent.length) lines.push(`Overspent: ${names(overspent)}.`);
  if (lines.length === 0) return null;

  const billCount = overdue.length + dueToday.length + dueTomorrow.length;
  const title = billCount ? `${plural(billCount, 'bill')} need${billCount === 1 ? 's' : ''} attention` : `${plural(overspent.length, 'envelope')} overspent`;
  return { title, body: lines.join(' ') };
}

// ---------- Things worth telling people as they happen ----------

export const DEFAULT_ALERTS = {
  summary: true, // the morning summary
  toFile: true, // new bank transactions that need an envelope
  income: true, // money arriving
  large: true, // a big purchase
  largeOver: 200,
  overspent: true, // an envelope going into the red
  low: true, // an account running low
  lowUnder: 100,
  quietFrom: 21, // no notifications from 9pm...
  quietTo: 7, // ...until 7am
};

const dollars = (n) => '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Is this hour inside the quiet stretch? (Which may run past midnight.)
export function isQuiet(hour, settings) {
  const from = Number(settings.quietFrom);
  const to = Number(settings.quietTo);
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

// Compares the records with what was true at the last check and returns the
// notifications to send, plus the notes to keep for next time. `state` is
// those notes; on the very first check nothing is sent, so a new setup
// doesn't announce everything that already exists.
export function events(records, state, settings, today) {
  const of = (kind) => records.filter((r) => r.kind === kind && !r.deleted).map((r) => ({ id: r.id, ...r.data }));
  const txs = of('tx');
  const alerts = [];
  const first = !state || state.txMark === undefined;
  const next = { ...(state || {}) };

  // ---- New transactions from the bank since the last check ----
  const mark = Number(state?.txMark) || 0;
  const fresh = txs.filter((t) => t.plaidId && Number(t.created) > mark).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  next.txMark = txs.reduce((max, t) => Math.max(max, Number(t.created) || 0), mark);
  if (!first && fresh.length) {
    const lines = [];
    const arrived = fresh.filter((t) => t.amount >= 200 && t.envelopeId !== 'transfer');
    const big = fresh.filter((t) => t.amount <= -Math.abs(Number(settings.largeOver) || 200) && t.envelopeId !== 'transfer');
    const unfiled = fresh.filter((t) => !t.envelopeId);
    if (settings.income && arrived.length) lines.push(`Money in: ${arrived.map((t) => `${dollars(t.amount)} from ${t.payee}`).join(', ')}. Time to give it a job.`);
    if (settings.large && big.length) lines.push(`Large purchase: ${big.map((t) => `${dollars(t.amount)} at ${t.payee}`).join(', ')}.`);
    if (settings.toFile && unfiled.length) {
      const shown = unfiled.slice(0, 3).map((t) => `${t.payee} ${dollars(t.amount)}`).join(', ');
      lines.push(`${plural(unfiled.length, 'transaction')} to file: ${shown}${unfiled.length > 3 ? ` and ${unfiled.length - 3} more` : ''}.`);
    }
    if (lines.length) {
      const title = settings.income && arrived.length ? 'Money arrived' : settings.large && big.length ? 'Large purchase' : `${plural(unfiled.length, 'new transaction')}`;
      alerts.push({ title, body: lines.join(' ') });
    }
  }

  // ---- Envelopes that have just gone into the red ----
  const balance = new Map();
  const add = (id, amount) => balance.set(id, (balance.get(id) || 0) + (Number(amount) || 0));
  for (const a of of('assign')) if ((a.week || '') <= today) add(a.envelopeId, a.amount);
  for (const t of txs) {
    if ((t.date || '') > today) continue;
    for (const p of Array.isArray(t.splits) && t.splits.length ? t.splits : [t]) add(p.envelopeId, p.amount);
  }
  const red = of('envelope').filter((e) => !e.archived && (balance.get(e.id) || 0) < -0.004);
  const wasRed = new Set(state?.red || []);
  const newlyRed = red.filter((e) => !wasRed.has(e.id));
  next.red = red.map((e) => e.id);
  if (!first && settings.overspent && newlyRed.length) {
    alerts.push({ title: newlyRed.length === 1 ? `${newlyRed[0].name} is overspent` : `${newlyRed.length} envelopes overspent`, body: newlyRed.map((e) => `${e.name} is ${dollars(balance.get(e.id))} over.`).join(' ') + ' Cover it from another envelope.' });
  }

  // ---- Accounts that have just dropped below the line ----
  const limit = Number(settings.lowUnder) || 0;
  const low = of('account')
    .filter((a) => a.type !== 'credit')
    .map((a) => ({ ...a, now: (Number(a.startBalance) || 0) + txs.filter((t) => t.accountId === a.id).reduce((sum, t) => sum + (Number(t.amount) || 0), 0) }))
    .filter((a) => a.now < limit && (a.type === 'checking' || a.now < 0));
  const wasLow = new Set(state?.low || []);
  const newlyLow = low.filter((a) => !wasLow.has(a.id));
  next.low = low.map((a) => a.id);
  if (!first && settings.low && newlyLow.length) {
    alerts.push({ title: 'Account running low', body: newlyLow.map((a) => `${a.name} is ${a.now < 0 ? 'overdrawn by' : 'down to'} ${dollars(a.now)}.`).join(' ') });
  }

  return { alerts, state: next };
}

// ---------- The web entry point ----------

async function handle(req) {
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const env = Deno.env.toObject();
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const check = ({ data, error }) => {
      if (error) throw new Error(error.message);
      return data;
    };

    const [config] = check(await db.from('push_config').select('*').eq('id', 1));
    if (!config) throw new Error('Notifications are not set up yet: run supabase/setup-notify.sql.');

    // Who is asking? Either the database's timer, which knows the key that
    // setup stored, or a signed-in family member.
    const fromTimer = req.headers.get('x-notify-key') === config.cron_key;
    if (!fromTimer) {
      const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
      const { data: auth } = await db.auth.getUser(jwt);
      if (!auth?.user) return reply({ error: 'Please sign in again.' }, 401);
      const { data: member } = await db.from('members').select('user_id').eq('user_id', auth.user.id);
      if (!member?.length) return reply({ error: 'This login is not on the family list.' }, 403);
    }

    // The signing keys are made once, on first use, and kept in the locked table.
    let keys = { publicKey: config.public_key, privateKey: config.private_key };
    if (!keys.publicKey || !keys.privateKey) {
      keys = await generateKeys();
      check(await db.from('push_config').update({ public_key: keys.publicKey, private_key: keys.privateKey }).eq('id', 1));
    }

    const body = await req.json().catch(() => ({}));
    const action = fromTimer ? 'tick' : body.action;
    if (action === 'config') return reply({ version: VERSION, publicKey: keys.publicKey });

    // On the timer, first ask the bank function to fetch anything new, so
    // there's fresh news to report. If that fails, carry on with what's here.
    if (action === 'tick') {
      await fetch(`${env.SUPABASE_URL}/functions/v1/plaid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-notify-key': config.cron_key, apikey: env.SUPABASE_ANON_KEY || '' },
        body: JSON.stringify({ action: 'sync' }),
      }).catch(() => null);
    }

    const zone = env.NOTIFY_TZ || 'America/New_York';
    const today = localDate(zone);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    const records = check(await db.from('records').select('id, kind, data, deleted').in('kind', ['bill', 'envelope', 'assign', 'tx', 'account', 'push', 'settings', 'notifystate']).eq('deleted', false).limit(20000));
    const settings = { ...DEFAULT_ALERTS, ...(records.find((r) => r.id === ALERT_SETTINGS)?.data?.alerts || {}) };
    const summary = digest(records, today);
    if (action === 'preview') return reply({ version: VERSION, summary });

    // Send to every subscribed device. One that has gone away (the app was
    // removed, or permission withdrawn) answers 404 or 410: forget it.
    const devices = records.filter((r) => r.kind === 'push' && r.data?.endpoint && r.data?.keys);
    const failed = [];
    const broadcast = async (payload) => {
      let sent = 0;
      for (const device of devices) {
        try {
          const status = await sendPush(device.data, payload, keys, env.SUPABASE_URL);
          if (status >= 200 && status < 300) sent++;
          else if (status === 404 || status === 410) await db.from('records').update({ deleted: true }).eq('id', device.id);
          else failed.push(status);
        } catch (err) {
          failed.push(err.message);
        }
      }
      return sent;
    };

    if (action === 'test') {
      const sent = await broadcast({ title: 'Family Budget', body: 'Notifications are working on this device.' });
      return reply({ version: VERSION, sent, devices: devices.length, failed });
    }
    if (action !== 'tick') throw new Error('Unknown action.');

    // During quiet hours nothing is sent and nothing is marked as told, so
    // it all arrives together in the morning.
    if (isQuiet(hour, settings)) return reply({ version: VERSION, quiet: true });

    const stateRow = records.find((r) => r.id === ALERT_STATE);
    const { alerts, state } = events(records, stateRow?.data, settings, today);
    // The morning summary goes out at the first check at or after 9am.
    if (settings.summary && hour >= 9 && state.summaryDate !== today) {
      state.summaryDate = today;
      if (summary) alerts.push(summary);
    }
    let sent = 0;
    for (const alert of alerts) sent += await broadcast(alert);
    check(await db.from('records').upsert({ id: ALERT_STATE, kind: 'notifystate', data: state, deleted: false }));
    return reply({ version: VERSION, sent, devices: devices.length, failed, alerts });
  } catch (err) {
    return reply({ error: err.message || 'Something went wrong.' }, 400);
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handle);
