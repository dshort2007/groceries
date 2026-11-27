// Debts: what's owed, which one to go after next, when each will be gone,
// and whether this month's payment is lined up.

import { h, money, num, numberField, rerender, goTo } from '../ui.js';
import { payoffPlan, debtStatus, today } from '../money.js';
import { envelopeSelect } from './shared.js';
import * as db from '../db.js';

export const SETTINGS_ID = '00000000-0000-4000-8000-000000000002';

let editingId = null;

export function when(months) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function span(months) {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years && `${years} yr`, rest && `${rest} mo`].filter(Boolean).join(' ') || '0 mo';
}

const dayOf = (date) =>
  new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// The plan the family has chosen to follow.
export const debtStrategy = () => (db.get(SETTINGS_ID)?.debtStrategy === 'avalanche' ? 'avalanche' : 'snowball');

function renderEditor(d) {
  const update = (changes) => { db.put('debt', { ...d, ...changes }); rerender(); };
  return h(
    'div',
    { class: 'tx editing' },
    h('label', { class: 'field' }, h('span', {}, 'Debt'), h('input', { type: 'text', value: d.name, onchange: (e) => update({ name: e.target.value.trim() || d.name }) })),
    h(
      'div',
      { class: 'fields wrap' },
      // Typing a new balance (from a statement) restarts the payment count.
      numberField('Balance on the latest statement', d.balance, (v) => update({ balance: v ?? 0, asOf: today(), asOfAt: Date.now() }), { key: `db-${d.id}` }),
      numberField('Interest rate %', d.apr, (v) => update({ apr: v ?? 0 }), { key: `da-${d.id}` }),
      numberField('Minimum payment', d.minPayment, (v) => update({ minPayment: v ?? 0 }), { key: `dm-${d.id}` })
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Payments come from envelope'),
      envelopeSelect(d.envelopeId, (v) => update({ envelopeId: v, asOf: d.asOf || today(), asOfAt: d.asOfAt || Date.now() }), { special: false, blank: 'Not linked', key: `de-${d.id}` })
    ),
    h('p', { class: 'muted small' }, 'Payments filed to that envelope bring this balance down. A bill paid from the same envelope shows here as the next payment.'),
    h(
      'div',
      { class: 'button-row' },
      h('button', { class: 'primary', onclick: () => { editingId = null; rerender(); } }, 'Done'),
      h('button', { class: 'danger', onclick: () => { if (confirm(`Remove ${d.name}?`)) { editingId = null; db.remove(d.id); rerender(); } } }, 'Remove')
    )
  );
}

