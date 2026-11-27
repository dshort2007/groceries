// Accounts and the money moving through them: add by hand, import a bank
// file, file into envelopes, split across envelopes.

import { h, money, num, numberField, rerender } from '../ui.js';
import { today, readBankCsv, payeeKey, accountBalances } from '../money.js';
import { envelopeSelect, accountSelect, accounts, envelopeName } from './shared.js';
import * as db from '../db.js';

let onlyUnfiled = false;
let limit = 100;
let editingAccount = null;
let draft = null; // the transaction being edited, with unsaved changes
let pending = null; // a bank file that's been read but not imported yet
let importAccount = '';

const TYPES = [['checking', 'Checking'], ['savings', 'Savings'], ['credit', 'Credit card'], ['cash', 'Cash']];
const rules = () => new Map(db.all('rule').map((r) => [r.key, r]));

// Remember which envelope this payee goes in, for next time.
function learn(payee, envelopeId) {
  const key = payeeKey(payee);
  if (!key || !envelopeId || envelopeId === 'split') return;
  const existing = rules().get(key);
  if (existing?.envelopeId !== envelopeId) db.put('rule', { ...existing, key, envelopeId });
}

// ---------- Accounts ----------

function renderAccount(a, balance, used) {
  const credit = a.type === 'credit';
  if (editingAccount !== a.id) {
    return h(
      'div',
      { class: 'tx-line account' },
      h('span', {}, a.name, h('span', { class: 'muted small' }, ` · ${TYPES.find(([t]) => t === a.type)?.[1] || 'Account'}`)),
      h('span', {}, h('strong', { class: balance < -0.004 ? 'neg' : null }, money(balance)), h('button', { class: 'link', onclick: () => { editingAccount = a.id; rerender(); } }, 'Edit'))
    );
  }

  const update = (changes) => { db.put('account', { ...a, ...changes }); rerender(); };
  const bank = h('input', { type: 'number', step: 'any', inputMode: 'decimal', placeholder: credit ? 'Owed, per the bank' : 'Balance, per the bank' });
  return h(
    'div',
    { class: 'tx editing' },
    h(
      'div',
      { class: 'fields wrap' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: a.name, onchange: (e) => update({ name: e.target.value.trim() || a.name }) })),
      h('label', { class: 'field' }, h('span', {}, 'Type'), h('select', { onchange: (e) => update({ type: e.target.value, startBalance: 0 }) }, TYPES.map(([v, label]) => h('option', { value: v, selected: v === a.type }, label)))),
      numberField(credit ? 'Owed when you started' : 'Balance when you started', credit ? -a.startBalance || '' : a.startBalance || '', (v) => update({ startBalance: credit ? -Math.abs(v ?? 0) : v ?? 0 }))
    ),
    h('p', { class: 'muted small' }, `The app says ${money(balance)}. If the bank says something different, enter the bank's number and the app adds one correcting transaction for the difference.`),
    h(
      'div',
      { class: 'fields wrap' },
      bank,
      h(
        'button',
        {
          onclick: () => {
            const said = num(bank.value);
            if (said === null) return;
            const diff = Math.round(((credit ? -Math.abs(said) : said) - balance) * 100) / 100;
            if (diff === 0) return alert('It already matches.');
            db.put('tx', { date: today(), payee: 'Balance correction', amount: diff, envelopeId: '', accountId: a.id, created: Date.now() });
            rerender();
          },
        },
        'Match the bank'
      )
    ),
    h(
      'div',
      { class: 'button-row' },
      h('button', { class: 'primary', onclick: () => { editingAccount = null; rerender(); } }, 'Done'),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (used) return alert(`${a.name} has transactions in it, so it can't be removed.`);
            editingAccount = null;
            db.remove(a.id);
            rerender();
          },
        },
        'Remove'
      )
    )
  );
}

