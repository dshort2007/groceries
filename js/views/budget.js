// The weekly envelope budget.

import { h, money, num, numberField, rerender, goTo } from '../ui.js';
import { today, addDays, weekStart, budgetFor, monthlyTargets, goalStatus } from '../money.js';
import * as db from '../db.js';

let week = weekStart(today());
let editing = false;
let showQuiet = false; // envelopes with nothing going on are tucked away
let incomeOpen = false;

// Which groups are expanded, remembered on this device. '*' means all.
const OPEN_KEY = 'budget-open';
function openGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []);
  } catch {
    return new Set();
  }
}
function saveOpenGroups(open) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // Not remembered, that's all.
  }
}

// Whole dollars, for the small print where cents are just clutter.
const whole = (n) => '$' + Math.round(n).toLocaleString('en-US');

// Nothing planned, nothing in it, nothing happening: not worth a row.
const isQuiet = (row, target, e) =>
  !(Number(e?.goalAmount) > 0) && target.amount === 0 && Math.abs(row.available) < 0.005 && row.assigned === 0 && row.assignedMonth === 0 && row.spent === 0;

const STARTER = [
  ['Giving', ['Tithe']],
  ['Housing', ['Rent', 'Utilities']],
  ['Food', ['Groceries', 'Dining Out']],
  ['Transportation', ['Gas', 'Car Maintenance']],
  ['Personal', ['Pocket Money', 'Clothing']],
  ['Debt', ['Debt Payments']],
];

const shortDate = (date) =>
  new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Envelopes grouped the way they were set up, groups in first-seen order.
function grouped(envelopes) {
  const groups = new Map();
  for (const e of [...envelopes].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) {
    const name = e.group || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  return groups;
}

// Set how much goes into an envelope for the week on screen.
function setAssigned(envelopeId, amount) {
  const existing = db.all('assign').filter((a) => a.week === week && a.envelopeId === envelopeId);
  const [first, ...extras] = existing;
  for (const extra of extras) db.remove(extra.id);
  db.put('assign', { ...first, week, envelopeId, amount: amount ?? 0 });
  rerender();
}

// Brings in a setup file: accounts, envelopes, debts and bills. Items can
// point at each other by "key" (a debt's envelopeKey, a bill's accountKey);
// those are swapped for the real ids as everything is created.
async function loadSetupFile(file) {
  try {
    const setup = JSON.parse(await file.text());
    const ids = new Map();
    let sort = Date.now();
    const create = (kind, { key, envelopeKey, accountKey, ...record }) => {
      if (envelopeKey) record.envelopeId = ids.get(envelopeKey) || '';
      if (accountKey) record.accountId = ids.get(accountKey) || '';
      const id = db.put(kind, { ...record, sort: sort++ });
      if (key) ids.set(key, id);
    };
    for (const a of setup.accounts || []) create('account', { type: 'checking', startBalance: 0, startDate: today(), ...a });
    for (const e of setup.envelopes || []) create('envelope', e);
    for (const d of setup.debts || []) create('debt', { ...d, asOf: today(), asOfAt: Date.now() });
    for (const b of setup.bills || []) create('bill', b);
    rerender();
  } catch {
    alert("That file couldn't be read as a setup file.");
  }
}

function renderEmpty() {
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Set up your envelopes'),
    h('p', { class: 'muted' }, 'An envelope is a pot of money for one purpose: rent, groceries, gas. Start from a setup file made from your spreadsheet, or from a short common list you can edit.'),
    h(
      'div',
      { class: 'button-row' },
      h(
        'label',
        { class: 'button primary' },
        'Load my setup file',
        h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => e.target.files[0] && loadSetupFile(e.target.files[0]) })
      ),
      h(
        'button',
        {
          onclick: () => {
            let sort = Date.now();
            for (const [group, names] of STARTER) {
              for (const name of names) db.put('envelope', { name, group, plan: 0, sort: sort++ });
            }
            rerender();
          },
        },
        'Start with a common list'
      )
    )
  );
}

