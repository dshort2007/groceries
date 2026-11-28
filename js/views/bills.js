// The bills calendar: what's due, from which account, and is the money
// sitting in its envelope yet.

import { h, money, num, numberField, rerender } from '../ui.js';
import { today, addDays, weekStart, budgetFor, dueAfter, billEstimate, findPayment, billMonthly, suggestBills } from '../money.js';
import { envelopeSelect, accountSelect, budgetPeriod } from './shared.js';
import { renderPaychecks } from './paychecks.js';
import * as db from '../db.js';

let editingId = null;
const SUGGEST_SETTINGS = '00000000-0000-4000-8000-000000000006'; // which suggestions were turned down
let mode = 'calendar'; // or 'paychecks'
// How often a bill comes round. "d14" is every 14 days; "m3" every 3 months.
const REPEATS = [['d7', 'Every week'], ['d14', 'Every 2 weeks'], ['semi', 'The 15th and the last day'], ['m1', 'Every month'], ['m3', 'Every 3 months'], ['m6', 'Every 6 months'], ['m12', 'Every year']];
const repeatOf = (bill) => (bill.monthDays?.length ? 'semi' : Number(bill.days) > 0 ? `d${bill.days}` : `m${bill.every || 1}`);
const repeatChange = (code) =>
  code === 'semi' ? { days: 0, monthDays: [15, 31] } : code[0] === 'd' ? { days: Number(code.slice(1)), monthDays: null } : { days: 0, every: Number(code.slice(1)), monthDays: null };

const longDate = (date) =>
  new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// Moves a bill on to its next due date. For a bill whose amount changes,
// remember what was paid and use the recent average as the next estimate.
function advance(bill, paid, date, extra = {}) {
  // Keep what's needed to undo this: where the bill stood before.
  const { undo: _, ...before } = bill;
  const next = { ...bill, nextDue: dueAfter(bill), lastPaid: date, paidAmount: paid, ...extra, undo: { ...before, txId: extra.createdTxId || null } };
  delete next.createdTxId;
  if (bill.variable && paid > 0) {
    next.history = [...(bill.history || []), { date, amount: paid }].slice(-12);
    next.amount = billEstimate(next.history);
  }
  db.put('bill', next);
}

// Put a bill back to how it was before it was last marked paid, removing
// the transaction that marking it paid created (if it created one).
function undoPaid(bill) {
  const { txId, ...before } = bill.undo;
  if (txId) db.remove(txId);
  db.put('bill', before);
  rerender();
}

function pay(bill) {
  const amount = Number(bill.amount) || 0;
  let createdTxId = null;
  if (bill.record !== false && amount > 0) {
    createdTxId = db.put('tx', {
      date: today(),
      payee: bill.payTo ? `${bill.name} - ${bill.payTo}` : bill.name,
      amount: -amount,
      envelopeId: bill.envelopeId || '',
      accountId: bill.accountId || '',
      created: Date.now(),
    });
  }
  advance(bill, amount, today(), { createdTxId });
  rerender();
}

// Bills from the setup file were named "Rent (FirstKey Homes)". Move the
// part in brackets into the new "Paid to" field, once.
function tidyNames(bills) {
  let changed = false;
  for (const b of bills) {
    const m = b.payTo === undefined && /^(.+?)\s*\(([^()]+)\)$/.exec(b.name || '');
    if (m) {
      db.put('bill', { ...b, name: m[1], payTo: m[2] });
      changed = true;
    }
  }
  return changed;
}