function renderAccounts(all) {
  const list = accounts();
  const balances = accountBalances(list, all);
  const used = new Set(all.map((t) => t.accountId));
  const cash = list.filter((a) => a.type !== 'credit').reduce((sum, a) => sum + balances.get(a.id), 0);

  const name = h('input', { type: 'text', placeholder: 'Add an account, e.g. Chime checking', required: true });
  const type = h('select', { 'aria-label': 'Type' }, TYPES.map(([v, label]) => h('option', { value: v }, label)));
  const start = h('input', { type: 'number', step: 'any', inputMode: 'decimal', placeholder: 'Balance now (owed, for a card)' });

  return h(
    'details',
    { class: 'card', open: list.length === 0 || editingAccount !== null || undefined },
    h('summary', {}, h('span', {}, 'Accounts'), list.length > 0 && h('span', { class: 'muted' }, ` ${money(cash)} in the bank`)),
    list.map((a) => renderAccount(a, balances.get(a.id), used.has(a.id))),
    h(
      'form',
      {
        class: 'account-form',
        onsubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          const amount = num(start.value) ?? 0;
          db.put('account', {
            name: name.value.trim(),
            type: type.value,
            startBalance: type.value === 'credit' ? -Math.abs(amount) : amount,
            startDate: today(),
            sort: Date.now(),
          });
          rerender();
        },
      },
      name,
      type,
      start,
      h('button', { type: 'submit', class: 'primary' }, 'Add')
    ),
    h('p', { class: 'muted small' }, "Money already in an account when you add it shows up in Left to assign on the Budget tab, ready to go into envelopes. If you've already added that money as income, enter 0 here.")
  );
}

// ---------- Adding ----------

function renderAddForm() {
  const date = h('input', { type: 'date', value: today(), required: true, 'aria-label': 'Date' });
  const payee = h('input', { type: 'text', placeholder: 'Where or who', required: true });
  const amount = h('input', { type: 'number', step: 'any', min: '0', inputMode: 'decimal', placeholder: 'Amount', required: true });
  let envelopeId = '';
  let from = '';
  let to = '';
  const envelope = envelopeSelect('', (v) => (envelopeId = v));
  const toAccount = accountSelect('', (v) => (to = v), { blank: 'To which account?', label: 'To account' });
  toAccount.hidden = true;
  const direction = h(
    'select',
    {
      'aria-label': 'Spent, received or moved',
      onchange: (e) => {
        // Moving money between accounts needs a second account, not an
        // envelope or a payee.
        const moving = e.target.value === 'move';
        toAccount.hidden = !moving;
        envelope.hidden = payee.hidden = moving;
        payee.required = !moving;
      },
    },
    h('option', { value: 'out' }, 'Spent'),
    h('option', { value: 'in' }, 'Received'),
    accounts().length > 1 && h('option', { value: 'move' }, 'Moved between accounts')
  );

  return h(
    'form',
    {
      class: 'card tx-form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const value = num(amount.value);
        if (!(value > 0)) return;
        const base = { date: date.value, created: Date.now() };
        if (direction.value === 'move') {
          if (!from || !to || from === to) return alert('Choose the account the money left and the one it went to.');
          db.put('tx', { ...base, payee: `Transfer to ${db.get(to).name}`, amount: -value, envelopeId: 'transfer', accountId: from });
          db.put('tx', { ...base, payee: `Transfer from ${db.get(from).name}`, amount: value, envelopeId: 'transfer', accountId: to });
        } else {
          const name = payee.value.trim();
          db.put('tx', {
            ...base,
            payee: name,
            amount: direction.value === 'out' ? -value : value,
            envelopeId: envelopeId || rules().get(payeeKey(name))?.envelopeId || '',
            accountId: from,
          });
          learn(name, envelopeId);
        }
        rerender();
      },
    },
    h('h2', {}, 'Add a transaction'),
    h('div', { class: 'fields wrap' }, date, direction, amount),
    payee,
    h('div', { class: 'fields wrap' }, envelope, accountSelect('', (v) => (from = v), { blank: 'Which account?' }), toAccount),
    h('button', { type: 'submit', class: 'primary' }, 'Add')
  );
}

