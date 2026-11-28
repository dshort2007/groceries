// Server-side helper for bank connections. It runs on Supabase, not in the
// browser, because it holds two things a browser must never see: the Plaid
// secret key, and the access tokens that let Plaid read each bank.
//
// The app calls it with { action: ... }:
//   link_token  start connecting (or reconnecting) a bank
//   exchange    finish connecting, once the person has signed in at the bank
//   sync        fetch new transactions from every connected bank
//   status      list connected banks
//   remove      disconnect a bank
//
// Settings it needs (Supabase > Edge Functions > Secrets):
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV ("sandbox" or "production")

// Bump this whenever the function changes, so the app can tell when the
// copy running on Supabase is out of date.
export const VERSION = 4;

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------- Pure helpers (tested in tests/plaid.test.js) ----------

// Same simplification the app uses to remember "this store goes in that
// envelope". Keep in step with payeeKey in js/money.js.
export function payeeKey(payee) {
  return String(payee || '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
}

// A stable record id for a bank transaction, so the same transaction can
// never be added twice.
export async function uuidFor(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const shiftDays = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);

// Fetch everything new for one bank login and work out what to change in
// the app's records. `plaid(path, body)` calls Plaid; `store` reads and
// writes the database. Returns counts and the new bookmark.
export async function syncItem(item, plaid, store, now = Date.now()) {
  // Plaid hands changes over in pages, with a bookmark ("cursor"). The
  // bookmark is only saved once every page has been processed, so a
  // failure part-way just means starting this batch again next time.
  let cursor = item.cursor || undefined;
  const latest = new Map();
  const removedIds = [];
  for (let more = true; more; ) {
    const page = await plaid('/transactions/sync', { access_token: item.access_token, cursor, count: 500 });
    for (const t of [...page.added, ...page.modified]) latest.set(t.transaction_id, t);
    for (const t of page.removed) removedIds.push(t.transaction_id);
    cursor = page.next_cursor;
    more = page.has_more;
  }

  // Leave out anything from before the date the family chose to start
  // from, and anything the bank added and took away again in one go.
  const gone = new Set(removedIds);
  const incoming = [...latest.values()].filter((t) => t.date >= item.start_date && !gone.has(t.transaction_id));

  // A purchase first arrives as "pending". When the bank finalises it, the
  // pending one is removed and a final one arrives that names the pending
  // one it replaces, so look those up too.
  const lookups = [...incoming.map((t) => t.transaction_id), ...incoming.map((t) => t.pending_transaction_id).filter(Boolean), ...removedIds];
  const known = await store.txByPlaidIds(lookups);
  const accountFor = new Map();
  for (const a of await store.records('account')) {
    if (a.data.plaidAccountId) accountFor.set(a.data.plaidAccountId, a.id);
  }
  const rules = new Map((await store.records('rule')).map((r) => [r.data.key, r.data.envelopeId]));
  const earliest = incoming.reduce((min, t) => (t.date < min ? t.date : min), '9999-12-31');
  const typedIn = incoming.length ? await store.manualTxSince(shiftDays(earliest, -5)) : [];
  const claimed = new Set();
  const finalised = new Set(); // pending ids that turned into final ones

  const changes = [];
  const counts = { added: 0, matched: 0, updated: 0, removed: 0 };

  for (const t of incoming) {
    const amount = -t.amount; // Plaid: money out is positive. The app: negative.
    const accountId = accountFor.get(t.account_id) || '';
    const replaces = t.pending_transaction_id && known.has(t.pending_transaction_id) ? t.pending_transaction_id : null;
    const existing = known.get(t.transaction_id) || (replaces && known.get(replaces));

    if (existing) {
      // Either the bank corrected something, or a pending purchase became
      // final (often with a new amount: a tip added, a gas hold settled).
      // Keep the family's own edits (name, envelope) and take the bank's
      // date, amount and pending status.
      if (replaces) finalised.add(replaces);
      if (existing.deleted) continue;
      const data = { ...existing.data, date: t.date, amount, plaidId: t.transaction_id };
      if (t.pending) data.pending = true;
      else delete data.pending;
      const same =
        existing.data.amount === amount &&
        existing.data.date === t.date &&
        existing.data.plaidId === t.transaction_id &&
        !!existing.data.pending === !!t.pending;
      if (same) continue;
      if (existing.data.splits && existing.data.amount !== amount) {
        delete data.splits; // the pieces no longer add up: ask again
        data.envelopeId = '';
      }
      changes.push({ ...existing, data });
      counts.updated++;
      continue;
    }

    // Already typed in by hand, or added by marking a bill paid? Same
    // amount, within four days, same account (or none): treat it as that
    // one rather than adding a duplicate.
    const twin = typedIn.find(
      (m) =>
        !claimed.has(m.id) &&
        Math.abs(m.data.amount - amount) < 0.005 &&
        daysApart(m.data.date, t.date) <= 4 &&
        (!m.data.accountId || !accountId || m.data.accountId === accountId)
    );
    if (twin) {
      claimed.add(twin.id);
      changes.push({
        ...twin,
        data: { ...twin.data, plaidId: t.transaction_id, plaidAccountId: t.account_id, accountId: twin.data.accountId || accountId, ...(t.pending ? { pending: true } : {}) },
      });
      counts.matched++;
      continue;
    }

    const payee = t.merchant_name || t.name || '';
    changes.push({
      id: await uuidFor('plaid:' + t.transaction_id),
      kind: 'tx',
      deleted: false,
      data: {
        date: t.date,
        payee,
        amount,
        envelopeId: rules.get(payeeKey(payee)) || '',
        accountId,
        plaidAccountId: t.account_id,
        plaidId: t.transaction_id,
        created: now + counts.added,
        ...(t.pending ? { pending: true } : {}),
      },
    });
    counts.added++;
  }

  for (const id of removedIds) {
    if (finalised.has(id)) continue; // not gone: it became the final one above
    const existing = known.get(id);
    if (existing && !existing.deleted) {
      changes.push({ ...existing, deleted: true });
      counts.removed++;
    }
  }

  return { changes, cursor, counts };
}

// Update the stored list of a bank's accounts with its latest balances.
// "current" is what has cleared; "available" also takes off purchases still
// pending, which is the closer match to what the app counts.
export function withBalances(accounts, fresh) {
  if (!Array.isArray(fresh)) return accounts;
  const byId = new Map(fresh.map((a) => [a.account_id, a.balances || {}]));
  return accounts.map((a) => {
    const b = byId.get(a.id);
    return b ? { ...a, balance: b.current ?? a.balance, available: b.available ?? null, balanceAt: new Date().toISOString() } : a;
  });
}

// ---------- Talking to Plaid and the database ----------

export function makePlaid(env, fetchFn = fetch) {
  const host = HOSTS[env.PLAID_ENV || 'sandbox'];
  if (!host) throw new Error('PLAID_ENV must be "sandbox" or "production".');
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('PLAID_CLIENT_ID and PLAID_SECRET are not set.');
  return async (path, body) => {
    const res = await fetchFn(host + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
    });
    const json = await res.json();
    if (!res.ok) {
      const err = new Error(json.error_message || 'Plaid request failed.');
      err.code = json.error_code || 'PLAID_ERROR';
      throw err;
    }
    return json;
  };
}

