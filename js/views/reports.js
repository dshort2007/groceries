// Reports: how income and spending have gone by month and by year, where
// the money went, and net worth over time.

import { h, money, rerender } from '../ui.js';
import { today, addMonths, monthsEnding, monthlyReport, netWorth, billMonthly } from '../money.js';
import { stableId } from '../storage.js';
import * as db from '../db.js';

let mode = 'month'; // or 'year', 'worth'
let month = today().slice(0, 7);
const openGroups = new Set();

const monthName = (m, style = 'long') =>
  new Date(m + '-01T00:00:00Z').toLocaleDateString('en-US', { month: style, year: 'numeric', timeZone: 'UTC' });
const shift = (m, by) => addMonths(m + '-01', by).slice(0, 7);
const longDay = (date) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Once a month the app notes down where things stand, so net worth can be
// followed over time. Called when the app opens; it only writes when the
// figures have changed, and keeps one note per month (the latest).
export function recordSnapshot() {
  const accounts = db.all('account');
  const debts = db.all('debt');
  if (accounts.length === 0 && debts.length === 0) return;
  const now = netWorth(accounts, db.all('tx'), debts);
  const id = stableId('snapshot:' + today().slice(0, 7));
  const old = db.get(id);
  if (old && old.cash === now.cash && old.owed === now.owed) return;
  db.put('snapshot', { id, month: today().slice(0, 7), ...now, taken: today() });
}

function renderTabs() {
  return h(
    'div',
    { class: 'subtabs' },
    [['month', 'By month'], ['year', 'By year'], ['worth', 'Net worth']].map(([id, label]) => h('button', { class: id === mode ? 'on' : null, onclick: () => { mode = id; rerender(); } }, label))
  );
}

// ---------- By month ----------

function renderMonth() {
  const now = today().slice(0, 7);
  const months = monthsEnding(month, 6);
  const report = monthlyReport(db.all('envelope'), db.all('tx'), months);
  const hasData = report.months.some((m) => m.income !== 0 || m.spent !== 0);

  const nav = h(
    'div',
    { class: 'week-nav' },
    h('button', { 'aria-label': 'Previous month', onclick: () => { month = shift(month, -1); rerender(); } }, '‹'),
    h('div', {}, h('strong', {}, monthName(month)), month !== now && h('button', { class: 'link', onclick: () => { month = now; rerender(); } }, 'This month')),
    h('button', { 'aria-label': 'Next month', disabled: month >= now, onclick: () => { month = shift(month, 1); rerender(); } }, '›')
  );
  if (!hasData) {
    return [nav, h('p', { class: 'empty' }, 'Nothing to report for these months yet. Reports fill in as transactions are filed into envelopes.')];
  }

  // ---- Income against spending, six months ----
  const overview = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Income and spending'),
    h(
      'table',
      { class: 'report' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'right' }, 'Income'), h('th', { class: 'right' }, 'Spent'), h('th', { class: 'right' }, 'Left over'))),
      h(
        'tbody',
        {},
        report.months.map((m) =>
          h(
            'tr',
            { class: m.month === month ? 'is-best' : null },
            h('td', {}, monthName(m.month, 'short')),
            h('td', { class: 'right' }, money(m.income)),
            h('td', { class: 'right' }, money(m.spent)),
            h('td', { class: 'right ' + (m.net < -0.004 ? 'neg' : '') }, money(m.net))
          )
        )
      )
    ),
    h('p', { class: 'muted small' }, 'Spending is everything filed into an envelope, with refunds taken off. Transfers and transactions with no envelope are left out.')
  );

  // ---- Where it went this month, against the three months before ----
  // Compare only with months that have anything recorded, so a first month
  // isn't measured against empty ones.
  const active = new Set(report.months.filter((m) => m.spent > 0 || m.income > 0).map((m) => m.month));
  const earlier = months.slice(2, 5).filter((m) => active.has(m));
  const usual = (byMonth) => (earlier.length ? earlier.reduce((sum, m) => sum + (byMonth[m] || 0), 0) / earlier.length : 0);
  const compare = (now_, avg) => {
    if (earlier.length === 0 || (avg < 1 && now_ < 1)) return '';
    const diff = now_ - avg;
    if (Math.abs(diff) < Math.max(5, avg * 0.1)) return 'about usual';
    return `${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than usual`;
  };
  const groups = report.groups
    .map((g) => ({ ...g, now: g.byMonth[month] || 0, avg: usual(g.byMonth) }))
    .filter((g) => g.now > 0.004 || g.avg > 0.004)
    .sort((a, b) => b.now - a.now);
  const total = groups.reduce((sum, g) => sum + g.now, 0);

  const breakdown = h(
    'div',
    { class: 'card' },
    h('div', { class: 'list-head' }, h('h2', {}, `Where it went in ${monthName(month, 'long').split(' ')[0]}`), h('strong', {}, money(total))),
    groups.length === 0 && h('p', { class: 'muted' }, 'No spending filed this month.'),
    groups.map((g) =>
      h(
        'details',
        { class: 'report-group', open: openGroups.has(g.name) || undefined, ontoggle: (e) => (e.target.open ? openGroups.add(g.name) : openGroups.delete(g.name)) },
        h('summary', {}, h('span', { class: 'report-name' }, g.name, h('span', { class: 'muted small' }, ` ${compare(g.now, g.avg)}`)), h('strong', {}, money(g.now))),
        total > 0 && h('span', { class: 'meter', role: 'img', 'aria-label': `${Math.round((g.now / total) * 100)}% of the month's spending` }, h('span', { style: `width:${Math.max(0, (g.now / total) * 100)}%` })),
        g.envelopes
          .map((e) => ({ ...e, now: e.byMonth[month] || 0, avg: usual(e.byMonth) }))
          .filter((e) => e.now > 0.004 || e.avg > 0.004)
          .sort((a, b) => b.now - a.now)
          .map((e) => h('div', { class: 'tx-line report-env' }, h('span', {}, e.name, earlier.length > 0 && h('span', { class: 'muted small' }, ` usually ${money(e.avg)}`)), h('span', {}, money(e.now))))
      )
    ),
    earlier.length > 0 && h('p', { class: 'muted small' }, `"Usual" is the average of ${earlier.map((m) => monthName(m, 'short').split(' ')[0]).join(', ')}.`)
  );

  // ---- Top payees ----
  const payees = (report.payees[month] || []).slice(0, 8);
  const top =
    payees.length > 0 &&
    h('div', { class: 'card' }, h('h2', {}, 'Biggest payees'), payees.map((p) => h('div', { class: 'tx-line report-env' }, h('span', {}, p.payee), h('span', {}, money(p.spent)))));

  return [nav, overview, breakdown, top];
}

