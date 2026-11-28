// Pickers used on more than one tab.

import { h } from '../ui.js';
import * as db from '../db.js';

const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0);

// The envelope picker. Income and transfers are special choices.
export function envelopeSelect(value, onchange, { key, special = true, blank = 'Choose an envelope…', label = 'Envelope' } = {}) {
  const groups = new Map();
  for (const e of db.all('envelope').filter((e) => !e.archived || e.id === value).sort(bySort)) {
    const name = e.group || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  const option = (v, label) => h('option', { value: v, selected: v === (value || '') }, label);
  return h(
    'select',
    // Highlighted when it's asking for an answer, not when it's a filter.
    { class: value || !special || blank !== 'Choose an envelope…' ? null : 'unfiled', 'aria-label': label, data: key ? { key } : undefined, onchange: (e) => onchange(e.target.value) },
    option('', blank),
    special && option('income', 'Income (to assign)'),
    special && option('transfer', 'Transfer between our accounts'),
    [...groups].map(([name, list]) => h('optgroup', { label: name }, list.map((e) => option(e.id, e.name))))
  );
}

export const accounts = () => db.all('account').sort(bySort);

export function accountSelect(value, onchange, { key, blank = 'No account', label = 'Account' } = {}) {
  return h(
    'select',
    { 'aria-label': label, data: key ? { key } : undefined, onchange: (e) => onchange(e.target.value) },
    h('option', { value: '', selected: !value }, blank),
    accounts().map((a) => h('option', { value: a.id, selected: a.id === value }, a.name))
  );
}

export const envelopeName = (id) =>
  id === 'income' ? 'Income' : id === 'transfer' ? 'Transfer' : db.get(id)?.name || 'No envelope';
