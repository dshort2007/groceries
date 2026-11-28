// Checks that the price math is right. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCost, bestLine, parseSize, sizeIn, perUnit, optimize, storeFee } from '../js/optimizer.js';

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

test('the store brand wins when it is cheaper, unless the name brand is required', () => {
  const ketchup = { id: 'k', qty: 1, unit: 'each' };
  const entry = { price: 3.49, generic: { price: 1.99 } };
  assert.deepEqual(bestLine(ketchup, entry), { ...lineCost(ketchup, { price: 1.99 }), storeBrand: true });
  assert.equal(bestLine({ ...ketchup, brand: 'name' }, entry).cost, 3.49);
  assert.equal(bestLine({ ...ketchup, brand: 'name' }, { generic: { price: 1.99 } }), null);
  assert.equal(bestLine(ketchup, { generic: { price: 1.99 } }).storeBrand, true);
  assert.equal(bestLine(ketchup, { price: 1.5, generic: { price: 1.99 } }).storeBrand, false);

  // It changes which store the plan picks.
  const state = {
    items: [ketchup],
    stores: [{ id: 'a' }, { id: 'b' }],
    prices: { k: { a: { price: 3.49, generic: { price: 1.99 } }, b: { price: 2.5 } } },
    settings: { maxStores: 1 },
  };
  assert.equal(optimize(state).best.stores[0].store.id, 'a');
  state.items = [{ ...ketchup, brand: 'name' }];
  assert.equal(optimize(state).best.stores[0].store.id, 'b');
});

test('reads package sizes and converts them to the unit on the list', () => {
  assert.deepEqual(parseSize('12 ct'), { amount: 12, unit: 'ct' });
  assert.deepEqual(parseSize('1/2 gal'), { amount: 0.5, unit: 'gal' });
  assert.deepEqual(parseSize('16.9 fl oz'), { amount: 16.9, unit: 'fl oz' });
  assert.deepEqual(parseSize('2 lbs'), { amount: 2, unit: 'lb' });
  assert.equal(parseSize('each'), null);
  assert.equal(sizeIn('oz', parseSize('1 lb')), 16);
  assert.equal(sizeIn('fl oz', parseSize('1/2 gal')), 64);
  assert.equal(sizeIn('gal', parseSize('64 fl oz')), 0.5);
  assert.equal(sizeIn('ct', parseSize('18 ct')), 18);
  assert.equal(sizeIn('oz', parseSize('12 ct')), null); // count can't become weight
  assert.equal(sizeIn('oz', parseSize('500 g')), 17.64);
});

test('compares products of different sizes by price per unit', () => {
  assert.deepEqual(perUnit(1.99, '12 ct'), { price: 1.99 / 12, unit: 'ct' });
  assert.equal(perUnit(3.2, '1 lb').unit, 'oz');
  assert.equal(perUnit(3.2, '1 lb').price, 0.2);
  assert.equal(perUnit(2.56, '1/2 gal').price, 0.04); // per fl oz
  assert.equal(perUnit(2, 'each'), null);
  assert.equal(perUnit(0, '12 ct'), null);
});