function renderBill(bill, available, payment) {
  const update = (changes) => { db.put('bill', { ...bill, ...changes }); rerender(); };

  if (editingId === bill.id) {
    return h(
      'div',
      { class: 'tx editing' },
      h(
        'div',
        { class: 'fields wrap' },
        h('label', { class: 'field' }, h('span', {}, 'Bill'), h('input', { type: 'text', value: bill.name, onchange: (e) => update({ name: e.target.value.trim() || bill.name }) })),
        h('label', { class: 'field' }, h('span', {}, 'Paid to'), h('input', { type: 'text', value: bill.payTo || '', placeholder: 'Company or person', onchange: (e) => update({ payTo: e.target.value.trim() }) })),
        numberField(bill.variable ? 'Amount (estimate)' : 'Amount', bill.amount || '', (v) => update({ amount: v ?? 0 }))
      ),
      h(
        'div',
        { class: 'fields wrap' },
        h('label', { class: 'field' }, h('span', {}, 'Next due'), h('input', { type: 'date', value: bill.nextDue, onchange: (e) => e.target.value && update({ nextDue: e.target.value, day: Number(e.target.value.slice(8)) }) })),
        h('label', { class: 'field' }, h('span', {}, 'Repeats'), h('select', { onchange: (e) => update(repeatChange(e.target.value)) }, REPEATS.map(([code, label]) => h('option', { value: code, selected: code === repeatOf(bill) }, label))))
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
        h('input', { type: 'checkbox', checked: !!bill.variable, onchange: (e) => update({ variable: e.target.checked }) }),
        'The amount changes each time (utilities, for example)'
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
    bill.payTo && `To ${bill.payTo}`,
    longDate(bill.nextDue),
    db.get(bill.accountId)?.name,
    repeatOf(bill) !== 'm1' && REPEATS.find(([code]) => code === repeatOf(bill))?.[1].toLowerCase(),
  ].filter(Boolean);
  const usual = bill.variable && billEstimate(bill.history);

  return h(
    'div',
    { class: 'tx bill' },
    h(
      'div',
      { class: 'tx-line' },
      h('span', {}, h('strong', {}, bill.name), h('div', { class: 'muted small' }, details.join(' · '))),
      bill.variable
        ? // A changing bill gets its box right here: type this month's
          // amount when the bill arrives, no need to open Edit.
          h(
            'label',
            { class: 'field bill-amount' },
            h('span', {}, 'This time'),
            h('input', { type: 'number', step: 'any', min: '0', inputMode: 'decimal', value: bill.amount || '', data: { key: `bill-${bill.id}` }, onchange: (e) => update({ amount: num(e.target.value) ?? 0 }) })
          )
        : h('strong', {}, amount > 0 ? money(amount) : h('span', { class: 'muted' }, 'No amount'))
    ),
    usual && h('div', { class: 'muted small' }, `Recent average ${money(usual)}.`),
    (Number(bill.days) > 0 || bill.monthDays?.length > 0) && amount > 0 && h('div', { class: 'muted small' }, `About ${money(billMonthly(bill))} a month.`),
    short && h('div', {}, h('span', { class: 'badge' }, `Envelope has ${money(available)}`)),
    payment &&
      h(
        'div',
        { class: 'found' },
        h('span', {}, `Looks paid: ${money(payment.amount)} on ${longDate(payment.tx.date)}${payment.tx.payee ? ` (${payment.tx.payee})` : ''}.`),
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              advance(bill, payment.amount, payment.tx.date, { lastTxId: payment.tx.id });
              rerender();
            },
          },
          "Yes, that's it"
        )
      ),
    h(
      'div',
      { class: 'tx-line' },
      h('button', { onclick: () => pay(bill) }, 'Mark paid'),
      h('button', { class: 'link', onclick: () => { editingId = bill.id; rerender(); } }, 'Edit')
    )
  );
}

export function renderBills() {
  const tabs = h(
    'div',
    { class: 'subtabs' },
    [['calendar', 'By due date'], ['paychecks', 'By paycheck']].map(([id, label]) => h('button', { class: id === mode ? 'on' : null, onclick: () => { mode = id; rerender(); } }, label))
  );
  return [tabs, ...(mode === 'paychecks' ? renderPaychecks() : renderCalendar())];
}