// One debt, read-only: the facts, progress, and this month's payment.
function renderDebt(d, info) {
  if (editingId === d.id) return renderEditor(d);
  const { balance, paid, rank, focus, payoffMonth, bill, extra } = info;
  const min = Number(d.minPayment) || 0;
  const start = Number(d.startBalance) || 0;
  const share = start > 0 ? Math.max(0, Math.min(1, (start - balance) / start)) : 0;

  const facts = [
    Number(d.apr) > 0 ? `${d.apr}%` : 'No rate entered',
    `minimum ${money(min)}`,
    balance <= 0 ? null : payoffMonth ? `gone about ${when(payoffMonth)}` : null,
  ].filter(Boolean);

  // What the linked bill says about this month's payment.
  let payment = null;
  if (balance <= 0) payment = null;
  else if (!d.envelopeId) payment = h('div', { class: 'warn small' }, "Not linked to an envelope, so payments won't bring this down. Use Edit to link it.");
  else if (!bill) payment = h('div', { class: 'muted small' }, 'No bill is paid from its envelope, so there is no due date to show.');
  else {
    const amount = Number(bill.amount) || 0;
    const low = amount < min - 0.004;
    payment = h(
      'div',
      { class: 'debt-bill' },
      h('button', { class: 'link plain', onclick: () => goTo('bills') }, `Next payment ${money(amount)} due ${dayOf(bill.nextDue)}`),
      bill.lastPaid && bill.lastPaid.slice(0, 7) === today().slice(0, 7) && h('span', { class: 'badge good' }, 'Paid this month'),
      low &&
        h(
          'div',
          { class: 'found warn-box' },
          h('span', {}, `That's below the ${money(min)} minimum.`),
          h('button', { onclick: () => { db.put('bill', { ...bill, amount: min }); rerender(); } }, `Set the bill to ${money(min)}`)
        )
    );
  }

  return h(
    'div',
    { class: 'tx debt-row' + (balance <= 0 ? ' cleared' : '') },
    h(
      'div',
      { class: 'tx-line' },
      h('span', {}, rank && h('span', { class: 'rank' }, String(rank)), h('strong', {}, d.name), focus && h('span', { class: 'badge good' }, 'Focus')),
      h('strong', {}, balance <= 0 ? 'Paid off' : money(balance))
    ),
    h('div', { class: 'tx-line' }, h('span', { class: 'muted small' }, facts.join(' · ')), h('button', { class: 'link', onclick: () => { editingId = d.id; rerender(); } }, 'Edit')),
    start > 0 && share > 0.001 && h('span', { class: 'meter', role: 'img', 'aria-label': `${Math.round(share * 100)}% paid off` }, h('span', { style: `width:${share * 100}%` })),
    paid > 0 && balance > 0 && h('div', { class: 'small' }, `${money(paid)} paid since the last statement balance.`),
    focus && extra > 0 && h('div', { class: 'small' }, `Your extra ${money(extra)} a month goes here: pay ${money(min + extra)}.`),
    payment
  );
}

