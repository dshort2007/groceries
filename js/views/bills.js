// The bills calendar: what's due, from which account, and is the money
// sitting in its envelope yet.

import { h, money, num, numberField, rerender } from '../ui.js';
import { today, addDays, weekStart, budgetFor, dueAfter } from '../money.js';
import { envelopeSelect, accountSelect } from './shared.js';
import * as db from '../db.js';

let editingId = null;
const REPEATS = [[1, 'Every month'], [3, 'Every 3 months'], [6, 'Every 6 months'], [12, 'Every year']];

const longDate = (date) =>
  new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function pay(bill) {
  const amount = Number(bill.amount) || 0;
  if (bill.record !== false && amount > 0) {
    db.put('tx', {
      date: today(),
      payee: bill.name,
      amount: -amount,
      envelopeId: bill.envelopeId || '',
      accountId: bill.accountId || '',
      created: Date.now(),
    });
  }
  db.put('bill', { ...bill, nextDue: dueAfter(bill), lastPaid: today() });
  rerender();
}

function renderBill(bill, available) {
  const update = (changes) => { db.put('bill', { ...bill, ...changes }); rerender(); };

  if (editingId === bill.id) {
    return h(
      'div',
      { class: 'tx editing' },
      h(
        'div',
        { class: 'fields wrap' },
        h('label', { class: 'field' }, h('span', {}, 'Bill'), h('input', { type: 'text', value: bill.name, onchange: (e) => update({ name: e.target.value.trim() || bill.name }) })),
        numberField('Amount', bill.amount || '', (v) => update({ amount: v ?? 0 }))
      ),
      h(
        'div',
        { class: 'fields wrap' },
        h('label', { class: 'field' }, h('span', {}, 'Next due'), h('input', { type: 'date', value: bill.nextDue, onchange: (e) => e.target.value && update({ nextDue: e.target.value, day: Number(e.target.value.slice(8)) }) })),
        h('label', { class: 'field' }, h('span', {}, 'Repeats'), h('select', { onchange: (e) => update({ every: Number(e.target.value) }) }, REPEATS.map(([n, label]) => h('option', { value: n, selected: n === (bill.every || 1) }, label))))
      ),
      h(
        'div',
        { class: 'fields wrap' },
        h('label', { class: 'field' }, h('span', {}, 'Paid from envelope'), envelopeSelect(bill.envelopeId, (v) => update({ envelopeId: v }), { special: false, blank: 'No envelope' })),
        h('label', { class: 'field' }, h('span', {}, 'Paid from account'), accountSelect(bill.accountId, (v) => update({ accountId: v })))
      ),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: bill.record !== false, onchange: (e) => update({ record: e.target.checked }) }),
        'Add a transaction when I mark it paid'
      ),
      h('p', { class: 'muted small' }, 'Untick this if the payment will also arrive from a bank import, so it isn\'t counted twice.'),
      h(
        'div',
        { class: 'button-row' },
        h('button', { class: 'primary', onclick: () => { editingId = null; rerender(); } }, 'Done'),
        h('button', { class: 'danger', onclick: () => { if (confirm(`Remove ${bill.name}?`)) { editingId = null; db.remove(bill.id); rerender(); } } }, 'Remove')
      )
    );
  }

  const amount = Number(bill.amount) || 0;
  const short = available !== undefined && amount > 0 && available < amount - 0.004;
  const details = [
    longDate(bill.nextDue),
    db.get(bill.accountId)?.name,
    (bill.every || 1) > 1 && REPEATS.find(([n]) => n === bill.every)?.[1].toLowerCase(),
  ].filter(Boolean);

  return h(
    'div',
    { class: 'tx bill' },
    h(
      'div',
      { class: 'tx-line' },
      h('span', {}, h('strong', {}, bill.name), h('div', { class: 'muted small' }, details.join(' · '))),
      h('strong', {}, amount > 0 ? money(amount) : h('span', { class: 'muted' }, 'No amount'))
    ),
    short && h('div', { class: 'warn small' }, `Its envelope only has ${money(available)}.`),
    h(
      'div',
      { class: 'tx-line' },
      h('button', { onclick: () => pay(bill) }, 'Mark paid'),
      h('button', { class: 'link', onclick: () => { editingId = bill.id; rerender(); } }, 'Edit')
    )
  );
}

export function renderBills() {
  const bills = db.all('bill').sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : 0));
  const now = today();
  const weekEnd = addDays(weekStart(now), 6);
  const monthOut = addDays(now, 30);
  const budget = budgetFor(
    { envelopes: db.all('envelope'), transactions: db.all('tx'), assignments: db.all('assign'), accounts: db.all('account') },
    weekStart(now)
  );

  const sections = [
    ['Overdue', (b) => b.nextDue < now],
    ['Due this week', (b) => b.nextDue >= now && b.nextDue <= weekEnd],
    ['Next 30 days', (b) => b.nextDue > weekEnd && b.nextDue <= monthOut],
    ['Later', (b) => b.nextDue > monthOut],
  ];
  const total = (list) => list.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);

  const cards = sections.map(([title, test]) => {
    const list = bills.filter(test);
    if (list.length === 0) return null;
    return h(
      'section',
      { class: 'card' + (title === 'Overdue' ? ' overdue' : '') },
      h('div', { class: 'list-head' }, h('h2', {}, title), h('span', { class: 'muted' }, money(total(list)))),
      list.map((b) => renderBill(b, budget.rows.get(b.envelopeId)?.available))
    );
  });

  const name = h('input', { type: 'text', placeholder: 'Add a bill, e.g. Internet', required: true });
  const due = h('input', { type: 'date', value: now, required: true, 'aria-label': 'Next due date' });
  const addForm = h(
    'form',
    {
      class: 'card account-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim() || !due.value) return;
        editingId = db.put('bill', { name: name.value.trim(), amount: 0, nextDue: due.value, day: Number(due.value.slice(8)), every: 1 });
        rerender();
      },
    },
    name,
    due,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );

  return [
    bills.length === 0 && h('p', { class: 'empty' }, 'No bills yet. Add the ones that come around on a schedule.'),
    ...cards,
    addForm,
  ];
}
