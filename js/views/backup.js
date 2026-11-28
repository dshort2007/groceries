// Backup: a copy of everything in a file you keep, a spreadsheet of the
// transactions, and a way to put a backup back.

import { h, download, rerender } from '../ui.js';
import { today } from '../money.js';
import { envelopeName } from './shared.js';
import * as db from '../db.js';

let message = '';

// One spreadsheet cell, quoted so commas and quotes inside it survive.
const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

function transactionsCsv() {
  const rows = [['Date', 'Payee', 'Amount', 'Envelope', 'Account', 'Pending']];
  const txs = db.all('tx').sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const t of txs) {
    const account = db.get(t.accountId)?.name || '';
    // A split purchase becomes one row per envelope.
    const pieces = t.splits?.length ? t.splits : [{ envelopeId: t.envelopeId, amount: t.amount }];
    for (const p of pieces) rows.push([t.date, t.payee, Number(p.amount).toFixed(2), p.envelopeId ? envelopeName(p.envelopeId) : '', account, t.pending ? 'yes' : '']);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

async function restore(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.app !== 'family-budget' || !Array.isArray(backup.records)) throw new Error('not a backup');
    if (!confirm(`Restore ${backup.records.length} records from the backup made on ${backup.made}? Anything in the backup replaces what is here now. Things added since the backup are kept.`)) return;
    message = `Restored ${db.importAll(backup.records)} records.`;
  } catch {
    message = "That file isn't a Family Budget backup.";
  }
  rerender();
}

export function renderBackup() {
  const records = db.exportAll();
  return [
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Back up everything'),
      h('p', { class: 'muted' }, `Saves all ${records.length} records (envelopes, transactions, bills, debts, groceries, settings) to a file on this device. Keep it somewhere safe: it contains your financial details.`),
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              download(`family-budget-backup-${today()}.json`, JSON.stringify({ app: 'family-budget', made: today(), records }), 'application/json');
              message = 'Backup saved to your downloads.';
              rerender();
            },
          },
          'Download a backup'
        )
      ),
      h('p', { class: 'muted small' }, 'It does not include your sign-ins or bank connections; those stay with Supabase and Plaid.')
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Transactions as a spreadsheet'),
      h('p', { class: 'muted' }, 'A CSV file that opens in Excel or Numbers, one row per transaction (split purchases get a row per envelope).'),
      h('div', { class: 'button-row' }, h('button', { onclick: () => download(`transactions-${today()}.csv`, transactionsCsv(), 'text/csv') }, 'Download transactions'))
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Restore from a backup'),
      h('p', { class: 'muted' }, 'Puts back everything in a backup file. Use it if something was changed or removed by mistake.'),
      h('input', { type: 'file', accept: '.json,application/json', onchange: (e) => e.target.files[0] && restore(e.target.files[0]) })
    ),
    message && h('p', { class: 'card' }, message),
  ];
}
