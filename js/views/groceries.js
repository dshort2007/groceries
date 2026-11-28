// The grocery price planner: the shared list, prices at each store, the
// best plan, a shopping checklist and the stores themselves.
//
// Every item and every store is saved as its own record, so two people can
// add to the list or tick things off at the same time without overwriting
// each other.

import { optimize, bestLine, lineCost, storeIsEligible, parseSize, sizeIn } from '../optimizer.js';
import { defaultState, normalizeState, newId, stableId } from '../storage.js';
import { h, money, num, rerender } from '../ui.js';
import { today } from '../money.js';
import * as db from '../db.js';

// Where the whole planner used to be saved as one lump. Still read once,
// to move an existing list over.
export const GROCERY_ID = '00000000-0000-4000-8000-000000000001';
const SETTINGS_ID = '00000000-0000-4000-8000-000000000005';

const UNITS = [
  ['each', 'each'],
  ['ct', 'count'],
  ['oz', 'oz'],
  ['lb', 'lb'],
  ['fl oz', 'fl oz'],
  ['gal', 'gal'],
];

let state = null;
let view = 'list';
const openItems = new Set(); // which items are expanded, kept across redraws
const showOwnBrand = new Set(); // "item|store" rows showing a store-brand line
let lookup = null; // a Kroger search in progress: { itemId, storeId, term, ... }
let notice = ''; // result of the last "update Kroger prices"

// ---------- Loading and saving ----------

let snapshot = new Map(); // what each record looked like when loaded

function moveOldList() {
  const old = normalizeState(db.get(GROCERY_ID));
  const source = old || defaultState();
  // Ids are worked out from the old ones, so if two devices do this at the
  // same moment they produce the same records instead of two copies.
  const id = (x) => (old ? stableId('grocery:' + x) : x);
  source.stores.forEach((s, i) => db.put('gstore', { ...s, id: id(s.id), sort: i }));
  source.items.forEach((item, i) => {
    const prices = {};
    for (const [storeId, entry] of Object.entries(source.prices[item.id] || {})) prices[id(storeId)] = entry;
    db.put('gitem', { ...item, id: id(item.id), sort: i, prices });
  });
  db.put('gsettings', { id: SETTINGS_ID, ...source.settings });
  if (old) db.remove(GROCERY_ID);
}

function load() {
  if (db.all('gitem').length === 0 && db.all('gstore').length === 0) moveOldList();
  const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0);
  const items = db.all('gitem').sort(bySort);
  const { id: _, ...settings } = db.get(SETTINGS_ID) || {};
  state = {
    items: items.map(({ prices, ...item }) => item),
    stores: db.all('gstore').sort(bySort),
    prices: Object.fromEntries(items.map((i) => [i.id, structuredClone(i.prices || {})])),
    settings: { maxStores: 3, extraStopCost: 0, ...settings },
  };
  snapshot = new Map();
  for (const item of state.items) snapshot.set(item.id, JSON.stringify(itemRecord(item)));
  for (const store of state.stores) snapshot.set(store.id, JSON.stringify(store));
  snapshot.set(SETTINGS_ID, JSON.stringify({ id: SETTINGS_ID, ...state.settings }));
}

// An item is saved together with its prices at every store.
const itemRecord = (item) => ({ ...item, prices: state.prices[item.id] || {} });

// Saves only what actually changed since it was loaded.
function save() {
  const kept = new Set();
  const write = (kind, record) => {
    kept.add(record.id);
    const json = JSON.stringify(record);
    if (snapshot.get(record.id) === json) return;
    db.put(kind, record);
    snapshot.set(record.id, json);
  };
  for (const item of state.items) write('gitem', itemRecord(item));
  for (const store of state.stores) write('gstore', store);
  write('gsettings', { id: SETTINGS_ID, ...state.settings });
  for (const id of [...snapshot.keys()]) {
    if (!kept.has(id)) {
      db.remove(id);
      snapshot.delete(id);
    }
  }
}

export function renderGroceries() {
  load();
  const tabs = [['list', 'List', renderList], ['shop', 'Shop', renderShop], ['plan', 'Best plan', renderPlan], ['stores', 'Stores', renderStores]];
  return [
    h(
      'div',
      { class: 'subtabs' },
      tabs.map(([id, label]) =>
        h('button', { class: id === view ? 'on' : null, onclick: () => { view = id; rerender(); } }, label)
      )
    ),
    ...tabs.find(([id]) => id === view)[2](),
  ];
}