export function renderDebts() {
  const debts = db.all('debt').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  // Remember where each debt started, so progress can be shown.
  for (const d of debts) {
    if (d.startBalance === undefined && Number(d.balance) > 0) db.put('debt', { ...d, startBalance: Number(d.balance) });
  }

  const settings = db.get(SETTINGS_ID) || { id: SETTINGS_ID };
  const extra = Number(settings.debtExtra) || 0;
  const strategy = debtStrategy();
  const txs = db.all('tx');
  const bills = db.all('bill');
  const status = new Map(debts.map((d) => [d.id, debtStatus(d, txs)]));
  const current = debts.map((d) => ({ ...d, balance: status.get(d.id).balance }));
  const active = current.filter((d) => d.balance > 0);

  const name = h('input', { type: 'text', placeholder: 'Add a debt, e.g. Car loan', required: true });
  const addForm = h(
    'form',
    {
      class: 'add-form simple',
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        editingId = db.put('debt', { name: name.value.trim(), balance: 0, apr: 0, minPayment: 0, asOf: today(), asOfAt: Date.now(), sort: Date.now() });
        rerender();
      },
    },
    name,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );

  if (debts.length === 0) {
    return [h('div', { class: 'card' }, h('h2', {}, 'Debts'), h('p', { class: 'muted' }, 'Add what you owe to see when you could be debt-free and which debt to go after first.'), addForm)];
  }

  const plans = { snowball: payoffPlan(active, extra, 'snowball'), avalanche: payoffPlan(active, extra, 'avalanche') };
  const plan = plans[strategy];
  const total = active.reduce((sum, d) => sum + d.balance, 0);
  const minimums = active.reduce((sum, d) => sum + (Number(d.minPayment) || 0), 0);
  const started = current.reduce((sum, d) => sum + (Number(d.startBalance) || 0), 0);
  const paidOff = Math.max(0, started - current.reduce((sum, d) => sum + d.balance, 0));

  // ---- Summary ----
  const summary = h(
    'div',
    { class: 'card left ' + (active.length ? 'todo' : 'done') },
    h('div', { class: 'muted small' }, 'Total debt'),
    h('div', { class: 'big' }, money(total)),
    active.length === 0
      ? h('p', {}, 'Nothing owed.')
      : plan.never
        ? h('p', { class: 'warn' }, "At these payments the balances never reach zero: the interest is more than what's being paid.")
        : h('p', {}, `Debt-free about ${when(plan.months)}, in ${span(plan.months)}, paying ${money(plan.monthly)} a month.`),
    started > 0 && paidOff > 0.004 && h('span', { class: 'meter', role: 'img', 'aria-label': `${Math.round((paidOff / started) * 100)}% paid off` }, h('span', { style: `width:${Math.min(100, (paidOff / started) * 100)}%` })),
    started > 0 && paidOff > 0.004 && h('p', { class: 'small' }, `${money(paidOff)} paid off since you started tracking.`)
  );

  // ---- Plan: extra money and which order ----
  const choice = (key, title, note) => {
    const p = plans[key];
    return h(
      'button',
      { class: 'choice' + (strategy === key ? ' on' : ''), 'aria-pressed': String(strategy === key), onclick: () => { db.put('settings', { ...settings, debtStrategy: key }); rerender(); } },
      h('strong', {}, title),
      h('span', { class: 'muted small' }, note),
      p.never ? h('span', { class: 'small' }, 'Never paid off') : h('span', { class: 'small' }, `${span(p.months)} · ${money(p.totalInterest)} interest`)
    );
  };
  let verdict = null;
  if (active.length > 1 && !plans.snowball.never && !plans.avalanche.never) {
    const saved = plans.snowball.totalInterest - plans.avalanche.totalInterest;
    verdict = h(
      'p',
      { class: 'muted small' },
      saved > 1
        ? `Highest rate first costs ${money(saved)} less in interest. Smallest first clears your first debt in ${span(plans.snowball.order[0].month)} (against ${span(plans.avalanche.order[0].month)}), which is why Dave Ramsey recommends it.`
        : 'Both orders cost about the same here.'
    );
  }
  const planCard =
    active.length > 0 &&
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Your plan'),
      numberField('Extra I can pay each month, on top of minimums', extra || '', (v) => { db.put('settings', { ...settings, debtExtra: v ?? 0 }); rerender(); }, { class: 'inline wide', key: 'debt-extra', placeholder: '0' }),
      h('div', { class: 'choices' }, choice('snowball', 'Smallest balance first', 'The debt snowball'), choice('avalanche', 'Highest rate first', 'The debt avalanche')),
      verdict
    );

  // ---- The debts, in the order the plan pays them off ----
  const rank = new Map(plan.attack.map((id, i) => [id, i + 1]));
  const payoff = new Map((plan.order || []).map((o) => [o.id, o.month]));
  const ordered = [...current].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  const missingRate = active.filter((d) => !(Number(d.apr) > 0));

  const list = h(
    'div',
    { class: 'card' },
    h('div', { class: 'list-head' }, h('h2', {}, 'Debts'), active.length > 0 && h('span', { class: 'muted' }, `${money(minimums)}/mo minimums`)),
    active.length > 1 && h('p', { class: 'muted small' }, 'In the order your plan pays them off. Pay the minimum on each, and put everything extra on the one marked Focus.'),
    missingRate.length > 0 && h('p', { class: 'warn small' }, `No interest rate entered for ${missingRate.map((d) => d.name).join(', ')}. They're counted as 0%, so the dates here are too optimistic.`),
    ordered.map((d) =>
      renderDebt(debts.find((x) => x.id === d.id), {
        balance: d.balance,
        paid: status.get(d.id).paid,
        rank: d.balance > 0 && active.length > 1 ? rank.get(d.id) : null,
        focus: active.length > 1 && rank.get(d.id) === 1,
        payoffMonth: payoff.get(d.id),
        bill: d.envelopeId ? bills.find((b) => b.envelopeId === d.envelopeId) : null,
        extra,
      })
    ),
    addForm
  );

  return [
    summary,
    planCard,
    list,
    h('p', { class: 'muted small' }, 'Balances come down as you record payments from the linked envelope. Interest isn’t added automatically, so type in the balance from each new statement to keep it accurate. The dates are an estimate: they assume rates and minimums stay the same, no new borrowing, and that each paid-off debt’s payment rolls onto the next one.'),
  ];
}
