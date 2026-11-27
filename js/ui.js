// Small helpers every screen uses.

// Builds a page element. Text is always inserted as text, never as HTML, so
// nothing a person types (or a bank file contains) can break the page.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'data') Object.assign(el.dataset, value);
    else if (key === 'list') el.setAttribute('list', value); // read-only as a property
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

// Small line drawings. These are fixed text written here, never anything a
// person typed, so setting them as HTML is safe.
const ICONS = {
  overview: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>',
  budget: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7.5 8 6 8-6"/>',
  tx: '<path d="M4 8h14m0 0-3.5-3.5M18 8l-3.5 3.5"/><path d="M20 16H6m0 0 3.5-3.5M6 16l3.5 3.5"/>',
  bills: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  debts: '<path d="m3 7 6.5 6.5 4-4L21 17"/><path d="M21 11.5V17h-5.5"/>',
  groceries: '<path d="M3 4h2.5l2.2 10.5h10.3L20 7.5H6.3"/><circle cx="9" cy="18.5" r="1.4"/><circle cx="17" cy="18.5" r="1.4"/>',
  bank: '<path d="M3.5 9.5 12 4l8.5 5.5z"/><path d="M5.5 10v7M10 10v7M14 10v7M18.5 10v7M3.5 19.5h17"/>',
};

export function icon(name) {
  const el = h('span', { class: 'icon', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
  return el;
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (n) => dollars.format(Math.abs(n) < 0.005 ? 0 : n);

export const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

// A labelled number box.
export function numberField(label, value, onchange, extra = {}) {
  return h(
    'label',
    { class: 'field ' + (extra.class || '') },
    h('span', {}, label),
    h('input', {
      type: 'number',
      step: 'any',
      inputMode: 'decimal',
      value: value ?? '',
      placeholder: extra.placeholder,
      data: extra.key ? { key: extra.key } : undefined,
      onchange: (e) => onchange(num(e.target.value)),
    })
  );
}

// Redrawing the screen. app.js supplies the real function at startup.
// It runs a moment later, after the browser has finished moving the cursor
// to the next box, so tabbing through a row of numbers keeps working.
let draw = () => {};
let go = () => {};
export const setRenderer = (drawFn, goFn) => { draw = drawFn; go = goFn; };
export const rerender = () => setTimeout(draw, 0);
export const goTo = (view) => go(view);

// For redraws caused by something finishing in the background (the bank
// answering, say): wait until nobody is mid-typing, so a half-filled box
// is never wiped out from under them.
export function rerenderWhenIdle() {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  setTimeout(typing ? rerenderWhenIdle : draw, typing ? 1500 : 0);
}
