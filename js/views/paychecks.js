// Paycheck planning: which bills each paycheck has to cover before the
// next one arrives, and what's left for everything else.

import { h, money, numberField, rerender } from '../ui.js';
import { today, paycheckPlan } from '../money.js';
import * as db from '../db.js';

let editing = false;
const REPEATS = [['d7', 'Every week'], ['d14', 'Every 2 weeks'], ['m1', 'Same date every month'], ['last', 'Last day of each month'], ['semi', 'The 15th and the last day']];
const repeatOf = (p) => (p.monthDays?.length === 2 ? 'semi' : p.monthDays?.length === 1 ? 'last' : Number(p.days) > 0 ? `d${p.days}` : 'm1');
const repeatChange = (code) =>
  code === 'semi' ? { days: 0, monthDays: [15, 31] } : code === 'last' ? { days: 0, monthDays: [31] } : code[0] === 'd' ? { days: Number(code.slice(1)), monthDays: null } : { days: 0, every: 1, monthDays: null };
const day = (date) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function renderPaydays(paychecks) {
  const name = h('input', { type: 'text', placeholder: 'Add a paycheck, e.g. Church', required: true });
  const date = h('input', { type: 'date', value: today(), required: true, 'aria-label': 'A date it gets paid' });
  return h(
    'details',
    { class: 'card', open: editing || paychecks.length === 0 || undefined, ontoggle: (e) => (editing = e.target.open) },
    h('summary', {}, 'Your paydays', paychecks.length > 0 && h('span', { class: 'muted' }, ` ${paychecks.map((p) => p.name).join(', ')}`)),
    paychecks.map((p) => {
      const update = (changes) => { db.put('paycheck', { ...p, ...changes }); rerender(); };
      return h(
        'div',
        { class: 'tx' },
        h(
          'div',
          { class: 'fields wrap' },
          h('label', { class: 'field' }, h('span', {}, 'Paycheck'), h('input', { type: 'text', value: p.name, onchange: (e) => update({ name: e.target.value.trim() || p.name }) })),
          numberField('Take-home amount', p.amount || '', (v) => update({ amount: v ?? 0 }), { key: `pay-${p.id}` })
        ),
        h(
          'div',
          { class: 'fields wrap' },
          h('label', { class: 'field' }, h('span', {}, 'Paid'), h('select', { onchange: (e) => update(repeatChange(e.target.value)) }, REPEATS.map(([code, label]) => h('option', { value: code, selected: code === repeatOf(p) }, label)))),
          // Fixed days of the month need no example date; the others do.
          !p.monthDays?.length &&
            h('label', { class: 'field' }, h('span', {}, 'A date it gets paid'), h('input', { type: 'date', value: p.nextDate || '', onchange: (e) => e.target.value && update({ nextDate: e.target.value, day: Number(e.target.value.slice(8)) }) }))
        ),
        h(
          'div',
          { class: 'fields wrap' },
          h('label', { class: 'field' }, h('span', {}, 'First payday (optional)'), h('input', { type: 'date', value: p.starts || '', onchange: (e) => update({ starts: e.target.value }) })),
          h('label', { class: 'field' }, h('span', {}, 'Last payday (optional)'), h('input', { type: 'date', value: p.ends || '', onchange: (e) => update({ ends: e.target.value }) }))
        ),
        h('button', { class: 'link danger', onclick: () => { if (confirm(`Remove ${p.name}?`)) { db.remove(p.id); rerender(); } } }, 'Remove')
      );
    }),
    h(
      'form',
      {
        class: 'account-form',
        onsubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim() || !date.value) return;
          db.put('paycheck', { name: name.value.trim(), amount: 0, nextDate: date.value, day: Number(date.value.slice(8)), days: 14, sort: Date.now() });
          editing = true;
          rerender();
        },
      },
      name,
      date,
      h('button', { type: 'submit', class: 'primary' }, 'Add')
    ),
    h('p', { class: 'muted small' }, 'Any one payday is enough; the app works out the rest from how often it repeats. If your pay schedule is changing, give the current paycheck a last payday and add the new one with a first payday. Paid on two other fixed dates, the 1st and 15th say? Add it as two monthly paychecks.')
  );
}

export function renderPaychecks() {
  const paychecks = db.all('paycheck').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const plan = paycheckPlan(paychecks, db.all('bill'), today());

  const periods = plan.map((p) =>
    h(
      'div',
      { class: 'card' + (p.left < -0.004 ? ' overdue' : '') },
      h(
        'div',
        { class: 'list-head' },
        h('h2', {}, `${day(p.from)} to ${day(p.until)}`, p.current && h('span', { class: 'badge good' }, 'Now')),
        h('strong', {}, money(p.amount))
      ),
      h('div', { class: 'muted small' }, p.names.join(' + ')),
      p.bills.length === 0 && h('p', { class: 'muted' }, 'No bills due before the next payday.'),
      p.bills.map((b) =>
        h('div', { class: 'tx-line report-env' }, h('span', {}, b.name, h('span', { class: 'muted small' }, ` ${day(b.date)}`), b.overdue && h('span', { class: 'badge' }, 'Overdue')), h('span', {}, money(b.amount)))
      ),
      h(
        'div',
        { class: 'pay-totals' },
        h('div', { class: 'tx-line' }, h('span', { class: 'muted' }, 'Bills'), h('span', {}, money(p.billsTotal))),
        h('div', { class: 'tx-line' }, h('strong', {}, p.left < -0.004 ? 'Short by' : 'Left for everything else'), h('strong', { class: p.left < -0.004 ? 'neg' : 'pos' }, money(Math.abs(p.left))))
      )
    )
  );

  return [
    renderPaydays(paychecks),
    paychecks.length > 0 && plan.length === 0 && h('p', { class: 'empty' }, 'Enter a take-home amount for a paycheck to see the plan.'),
    ...periods,
    plan.length > 0 && h('p', { class: 'muted small' }, '"Left for everything else" is what the paycheck has after its bills: groceries, gas, pocket money, extra toward debt. Bills with no amount aren\'t counted.'),
  ];
}