// ---------- Kroger price lookup ----------

const krogerCall = (action, body) => db.callFunction('kroger', { action, ...body });
const krogerStores = () => state.stores.filter((s) => s.enabled !== false && s.kroger?.locationId);

// Remember a price so the item can show how it has moved over time.
function logPrice(entry, kind, price) {
  if (!(price > 0)) return;
  const history = (entry.history ??= []);
  const last = history.filter((p) => p.k === kind).at(-1);
  if (last && last.p === price) return;
  if (last && last.d === today()) last.p = price; // corrected the same day
  else history.push({ d: today(), p: price, k: kind });
  if (history.length > 40) history.splice(0, history.length - 40);
}

// Put a Kroger product's price onto an item.
function applyProduct(item, store, product) {
  const entry = ((state.prices[item.id] ??= {})[store.id] ??= {});
  const ownBrand = product.storeBrand && item.brand !== 'name';
  const target = ownBrand ? (entry.generic ??= {}) : entry;
  target.price = product.price;
  target.productId = product.productId;
  target.label = product.name;
  if (item.unit !== 'each') {
    const size = sizeIn(item.unit, parseSize(product.size));
    if (size) target.size = size;
  }
  entry.updated = today();
  logPrice(entry, ownBrand ? 'g' : 'n', product.price);
  if (ownBrand) showOwnBrand.add(`${item.id}|${store.id}`);
}

async function runLookup() {
  const store = state.stores.find((s) => s.id === lookup.storeId);
  lookup = { ...lookup, busy: true, error: '', products: null };
  rerender();
  try {
    const reply = await krogerCall('search', { term: lookup.term, locationId: store.kroger.locationId });
    if (!Array.isArray(reply?.products)) throw new Error('The "kroger" function gave an unexpected reply. It may still contain sample code.');
    lookup = { ...lookup, busy: false, products: reply.products };
  } catch (err) {
    lookup = { ...lookup, busy: false, error: err.message };
  }
  rerender();
}

// Every price on the list that came from a Kroger product at this store.
function krogerLinked(store) {
  const linked = [];
  for (const item of state.items) {
    const entry = state.prices[item.id]?.[store.id];
    for (const [kind, target] of [['n', entry], ['g', entry?.generic]]) {
      if (target?.productId) linked.push({ entry, kind, target });
    }
  }
  return linked;
}

// Fetch today's price for every item that was picked from Kroger before.
async function refreshKroger() {
  notice = 'Checking Kroger…';
  rerender();
  let checked = 0;
  let changed = 0;
  try {
    for (const { id, kroger } of krogerStores()) {
      const ids = krogerLinked(state.stores.find((s) => s.id === id)).map((l) => l.target.productId);
      if (ids.length === 0) continue;
      const reply = await krogerCall('prices', { locationId: kroger.locationId, productIds: ids });
      // The screen may have been redrawn (and the list reloaded) while
      // waiting, so look the prices up afresh before changing them, and
      // save straight away.
      const byId = new Map((reply?.products || []).map((p) => [p.productId, p]));
      const store = state.stores.find((s) => s.id === id);
      for (const { entry, kind, target } of store ? krogerLinked(store) : []) {
        const product = byId.get(target.productId);
        if (!product || !(product.price > 0)) continue;
        checked++;
        if (target.price !== product.price) changed++;
        target.price = product.price;
        entry.updated = today();
        logPrice(entry, kind, product.price);
      }
      save();
    }
    notice = checked ? `Checked ${checked} Kroger price${checked === 1 ? '' : 's'}: ${changed} changed.` : 'No items are linked to a Kroger product yet. Use "Look up price" on an item first.';
  } catch (err) {
    notice = err.message;
  }
  rerender();
}

function renderLookup(item, store) {
  const term = h('input', { type: 'text', value: lookup.term, 'aria-label': 'Search Kroger for' });
  return h(
    'div',
    { class: 'lookup' },
    h(
      'form',
      { class: 'add-form simple', onsubmit: (e) => { e.preventDefault(); lookup.term = term.value.trim(); runLookup(); } },
      term,
      h('button', { type: 'submit' }, 'Search')
    ),
    lookup.busy && h('p', { class: 'muted small' }, 'Searching Kroger…'),
    lookup.error && h('p', { class: 'warn small' }, lookup.error),
    lookup.products?.length === 0 && h('p', { class: 'muted small' }, 'Nothing found with a price at this store. Try different words.'),
    (lookup.products || []).map((p) =>
      h(
        'button',
        { class: 'product', onclick: () => { applyProduct(item, store, p); lookup = null; save(); rerender(); } },
        h('span', {}, p.name, h('span', { class: 'muted small' }, ` · ${p.size || 'no size'}`), p.storeBrand && h('span', { class: 'badge' }, 'Store brand')),
        h('strong', {}, money(p.price), p.onSale && h('span', { class: 'muted small' }, ` was ${money(p.regular)}`))
      )
    ),
    h('button', { class: 'link', onclick: () => { lookup = null; rerender(); } }, 'Cancel')
  );
}

