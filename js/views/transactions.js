// Money in and out: add by hand, import a bank file, file into envelopes.

import { h, money, num, rerender } from '../ui.js';
import { today, readBankCsv, payeeKey } from '../money.js';
import * as db from '../db.js';

let onlyUnfiled = false;
let limit = 100;
let editingId = null;
let pending = null; // a bank file that's been read but not imported yet

// The envelope picker. Income and transfers are special choices.
function envelopeSelect(value, onchange, key) {
  const groups = new Map();
  for (const e of db.all('envelope').filter((e) => !e.archived || e.id === value).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) {
    const name = e.group || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  const option = (v, label) => h('option', { value: v, selected: v === (value || '') }, label);
  return h(
    'select',
    { class: value ? null : 'unfiled', 'aria-label': 'Envelope', data: key ? { key } : undefined, onchange: (e) => onchange(e.target.value) },
    option('', 'Choose an envelope…'),
    option('income', 'Income (to assign)'),
    option('transfer', 'Transfer between our accounts'),
    [...groups].map(([name, list]) => h('optgroup', { label: name }, list.map((e) => option(e.id, e.name))))
  );
}

const rules = () => new Map(db.all('rule').map((r) => [r.key, r]));

// Remember which envelope this payee goes in, for next time.
function learn(payee, envelopeId) {
  const key = payeeKey(payee);
  if (!key || !envelopeId) return;
  const existing = rules().get(key);
  if (existing?.envelopeId !== envelopeId) db.put('rule', { ...existing, key, envelopeId });
}

function renderAddForm() {
  const date = h('input', { type: 'date', value: today(), required: true, 'aria-label': 'Date' });
  const payee = h('input', { type: 'text', placeholder: 'Where or who', required: true });
  const amount = h('input', { type: 'number', step: 'any', min: '0', inputMode: 'decimal', placeholder: 'Amount', required: true });
  const direction = h('select', { 'aria-label': 'Spent or received' }, h('option', { value: 'out' }, 'Spent'), h('option', { value: 'in' }, 'Received'));
  let envelopeId = '';
  const account = h('input', { type: 'text', placeholder: 'Account (optional)', list: 'accounts' });

  return h(
    'form',
    {
      class: 'card tx-form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const value = num(amount.value);
        if (!(value > 0)) return;
        const name = payee.value.trim();
        const filed = envelopeId || rules().get(payeeKey(name))?.envelopeId || '';
        db.put('tx', {
          date: date.value,
          payee: name,
          amount: direction.value === 'out' ? -value : value,
          envelopeId: filed,
          account: account.value.trim(),
          created: Date.now(),
        });
        learn(name, envelopeId);
        rerender();
      },
    },
    h('h2', {}, 'Add a transaction'),
    h('div', { class: 'fields wrap' }, date, direction, amount),
    payee,
    h('div', { class: 'fields wrap' }, envelopeSelect('', (v) => (envelopeId = v)), account),
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );
}

function renderImport() {
  const account = h('input', { type: 'text', placeholder: 'Which account is this file from?', list: 'accounts' });
  const picker = h('input', {
    type: 'file',
    accept: '.csv,text/csv',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      pending = { ...readBankCsv(await file.text()), name: file.name, flip: false, account: account.value.trim() };
      rerender();
    },
  });

  let preview = null;
  if (pending?.error) preview = h('p', { class: 'warn' }, pending.error);
  else if (pending) {
    const have = new Set(db.all('tx').map((t) => t.importKey).filter(Boolean));
    const fresh = pending.rows.filter((r) => !have.has(r.importKey));
    const sign = pending.flip ? -1 : 1;
    preview = h(
      'div',
      { class: 'preview' },
      h('p', {}, `${pending.name}: ${fresh.length} new, ${pending.rows.length - fresh.length} already imported.`),
      h(
        'ul',
        { class: 'tx-preview' },
        fresh.slice(0, 4).map((r) =>
          h('li', {}, h('span', {}, `${r.date} · ${r.payee}`), h('span', { class: r.amount * sign < 0 ? null : 'pos' }, money(r.amount * sign)))
        )
      ),
      h('p', { class: 'muted small' }, 'Check the examples: money you spent should show with a minus sign.'),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: pending.flip, onchange: (e) => { pending.flip = e.target.checked; rerender(); } }),
        "They're backwards, flip them"
      ),
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            class: 'primary',
            disabled: fresh.length === 0,
            onclick: () => {
              const known = rules();
              let created = Date.now();
              for (const r of fresh) {
                db.put('tx', {
                  date: r.date,
                  payee: r.payee,
                  amount: r.amount * sign,
                  envelopeId: known.get(payeeKey(r.payee))?.envelopeId || '',
                  account: pending.account,
                  importKey: r.importKey,
                  created: created++,
                });
              }
              pending = null;
              onlyUnfiled = true;
              rerender();
            },
          },
          `Import ${fresh.length}`
        ),
        h('button', { onclick: () => { pending = null; rerender(); } }, 'Cancel')
      )
    );
  }

  return h(
    'details',
    { class: 'card', open: !!pending },
    h('summary', {}, 'Import a bank file (CSV)'),
    h('p', { class: 'muted small' }, 'Download transactions from your bank or card as a CSV file and choose it here. Rows you already imported are skipped, so overlapping date ranges are fine.'),
    !pending && account,
    !pending && picker,
    preview
  );
}