function renderEnvelope(e, row, target) {
  if (editing) {
    const update = (field, value) => { db.put('envelope', { ...e, [field]: value }); rerender(); };
    return h(
      'div',
      { class: 'envelope editing' },
      h('label', { class: 'field grow' }, h('span', {}, 'Name'), h('input', { type: 'text', value: e.name, data: { key: `name-${e.id}` }, onchange: (ev) => update('name', ev.target.value.trim() || e.name) })),
      h('label', { class: 'field grow' }, h('span', {}, 'Group'), h('input', { type: 'text', value: e.group || '', list: 'groups', data: { key: `group-${e.id}` }, onchange: (ev) => update('group', ev.target.value.trim()) })),
      // An envelope that pays bills takes its target from them.
      target.bills.length > 0
        ? h('label', { class: 'field' }, h('span', {}, 'Monthly target'), h('input', { type: 'text', value: money(target.amount), disabled: true, title: 'Set by the bills paid from this envelope. Change the bill to change this.' }))
        : numberField('Monthly target', e.plan || '', (v) => update('plan', v ?? 0), { key: `plan-${e.id}` }),
      // Optional savings goal: an amount to build up to, and by when.
      numberField('Goal amount', e.goalAmount || '', (v) => update('goalAmount', v ?? 0), { key: `goal-${e.id}`, placeholder: 'None' }),
      h('label', { class: 'field' }, h('span', {}, 'Goal date'), h('input', { type: 'date', value: e.goalDate || '', data: { key: `goald-${e.id}` }, onchange: (ev) => update('goalDate', ev.target.value) })),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (Math.abs(row.available) >= 0.005) {
              return alert(`${e.name} still has ${money(row.available)} in it. Change what's assigned so it's at $0.00, then remove it.`);
            }
            db.put('envelope', { ...e, archived: true });
            rerender();
          },
        },
        'Remove'
      )
    );
  }

  // One compact line: name, the box to assign into, and what's available.
  // Spending and progress sit underneath in small print, only when there's
  // something to say.
  const notes = [
    row.spent !== 0 && `Spent ${money(row.spent)}`,
    target.amount > 0 && `${whole(row.assignedMonth)} of ${whole(target.amount)}/mo`,
  ].filter(Boolean);
  const goal = goalStatus({ amount: e.goalAmount, date: e.goalDate }, row.available, today());
  if (goal) {
    notes.push(
      goal.reached
        ? `Goal of ${whole(goal.target)} reached`
        : `Goal ${whole(goal.target)}` + (goal.late ? ', past its date' : goal.perWeek ? `: ${money(goal.perWeek)} a week gets there by ${shortDate(e.goalDate)}` : `: ${whole(goal.remaining)} to go`)
    );
  }
  return h(
    'div',
    { class: 'envelope' },
    h(
      'div',
      { class: 'envelope-name' },
      h('div', {}, e.name),
      notes.length > 0 && h('div', { class: 'muted small' }, notes.join(' · ')),
      goal && h('span', { class: 'meter', role: 'img', 'aria-label': `${Math.round(goal.share * 100)}% of the goal` }, h('span', { style: `width:${goal.share * 100}%` }))
    ),
    h('input', {
      type: 'number',
      step: 'any',
      inputMode: 'decimal',
      placeholder: '0.00',
      'aria-label': `Assign to ${e.name}`,
      value: row.assigned || '',
      data: { key: `assign-${e.id}` },
      onchange: (ev) => setAssigned(e.id, num(ev.target.value)),
    }),
    h('span', { class: 'pill ' + (row.available < -0.004 ? 'neg' : row.available > 0.004 ? 'pos' : 'muted'), title: 'Available' }, money(row.available))
  );
}