// ---------- Prices from a receipt ----------

let receipt = null; // { storeId, busy, error, lines: [{ name, price, choice, ... }] }

// Shrink a phone photo before sending it: receipts stay readable at this
// size and it's far quicker to upload.
async function photoToJpeg(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
}

async function readReceipt(storeId, input) {
  receipt = { storeId, busy: true };
  rerender();
  try {
    const reply = await db.callFunction('receipt', { action: 'read', ...input, items: state.items.map((i) => ({ id: i.id, name: i.name })) });
    if (!Array.isArray(reply?.lines)) throw new Error('The "receipt" function gave an unexpected reply. It may still contain sample code.');
    // Each line starts out pointing at the list item it was matched to, or
    // "skip" when there was no match, so nothing lands on the list by surprise.
    receipt = { storeId, store: reply.store, date: reply.date, lines: reply.lines.map((l) => ({ ...l, choice: l.itemId || 'skip' })) };
  } catch (err) {
    receipt = { storeId, error: err.message };
  }
  rerender();
}

function saveReceipt() {
  const store = state.stores.find((s) => s.id === receipt.storeId);
  if (!store) return;
  let saved = 0;
  for (const line of receipt.lines) {
    if (line.choice === 'skip' || !(Number(line.price) > 0)) continue;
    let item = state.items.find((i) => i.id === line.choice);
    if (line.choice === 'new') {
      item = { id: newId(), name: line.name, qty: 1, unit: 'each', sort: Date.now() + saved };
      state.items.push(item);
    }
    if (!item) continue;
    const entry = ((state.prices[item.id] ??= {})[store.id] ??= {});
    entry.price = Number(line.price);
    delete entry.productId;
    entry.updated = today();
    logPrice(entry, 'n', entry.price);
    saved++;
  }
  save();
  notice = `Saved ${saved} price${saved === 1 ? '' : 's'} at ${store.name} from the receipt.`;
  receipt = null;
  rerender();
}

function renderReceipt() {
  if (!db.ready) return null; // needs the server
  const stores = state.stores.filter((s) => s.enabled !== false);
  if (receipt?.lines) {
    const store = stores.find((s) => s.id === receipt.storeId);
    const picked = receipt.lines.filter((l) => l.choice !== 'skip').length;
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, `Receipt from ${store?.name || 'store'}`),
      h('p', { class: 'muted small' }, `${receipt.store ? `It says "${receipt.store}"${receipt.date ? `, ${receipt.date}` : ''}. ` : ''}Check each line: which list item it is, and the price for one. Anything left on "Skip" is ignored.`),
      receipt.lines.length === 0 && h('p', { class: 'muted' }, 'No product lines were found on it.'),
      receipt.lines.map((line) =>
        h(
          'div',
          { class: 'tx' },
          h('div', { class: 'tx-line' }, h('span', {}, line.name, h('span', { class: 'muted small' }, ` ${line.receiptText}${line.quantity > 1 ? ` · ${line.quantity} bought` : ''}`))),
          h(
            'div',
            { class: 'split' },
            h(
              'select',
              { 'aria-label': `What ${line.name} is on the list`, class: line.choice === 'skip' ? 'unfiled' : null, onchange: (e) => { line.choice = e.target.value; rerender(); } },
              h('option', { value: 'skip', selected: line.choice === 'skip' }, 'Skip'),
              state.items.map((i) => h('option', { value: i.id, selected: line.choice === i.id }, i.name)),
              h('option', { value: 'new', selected: line.choice === 'new' }, 'Add to the list as new')
            ),
            h('input', { type: 'number', step: 'any', min: '0', inputMode: 'decimal', value: line.price, 'aria-label': 'Price for one', oninput: (e) => (line.price = num(e.target.value) ?? 0) }),
            h('span', {})
          )
        )
      ),
      h(
        'div',
        { class: 'button-row' },
        h('button', { class: 'primary', disabled: picked === 0, onclick: saveReceipt }, `Save ${picked} price${picked === 1 ? '' : 's'}`),
        h('button', { onclick: () => { receipt = null; rerender(); } }, 'Cancel')
      ),
      h('p', { class: 'muted small' }, 'Prices go in as the name-brand price, per package. For items measured by size (oz, count), check the package size on the item afterwards.')
    );
  }

  let storeId = receipt?.storeId || stores[0]?.id || '';
  const text = h('textarea', { rows: 3, placeholder: 'Or paste the text of an emailed receipt here' });
  return h(
    'details',
    { class: 'card', open: !!receipt || undefined },
    h('summary', {}, 'Add prices from a receipt'),
    h('p', { class: 'muted small' }, 'Take a photo of a receipt (or paste one from an email) and the app reads the prices off it. You check them before anything is saved.'),
    h('label', { class: 'field' }, h('span', {}, 'Which store is it from?'), h('select', { onchange: (e) => (storeId = e.target.value) }, stores.map((s) => h('option', { value: s.id, selected: s.id === storeId }, s.name)))),
    h('label', { class: 'field' }, h('span', {}, 'Photo of the receipt'), h('input', {
      type: 'file',
      accept: 'image/*',
      disabled: receipt?.busy,
      onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          await readReceipt(storeId, { image: await photoToJpeg(file) });
        } catch (err) {
          receipt = { storeId, error: "That photo couldn't be opened. Try another, or paste the text." };
          rerender();
        }
      },
    })),
    text,
    h('button', { disabled: receipt?.busy, onclick: () => text.value.trim() && readReceipt(storeId, { text: text.value.trim() }) }, 'Read the pasted text'),
    receipt?.busy && h('p', {}, 'Reading the receipt… this can take up to half a minute.'),
    receipt?.error && h('p', { class: 'warn small' }, receipt.error)
  );
}

