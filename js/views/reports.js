// Reports: how income and spending have gone month by month, and where the
// money went.

import { h, money, rerender } from '../ui.js';
import { today, addMonths, monthsEnding, monthlyReport } from '../money.js';
import * as db from '../db.js';

let month = today().slice(0, 7);
const openGroups = new Set();

const monthName = (m, style = 'long') =>
  new Date(m + '-01T00:00:00Z').toLocaleDateString('en-US', { month: style, year: 'numeric', timeZone: 'UTC' });
const shift = (m, by) => addMonths(m + '-01', by).slice(0, 7);

export function renderReports() {
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
  // Compare with the three months before, but only ones that have anything
  // recorded, so a first month isn't measured against empty ones.
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
        h(
          'summary',
          {},
          h('span', { class: 'report-name' }, g.name, h('span', { class: 'muted small' }, ` ${compare(g.now, g.avg)}`)),
          h('strong', {}, money(g.now))
        ),
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