// ---------- By year ----------

function renderYear() {
  const thisYear = today().slice(0, 4);
  const year = month.slice(0, 4);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const report = monthlyReport(db.all('envelope'), db.all('tx'), months);
  const sum = (byMonth) => months.reduce((total, m) => total + (byMonth[m] || 0), 0);
  // Averages are over the months that have anything in them, so a year
  // that's only two months old isn't divided by twelve.
  const activeMonths = Math.max(1, report.months.filter((m) => m.income !== 0 || m.spent !== 0).length);
  const income = report.months.reduce((t, m) => t + m.income, 0);
  const spent = report.months.reduce((t, m) => t + m.spent, 0);

  const nav = h(
    'div',
    { class: 'week-nav' },
    h('button', { 'aria-label': 'Previous year', onclick: () => { month = shift(month, -12); rerender(); } }, '‹'),
    h('div', {}, h('strong', {}, year), year !== thisYear && h('button', { class: 'link', onclick: () => { month = today().slice(0, 7); rerender(); } }, 'This year')),
    h('button', { 'aria-label': 'Next year', disabled: year >= thisYear, onclick: () => { month = shift(month, 12); rerender(); } }, '›')
  );

  const totals = h(
    'div',
    { class: 'card left ' + (income - spent < -0.004 ? 'over' : 'done') },
    h('div', { class: 'muted small' }, `Left over in ${year}`),
    h('div', { class: 'big' }, money(income - spent)),
    h('p', { class: 'small' }, `${money(income)} in, ${money(spent)} spent, across ${activeMonths} month${activeMonths === 1 ? '' : 's'} with anything recorded.`)
  );

  const groups = report.groups.map((g) => ({ ...g, total: sum(g.byMonth) })).filter((g) => g.total > 0.004).sort((a, b) => b.total - a.total);
  const breakdown = h(
    'div',
    { class: 'card' },
    h('div', { class: 'list-head' }, h('h2', {}, `Where it went in ${year}`), h('strong', {}, money(spent))),
    groups.length === 0 && h('p', { class: 'muted' }, 'No spending filed this year.'),
    groups.map((g) =>
      h(
        'details',
        { class: 'report-group', open: openGroups.has('y' + g.name) || undefined, ontoggle: (e) => (e.target.open ? openGroups.add('y' + g.name) : openGroups.delete('y' + g.name)) },
        h('summary', {}, h('span', { class: 'report-name' }, g.name, h('span', { class: 'muted small' }, ` ${money(g.total / activeMonths)} a month`)), h('strong', {}, money(g.total))),
        spent > 0 && h('span', { class: 'meter', role: 'img', 'aria-label': `${Math.round((g.total / spent) * 100)}% of the year's spending` }, h('span', { style: `width:${Math.max(0, (g.total / spent) * 100)}%` })),
        g.envelopes
          .map((e) => ({ ...e, total: sum(e.byMonth) }))
          .filter((e) => e.total > 0.004)
          .sort((a, b) => b.total - a.total)
          .map((e) => h('div', { class: 'tx-line report-env' }, h('span', {}, e.name, h('span', { class: 'muted small' }, ` ${money(e.total / activeMonths)} a month`)), h('span', {}, money(e.total))))
      )
    )
  );

  // ---- Costs that don't come every month: the ones that catch people out ----
  const rare = db
    .all('bill')
    .filter((b) => !b.monthDays?.length && !(Number(b.days) > 0) && (Number(b.every) || 1) >= 3 && Number(b.amount) > 0)
    .sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1));
  const occasional =
    rare.length > 0 &&
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Bills that don\'t come every month'),
      rare.map((b) =>
        h('div', { class: 'tx-line report-env' }, h('span', {}, b.name, h('span', { class: 'muted small' }, ` next ${longDay(b.nextDue)} · ${money(billMonthly(b))} a month set aside covers it`)), h('span', {}, money(Number(b.amount))))
      ),
      h('p', { class: 'muted small' }, 'Putting the monthly amount into each one\'s envelope means the money is already there when the bill arrives.')
    );

  return [nav, totals, breakdown, occasional];
}