function renderRow(t) {
  const update = (changes) => { db.put('tx', { ...t, ...changes }); rerender(); };

  if (editingId === t.id) {
    const date = h('input', { type: 'date', value: t.date, 'aria-label': 'Date' });
    const payee = h('input', { type: 'text', value: t.payee });
    const amount = h('input', { type: 'number', step: 'any', inputMode: 'decimal', value: t.amount, 'aria-label': 'Amount (minus for money spent)' });
    return h(
      'div',
      { class: 'tx editing' },
      h('div', { class: 'fields wrap' }, date, amount),
      payee,
      h('p', { class: 'muted small' }, 'Use a minus sign for money spent.'),
      h(
        'div',
        { class: 'button-row' },
        h('button', { class: 'primary', onclick: () => { editingId = null; update({ date: date.value || t.date, payee: payee.value.trim(), amount: num(amount.value) ?? t.amount }); } }, 'Save'),
        h('button', { onclick: () => { editingId = null; rerender(); } }, 'Cancel'),
        h('button', { class: 'danger', onclick: () => { editingId = null; db.remove(t.id); rerender(); } }, 'Delete')
      )
    );
  }

  return h(
    'div',
    { class: 'tx' },
    h(
      'div',
      { class: 'tx-line' },
      h('span', {}, h('span', { class: 'muted small' }, t.date.slice(5).replace('-', '/') + ' '), t.payee || '(no name)', t.account && h('span', { class: 'muted small' }, ` · ${t.account}`)),
      h('strong', { class: t.amount > 0 ? 'pos' : null }, money(t.amount))
    ),
    h(
      'div',
      { class: 'tx-line' },
      envelopeSelect(t.envelopeId, (v) => { learn(t.payee, v); update({ envelopeId: v }); }, `env-${t.id}`),
      h('button', { class: 'link', onclick: () => { editingId = t.id; rerender(); } }, 'Edit')
    )
  );
}

export function renderTransactions() {
  const all = db.all('tx').sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created ?? 0) - (a.created ?? 0)));
  const unfiled = all.filter((t) => !t.envelopeId);
  if (unfiled.length === 0) onlyUnfiled = false;
  const shown = onlyUnfiled ? unfiled : all;

  const list = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'list-head' },
      h('h2', {}, onlyUnfiled ? 'Need an envelope' : 'Transactions'),
      unfiled.length > 0 &&
        h('button', { class: 'link', onclick: () => { onlyUnfiled = !onlyUnfiled; rerender(); } }, onlyUnfiled ? 'Show all' : `${unfiled.length} need an envelope`)
    ),
    shown.length === 0 && h('p', { class: 'empty' }, 'Nothing here yet.'),
    shown.slice(0, limit).map(renderRow),
    shown.length > limit && h('div', { class: 'button-row' }, h('button', { onclick: () => { limit += 100; rerender(); } }, 'Show more'))
  );

  const accounts = [...new Set(all.map((t) => t.account).filter(Boolean))];
  return [renderAddForm(), renderImport(), list, h('datalist', { id: 'accounts' }, accounts.map((a) => h('option', { value: a })))];
}
