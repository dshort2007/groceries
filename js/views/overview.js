// The overview: how things stand today, what needs attention, and a few
// suggestions. Everything here is worked out from the same data the other
// tabs show; nothing is stored.

import { h, icon, money, goTo } from '../ui.js';
import { today, addDays, weekStart, budgetFor, accountBalances, debtStatus, payoffPlan, parts, monthlyTargets, billMonthly, goalStatus, suggestBills, priceChanges, expectedIncome } from '../money.js';
import { bankSummary } from './bank.js';
import { budgetPeriod } from './shared.js';
import { when, span, SETTINGS_ID, debtStrategy, planPayment } from './debts.js';
import * as db from '../db.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function tile(label, value, note, tab, picture) {
  return h(
    'button',
    { class: 'card tile', onclick: () => goTo(tab) },
    h('div', { class: 'tile-top' }, icon(picture), h('span', { class: 'muted small' }, label)),
    h('div', { class: 'tile-value' }, value),
    note && h('div', { class: 'muted small' }, note)
  );
}

// Everything the page needs, gathered in one place.
function gather() {
  const now = today();
  const { start: week, end: periodEnd } = budgetPeriod(now);
  const month = now.slice(0, 7);
  const envelopes = db.all('envelope');
  const bills = db.all('bill');
  // Each envelope with its real monthly target (from its bills, if any).
  const targets = monthlyTargets(envelopes, bills);
  const live = envelopes.filter((e) => !e.archived).map((e) => ({ ...e, plan: targets.get(e.id).amount }));
  const txs = db.all('tx');
  const accounts = db.all('account');
  const budget = budgetFor({ envelopes, transactions: txs, assignments: db.all('assign'), accounts }, week, periodEnd);
  const balances = accountBalances(accounts, txs);
  const sum = (list, fn) => list.reduce((total, x) => total + fn(x), 0);

  const cash = sum(accounts.filter((a) => a.type !== 'credit'), (a) => balances.get(a.id));
  const cardsOwed = -sum(accounts.filter((a) => a.type === 'credit'), (a) => balances.get(a.id));

  const soon = addDays(now, 7);
  const overdue = bills.filter((b) => b.nextDue < now);
  const dueSoon = bills.filter((b) => b.nextDue >= now && b.nextDue <= soon);

  // Several bills can share an envelope, so compare each envelope with
  // everything coming out of it in the next week.
  const needed = new Map();
  for (const b of [...overdue, ...dueSoon]) {
    if (b.envelopeId) needed.set(b.envelopeId, (needed.get(b.envelopeId) || 0) + (Number(b.amount) || 0));
  }
  const shortEnvelopes = [...needed]
    .map(([id, need]) => ({ envelope: db.get(id), need, have: budget.rows.get(id)?.available ?? 0 }))
    .filter((x) => x.envelope && x.have < x.need - 0.004);

  const debts = db.all('debt').map((d) => ({ ...d, ...debtStatus(d, txs), statement: Number(d.balance) || 0 }));
  const owing = debts.filter((d) => d.balance > 0).map((d) => ({ ...d, minPayment: planPayment(d, bills) }));
  const extra = Number(db.get(SETTINGS_ID)?.debtExtra) || 0;

  // This month's spending per group, net of refunds.
  const groupOf = new Map(envelopes.map((e) => [e.id, e.group || 'Other']));
  const groups = new Map();
  const group = (name) => groups.get(name) || groups.set(name, { name, spent: 0, plan: 0 }).get(name);
  for (const e of live) group(e.group || 'Other').plan += Number(e.plan) || 0;
  for (const t of txs) {
    if (!t.date.startsWith(month)) continue;
    for (const p of parts(t)) if (groupOf.has(p.envelopeId)) group(groupOf.get(p.envelopeId)).spent -= p.amount;
  }

  return { periodStart: week, periodEnd, periodWord: periodEnd > addDays(week, 7) ? 'month' : 'week', now, month, live, txs, accounts, budget, cash, cardsOwed, bills, overdue, dueSoon, shortEnvelopes, debts, owing, extra, groups: [...groups.values()], sum };
}

