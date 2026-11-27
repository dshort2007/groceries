// The "brain" of the app: given a grocery list, stores and prices, work out
// the cheapest way to buy everything. This file has no screen code in it, so
// it can be tested on its own (see tests/optimizer.test.js).

const round2 = (n) => Math.round(n * 100) / 100;

// A store can be used if it's switched on and, when it needs a membership
// (like Sam's Club), the shopper has one.
export function storeIsEligible(store) {
  if (store.enabled === false) return false;
  return !store.requiresMembership || !!store.isMember;
}

// The per-trip fee (delivery, pickup...) the shopper actually pays here.
export function storeFee(store) {
  const fee = Number(store.fee) || 0;
  if (fee <= 0) return 0;
  if (store.feeWaivedForMembers && store.isMember) return 0;
  return fee;
}

// What one list item costs at one store.
//   item:  { qty, unit }            e.g. 24 "ct" of eggs, or 2 "each"
//   entry: { price, size, coupon }  e.g. $2.50 for a 12 ct package
// Returns null when there isn't enough info to price it.
export function lineCost(item, entry) {
  if (!entry || !(Number(entry.price) > 0)) return null;
  const price = Number(entry.price);
  const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;

  let size = 1;
  if (item.unit !== 'each') {
    size = Number(entry.size);
    if (!(size > 0)) return null; // need the package size to compare fairly
  }

  // You can't buy part of a package, so round up.
  const packages = Math.ceil(qty / size - 1e-9);
  const coupon = Number(entry.coupon) > 0 ? Number(entry.coupon) : 0;
  const cost = round2(Math.max(0, packages * price - coupon));
  return { packages, price, coupon, cost, unitPrice: price / size };
}

// Price the whole list using only the given stores: each item goes to
// whichever of those stores is cheapest for it.
function buildPlan(stores, items, prices, extraStopCost) {
  const byStore = new Map(stores.map((s) => [s.id, { store: s, lines: [] }]));
  const missing = [];

  for (const item of items) {
    let best = null;
    for (const store of stores) {
      const line = lineCost(item, prices[item.id]?.[store.id]);
      if (line && (!best || line.cost < best.line.cost)) best = { store, line };
    }
    if (best) byStore.get(best.store.id).lines.push({ item, ...best.line });
    else missing.push(item);
  }

  const used = [...byStore.values()].filter((s) => s.lines.length > 0);
  for (const s of used) {
    s.subtotal = round2(s.lines.reduce((sum, l) => sum + l.cost, 0));
    s.fee = storeFee(s.store);
  }

  const itemsTotal = round2(used.reduce((sum, s) => sum + s.subtotal, 0));
  const fees = round2(used.reduce((sum, s) => sum + s.fee, 0));
  const total = round2(itemsTotal + fees);
  // "score" is what plans are ranked by: real money plus the hassle value
  // the shopper put on each extra stop. It is never shown as a price.
  const score = total + extraStopCost * Math.max(0, used.length - 1);

  return { stores: used, missing, itemsTotal, fees, total, score };
}

// Better plan = covers more of the list, then cheaper, then fewer stops.
function comparePlans(a, b) {
  return (
    a.missing.length - b.missing.length ||
    a.score - b.score ||
    a.stores.length - b.stores.length
  );
}

// Try every combination of stores (there are only a handful, so this is
// instant) and report the best options.
export function optimize(state) {
  const items = state.items || [];
  const prices = state.prices || {};
  const allStores = state.stores || [];
  const eligible = allStores.filter(storeIsEligible);
  const excluded = allStores.filter(
    (s) => s.enabled !== false && !storeIsEligible(s)
  );
  const maxStores = Math.max(1, Number(state.settings?.maxStores) || 1);
  const extraStopCost = Math.max(0, Number(state.settings?.extraStopCost) || 0);

  const singles = [];
  const byCount = {}; // best plan that uses exactly N stores
  let best = null;

  if (items.length > 0) {
    const n = eligible.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      const subset = eligible.filter((_, i) => mask & (1 << i));
      if (subset.length > maxStores) continue;
      const plan = buildPlan(subset, items, prices, extraStopCost);
      // If a store in the combination ended up with nothing, this is the
      // same as a smaller combination we check anyway.
      if (plan.stores.length !== subset.length) continue;

      if (subset.length === 1) singles.push(plan);
      const count = subset.length;
      if (!byCount[count] || comparePlans(plan, byCount[count]) < 0) {
        byCount[count] = plan;
      }
      if (!best || comparePlans(plan, best) < 0) best = plan;
    }
  }

  singles.sort(comparePlans);
  return { best, bestSingle: singles[0] || null, singles, byCount, excluded };
}
