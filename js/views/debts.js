// Debts, and a comparison of the two common payoff orders.

import { h, money, numberField, rerender } from '../ui.js';
import { payoffPlan, debtStatus, today } from '../money.js';
import { envelopeSelect } from './shared.js';
import * as db from '../db.js';

export const SETTINGS_ID = '00000000-0000-4000-8000-000000000002';

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

function renderPlan(title, subtitle, plan) {
  if (plan.never) {
    return h('div', { class: 'card plan' }, h('h3', {}, title), h('p', { class: 'warn' }, "At these payments the balances never reach zero: the interest is more than what's being paid."));
  }
  return h(
    'div',
    { class: 'card plan' },
    h('h3', {}, title),
    h('div', { class: 'muted small' }, subtitle),
    h('div', { class: 'big' }, span(plan.months)),
    h('div', {}, `Debt-free ${when(plan.months)}`),
    h('div', { class: 'muted' }, `${money(plan.totalInterest)} in interest`),
    h('ol', {}, plan.order.map((d) => h('li', {}, h('span', {}, d.name), h('span', { class: 'muted small' }, when(d.month)))))
  );
}

export function renderDebts() {
  const debts = db.all('debt').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const settings = db.get(SETTINGS_ID) || { id: SETTINGS_ID };
  const extra = Number(settings.debtExtra) || 0;

  // Each debt's balance, brought down by payments made since it was entered.
  const txs = db.all('tx');
  const status = new Map(debts.map((d) => [d.id, debtStatus(d, txs)]));
  const current = debts.map((d) => ({ ...d, balance: status.get(d.id).balance }));
  const shortDay = (date) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const rows = debts.map((d) => {
    const update = (changes) => { db.put('debt', { ...d, ...changes }); rerender(); };
    const { paid, balance } = status.get(d.id);
    return h(
      'div',
      { class: 'debt' },
      h('label', { class: 'field grow' }, h('span', {}, 'Debt'), h('input', { type: 'text', value: d.name, data: { key: `dn-${d.id}` }, onchange: (e) => update({ name: e.target.value.trim() || d.name }) })),
      // Typing a new balance (from a statement) restarts the payment count.
      numberField('Balance', d.balance, (v) => update({ balance: v ?? 0, asOf: today(), asOfAt: Date.now() }), { key: `db-${d.id}` }),
      numberField('Rate %', d.apr, (v) => update({ apr: v ?? 0 }), { key: `da-${d.id}` }),
      numberField('Minimum', d.minPayment, (v) => update({ minPayment: v ?? 0 }), { key: `dm-${d.id}` }),
      h('button', { class: 'danger', 'aria-label': `Remove ${d.name}`, onclick: () => { if (confirm(`Remove ${d.name}?`)) { db.remove(d.id); rerender(); } } }, '×'),
      h(
        'div',
        { class: 'debt-link' },
        h('label', { class: 'field' }, h('span', {}, 'Payments come from envelope'), envelopeSelect(d.envelopeId, (v) => update({ envelopeId: v, asOf: d.asOf || today(), asOfAt: d.asOfAt || Date.now() }), { special: false, blank: 'Not linked', key: `de-${d.id}` })),
        paid > 0 && h('div', { class: 'small' }, `${money(paid)} paid since ${shortDay(d.asOf)}, so about `, h('strong', {}, money(balance)), ' now.')
      )
    );
  });

  const name = h('input', { type: 'text', placeholder: 'Add a debt, e.g. Car loan', required: true });
  const addForm = h(
    'form',
    {
      class: 'add-form simple',
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        db.put('debt', { name: name.value.trim(), balance: 0, apr: 0, minPayment: 0, asOf: today(), asOfAt: Date.now(), sort: Date.now() });
        rerender();
      },
    },
    name,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );

  const total = current.reduce((sum, d) => sum + d.balance, 0);
  const minimums = debts.reduce((sum, d) => sum + (Number(d.minPayment) || 0), 0);
  const list = h(
    'div',
    { class: 'card' },
    h('div', { class: 'list-head' }, h('h2', {}, 'Debts'), debts.length > 0 && h('span', { class: 'muted' }, `${money(total)} · ${money(minimums)}/mo minimums`)),
    rows,
    addForm
  );

  const active = current.filter((d) => d.balance > 0);
  if (active.length === 0) return [list];

  const snowball = payoffPlan(active, extra, 'snowball');
  const avalanche = payoffPlan(active, extra, 'avalanche');

  let verdict = null;
  if (!snowball.never && !avalanche.never) {
    const saved = snowball.totalInterest - avalanche.totalInterest;
    const sooner = snowball.months - avalanche.months;
    const firstWin = `With smallest-first, your first debt is gone in ${span(snowball.order[0].month)}; with highest-rate-first, in ${span(avalanche.order[0].month)}.`;
    verdict = h(
      'p',
      { class: 'card' },
      saved > 1
        ? `Highest-rate-first costs ${money(saved)} less in interest${sooner > 0 ? ` and finishes ${span(sooner)} sooner` : ''}. ${firstWin} Smallest-first trades some interest for earlier wins, which is why Dave Ramsey recommends it.`
        : `Both orders cost about the same here. ${firstWin}`
    );
  }

  const missingRate = active.filter((d) => !(Number(d.apr) > 0));
  return [
    list,
    h(
      'div',
      { class: 'card settings' },
      numberField('Extra I can pay each month, on top of minimums', extra || '', (v) => { db.put('settings', { ...settings, debtExtra: v ?? 0 }); rerender(); }, { class: 'inline', key: 'debt-extra', placeholder: '0' })
    ),
    missingRate.length > 0 && h('p', { class: 'warn' }, `No interest rate entered for ${missingRate.map((d) => d.name).join(', ')}, so these are counted as 0% and the totals below are too low.`),
    h(
      'div',
      { class: 'plans' },
      renderPlan('Smallest balance first', 'The debt snowball', snowball),
      renderPlan('Highest rate first', 'The debt avalanche', avalanche)
    ),
    verdict,
    h('p', { class: 'muted small' }, 'Balances come down as you record payments from the linked envelope. Interest isn’t added automatically, so type in the balance from each new statement to keep it accurate. The payoff dates are an estimate: they assume rates and minimum payments stay the same, no new borrowing, and that each paid-off debt’s payment rolls onto the next one.'),
  ];
}