// Things that need doing, most urgent first. Each links to where to fix it.
function looseEnds(d) {
  const ends = [];
  const add = (tab, text, level = 'todo') => ends.push({ tab, text, level });

  for (const b of d.overdue) add('bills', `Overdue: ${b.name} was due ${plural(daysBetween(b.nextDue, d.now), 'day')} ago. Pay it, or mark it paid.`, 'urgent');
  const bank = bankSummary();
  if (bank.outdated) add('tx', 'The bank function on Supabase is an older version. Paste in the latest code and deploy it.', 'info');
  for (const item of bank.items.filter((i) => i.error)) add('tx', `${item.institution} has stopped sending transactions. It needs you to reconnect.`, 'urgent');

  const left = d.budget.leftToAssign;
  if (left < -0.004) {
    // Planning ahead of a paycheck isn't a problem; assigning more than
    // even the expected pay will cover is.
    const lastAssigned = db.all('assign').filter((a) => Number(a.amount) > 0).reduce((max, a) => (a.week > max ? a.week : max), '');
    const horizon = lastAssigned && budgetPeriod(lastAssigned).end > d.periodEnd ? budgetPeriod(lastAssigned).end : d.periodEnd;
    const coming = expectedIncome(db.all('paycheck'), d.txs, d.periodStart, horizon, d.now).reduce((sum, e) => sum + e.amount, 0);
    if (left + coming >= -0.004) add('budget', `You've planned ${money(-left)} ahead of pay that's still to come. It isn't there to spend until it arrives.`, 'info');
    else add('budget', `You've assigned ${money(-left - coming)} more than you ${coming > 0 ? 'will have, even with expected pay' : 'have'}. Take it back out of an envelope.`, 'urgent');
  }
  const overspent = d.live.filter((e) => d.budget.rows.get(e.id).available < -0.004);
  if (overspent.length) {
    add('budget', `Overspent: ${overspent.map((e) => `${e.name} (${money(-d.budget.rows.get(e.id).available)})`).join(', ')}. Cover ${overspent.length === 1 ? 'it' : 'them'} from another envelope.`, 'urgent');
  }
  if (d.shortEnvelopes.length) {
    add('budget', `Not enough set aside for bills due within a week: ${d.shortEnvelopes.map((s) => `${s.envelope.name} (short ${money(s.need - Math.max(0, s.have))})`).join(', ')}.`);
  }

  if (d.budget.needsEnvelope > 0) add('tx', `${plural(d.budget.needsEnvelope, 'transaction')} ${d.budget.needsEnvelope === 1 ? 'needs' : 'need'} an envelope.`);
  if (left > 0.004) add('budget', `${money(left)} is waiting to be assigned to envelopes.`);

  const matched = new Set(d.accounts.map((a) => a.plaidAccountId).filter(Boolean));
  const unmatched = bank.items.flatMap((i) => i.accounts.filter((a) => !matched.has(a.id)).map((a) => `${i.institution} ${a.name}`));
  if (unmatched.length) add('tx', `Not tracked yet: ${unmatched.join(', ')}. Say which account each one is, or leave it if you don't want it.`, 'info');

  const noRate = d.owing.filter((x) => !(Number(x.apr) > 0));
  if (noRate.length) add('debts', `No interest rate entered for ${noRate.map((x) => x.name).join(', ')}, so the payoff dates are too optimistic.`, 'info');
  const stale = d.owing.filter((x) => x.asOf && daysBetween(x.asOf, d.now) > 35);
  if (stale.length) add('debts', `Balances not updated in over a month: ${stale.map((x) => x.name).join(', ')}. Enter the figure from the latest statement.`, 'info');
  const unlinked = d.owing.filter((x) => !x.envelopeId);
  if (unlinked.length) add('debts', `Not linked to an envelope, so payments won't bring the balance down: ${unlinked.map((x) => x.name).join(', ')}.`, 'info');
  const maybeBills = suggestBills(d.txs, d.bills, db.get('00000000-0000-4000-8000-000000000006')?.notBills, d.now);
  if (maybeBills.length) add('bills', `${plural(maybeBills.length, 'regular payment')} ${maybeBills.length === 1 ? 'looks' : 'look'} like ${maybeBills.length === 1 ? 'a bill' : 'bills'} you haven't set up: ${maybeBills.slice(0, 3).map((f) => f.name).join(', ')}.`, 'info');
  for (const c of priceChanges(d.txs, d.now).slice(0, 3)) add('bills', `${c.name} went ${c.change > 0 ? 'up' : 'down'} from ${money(c.was)} to ${money(c.now)}.`, 'info');
  const noAmount = d.bills.filter((b) => !(Number(b.amount) > 0));
  if (noAmount.length) add('bills', `No amount entered for ${noAmount.map((b) => b.name).join(', ')}.`, 'info');

  return ends;
}