export function renderBudget() {
  const allEnvelopes = db.all('envelope');
  const envelopes = allEnvelopes.filter((e) => !e.archived);
  if (envelopes.length === 0) return [renderEmpty()];

  const budget = budgetFor(
    { envelopes: allEnvelopes, transactions: db.all('tx'), assignments: db.all('assign'), accounts: db.all('account') },
    week
  );
  const left = budget.leftToAssign;
  const targets = monthlyTargets(envelopes, db.all('bill'));

  const nav = h(
    'div',
    { class: 'week-nav' },
    h('button', { 'aria-label': 'Previous week', onclick: () => { week = addDays(week, -7); rerender(); } }, '‹'),
    h(
      'div',
      {},
      h('strong', {}, `${shortDate(week)} – ${shortDate(addDays(week, 6))}`),
      week !== weekStart(today()) &&
        h('button', { class: 'link', onclick: () => { week = weekStart(today()); rerender(); } }, 'This week')
    ),
    h('button', { 'aria-label': 'Next week', onclick: () => { week = addDays(week, 7); rerender(); } }, '›')
  );

  const incomeAmount = h('input', { type: 'number', step: 'any', min: '0', inputMode: 'decimal', placeholder: 'Amount', required: true });
  const incomeFrom = h('input', { type: 'text', placeholder: 'From, e.g. Paycheck', required: true });
  const summary = h(
    'div',
    { class: 'card left ' + (left < -0.004 ? 'over' : left > 0.004 ? 'todo' : 'done') },
    h('div', { class: 'muted small' }, 'Left to assign'),
    h('div', { class: 'big' }, money(left)),
    h(
      'p',
      { class: 'small' },
      left < -0.004
        ? "You've assigned more than you have. Take some back out of an envelope."
        : left > 0.004
          ? 'Give every dollar a job: keep assigning until this reaches $0.00.'
          : 'Every dollar has a job.'
    ),
    incomeOpen
      ? h(
          'form',
          {
            class: 'income-form',
            onsubmit: (ev) => {
              ev.preventDefault();
              const amount = num(incomeAmount.value);
              if (!(amount > 0)) return;
              const now = today();
              db.put('tx', {
                date: now >= week && now <= addDays(week, 6) ? now : week,
                payee: incomeFrom.value.trim(),
                amount,
                envelopeId: 'income',
                created: Date.now(),
              });
              incomeOpen = false;
              rerender();
            },
          },
          incomeAmount,
          incomeFrom,
          h('button', { type: 'submit' }, 'Add income')
        )
      : h('button', { class: 'link', onclick: () => { incomeOpen = true; rerender(); } }, '+ Add income'),
    budget.incomeThisWeek > 0 && h('p', { class: 'muted small' }, `Income this week: ${money(budget.incomeThisWeek)}`)
  );

  const todo =
    budget.needsEnvelope > 0 &&
    h(
      'button',
      { class: 'card notice', onclick: () => goTo('tx') },
      `${budget.needsEnvelope} transaction${budget.needsEnvelope === 1 ? ' needs' : 's need'} an envelope ›`
    );

  const open = openGroups();
  let quietCount = 0;
  const groups = [...grouped(envelopes)].map(([name, all]) => {
    const quiet = all.filter((e) => isQuiet(budget.rows.get(e.id), targets.get(e.id), e));
    quietCount += quiet.length;
    // While editing, show everything so anything can be renamed or removed.
    const list = editing || showQuiet ? all : all.filter((e) => !quiet.includes(e));
    if (list.length === 0) return null;

    const available = all.reduce((sum, e) => sum + budget.rows.get(e.id).available, 0);
    const assigned = all.reduce((sum, e) => sum + budget.rows.get(e.id).assigned, 0);
    const overspent = all.some((e) => budget.rows.get(e.id).available < -0.004);
    return h(
      'details',
      {
        class: 'card group',
        open: editing || open.has('*') || open.has(name) || undefined,
        ontoggle: (ev) => {
          // Remember the choice. "All open" becomes a plain list first so
          // closing one group doesn't close the rest.
          const now = openGroups();
          if (now.has('*')) {
            now.delete('*');
            for (const g of grouped(envelopes).keys()) now.add(g);
          }
          if (ev.target.open) now.add(name);
          else now.delete(name);
          saveOpenGroups(now);
        },
      },
      h(
        'summary',
        {},
        h('span', { class: 'group-name' }, name, h('span', { class: 'muted small' }, ` (${list.length})`)),
        h(
          'span',
          { class: 'group-totals' },
          assigned !== 0 && h('span', { class: 'muted small' }, `${money(assigned)} assigned`),
          h('span', { class: 'pill ' + (overspent ? 'neg' : available > 0.004 ? 'pos' : 'muted') }, money(available))
        )
      ),
      list.map((e) => renderEnvelope(e, budget.rows.get(e.id), targets.get(e.id)))
    );
  });
  const groupNames = [...grouped(envelopes).keys()];
  const allOpen = open.has('*') || groupNames.every((g) => open.has(g));

  const name = h('input', { type: 'text', placeholder: 'New envelope', required: true });
  const group = h('input', { type: 'text', placeholder: 'Group', list: 'groups' });
  const addForm = h(
    'form',
    {
      class: 'card add-envelope',
      onsubmit: (ev) => {
        ev.preventDefault();
        if (!name.value.trim()) return;
        db.put('envelope', { name: name.value.trim(), group: group.value.trim(), plan: 0, sort: Date.now() });
        rerender();
      },
    },
    name,
    group,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );

  return [
    nav,
    summary,
    todo,
    !editing &&
      h(
        'div',
        { class: 'budget-tools' },
        h('button', { class: 'link', onclick: () => { saveOpenGroups(allOpen ? [] : ['*']); rerender(); } }, allOpen ? 'Collapse all' : 'Expand all'),
        quietCount > 0 &&
          h('button', { class: 'link', onclick: () => { showQuiet = !showQuiet; rerender(); } }, showQuiet ? 'Hide unused envelopes' : `Show ${quietCount} unused`)
      ),
    ...groups,
    editing && h('p', { class: 'muted small' }, 'Monthly target is optional: roughly what you mean to put in that envelope each month. A goal is for saving up: set an amount (and a date if there is one) and the envelope shows how far along it is and what to set aside each week. If bills are paid from an envelope, its target is worked out from them (a $72 bill every 3 months counts as $24 a month) and is changed on the Bills tab. It moves no money. It only lets the app show how far along you are ("$200 of $440 this month") and where the gaps are on the Overview.'),
    h('datalist', { id: 'groups' }, [...grouped(envelopes).keys()].map((g) => h('option', { value: g }))),
    h(
      'div',
      { class: 'button-row' },
      h('button', { onclick: () => { editing = !editing; rerender(); } }, editing ? 'Done editing' : 'Edit envelopes')
    ),
    editing && addForm,
  ];
}
