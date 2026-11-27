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