function renderCalendar() {
  if (tidyNames(db.all('bill'))) rerender();
  const bills = db.all('bill').sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : 0));
  const now = today();
  const weekEnd = addDays(weekStart(now), 6);
  const monthOut = addDays(now, 30);
  const budget = budgetFor(
    { envelopes: db.all('envelope'), transactions: db.all('tx'), assignments: db.all('assign'), accounts: db.all('account') },
    budgetPeriod(now).start,
    budgetPeriod(now).end
  );

  const txs = db.all('tx');
  const perEnvelope = new Map();
  for (const b of bills) if (b.envelopeId) perEnvelope.set(b.envelopeId, (perEnvelope.get(b.envelopeId) || 0) + 1);

  const sections = [
    ['Overdue', (b) => b.nextDue < now],
    ['Due this week', (b) => b.nextDue >= now && b.nextDue <= weekEnd],
    ['Next 30 days', (b) => b.nextDue > weekEnd && b.nextDue <= monthOut],
    ['Later', (b) => b.nextDue > monthOut],
  ];
  const total = (list) => list.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);

  // ---- Summary ----
  const soon = bills.filter((b) => b.nextDue <= addDays(now, 7));
  const overdue = bills.filter((b) => b.nextDue < now);
  const perMonth = bills.reduce((sum, b) => sum + billMonthly(b), 0);
  const summary =
    bills.length > 0 &&
    h(
      'div',
      { class: 'card left ' + (overdue.length ? 'over' : soon.length ? 'todo' : 'done') },
      h('div', { class: 'muted small' }, 'Due in the next 7 days'),
      h('div', { class: 'big' }, money(total(soon))),
      h(
        'p',
        { class: 'small' },
        [
          overdue.length ? `${overdue.length} overdue. ` : '',
          soon.length ? `${soon.length} bill${soon.length === 1 ? '' : 's'} to pay. ` : 'Nothing due this week. ',
          `All ${bills.length} bills come to about ${money(perMonth)} a month.`,
        ].join('')
      )
    );

  // ---- Paid in the last two weeks, with a way to take it back ----
  const recent = bills.filter((b) => b.undo && b.lastPaid && b.lastPaid >= addDays(now, -14)).sort((a, b) => (a.lastPaid < b.lastPaid ? 1 : -1));
  const paid =
    recent.length > 0 &&
    h(
      'details',
      { class: 'card' },
      h('summary', {}, 'Paid recently', h('span', { class: 'muted' }, ` ${recent.length}`)),
      recent.map((b) =>
        h(
          'div',
          { class: 'tx-line report-env' },
          h('span', {}, b.name, h('span', { class: 'muted small' }, ` ${longDate(b.lastPaid)}${b.paidAmount > 0 ? ` · ${money(b.paidAmount)}` : ''}`)),
          h('button', { class: 'link', onclick: () => { if (confirm(`Undo marking ${b.name} as paid?${b.undo.txId ? ' The transaction it added will be removed.' : ''}`)) undoPaid(b); } }, 'Undo')
        )
      )
    );

  const cards = sections.map(([title, test]) => {
    const list = bills.filter(test);
    if (list.length === 0) return null;
    return h(
      'section',
      { class: 'card' + (title === 'Overdue' ? ' overdue' : '') },
      h('div', { class: 'list-head' }, h('h2', {}, title), h('span', { class: 'muted' }, money(total(list)))),
      list.map((b) => renderBill(b, budget.rows.get(b.envelopeId)?.available, findPayment(b, txs, (perEnvelope.get(b.envelopeId) || 0) > 1)))
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

  // ---- Regular payments that look like bills but aren't set up ----
  const settings = db.get(SUGGEST_SETTINGS) || { id: SUGGEST_SETTINGS };
  const found = suggestBills(txs, bills, settings.notBills, now);
  const suggestions =
    found.length > 0 &&
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'list-head' }, h('h2', {}, 'Looks like a bill'), h('span', { class: 'muted' }, String(found.length))),
      h('p', { class: 'muted small' }, 'Payments to the same place at a steady rhythm that aren\'t on your list yet.'),
      found.map((f) =>
        h(
          'div',
          { class: 'tx' },
          h('div', { class: 'tx-line' }, h('span', {}, h('strong', {}, f.name), h('div', { class: 'muted small' }, `${f.label}${f.variable ? ', amount varies' : ''} · paid ${f.count} times · next about ${longDate(f.nextDue)}`)), h('strong', {}, money(f.amount))),
          h(
            'div',
            { class: 'tx-line bill-actions' },
            h(
              'button',
              {
                onclick: () => {
                  // It arrived from the bank, so marking it paid shouldn't add a second transaction.
                  editingId = db.put('bill', { name: f.name, amount: f.amount, nextDue: f.nextDue, day: f.day, days: f.days, every: f.every, envelopeId: f.envelopeId, accountId: f.accountId, variable: f.variable, record: !f.fromBank, lastPaid: f.lastPaid });
                  rerender();
                },
              },
              'Add as a bill'
            ),
            h('button', { class: 'link', onclick: () => { db.put('settings', { ...settings, notBills: [...(settings.notBills || []), f.key] }); rerender(); } }, 'Not a bill')
          )
        )
      )
    );

  return [
    summary,
    bills.length === 0 && h('p', { class: 'empty' }, 'No bills yet. Add the ones that come around on a schedule.'),
    suggestions,
    ...cards,
    paid,
    addForm,
  ];
}