// ---------- Net worth ----------

function renderWorth() {
  recordSnapshot(); // make sure this month is on the list
  const now = netWorth(db.all('account'), db.all('tx'), db.all('debt'));
  const history = db.all('snapshot').sort((a, b) => (a.month < b.month ? 1 : -1));
  const first = history.at(-1);

  const summary = h(
    'div',
    { class: 'card left ' + (now.net < -0.004 ? 'todo' : 'done') },
    h('div', { class: 'muted small' }, 'Net worth'),
    h('div', { class: 'big' }, money(now.net)),
    h('p', { class: 'small' }, `${money(now.cash)} in your accounts, minus ${money(now.owed)} owed.`),
    first && history.length > 1 && h('p', { class: 'small' }, `${now.net - first.net >= 0 ? 'Up' : 'Down'} ${money(Math.abs(now.net - first.net))} since ${monthName(first.month)}.`)
  );

  const table = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Month by month'),
    history.length === 0
      ? h('p', { class: 'muted' }, 'The app notes these figures down each month from now on, so this fills in over time.')
      : h(
          'table',
          { class: 'report' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'right' }, 'In accounts'), h('th', { class: 'right' }, 'Owed'), h('th', { class: 'right' }, 'Net worth'))),
          h(
            'tbody',
            {},
            history.map((s, i) => {
              const before = history[i + 1];
              const change = before ? s.net - before.net : null;
              return h(
                'tr',
                {},
                h('td', {}, monthName(s.month, 'short')),
                h('td', { class: 'right' }, money(s.cash)),
                h('td', { class: 'right' }, money(s.owed)),
                h('td', { class: 'right' }, money(s.net), change !== null && h('div', { class: 'small ' + (change >= 0 ? 'pos' : 'neg') }, `${change >= 0 ? '+' : '−'}${money(Math.abs(change))}`))
              );
            })
          )
        ),
    h('p', { class: 'muted small' }, 'Accounts are your checking, savings and cash. Credit cards are left out of that side and counted from the Debts tab instead, so they aren\'t counted twice. Each month keeps the latest figures seen during it.')
  );

  return [summary, table];
}

export function renderReports() {
  const views = { month: renderMonth, year: renderYear, worth: renderWorth };
  return [renderTabs(), ...views[mode]()];
}