// Observations worth a thought. Facts from the numbers, not advice from a person.
function suggestions(d) {
  const out = [];

  const planned = d.sum(d.live, (e) => Number(e.plan) || 0);
  const funded = d.sum(d.live, (e) => Math.min(d.budget.rows.get(e.id).assignedMonth, Number(e.plan) || 0));
  if (planned > 0) {
    const gaps = d.live
      .map((e) => ({ name: e.name, gap: (Number(e.plan) || 0) - d.budget.rows.get(e.id).assignedMonth }))
      .filter((g) => g.gap > 0.004)
      .sort((a, b) => b.gap - a.gap);
    out.push(
      gaps.length === 0
        ? `Every envelope with a monthly plan is fully funded for this month.`
        : `This month you've funded ${money(funded)} of the ${money(planned)} you planned. Biggest gaps: ${gaps.slice(0, 3).map((g) => `${g.name} (${money(g.gap)})`).join(', ')}.`
    );
  }

  if (d.owing.length > 0) {
    const priciest = d.owing.filter((x) => Number(x.apr) > 0).sort((a, b) => b.apr - a.apr)[0];
    if (priciest) {
      out.push(`Your most expensive debt is ${priciest.name} at ${priciest.apr}%. Each $100 left on it costs about ${money(priciest.apr / 12)} a month in interest.`);
    }
    const base = payoffPlan(d.owing, d.extra, debtStrategy());
    const more = payoffPlan(d.owing, d.extra + 100, debtStrategy());
    if (!base.never && !more.never && base.months > more.months) {
      out.push(`Another $100 a month toward debt would have you debt-free ${span(base.months - more.months)} sooner and save about ${money(base.totalInterest - more.totalInterest)} in interest.`);
    }
    if (base.never) out.push("At the current payments your debt balances aren't going down: the interest is more than what's being paid.");
  }

  const subscriptions = d.bills.filter((b) => (db.get(b.envelopeId)?.group || '') === 'Subscriptions');
  if (subscriptions.length > 1) {
    const monthly = d.sum(subscriptions, (b) => billMonthly(b));
    out.push(`Your ${subscriptions.length} subscriptions add up to ${money(monthly)} a month, or ${money(monthly * 12)} a year.`);
  }

  const idle = d.live
    .map((e) => ({ e, row: d.budget.rows.get(e.id) }))
    .filter(({ e, row }) => Number(e.plan) > 0 && row.available > 2 * e.plan && row.available >= 100 && e.group !== 'Debt')
    .sort((a, b) => b.row.available - a.row.available)[0];
  if (idle) out.push(`${idle.e.name} is holding ${money(idle.row.available)}, more than two months of its plan. If that's not on purpose, some could go elsewhere.`);

  return out;
}

// One row per group: spent this month against the monthly plan.
function renderSpending(d) {
  const rows = d.groups.filter((g) => g.spent > 0.004).sort((a, b) => b.spent - a.spent);
  if (rows.length === 0) return null;
  const monthName = new Date(d.now + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, `Spent in ${monthName}`),
    h(
      'div',
      { class: 'meters' },
      rows.map((g) => {
        const over = g.plan > 0 && g.spent > g.plan + 0.004;
        // With no plan there's no limit to measure against, so no bar.
        const share = g.plan > 0 ? Math.min(1, g.spent / g.plan) : 0;
        const figure = g.plan > 0 ? `${money(g.spent)} of ${money(g.plan)}` : `${money(g.spent)} · no plan`;
        return h(
          'div',
          { class: 'meter-row', title: `${g.name}: ${figure}` },
          h('span', { class: 'meter-name' }, g.name),
          g.plan > 0
            ? h('span', { class: 'meter' + (over ? ' over' : ''), role: 'img', 'aria-label': `${Math.round((g.spent / g.plan) * 100)}% of plan` }, h('span', { style: `width:${share * 100}%` }))
            : h('span', {}),
          h('span', { class: 'meter-figure' }, figure, over && h('strong', {}, ` · over by ${money(g.spent - g.plan)}`))
        );
      })
    )
  );
}

