// Checks that the price math is right. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCost, optimize, storeFee } from '../js/optimizer.js';

const aldi = { id: 'aldi', name: 'Aldi' };
const kroger = { id: 'kroger', name: 'Kroger' };
const sams = { id: 'sams', name: "Sam's Club", requiresMembership: true };

const milk = { id: 'milk', name: 'Milk', qty: 2, unit: 'each' };
const eggs = { id: 'eggs', name: 'Eggs', qty: 24, unit: 'ct' };
const bread = { id: 'bread', name: 'Bread', qty: 1, unit: 'each' };

function makeState(overrides = {}) {
  return {
    items: [milk, eggs, bread],
    stores: [aldi, kroger],
    prices: {
      milk: { aldi: { price: 3 }, kroger: { price: 2.5 } },
      eggs: { aldi: { price: 2, size: 12 }, kroger: { price: 5, size: 18 } },
      bread: { aldi: { price: 1.5 }, kroger: { price: 3 } },
    },
    settings: { maxStores: 3, extraStopCost: 0 },
    ...overrides,
  };
}

test('"each" items cost price times quantity', () => {
  assert.equal(lineCost(milk, { price: 3 }).cost, 6);
});

test('sized items round up to whole packages', () => {
  const line = lineCost(eggs, { price: 5, size: 18 });
  assert.equal(line.packages, 2);
  assert.equal(line.cost, 10);
});

test('a coupon comes off once and never goes below zero', () => {
  assert.equal(lineCost(milk, { price: 3, coupon: 1 }).cost, 5);
  assert.equal(lineCost(bread, { price: 1.5, coupon: 5 }).cost, 0);
});

test('no price, or a sized item with no package size, cannot be priced', () => {
  assert.equal(lineCost(milk, {}), null);
  assert.equal(lineCost(eggs, { price: 2 }), null);
});

test('splits across stores when that is cheaper', () => {
  const { best, bestSingle } = optimize(makeState());
  // Aldi: eggs 4 + bread 1.5, Kroger: milk 5
  assert.equal(best.total, 10.5);
  assert.equal(best.stores.length, 2);
  assert.equal(bestSingle.stores[0].store.id, 'aldi');
  assert.equal(bestSingle.total, 11.5);
});

test('stays at one store when the extra stop is not worth it', () => {
  const state = makeState({ settings: { maxStores: 3, extraStopCost: 5 } });
  const { best } = optimize(state);
  assert.equal(best.stores.length, 1);
  assert.equal(best.total, 11.5);
});

test('respects the maximum number of stores', () => {
  const state = makeState({ settings: { maxStores: 1, extraStopCost: 0 } });
  assert.equal(optimize(state).best.stores.length, 1);
});

test('membership-only stores are left out until you have the membership', () => {
  const prices = makeState().prices;
  for (const id of Object.keys(prices)) prices[id].sams = { price: 0.5, size: 24 };

  const without = optimize(makeState({ stores: [aldi, kroger, sams], prices }));
  assert.ok(without.best.stores.every((s) => s.store.id !== 'sams'));
  assert.equal(without.excluded[0].id, 'sams');

  const member = { ...sams, isMember: true };
  const withIt = optimize(makeState({ stores: [aldi, kroger, member], prices }));
  assert.equal(withIt.best.stores[0].store.id, 'sams');
});

test('trip fees count, unless a membership waives them', () => {
  const walmart = { id: 'w', fee: 9.95, feeWaivedForMembers: true };
  assert.equal(storeFee(walmart), 9.95);
  assert.equal(storeFee({ ...walmart, isMember: true }), 0);

  const pricey = { ...kroger, fee: 10 };
  const { best } = optimize(makeState({ stores: [aldi, pricey] }));
  assert.equal(best.stores.length, 1); // the $1 saving is not worth a $10 fee
});

test('covering more of the list beats a lower total', () => {
  const state = makeState();
  delete state.prices.bread.kroger;
  state.prices.milk.kroger.price = 0.01;
  state.prices.eggs.kroger = { price: 0.01, size: 24 };
  state.settings.maxStores = 1;
  const { best } = optimize(state);
  assert.equal(best.stores[0].store.id, 'aldi');
  assert.equal(best.missing.length, 0);
});