// ---------- List ----------

function describeNeed(item) {
  return item.unit === 'each' ? `× ${item.qty}` : `${item.qty} ${item.unit}`;
}

// What the item would cost at each store that can be shopped at.
function linesFor(item) {
  return state.stores
    .filter(storeIsEligible)
    .map((store) => ({ store, line: bestLine(item, state.prices[item.id]?.[store.id]) }))
    .filter((x) => x.line);
}

function bestPriceText(item) {
  const best = linesFor(item).sort((a, b) => a.line.cost - b.line.cost)[0];
  return best ? `Best: ${best.store.name} ${money(best.line.cost)}` : 'No prices yet';
}

const shortDay = (date) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// "Was $2.79 on Nov 3. Lowest $2.49." once a price has changed at least once.
function historyNote(entry, kind) {
  const past = (entry?.history || []).filter((p) => p.k === kind);
  if (past.length < 2) return null;
  const current = past.at(-1);
  const before = past.at(-2);
  const lowest = Math.min(...past.map((p) => p.p));
  return h(
    'div',
    { class: 'muted small' },
    `Was ${money(before.p)} on ${shortDay(before.d)}. `,
    current.p <= lowest ? h('span', { class: 'badge good' }, 'Lowest yet') : `Lowest ${money(lowest)}.`
  );
}

