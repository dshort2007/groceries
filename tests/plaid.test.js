// Checks how bank transactions get merged into the app's records.
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { payeeKey as appPayeeKey } from '../js/money.js';

// The function is written for Supabase's runtime; load a copy here.
const copy = join(mkdtempSync(join(tmpdir(), 'plaid-')), 'fn.mjs');
copyFileSync(new URL('../supabase/functions/plaid/index.ts', import.meta.url), copy);
const { syncItem, payeeKey, uuidFor, makePlaid } = await import(pathToFileURL(copy));

const bank = (id, date, amount, name, extra = {}) => ({ transaction_id: id, account_id: 'acct-chk', date, amount, name, pending: false, ...extra });
const item = { item_id: 'item1', access_token: 'secret-token', cursor: null, start_date: '2026-11-27' };

function fakes(pages, rows = []) {
  const calls = [];
  const plaid = async (path, body) => {
    calls.push({ path, body });
    return pages[calls.length - 1];
  };
  const store = {
    txByPlaidIds: async (ids) => new Map(rows.filter((r) => ids.includes(r.data.plaidId)).map((r) => [r.data.plaidId, r])),
    manualTxSince: async (date) => rows.filter((r) => r.kind === 'tx' && !r.deleted && !r.data.plaidId && !r.data.importKey && r.data.date >= date),
    records: async (kind) => rows.filter((r) => r.kind === kind),
  };
  return { plaid, store, calls };
}
const page = (added, extra = {}) => ({ added, modified: [], removed: [], next_cursor: 'c1', has_more: false, ...extra });
const account = { id: 'app-chk', kind: 'account', data: { name: 'Chime', plaidAccountId: 'acct-chk' } };
const rule = { id: 'r1', kind: 'rule', data: { key: 'KROGER NEWNAN', envelopeId: 'env-groc' } };

