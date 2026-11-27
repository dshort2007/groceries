// Where the app's data lives. Right now that's the browser's own storage on
// this one device. Everything that saves or loads goes through these two
// functions, so moving to an online database later means changing this file
// only.

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

export function loadState() {
  const base = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Array.isArray(saved.items) && Array.isArray(saved.stores)) {
      return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
    }
  } catch {
    // Nothing saved yet, or storage is unavailable: start fresh.
  }
  return base;
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