function renderStoreRow(item, store, bestUnit) {
  const entry = state.prices[item.id]?.[store.id];
  const key = `${item.id}|${store.id}`;
  const sized = item.unit !== 'each';
  const ownBrandAllowed = item.brand !== 'name';
  const ownBrandOpen = ownBrandAllowed && (showOwnBrand.has(key) || entry?.generic?.price > 0);

  const set = (kind, field, value) => {
    const e = ((state.prices[item.id] ??= {})[store.id] ??= {});
    const target = kind === 'g' ? (e.generic ??= {}) : e;
    target[field] = num(value);
    e.updated = today();
    if (field === 'price') {
      delete target.productId; // typed by hand: no longer tied to a Kroger product
      logPrice(e, kind, target.price);
    }
    save();
    rerender();
  };
  const box = (label, kind, name, placeholder) =>
    h(
      'label',
      { class: 'field' },
      h('span', {}, label),
      h('input', {
        type: 'number',
        min: '0',
        step: 'any',
        inputMode: 'decimal',
        placeholder,
        value: (kind === 'g' ? entry?.generic : entry)?.[name] ?? '',
        data: { key: `${key}|${kind}|${name}` },
        onchange: (e) => set(kind, name, e.target.value),
      })
    );
  const fields = (kind) =>
    h('div', { class: 'fields' }, box('Price $', kind, 'price', '0.00'), sized && box(`Size (${item.unit})`, kind, 'size', '0'), box('Coupon $', kind, 'coupon', '0.00'));

  // What you'd pay here, and whether it's the best value by size.
  let hint = '';
  const line = bestLine(item, entry);
  const anyPrice = entry?.price > 0 || entry?.generic?.price > 0;
  if (line) {
    hint = `${money(line.cost)} for ${line.packages} pkg`;
    if (line.storeBrand && entry?.price > 0) hint += ' (store brand)';
    if (sized) hint += ` · ${money(line.unitPrice)}/${item.unit}`;
    if (!storeIsEligible(store)) hint += ' · needs membership';
  } else if (anyPrice) hint = sized ? 'Add the package size' : '';

  const looking = lookup && lookup.itemId === item.id && lookup.storeId === store.id;
  return h(
    'div',
    { class: 'price-row' },
    h(
      'div',
      { class: 'tx-line' },
      h('span', { class: 'store-name' }, store.name),
      store.kroger?.locationId && !looking &&
        h('button', { class: 'link', onclick: () => { lookup = { itemId: item.id, storeId: store.id, term: item.name }; runLookup(); } }, 'Look up price')
    ),
    looking && renderLookup(item, store),
    ownBrandOpen && h('div', { class: 'muted small brand-label' }, 'Name brand'),
    fields('n'),
    entry?.label && h('div', { class: 'muted small' }, entry.label),
    historyNote(entry, 'n'),
    ownBrandOpen && h('div', { class: 'muted small brand-label' }, "Store's own brand"),
    ownBrandOpen && fields('g'),
    ownBrandOpen && entry?.generic?.label && h('div', { class: 'muted small' }, entry.generic.label),
    ownBrandOpen && historyNote(entry, 'g'),
    ownBrandAllowed && !ownBrandOpen &&
      h('button', { class: 'link', onclick: () => { showOwnBrand.add(key); rerender(); } }, "+ Store's own brand price"),
    h(
      'div',
      { class: 'hint' },
      hint,
      line && sized && bestUnit === store.id && h('span', { class: 'badge good' }, `Best per ${item.unit}`)
    )
  );
}

function renderItem(item) {
  // The store with the lowest price per unit: the best value regardless of
  // how many packages this trip needs.
  const priced = linesFor(item);
  const bestUnit = priced.length > 1 ? priced.sort((a, b) => a.line.unitPrice - b.line.unitPrice)[0].store.id : null;
  const update = (changes) => { Object.assign(item, changes); save(); rerender(); };

  return h(
    'details',
    {
      class: 'card item',
      open: openItems.has(item.id),
      ontoggle: (e) => (e.target.open ? openItems.add(item.id) : openItems.delete(item.id)),
    },
    h(
      'summary',
      {},
      h('span', { class: 'item-name' + (item.got ? ' got' : '') }, item.name),
      h('span', { class: 'muted' }, describeNeed(item)),
      h('span', { class: 'muted' }, bestPriceText(item))
    ),
    state.stores.filter((s) => s.enabled !== false).map((store) => renderStoreRow(item, store, bestUnit)),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'label',
        { class: 'field inline' },
        h('span', {}, item.unit === 'each' ? 'How many' : `How much (${item.unit})`),
        h('input', {
          type: 'number',
          min: '0',
          step: 'any',
          inputMode: 'decimal',
          value: item.qty,
          data: { key: `qty-${item.id}` },
          onchange: (e) => update({ qty: num(e.target.value) > 0 ? num(e.target.value) : 1 }),
        })
      ),
      h(
        'select',
        { 'aria-label': 'Brand', class: 'brand-pick', onchange: (e) => update({ brand: e.target.value }) },
        h('option', { value: 'any', selected: item.brand !== 'name' }, 'Any brand is fine'),
        h('option', { value: 'name', selected: item.brand === 'name' }, 'Name brand only')
      ),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            state.items = state.items.filter((i) => i.id !== item.id);
            delete state.prices[item.id];
            openItems.delete(item.id);
            save();
            rerender();
          },
        },
        'Remove'
      )
    )
  );
}