function makeStore(db) {
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  const tx = () => db.from('records').select('id, kind, data, deleted').eq('kind', 'tx');
  return {
    async txByPlaidIds(ids) {
      const found = new Map();
      for (let i = 0; i < ids.length; i += 100) {
        for (const row of check(await tx().in('data->>plaidId', ids.slice(i, i + 100)))) {
          found.set(row.data.plaidId, row);
        }
      }
      return found;
    },
    async manualTxSince(date) {
      const rows = check(
        await tx().eq('deleted', false).is('data->>plaidId', null).is('data->>importKey', null).gte('data->>date', date).limit(2000)
      );
      return rows.filter((r) => r.data.envelopeId !== 'transfer');
    },
    async records(kind) {
      return check(await db.from('records').select('id, kind, data, deleted').eq('kind', kind).eq('deleted', false).limit(5000));
    },
    async save(rows) {
      for (let i = 0; i < rows.length; i += 500) check(await db.from('records').upsert(rows.slice(i, i + 500)));
    },
    async items() {
      return check(await db.from('plaid_items').select('*').order('created_at'));
    },
    async saveItem(item) {
      check(await db.from('plaid_items').upsert(item));
    },
    async removeItem(itemId) {
      check(await db.from('plaid_items').delete().eq('item_id', itemId));
    },
  };
}

// What the app is allowed to know about a connection: never the token.
const publicItem = ({ item_id, institution, accounts, start_date, last_sync, error }) => ({
  item_id, institution, accounts, start_date, last_sync, error,
});