function renderImport() {
  const picker = h('input', {
    type: 'file',
    accept: '.csv,text/csv',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      pending = { ...readBankCsv(await file.text()), name: file.name, flip: false };
      rerender();
    },
  });

  let preview = null;
  if (pending?.error) preview = h('div', {}, h('p', { class: 'warn' }, pending.error), h('button', { onclick: () => { pending = null; rerender(); } }, 'Try another file'));
  else if (pending) {
    const have = new Set(db.all('tx').map((t) => t.importKey).filter(Boolean));
    const fresh = pending.rows.filter((r) => !have.has(r.importKey));
    const sign = pending.flip ? -1 : 1;
    preview = h(
      'div',
      { class: 'preview' },
      h('p', {}, `${pending.name}: ${fresh.length} new, ${pending.rows.length - fresh.length} already imported.`),
      h(
        'ul',
        { class: 'tx-preview' },
        fresh.slice(0, 4).map((r) =>
          h('li', {}, h('span', {}, `${r.date} · ${r.payee}`), h('span', { class: r.amount * sign < 0 ? null : 'pos' }, money(r.amount * sign)))
        )
      ),
      h('p', { class: 'muted small' }, 'Check the examples: money you spent should show with a minus sign.'),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: pending.flip, onchange: (e) => { pending.flip = e.target.checked; rerender(); } }),
        "They're backwards, flip them"
      ),
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            class: 'primary',
            disabled: fresh.length === 0,
            onclick: () => {
              const known = rules();
              let created = Date.now();
              for (const r of fresh) {
                db.put('tx', {
                  date: r.date,
                  payee: r.payee,
                  amount: r.amount * sign,
                  envelopeId: known.get(payeeKey(r.payee))?.envelopeId || '',
                  accountId: importAccount,
                  importKey: r.importKey,
                  created: created++,
                });
              }
              pending = null;
              onlyUnfiled = true;
              rerender();
            },
          },
          `Import ${fresh.length}`
        ),
        h('button', { onclick: () => { pending = null; rerender(); } }, 'Cancel')
      )
    );
  }

  return h(
    'details',
    { class: 'card', open: !!pending || undefined },
    h('summary', {}, 'Import a bank file (CSV)'),
    h('p', { class: 'muted small' }, 'Download transactions from your bank or card as a CSV file and choose it here. Rows you already imported are skipped, so overlapping date ranges are fine.'),
    !pending && accountSelect(importAccount, (v) => (importAccount = v), { blank: 'Which account is this file from?' }),
    !pending && picker,
    preview
  );
}

// ---------- The list ----------

function renderEditor(t) {
  const set = (field) => (e) => (draft[field] = e.target.value);
  const left = h('strong', {});
  const showLeft = () => {
    const total = Math.abs(num(draft.amount) ?? 0);
    const used = draft.splits.reduce((sum, p) => sum + (num(p.amount) ?? 0), 0);
    const rest = Math.round((total - used) * 100) / 100;
    left.textContent = rest === 0 ? 'Fully split.' : `${money(rest)} left to split.`;
    left.className = rest === 0 ? 'pos' : 'neg';
  };

  let splitter = null;
  if (draft.splits) {
    splitter = h(
      'div',
      { class: 'splits' },
      draft.splits.map((p, i) =>
        h(
          'div',
          { class: 'split' },
          envelopeSelect(p.envelopeId, (v) => (p.envelopeId = v), { special: false }),
          h('input', { type: 'number', step: 'any', min: '0', inputMode: 'decimal', placeholder: 'Amount', value: p.amount, 'aria-label': 'Amount for this envelope', oninput: (e) => { p.amount = e.target.value; showLeft(); } }),
          h('button', { 'aria-label': 'Remove this row', onclick: () => { draft.splits.splice(i, 1); rerender(); } }, '×')
        )
      ),
      h('div', { class: 'tx-line' }, left, h('button', { class: 'link', onclick: () => { draft.splits.push({ envelopeId: '', amount: '' }); rerender(); } }, 'Add a row'))
    );
    showLeft();
  }

  const save = () => {
    const amount = num(draft.amount) ?? t.amount;
    const next = { ...t, date: draft.date || t.date, payee: draft.payee.trim(), amount, accountId: draft.accountId };
    if (draft.splits) {
      const rows = draft.splits.filter((p) => num(p.amount) > 0);
      const used = rows.reduce((sum, p) => sum + num(p.amount), 0);
      if (Math.abs(used - Math.abs(amount)) > 0.004) {
        return alert(`The rows add up to ${money(used)}, but the transaction is ${money(Math.abs(amount))}.`);
      }
      const sign = amount < 0 ? -1 : 1;
      if (rows.length > 1) {
        next.envelopeId = 'split';
        next.splits = rows.map((p) => ({ envelopeId: p.envelopeId, amount: sign * num(p.amount) }));
      } else {
        next.envelopeId = rows[0]?.envelopeId || '';
        delete next.splits;
      }
    } else if (t.splits) {
      next.envelopeId = '';
      delete next.splits;
    }
    draft = null;
    db.put('tx', next);
    rerender();
  };

  return h(
    'div',
    { class: 'tx editing' },
    h(
      'div',
      { class: 'fields wrap' },
      h('input', { type: 'date', value: draft.date, 'aria-label': 'Date', oninput: set('date') }),
      h('input', { type: 'number', step: 'any', inputMode: 'decimal', value: draft.amount, 'aria-label': 'Amount (minus for money spent)', oninput: (e) => { draft.amount = e.target.value; if (draft.splits) showLeft(); } })
    ),
    h('input', { type: 'text', value: draft.payee, 'aria-label': 'Where or who', oninput: set('payee') }),
    accountSelect(draft.accountId, (v) => (draft.accountId = v)),
    h('p', { class: 'muted small' }, 'Use a minus sign for money spent.'),
    splitter,
    h(
      'div',
      { class: 'button-row' },
      h('button', { class: 'primary', onclick: save }, 'Save'),
      draft.splits
        ? h('button', { onclick: () => { draft.splits = null; rerender(); } }, "Don't split")
        : h(
            'button',
            {
              onclick: () => {
                const real = t.envelopeId && t.envelopeId !== 'split' ? t.envelopeId : '';
                draft.splits = [{ envelopeId: real, amount: '' }, { envelopeId: '', amount: '' }];
                rerender();
              },
            },
            'Split across envelopes'
          ),
      h('button', { onclick: () => { draft = null; rerender(); } }, 'Cancel'),
      h('button', { class: 'danger', onclick: () => { draft = null; db.remove(t.id); rerender(); } }, 'Delete')
    )
  );
}

