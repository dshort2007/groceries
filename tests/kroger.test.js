// Checks the Kroger price helper. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const copy = join(mkdtempSync(join(tmpdir(), 'kroger-')), 'fn.mjs');
copyFileSync(new URL('../supabase/functions/kroger/index.ts', import.meta.url), copy);
const { toProduct, toLocation, makeKroger, run } = await import(pathToFileURL(copy));

const eggs = { productId: '0001111060933', description: 'Kroger Grade A Large Eggs', brand: 'Kroger', items: [{ size: '12 ct', price: { regular: 2.99, promo: 1.99 } }] };
const heinz = { productId: '0001300000124', description: 'Heinz Tomato Ketchup', brand: 'Heinz', items: [{ size: '20 oz', price: { regular: 3.49, promo: 0 } }] };

test('a product is boiled down, using the sale price when there is one', () => {
  assert.deepEqual(toProduct(eggs), { productId: '0001111060933', name: 'Kroger Grade A Large Eggs', brand: 'Kroger', size: '12 ct', price: 1.99, regular: 2.99, onSale: true, storeBrand: true });
  assert.deepEqual(toProduct(heinz), { productId: '0001300000124', name: 'Heinz Tomato Ketchup', brand: 'Heinz', size: '20 oz', price: 3.49, regular: 3.49, onSale: false, storeBrand: false });
  assert.equal(toProduct({ productId: 'x' }).price, 0); // not sold at this store
  assert.deepEqual(toLocation({ locationId: '011', name: 'Kroger - Main St', address: { addressLine1: '1 Main St', city: 'Newnan', state: 'GA' } }), { locationId: '011', name: 'Kroger - Main St', address: '1 Main St, Newnan, GA' });
});

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization, body: init.body });
    if (url.includes('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 1800 }) };
    if (url.includes('/locations')) return { ok: true, json: async () => ({ data: [{ locationId: '011', name: 'Kroger', address: { city: 'Newnan' } }] }) };
    return { ok: true, json: async () => ({ data: [eggs, heinz, { productId: 'none', items: [{}] }] }) };
  };
}

test('signs in once, then searches with the store and term', async () => {
  const calls = [];
  const kroger = makeKroger({ KROGER_CLIENT_ID: 'id', KROGER_CLIENT_SECRET: 'sec' }, fakeFetch(calls));
  const found = await run('search', { term: 'eggs', locationId: '011' }, kroger);
  assert.equal(found.products.length, 2); // the one with no price here is dropped
  assert.equal(calls[0].auth, 'Basic ' + btoa('id:sec'));
  assert.match(calls[0].body, /grant_type=client_credentials/);
  assert.equal(calls[1].auth, 'Bearer tok-1');
  assert.match(calls[1].url, /filter\.term=eggs&filter\.locationId=011/);

  await run('locations', { zip: '30263' }, kroger);
  assert.equal(calls.filter((c) => c.url.includes('/oauth2/token')).length, 1); // token reused
  assert.match(calls[2].url, /filter\.zipCode\.near=30263/);

  const priced = await run('prices', { productIds: ['a', 'b', 'a'], locationId: '011' }, kroger);
  assert.match(calls[3].url, /filter\.productId=a%2Cb&/);
  assert.equal(priced.products.length, 3);
});

test('explains bad input and missing keys', async () => {
  const kroger = makeKroger({ KROGER_CLIENT_ID: 'id', KROGER_CLIENT_SECRET: 'sec' }, fakeFetch([]));
  await assert.rejects(run('locations', { zip: 'abc' }, kroger), /5-digit/);
  await assert.rejects(run('search', { term: 'eg', locationId: '1' }, kroger), /3 letters/);
  await assert.rejects(run('search', { term: 'eggs' }, kroger), /which Kroger store/);
  assert.throws(() => makeKroger({}), /not set/);
});