async function run(action, body, user, plaid, store) {
  if (action === 'status') return { version: VERSION, items: (await store.items()).map(publicItem) };

  if (action === 'link_token') {
    const request = {
      user: { client_user_id: user.id },
      client_name: 'Family Budget',
      country_codes: ['US'],
      language: 'en',
    };
    if (body.redirect_uri) request.redirect_uri = body.redirect_uri;
    if (body.item_id) {
      // Reconnecting an existing bank login ("update mode").
      const item = (await store.items()).find((i) => i.item_id === body.item_id);
      if (!item) throw new Error('That connection no longer exists.');
      request.access_token = item.access_token;
    } else {
      request.products = ['transactions'];
      request.transactions = { days_requested: 90 };
    }
    return { link_token: (await plaid('/link/token/create', request)).link_token };
  }

  if (action === 'exchange') {
    const { access_token, item_id } = await plaid('/item/public_token/exchange', { public_token: body.public_token });
    const { accounts } = await plaid('/accounts/get', { access_token });
    const item = {
      item_id,
      access_token,
      institution: String(body.institution || 'Bank').slice(0, 80),
      accounts: accounts.map((a) => ({
        id: a.account_id,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        balance: a.balances?.current ?? null,
        available: a.balances?.available ?? null,
      })),
      start_date: /^\d{4}-\d{2}-\d{2}$/.test(body.start_date || '') ? body.start_date : new Date().toISOString().slice(0, 10),
      created_by: user.id,
    };
    await store.saveItem(item);
    return { item: publicItem(item) };
  }

  if (action === 'reconnected') {
    const item = (await store.items()).find((i) => i.item_id === body.item_id);
    if (item) await store.saveItem({ ...item, error: null });
    return {};
  }

  if (action === 'remove') {
    const item = (await store.items()).find((i) => i.item_id === body.item_id);
    if (item) {
      // Tell Plaid to forget the login too. If that fails, still forget it here.
      await plaid('/item/remove', { access_token: item.access_token }).catch(() => {});
      await store.removeItem(item.item_id);
    }
    return {};
  }

  if (action === 'sync') {
    const totals = { added: 0, matched: 0, updated: 0, removed: 0 };
    const results = [];
    for (const item of await store.items()) {
      // Unless asked to, don't bother the bank more than every 15 minutes.
      const recent = item.last_sync && Date.now() - Date.parse(item.last_sync) < 15 * 60 * 1000;
      if (recent && !body.force) {
        results.push(publicItem(item));
        continue;
      }
      try {
        const { changes, cursor, counts } = await syncItem(item, plaid, store);
        await store.save(changes);
        // Also fetch the bank's current balances, so the app can show when
        // its own numbers have drifted. If that fails, keep the old ones.
        const fresh = await plaid('/accounts/get', { access_token: item.access_token }).catch(() => null);
        const saved = { ...item, accounts: withBalances(item.accounts, fresh?.accounts), cursor, last_sync: new Date().toISOString(), error: null };
        await store.saveItem(saved);
        for (const key of Object.keys(totals)) totals[key] += counts[key];
        results.push(publicItem(saved));
      } catch (err) {
        // One bank failing (often: it wants you to sign in again) must not
        // stop the others.
        const failed = { ...item, error: err.code || err.message || 'ERROR' };
        await store.saveItem(failed).catch(() => {});
        results.push(publicItem(failed));
      }
    }
    return { version: VERSION, ...totals, items: results };
  }

  throw new Error('Unknown action.');
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

    // The notification timer may ask for a sync (and nothing else), so
    // there's fresh news to tell people about. It proves itself with the key
    // kept in the locked notifications table.
    const timerKey = req.headers.get('x-notify-key');
    if (timerKey) {
      const { data: config } = await db.from('push_config').select('cron_key').eq('id', 1);
      if (!config?.length || config[0].cron_key !== timerKey) return reply({ error: 'Not allowed.' }, 403);
      return reply(await run('sync', {}, { id: null }, makePlaid(env), makeStore(db)));
    }

    // Otherwise: who is asking? They must be signed in AND on the family list.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    const { data: auth } = await db.auth.getUser(token);
    if (!auth?.user) return reply({ error: 'Please sign in again.' }, 401);
    const { data: member } = await db.from('members').select('user_id').eq('user_id', auth.user.id);
    if (!member?.length) return reply({ error: 'This login is not on the family list.' }, 403);

    const body = await req.json();
    return reply(await run(body.action, body, auth.user, makePlaid(env), makeStore(db)));
  } catch (err) {
    return reply({ error: err.message || 'Something went wrong.', code: err.code }, 400);
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handle);
