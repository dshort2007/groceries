// The starting shape of the grocery planner's data.

export const newId = () => crypto.randomUUID();

// Turns any text into the same id every time. Used when the same starting
// data might be created on two devices at once (the default stores, or
// moving an old list over): both end up with identical ids, not duplicates.
export function stableId(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let hex = '';
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
      b = Math.imul(b + text.charCodeAt(i) + round, 0x85ebca6b) >>> 0;
    }
    hex += a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
  hex = hex.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function defaultState() {
  return {
    items: [],
    stores: [
      { id: stableId('store:Kroger'), name: 'Kroger', membershipName: 'Boost', fee: 0 },
      { id: stableId('store:Aldi'), name: 'Aldi', membershipName: '', fee: 0 },
      { id: stableId('store:Walmart'), name: 'Walmart', membershipName: 'Walmart+', fee: 0 },
      {
        id: stableId("store:Sam's Club"),
        name: "Sam's Club",
        membershipName: "Sam's Club membership",
        requiresMembership: true,
        fee: 0,
      },
    ],
    prices: {}, // prices[itemId][storeId] = { price, size, coupon, updated }
    settings: { maxStores: 3, extraStopCost: 0 },
  };
}

// Fill in anything missing from saved data. Returns null if it isn't ours.
export function normalizeState(saved) {
  if (!saved || !Array.isArray(saved.items) || !Array.isArray(saved.stores)) return null;
  const base = defaultState();
  return {
    ...base,
    ...saved,
    prices: saved.prices || {},
    settings: { ...base.settings, ...saved.settings },
  };
}
