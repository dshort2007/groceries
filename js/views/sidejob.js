// Side business income: log each job and see how it divides between the
// business, family savings and personal pay.

import { h, money, num, numberField, rerender } from '../ui.js';
import { today, splitJob } from '../money.js';
import * as db from '../db.js';

const SETTINGS_ID = '00000000-0000-4000-8000-000000000003';
const DEFAULTS = { name: 'Side business', business: 50, family: 50 };

let settingsOpen = false; // stays open while you change more than one number

export const sideJobSettings = () => ({ ...DEFAULTS, ...db.get(SETTINGS_ID), id: SETTINGS_ID });

const shortDate = (date) =>
  new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function renderSplit(split) {
  const cell = (label, value) => h('div', { class: 'split-cell' }, h('span', { class: 'muted small' }, label), h('strong', {}, money(value)));
  return h('div', { class: 'split-row' }, cell('Business', split.business), cell('Family savings', split.family), cell('Personal pay', split.personal));
}

function renderSettings(settings) {
  const update = (changes) => { db.put('settings', { ...settings, ...changes }); rerender(); };
  const personal = 100 - settings.business - settings.family;
  return h(
    'details',
    { class: 'card', open: settingsOpen || personal < 0 || undefined, ontoggle: (e) => (settingsOpen = e.target.open) },
    h('summary', {}, 'How each job is divided', h('span', { class: 'muted' }, ` ${settings.business}% / ${settings.family}% / ${Math.max(0, personal)}%`)),
    h(
      'div',
      { class: 'fields wrap' },
      numberField('Business %', settings.business, (v) => update({ business: Math.max(0, v ?? 0) }), { key: 'pct-business' }),
      numberField('Family savings %', settings.family, (v) => update({ family: Math.max(0, v ?? 0) }), { key: 'pct-family' }),
      h('label', { class: 'field' }, h('span', {}, 'Personal pay %'), h('input', { type: 'text', value: String(Math.max(0, personal)), disabled: true, title: 'Whatever is left after the other two.' }))
    ),
    personal < 0 && h('p', { class: 'warn' }, 'Business and family savings add up to more than 100%.'),
    h('p', { class: 'muted small' }, 'Personal pay is whatever is left after the other two. Changing these only affects jobs you add from now on; earlier jobs keep the split they were entered with.'),
    h('label', { class: 'field' }, h('span', {}, 'Name of the business'), h('input', { type: 'text', value: settings.name, onchange: (e) => update({ name: e.target.value.trim() || DEFAULTS.name }) }))
  );
}

function renderAddForm(settings) {
  const date = h('input', { type: 'date', value: today(), required: true, 'aria-label': 'Date' });
  const client = h('input', { type: 'text', placeholder: 'Client or job', required: true });
  const preview = h('div', {});
  const total = h('input', {
    type: 'number',
    step: 'any',
    min: '0',
    inputMode: 'decimal',
    placeholder: 'Total paid',
    required: true,
    // Show the split as the amount is typed.
    oninput: () => preview.replaceChildren(...(num(total.value) > 0 ? [renderSplit(splitJob(num(total.value), settings))] : [])),
  });

  return h(
    'form',
    {
      class: 'card tx-form',
      onsubmit: (e) => {
        e.preventDefault();
        const amount = num(total.value);
        if (!(amount > 0)) return;
        db.put('job', { date: date.value, client: client.value.trim(), total: amount, ...splitJob(amount, settings), created: Date.now() });
        rerender();
      },
    },
    h('h2', {}, 'Add a job'),
    h('div', { class: 'fields wrap' }, date, total),
    client,
    preview,
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );
}

function renderJob(job) {
  return h(
    'div',
    { class: 'tx' },
    h(
      'div',
      { class: 'tx-line' },
      h('span', {}, h('strong', {}, job.client || '(no name)'), h('span', { class: 'muted small' }, ` · ${shortDate(job.date)}`)),
      h('strong', {}, money(job.total))
    ),
    renderSplit(job),
    h(
      'div',
      { class: 'tx-line' },
      job.incomeTxId && db.get(job.incomeTxId)
        ? h('span', { class: 'muted small' }, 'Family share added to the budget.')
        : job.family > 0
          ? h(
              'button',
              {
                onclick: () => {
                  // Puts the family share into "Left to assign" on the Budget tab.
                  const incomeTxId = db.put('tx', { date: job.date, payee: `${sideJobSettings().name}: ${job.client}`, amount: job.family, envelopeId: 'income', created: Date.now() });
                  db.put('job', { ...job, incomeTxId });
                  rerender();
                },
              },
              `Add ${money(job.family)} to the budget as income`
            )
          : h('span', {}),
      h('button', { class: 'link danger', onclick: () => { if (confirm(`Remove the ${job.client} job?`)) { db.remove(job.id); rerender(); } } }, 'Remove')
    )
  );
}

export function renderSideJob() {
  const settings = sideJobSettings();
  const jobs = db.all('job').sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created ?? 0) - (a.created ?? 0)));
  const year = today().slice(0, 4);
  const sumOf = (list) => list.reduce((t, j) => ({ total: t.total + j.total, business: t.business + j.business, family: t.family + j.family, personal: t.personal + j.personal }), { total: 0, business: 0, family: 0, personal: 0 });
  const thisYear = sumOf(jobs.filter((j) => j.date.startsWith(year)));
  const all = sumOf(jobs);

  const totals =
    jobs.length > 0 &&
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'list-head' }, h('h2', {}, `${year} so far`), h('strong', {}, money(thisYear.total))),
      renderSplit(thisYear),
      all.total !== thisYear.total && h('div', { class: 'list-head all-time' }, h('span', { class: 'muted' }, 'All time'), h('span', { class: 'muted' }, money(all.total))),
      all.total !== thisYear.total && renderSplit(all)
    );

  return [
    totals,
    renderAddForm(settings),
    renderSettings(settings),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Jobs'),
      jobs.length === 0 && h('p', { class: 'empty' }, 'No jobs yet. Add one above to see how it divides.'),
      jobs.map(renderJob)
    ),
  ];
}