function renderList() {
  const name = h('input', { type: 'text', placeholder: 'Add an item, e.g. Eggs', required: true });
  const qty = h('input', { type: 'number', min: '0', step: 'any', value: 1, inputMode: 'decimal', 'aria-label': 'Amount needed' });
  const unit = h(
    'select',
    { 'aria-label': 'Unit' },
    UNITS.map(([value, label]) => h('option', { value }, label))
  );

  const form = h(
    'form',
    {
      class: 'card add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = name.value.trim();
        if (!text) return;
        const item = { id: newId(), name: text, qty: num(qty.value) > 0 ? num(qty.value) : 1, unit: unit.value, sort: Date.now() };
        state.items.push(item);
        openItems.add(item.id);
        save();
        rerender();
        setTimeout(() => document.querySelector('.add-form input')?.focus(), 30);
      },
    },
    name,
    qty,
    unit,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );

  const help = h(
    'p',
    { class: 'muted small' },
    'Use "each" for things you buy by the package. For things that come in different sizes at different stores, pick a unit and say how much you need (24 count eggs, 32 oz cheese). The app works out how many packages that takes at each store.'
  );
  const kroger = krogerStores().length > 0;

  const tools = h('div', { class: 'budget-tools' }, kroger ? h('button', { class: 'link', onclick: refreshKroger }, 'Update Kroger prices') : h('span', {}), notice && h('span', { class: 'muted small' }, notice));
  if (state.items.length === 0) {
    return [form, help, renderReceipt(), notice && tools, h('p', { class: 'empty' }, 'Your list is empty. Add your first item above.')];
  }
  return [form, help, renderReceipt(), (kroger || notice) && tools, ...state.items.map(renderItem)];
}

// ---------- Shop ----------
//
// The best plan as a checklist to use in the store. Ticks are saved on each
// item, so a second shopper sees them a few seconds later.

function renderShop() {
  if (state.items.length === 0) return [h('p', { class: 'empty' }, 'Add items on the List tab first.')];
  const { best } = optimize(state);
  const tick = (item) => h('input', { type: 'checkbox', checked: !!item.got, 'aria-label': `Got ${item.name}`, onchange: (e) => { item.got = e.target.checked; save(); rerender(); } });
  const row = (item, detail, cost) =>
    h(
      'label',
      { class: 'shop-row' + (item.got ? ' got' : '') },
      tick(item),
      h('span', {}, h('span', { class: 'shop-name' }, item.name), h('span', { class: 'muted small' }, ` ${detail}`)),
      cost !== null && h('span', {}, money(cost))
    );

  const sections = (best?.stores || []).map((s) =>
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'list-head' }, h('h2', {}, s.store.name), h('span', { class: 'muted' }, `${s.lines.filter((l) => !l.item.got).length} to get · ${money(s.subtotal)}`)),
      s.lines.map((l) => row(l.item, `${l.packages} pkg${l.storeBrand ? ' · store brand' : ''}${l.coupon ? ' · coupon' : ''}`, l.cost))
    )
  );
  const unpriced = best ? best.missing : state.items;
  const done = state.items.filter((i) => i.got);

  return [
    ...sections,
    unpriced.length > 0 &&
      h('div', { class: 'card' }, h('div', { class: 'list-head' }, h('h2', {}, 'No price yet'), h('span', { class: 'muted' }, 'Get these anywhere')), unpriced.map((item) => row(item, describeNeed(item), null))),
    done.length > 0 &&
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              // Prices are kept with the item, so they'd be lost on removal.
              // Unticking keeps the item and its prices for next time.
              if (!confirm(`Take ${done.length} ticked item${done.length === 1 ? '' : 's'} off the list? Their prices will be forgotten. Choose Cancel and use "Untick all" to keep them for next time.`)) return;
              state.items = state.items.filter((i) => !i.got);
              for (const i of done) delete state.prices[i.id];
              save();
              rerender();
            },
          },
          `Remove ${done.length} ticked`
        ),
        h('button', { onclick: () => { for (const i of done) i.got = false; save(); rerender(); } }, 'Untick all')
      ),
  ];
}

// ---------- Best plan ----------

function planName(plan) {
  return plan.stores.map((s) => s.store.name).join(' + ');
}

