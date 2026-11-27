// The copy of the data kept in this browser. It makes the app open instantly
// and keeps your changes if the connection drops. The shared online copy is
// handled in cloud.js.

const KEY = 'groceries-v1';

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  return {
    items: [],
    stores: [
      { id: newId(), name: 'Kroger', membershipName: 'Boost', fee: 0 },
      { id: newId(), name: 'Aldi', membershipName: '', fee: 0 },
      { id: newId(), name: 'Walmart', membershipName: 'Walmart+', fee: 0 },
      {
        id: newId(),
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

export function loadState() {
  try {
    const state = normalizeState(JSON.parse(localStorage.getItem(KEY)));
    if (state) return state;
  } catch {
    // Nothing saved yet, or storage is unavailable: start fresh.
  }
  return defaultState();
}

export function clearState() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