// Savings goals and how far along each one is.
function renderGoals(d) {
  const goals = d.live
    .map((e) => ({ e, g: goalStatus({ amount: e.goalAmount, date: e.goalDate }, d.budget.rows.get(e.id).available, d.now) }))
    .filter((x) => x.g);
  if (goals.length === 0) return null;
  const by = (date) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Savings goals'),
    h(
      'div',
      { class: 'meters' },
      goals.map(({ e, g }) =>
        h(
          'button',
          { class: 'goal', onclick: () => goTo('budget') },
          h('div', { class: 'tx-line' }, h('strong', {}, e.name), h('span', {}, `${money(g.target - g.remaining)} of ${money(g.target)}`)),
          h('span', { class: 'meter', role: 'img', 'aria-label': `${Math.round(g.share * 100)}% of the goal` }, h('span', { style: `width:${g.share * 100}%` })),
          h(
            'div',
            { class: 'muted small' },
            g.reached ? 'Reached.' : g.late ? `Past its date of ${by(e.goalDate)}, with ${money(g.remaining)} to go.` : g.perWeek ? `${money(g.perWeek)} a week gets there by ${by(e.goalDate)}.` : `${money(g.remaining)} to go.`
          )
        )
      )
    )
  );
}

export function renderOverview() {
  const d = gather();
  const ends = looseEnds(d);
  const ideas = suggestions(d);
  const left = d.budget.leftToAssign;
  const dueTotal = d.sum([...d.overdue, ...d.dueSoon], (b) => Number(b.amount) || 0);
  const debtTotal = d.sum(d.owing, (x) => x.balance);
  const plan = d.owing.length ? payoffPlan(d.owing, d.extra, debtStrategy()) : null;

  const hour = new Date().getHours();
  const hero = h(
    'div',
    { class: 'hero' },
    h('div', { class: 'hero-date' }, new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })),
    h('div', { class: 'hero-title' }, hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'),
    h('div', { class: 'hero-note' }, ends.length === 0 ? 'Everything is tied up.' : `${plural(ends.length, 'loose end')} to tie up.`)
  );

  return [
    hero,
    h(
      'div',
      { class: 'tiles' },
      tile('In the bank', money(d.cash), d.cardsOwed > 0.004 ? `${money(d.cardsOwed)} owed on cards` : plural(d.accounts.filter((a) => a.type !== 'credit').length, 'account'), 'tx', 'bank'),
      tile('Left to assign', money(left), left < -0.004 ? (ends.some((e) => e.text.startsWith("You've planned")) ? 'Planned ahead of pay' : 'More assigned than you have') : left > 0.004 ? 'Waiting for a job' : 'Every dollar has a job', 'budget', 'budget'),
      tile('Due in 7 days', money(dueTotal), d.overdue.length ? `${plural(d.dueSoon.length + d.overdue.length, 'bill')}, ${d.overdue.length} overdue` : plural(d.dueSoon.length, 'bill'), 'bills', 'bills'),
      tile('Debt', money(debtTotal), plan && !plan.never ? `Debt-free about ${when(plan.months)}` : plural(d.owing.length, 'debt'), 'debts', 'debts')
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'list-head' }, h('h2', {}, 'Loose ends'), ends.length > 0 && h('span', { class: 'muted' }, String(ends.length))),
      ends.length === 0
        ? h('p', { class: 'muted' }, 'Nothing needs your attention right now.')
        : ends.map((e) => h('button', { class: 'end', onclick: () => goTo(e.tab) }, h('span', { class: 'dot ' + e.level, 'aria-hidden': 'true' }), h('span', {}, e.text), h('span', { class: 'muted', 'aria-hidden': 'true' }, '›')))
    ),
    renderGoals(d),
    renderSpending(d),
    ideas.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Worth a look'), h('ul', { class: 'ideas' }, ideas.map((text) => h('li', {}, text)))),
  ];
}