function renderPlanCard(plan, result) {
  const sections = plan.stores.map((s) =>
    h(
      'section',
      { class: 'plan-store' },
      h('h3', {}, h('span', {}, s.store.name), h('span', {}, money(s.subtotal + s.fee))),
      h(
        'ul',
        {},
        s.lines.map((l) =>
          h(
            'li',
            {},
            h(
              'span',
              {},
              l.item.name,
              h(
                'span',
                { class: 'muted small' },
                ` ${l.packages} × ${money(l.price)}` + (l.coupon ? `, coupon −${money(l.coupon)}` : '') + (l.storeBrand ? ', store brand' : '')
              )
            ),
            h('span', {}, money(l.cost))
          )
        ),
        s.fee > 0 && h('li', {}, h('span', {}, 'Trip fee'), h('span', {}, money(s.fee)))
      )
    )
  );

  const single = result.bestSingle;
  let savings = null;
  if (plan.stores.length > 1 && single && single.missing.length === plan.missing.length) {
    const saved = single.total - plan.total;
    if (saved > 0.004) {
      savings = h('p', { class: 'savings' }, `Saves ${money(saved)} compared with buying everything at ${planName(single)}.`);
    }
  }

  return h(
    'div',
    { class: 'card best' },
    h('div', { class: 'muted small' }, 'Best plan'),
    h('h2', {}, h('span', {}, planName(plan)), h('span', {}, money(plan.total))),
    savings,
    sections,
    plan.missing.length > 0 &&
      h('p', { class: 'warn' }, `Not included, no usable price yet: ${plan.missing.map((i) => i.name).join(', ')}.`)
  );
}

function renderPlan() {
  const eligibleCount = state.stores.filter(storeIsEligible).length;
  const settings = h(
    'div',
    { class: 'card settings' },
    h(
      'label',
      { class: 'field inline' },
      h('span', {}, 'Most stores I’ll visit'),
      h(
        'select',
        {
          onchange: (e) => {
            state.settings.maxStores = Number(e.target.value);
            save();
            rerender();
          },
        },
        Array.from({ length: Math.max(1, eligibleCount) }, (_, i) =>
          h('option', { value: i + 1, selected: i + 1 === Math.min(state.settings.maxStores, Math.max(1, eligibleCount)) }, String(i + 1))
        )
      )
    ),
    h(
      'label',
      { class: 'field inline' },
      h('span', {}, 'An extra stop must save at least $'),
      h('input', {
        type: 'number',
        min: '0',
        step: 'any',
        inputMode: 'decimal',
        value: state.settings.extraStopCost,
        onchange: (e) => {
          state.settings.extraStopCost = num(e.target.value) ?? 0;
          save();
          rerender();
        },
      })
    )
  );

  if (state.items.length === 0) {
    return [settings, h('p', { class: 'empty' }, 'Add items to your list first.')];
  }

  const result = optimize(state);
  const priced = result.best && result.best.stores.length > 0;
  if (!priced) {
    return [settings, h('p', { class: 'empty' }, 'Enter some prices on the List tab and the best plan will show up here.')];
  }

  const total = state.items.length;
  const options = [
    ...result.singles,
    ...Object.entries(result.byCount)
      .filter(([count]) => Number(count) > 1)
      .map(([, plan]) => plan),
  ];
  const compare = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'All options'),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Where'), h('th', {}, 'Items'), h('th', { class: 'right' }, 'Total'))),
      h(
        'tbody',
        {},
        options.map((plan) =>
          h(
            'tr',
            { class: plan === result.best ? 'is-best' : null },
            h('td', {}, planName(plan)),
            h('td', {}, `${total - plan.missing.length} of ${total}`),
            h('td', { class: 'right' }, money(plan.total))
          )
        )
      )
    ),
    h('p', { class: 'muted small' }, 'A total only covers the items that option has prices for, so check the Items column before comparing.')
  );

  const excluded =
    result.excluded.length > 0 &&
    h(
      'p',
      { class: 'muted small' },
      `Left out because they need a membership you haven't marked on the Stores tab: ${result.excluded.map((s) => s.name).join(', ')}.`
    );

  return [settings, renderPlanCard(result.best, result), compare, excluded];
}

// ---------- Stores ----------

// Linking a store to a Kroger location lets items look their prices up.
let finding = null; // { storeId, busy, error, locations }

// Kroger and the chains it owns, which all share its price lookup.
const KROGER_FAMILY = /kroger|ralphs|fred meyer|harris teeter|king soopers|fry'?s|smith'?s|qfc|dillons|city market|food 4 less|foods co|mariano'?s|pick '?n save|metro market|pay.?less|baker'?s|gerbes|jay ?c|owen'?s|ruler/i;