function renderRow(t) {
  if (draft?.id === t.id) return renderEditor(t);
  const account = db.get(t.accountId)?.name || t.account;
  const edit = () => {
    draft = {
      id: t.id,
      date: t.date,
      payee: t.payee || '',
      amount: t.amount,
      accountId: t.accountId || '',
      splits: t.splits ? t.splits.map((p) => ({ envelopeId: p.envelopeId, amount: Math.abs(p.amount) })) : null,
    };
    rerender();
  };

  return h(
    'div',
    { class: 'tx' },
    h(
      'div',
      { class: 'tx-line' },
      h('span', {}, h('span', { class: 'muted small' }, t.date.slice(5).replace('-', '/') + ' '), t.payee || '(no name)', account && h('span', { class: 'muted small' }, ` · ${account}`)),
      h('strong', { class: t.amount > 0 ? 'pos' : null }, money(t.amount))
    ),
    h(
      'div',
      { class: 'tx-line' },
      t.splits
        ? h('span', { class: 'small' }, 'Split: ', t.splits.map((p) => `${envelopeName(p.envelopeId)} ${money(Math.abs(p.amount))}`).join(' · '))
        : envelopeSelect(t.envelopeId, (v) => { learn(t.payee, v); db.put('tx', { ...t, envelopeId: v }); rerender(); }, { key: `env-${t.id}` }),
      h('button', { class: 'link', onclick: edit }, 'Edit')
    )
  );
}

export function renderTransactions() {
  const all = db.all('tx').sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created ?? 0) - (a.created ?? 0)));
  const unfiled = all.filter((t) => (t.splits ? t.splits.some((p) => !p.envelopeId) : !t.envelopeId));
  if (unfiled.length === 0) onlyUnfiled = false;
  const shown = onlyUnfiled ? unfiled : all;

  const list = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'list-head' },
      h('h2', {}, onlyUnfiled ? 'Need an envelope' : 'Transactions'),
      unfiled.length > 0 &&
        h('button', { class: 'link', onclick: () => { onlyUnfiled = !onlyUnfiled; rerender(); } }, onlyUnfiled ? 'Show all' : `${unfiled.length} need an envelope`)
    ),
    shown.length === 0 && h('p', { class: 'empty' }, 'Nothing here yet.'),
    shown.slice(0, limit).map(renderRow),
    shown.length > limit && h('div', { class: 'button-row' }, h('button', { onclick: () => { limit += 100; rerender(); } }, 'Show more'))
  );

  return [renderAccounts(all), renderAddForm(), renderImport(), list];
}