test('new bank transactions become records, signed the app way and filed by rule', async () => {
  const { plaid, store } = fakes([page([
    bank('t1', '2026-11-28', 84.12, 'KROGER #432 NEWNAN GA'),
    bank('t2', '2026-11-28', -2430.4, 'CROSSROADS PAYROLL'),
  ])], [account, rule]);
  const { changes, cursor, counts } = await syncItem(item, plaid, store, 1000);
  assert.deepEqual(counts, { added: 2, matched: 0, updated: 0, removed: 0 });
  assert.equal(cursor, 'c1');
  assert.deepEqual(changes[0].data, { date: '2026-11-28', payee: 'KROGER #432 NEWNAN GA', amount: -84.12, envelopeId: 'env-groc', accountId: 'app-chk', plaidAccountId: 'acct-chk', plaidId: 't1', created: 1000 });
  assert.equal(changes[1].data.amount, 2430.4);
  assert.equal(changes[1].data.envelopeId, '');
  assert.match(changes[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(changes[0].id, await uuidFor('plaid:t1'));
});

test('pending purchases and anything before the start date are left out', async () => {
  const { plaid, store } = fakes([page([
    bank('t1', '2026-11-28', 10, 'A', { pending: true }),
    bank('t2', '2026-11-20', 10, 'B'),
    bank('t3', '2026-11-27', 10, 'C'),
  ])]);
  const { changes } = await syncItem(item, plaid, store);
  assert.deepEqual(changes.map((c) => c.data.plaidId), ['t3']);
});

test('follows every page and passes the bookmark along', async () => {
  const { plaid, store, calls } = fakes([
    page([bank('t1', '2026-11-28', 1, 'A')], { next_cursor: 'c1', has_more: true }),
    page([bank('t2', '2026-11-28', 2, 'B')], { next_cursor: 'c2' }),
  ]);
  const { changes, cursor } = await syncItem({ ...item, cursor: 'c0' }, plaid, store);
  assert.deepEqual(calls.map((c) => c.body.cursor), ['c0', 'c1']);
  assert.equal(cursor, 'c2');
  assert.equal(changes.length, 2);
});

test('a transaction typed in by hand is matched, not duplicated', async () => {
  const typed = { id: 'm1', kind: 'tx', deleted: false, data: { date: '2026-11-27', payee: 'Rent', amount: -2145, envelopeId: 'env-rent', accountId: '' } };
  const imported = { id: 'm2', kind: 'tx', deleted: false, data: { date: '2026-11-27', payee: 'x', amount: -50, importKey: 'k' } };
  const { plaid, store } = fakes([page([
    bank('t1', '2026-11-30', 2145, 'FIRSTKEY HOMES'),
    bank('t2', '2026-11-30', 2145, 'FIRSTKEY HOMES'), // a second identical charge is real
    bank('t3', '2026-11-28', 50, 'SOMETHING'),
  ])], [account, typed, imported]);
  const { changes, counts } = await syncItem(item, plaid, store);
  assert.deepEqual(counts, { added: 2, matched: 1, updated: 0, removed: 0 });
  assert.deepEqual(changes[0], { ...typed, data: { ...typed.data, plaidId: 't1', plaidAccountId: 'acct-chk', accountId: 'app-chk' } });
});

test("a bank correction keeps the family's edits; a removal deletes", async () => {
  const filed = { id: 'x1', kind: 'tx', deleted: false, data: { date: '2026-11-28', payee: 'Kroger (renamed)', amount: -80, envelopeId: 'env-groc', plaidId: 't1' } };
  const split = { id: 'x2', kind: 'tx', deleted: false, data: { date: '2026-11-28', payee: 'Walmart', amount: -80, envelopeId: 'split', splits: [{ envelopeId: 'a', amount: -60 }, { envelopeId: 'b', amount: -20 }], plaidId: 't2' } };
  const gone = { id: 'x3', kind: 'tx', deleted: false, data: { date: '2026-11-28', payee: 'Oops', amount: -5, plaidId: 't3' } };
  const same = { id: 'x4', kind: 'tx', deleted: false, data: { date: '2026-11-28', payee: 'Same', amount: -7, plaidId: 't4' } };
  const { plaid, store } = fakes([{
    added: [],
    modified: [bank('t1', '2026-11-29', 82.5, 'KROGER'), bank('t2', '2026-11-28', 85, 'WALMART'), bank('t4', '2026-11-28', 7, 'SAME')],
    removed: [{ transaction_id: 't3' }, { transaction_id: 'never-seen' }],
    next_cursor: 'c9',
    has_more: false,
  }], [filed, split, gone, same]);
  const { changes, counts } = await syncItem(item, plaid, store);
  assert.deepEqual(counts, { added: 0, matched: 0, updated: 2, removed: 1 });
  assert.deepEqual(changes[0].data, { ...filed.data, date: '2026-11-29', amount: -82.5 });
  assert.equal(changes[1].data.splits, undefined);
  assert.equal(changes[1].data.envelopeId, '');
  assert.deepEqual(changes[2], { ...gone, deleted: true });
});

test('running the same sync twice adds nothing new', async () => {
  const first = fakes([page([bank('t1', '2026-11-28', 9, 'A')])]);
  const { changes } = await syncItem(item, first.plaid, first.store);
  const second = fakes([page([bank('t1', '2026-11-28', 9, 'A')])], changes);
  assert.deepEqual((await syncItem(item, second.plaid, second.store)).changes, []);
});

test('payee simplification matches the app, and Plaid errors carry their code', async () => {
  for (const name of ['KROGER #432 NEWNAN GA', 'WAL-MART #1234', 'SQ *Coffee Shop']) assert.equal(payeeKey(name), appPayeeKey(name));
  const seen = [];
  const plaid = makePlaid({ PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox' }, async (url, init) => {
    seen.push([url, JSON.parse(init.body)]);
    return { ok: false, json: async () => ({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login needed' }) };
  });
  await assert.rejects(plaid('/transactions/sync', { access_token: 'a' }), (e) => e.code === 'ITEM_LOGIN_REQUIRED');
  assert.deepEqual(seen[0], ['https://sandbox.plaid.com/transactions/sync', { client_id: 'id', secret: 'sec', access_token: 'a' }]);
  assert.throws(() => makePlaid({ PLAID_ENV: 'sandbox' }), /not set/);
});