function renderKrogerLink(store) {
  if (!db.ready) return null; // needs the server
  // Only offered on stores it can work for (or one already linked).
  if (!store.kroger?.locationId && !KROGER_FAMILY.test(store.name || '')) return null;
  if (store.kroger?.locationId) {
    return h(
      'div',
      { class: 'tx-line' },
      h('span', { class: 'small' }, 'Prices looked up at ', h('strong', {}, store.kroger.name), h('span', { class: 'muted' }, store.kroger.address ? `, ${store.kroger.address}` : '')),
      h('button', { class: 'link', onclick: () => { delete store.kroger; save(); rerender(); } }, 'Unlink')
    );
  }
  const mine = finding?.storeId === store.id ? finding : null;
  const zip = h('input', { type: 'text', inputMode: 'numeric', placeholder: 'Zip code', maxLength: 5 });
  return h(
    'details',
    { class: 'kroger-link', open: !!mine || undefined },
    h('summary', {}, 'Look up prices from Kroger'),
    h('p', { class: 'muted small' }, 'For Kroger and the stores it owns (Ralphs, Fred Meyer, Harris Teeter and others). Find your store and items here can fetch their price from it.'),
    h(
      'form',
      {
        class: 'add-form simple',
        onsubmit: async (e) => {
          e.preventDefault();
          finding = { storeId: store.id, busy: true };
          rerender();
          try {
            const reply = await db.callFunction('kroger', { action: 'locations', zip: zip.value.trim() });
            if (!Array.isArray(reply?.locations)) throw new Error('The "kroger" function gave an unexpected reply. It may still contain sample code.');
            finding = { storeId: store.id, locations: reply.locations };
          } catch (err) {
            finding = { storeId: store.id, error: err.message };
          }
          rerender();
        },
      },
      zip,
      h('button', { type: 'submit' }, 'Find stores')
    ),
    mine?.busy && h('p', { class: 'muted small' }, 'Looking…'),
    mine?.error && h('p', { class: 'warn small' }, mine.error),
    mine?.locations?.length === 0 && h('p', { class: 'muted small' }, 'No stores found near that zip code.'),
    (mine?.locations || []).map((l) =>
      h('button', { class: 'product', onclick: () => { store.kroger = l; finding = null; save(); rerender(); } }, h('span', {}, l.name, h('span', { class: 'muted small' }, ` · ${l.address}`)), h('strong', {}, 'Use this'))
    )
  );
}

function renderStore(store) {
  const update = (field, value, redraw) => {
    store[field] = value;
    save();
    if (redraw) rerender();
  };
  const check = (label, field, on = !!store[field]) =>
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: on, onchange: (e) => update(field, e.target.checked, true) }),
      label
    );
  const hasMembership = !!(store.membershipName || '').trim();

  return h(
    'div',
    { class: 'card store' },
    h(
      'div',
      { class: 'fields' },
      h('label', { class: 'field grow' }, h('span', {}, 'Store'), h('input', { type: 'text', value: store.name, onchange: (e) => update('name', e.target.value.trim() || store.name, true) })),
      h('label', { class: 'field grow' }, h('span', {}, 'Membership or subscription'), h('input', { type: 'text', value: store.membershipName || '', placeholder: 'None', onchange: (e) => update('membershipName', e.target.value.trim(), true) }))
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: store.enabled !== false, onchange: (e) => update('enabled', e.target.checked, true) }),
      'I shop here'
    ),
    hasMembership && check(`I have ${store.membershipName}`, 'isMember'),
    hasMembership && check('You need it to shop here', 'requiresMembership'),
    h(
      'label',
      { class: 'field inline' },
      h('span', {}, 'Fee per trip $ (delivery, pickup)'),
      h('input', { type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: store.fee || 0, onchange: (e) => update('fee', num(e.target.value) ?? 0, false) })
    ),
    hasMembership && check(`${store.membershipName} waives that fee`, 'feeWaivedForMembers'),
    renderKrogerLink(store),
    h(
      'div',
      { class: 'row-actions' },
      h('span', {}),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (!confirm(`Remove ${store.name} and all the prices entered for it?`)) return;
            state.stores = state.stores.filter((s) => s.id !== store.id);
            for (const forItem of Object.values(state.prices)) delete forItem[store.id];
            save();
            rerender();
          },
        },
        'Remove store'
      )
    )
  );
}

function renderStores() {
  const name = h('input', { type: 'text', placeholder: 'Add a store, e.g. Costco', required: true });
  const form = h(
    'form',
    {
      class: 'card add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = name.value.trim();
        if (!text) return;
        state.stores.push({ id: newId(), name: text, membershipName: '', fee: 0, sort: Date.now() });
        save();
        rerender();
      },
    },
    name,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );
  return [...state.stores.map(renderStore), form];
}
