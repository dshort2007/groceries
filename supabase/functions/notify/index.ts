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

export const VERSION = 1;

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
    const action = fromTimer ? 'daily' : body.action;
    if (action === 'config') return reply({ version: VERSION, publicKey: keys.publicKey });

    const records = check(await db.from('records').select('id, kind, data, deleted').in('kind', ['bill', 'envelope', 'assign', 'tx', 'push']).eq('deleted', false).limit(20000));
    const summary = digest(records, localDate(env.NOTIFY_TZ || 'America/New_York'));
    if (action === 'preview') return reply({ version: VERSION, summary });

    let payload;
    if (action === 'test') payload = { title: 'Family Budget', body: 'Notifications are working on this device.' };
    else if (action === 'daily') payload = summary;
    else throw new Error('Unknown action.');
    if (!payload) return reply({ version: VERSION, sent: 0, nothing: true });

    // Send to every subscribed device. One that has gone away (the app was
    // removed, or permission withdrawn) answers 404 or 410: forget it.
    const devices = records.filter((r) => r.kind === 'push' && r.data?.endpoint && r.data?.keys);
    let sent = 0;
    const failed = [];
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
    return reply({ version: VERSION, sent, devices: devices.length, failed, summary: payload });
  } catch (err) {
    return reply({ error: err.message || 'Something went wrong.' }, 400);
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handle);
