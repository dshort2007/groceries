// Everything you see and tap. It reads and changes one "state" object (the
// list, stores, prices and settings), saves it, and redraws the screen.

import { optimize, lineCost, storeIsEligible } from './optimizer.js';
import { loadState, saveState, newId } from './storage.js';

const UNITS = [
  ['each', 'each'],
  ['ct', 'count'],
  ['oz', 'oz'],
  ['lb', 'lb'],
  ['fl oz', 'fl oz'],
  ['gal', 'gal'],
];

const state = loadState();
let view = 'list';
const openItems = new Set(); // which items are expanded, kept across redraws

const main = document.getElementById('main');
const money = (n) => '$' + Number(n).toFixed(2);
const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

// Small helper for building page elements. Text is always inserted as text,
// never as HTML, so nothing a person types can break the page.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

function save() {
  if (!saveState(state)) {
    document.getElementById('save-note').textContent =
      "Couldn't save on this device. Changes will be lost when you close the page.";
  }
}

function render() {
  for (const tab of document.querySelectorAll('nav button')) {
    tab.setAttribute('aria-current', tab.dataset.view === view ? 'page' : 'false');
  }
  const views = { list: renderList, plan: renderPlan, stores: renderStores };
  main.replaceChildren(...views[view]());
}

// ---------- List ----------

function describeNeed(item) {
  return item.unit === 'each' ? `× ${item.qty}` : `${item.qty} ${item.unit}`;
}

function bestPriceText(item) {
  let best = null;
  for (const store of state.stores.filter(storeIsEligible)) {
    const line = lineCost(item, state.prices[item.id]?.[store.id]);
    if (line && (!best || line.cost < best.line.cost)) best = { store, line };
  }
  return best ? `Best: ${best.store.name} ${money(best.line.cost)}` : 'No prices yet';
}

function priceHint(item, store) {
  const entry = state.prices[item.id]?.[store.id];
  if (!entry || !(entry.price > 0)) return '';
  const line = lineCost(item, entry);
  if (!line) return 'Add the package size';
  let text = `${money(line.cost)} for ${line.packages} pkg`;
  if (item.unit !== 'each') text += ` · ${money(line.unitPrice)}/${item.unit}`;
  if (!storeIsEligible(store)) text += ' · needs membership';
  return text;
}

function renderItem(item) {
  const summaryPrice = h('span', { class: 'muted' }, bestPriceText(item));
  const hints = new Map();

  const setPrice = (store, field, value) => {
    const forItem = (state.prices[item.id] ??= {});
    const entry = (forItem[store.id] ??= {});
    entry[field] = num(value);
    entry.updated = new Date().toISOString().slice(0, 10);
    save();
    // Update just this item's text so the cursor stays where it is.
    hints.get(store.id).textContent = priceHint(item, store);
    summaryPrice.textContent = bestPriceText(item);
  };

  const field = (label, store, name, placeholder) =>
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
        value: state.prices[item.id]?.[store.id]?.[name] ?? '',
        onchange: (e) => setPrice(store, name, e.target.value),
      })
    );

  const rows = state.stores
    .filter((s) => s.enabled !== false)
    .map((store) => {
      const hint = h('div', { class: 'hint' }, priceHint(item, store));
      hints.set(store.id, hint);
      return h(
        'div',
        { class: 'price-row' },
        h('div', { class: 'store-name' }, store.name),
        h(
          'div',
          { class: 'fields' },
          field('Price $', store, 'price', '0.00'),
          item.unit !== 'each' && field(`Size (${item.unit})`, store, 'size', '0'),
          field('Coupon $', store, 'coupon', '0.00')
        ),
        hint
      );
    });

  return h(
    'details',
    {
      class: 'card item',
      open: openItems.has(item.id),
      ontoggle: (e) =>
        e.target.open ? openItems.add(item.id) : openItems.delete(item.id),
    },
    h(
      'summary',
      {},
      h('span', { class: 'item-name' }, item.name),
      h('span', { class: 'muted' }, describeNeed(item)),
      summaryPrice
    ),
    rows,
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
          onchange: (e) => {
            item.qty = num(e.target.value) > 0 ? num(e.target.value) : 1;
            save();
            render();
          },
        })
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
            render();
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
        const item = { id: newId(), name: text, qty: num(qty.value) > 0 ? num(qty.value) : 1, unit: unit.value };
        state.items.push(item);
        openItems.add(item.id);
        save();
        render();
        document.querySelector('.add-form input')?.focus();
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

  if (state.items.length === 0) {
    return [form, help, h('p', { class: 'empty' }, 'Your list is empty. Add your first item above.')];
  }
  return [form, help, ...state.items.map(renderItem)];
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
                ` ${l.packages} × ${money(l.price)}` + (l.coupon ? `, coupon −${money(l.coupon)}` : '')
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
            render();
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
          render();
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

function renderStore(store) {
  const update = (field, value, redraw) => {
    store[field] = value;
    save();
    if (redraw) render();
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
            render();
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
        state.stores.push({ id: newId(), name: text, membershipName: '', fee: 0 });
        save();
        render();
      },
    },
    name,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );
  return [...state.stores.map(renderStore), form];
}

// ---------- Start ----------

for (const tab of document.querySelectorAll('nav button')) {
  tab.addEventListener('click', () => {
    view = tab.dataset.view;
    render();
  });
}
render();
