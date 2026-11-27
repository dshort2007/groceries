// Automatic bank connections through Plaid. The browser never sees a bank
// password or Plaid's keys: signing in to the bank happens in Plaid's own
// window, and everything secret stays in the server-side function
// (supabase/functions/plaid).

import { h, money, rerender, rerenderWhenIdle } from '../ui.js';
import { today } from '../money.js';
import { accounts } from './shared.js';
import * as db from '../db.js';

const LINK_KEY = 'plaid-link';
const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

const state = { loaded: false, available: false, problem: '', items: [], busy: '', message: '' };
let startDate = today();

const call = (action, body = {}) => db.callFunction('plaid', { action, ...body });

let refreshing = null;
export function refreshBank() {
  // Several parts of the app may ask at once; only ask the server once.
  refreshing ??= loadStatus().finally(() => (refreshing = null));
  return refreshing;
}

async function loadStatus() {
  try {
    state.items = (await call('status')).items;
    state.available = true;
  } catch (err) {
    state.available = false;
    state.problem = err.message;
  }
  state.loaded = true;
  rerenderWhenIdle();
}

// Bank transactions arrive knowing only the bank's own account number.
// Once that's been matched to one of the app's accounts, fill it in.
function fillInAccounts() {
  const byBankId = new Map(accounts().filter((a) => a.plaidAccountId).map((a) => [a.plaidAccountId, a.id]));
  for (const t of db.all('tx')) {
    if (t.plaidAccountId && !t.accountId && byBankId.has(t.plaidAccountId)) {
      db.put('tx', { ...t, accountId: byBankId.get(t.plaidAccountId) });
    }
  }
}

export async function syncBank(force) {
  if (!state.available || state.items.length === 0 || state.busy) return;
  state.busy = 'Checking the bank…';
  rerenderWhenIdle();
  try {
    const result = await call('sync', { force });
    state.items = result.items;
    const bits = [
      result.added && `${result.added} new`,
      result.matched && `${result.matched} matched to ones you'd entered`,
      result.updated && `${result.updated} corrected`,
      result.removed && `${result.removed} removed`,
    ].filter(Boolean);
    state.message = bits.length ? `From the bank: ${bits.join(', ')}.` : force ? 'Nothing new from the bank.' : '';
    await db.sync(); // bring what the server just added onto this device
    fillInAccounts();
  } catch (err) {
    state.message = err.message;
  }
  state.busy = '';
  rerenderWhenIdle();
}

function loadPlaid() {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLAID_SCRIPT;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Couldn't load Plaid. Check your connection."));
    document.head.append(script);
  });
}

const forget = () => {
  try {
    localStorage.removeItem(LINK_KEY);
  } catch {
    // Nothing to forget.
  }
};

// Opens Plaid's window. `saved` is { token, startDate, itemId }.
async function openLink(saved, receivedRedirectUri) {
  await loadPlaid();
  window.Plaid.create({
    token: saved.token,
    receivedRedirectUri,
    onSuccess: async (publicToken, metadata) => {
      forget();
      state.busy = 'Finishing up…';
      rerender();
      try {
        if (saved.itemId) await call('reconnected', { item_id: saved.itemId });
        else await call('exchange', { public_token: publicToken, institution: metadata?.institution?.name, start_date: saved.startDate });
        state.busy = '';
        await refreshBank();
        await syncBank(true);
      } catch (err) {
        state.busy = '';
        state.message = err.message;
        rerender();
      }
    },
    onExit: (err) => {
      forget();
      if (err) {
        state.message = err.display_message || err.error_message || 'The bank connection was not completed.';
        rerender();
      }
    },
  }).open();
}

async function connect(itemId) {
  state.message = '';
  state.busy = 'Opening the bank sign-in…';
  rerender();
  try {
    // Some banks send you to their own site or app and back again, so
    // Plaid needs to know this page's address (a secure one, not a
    // local test address).
    const redirect_uri = location.protocol === 'https:' ? location.origin + location.pathname : undefined;
    const { link_token } = await call('link_token', { item_id: itemId, redirect_uri });
    const saved = { token: link_token, startDate, itemId };
    try {
      localStorage.setItem(LINK_KEY, JSON.stringify(saved));
    } catch {
      // Only needed when the bank sends you away and back.
    }
    state.busy = '';
    rerender();
    await openLink(saved);
  } catch (err) {
    state.busy = '';
    state.message = err.message;
    rerender();
  }
}

// If the bank just sent the person back here, carry on where Plaid left off.
export function resumeBankLink() {
  if (!/[?&]oauth_state_id=/.test(location.search)) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LINK_KEY));
  } catch {
    // Handled below.
  }
  const returnedTo = location.href;
  history.replaceState(null, '', location.pathname);
  if (saved) openLink(saved, returnedTo).catch((err) => { state.message = err.message; rerender(); });
}

// Choose which of the app's accounts a bank account is.
function setMatch(bankAccount, institution, choice) {
  const current = accounts().find((a) => a.plaidAccountId === bankAccount.id);
  if (current) {
    const { plaidAccountId, ...rest } = current;
    db.put('account', rest);
  }
  if (choice === 'new') {
    const credit = bankAccount.type === 'credit';
    const balance = Number(bankAccount.balance) || 0;
    db.put('account', {
      name: `${institution} ${bankAccount.name}${bankAccount.mask ? ' ••' + bankAccount.mask : ''}`,
      type: credit ? 'credit' : bankAccount.subtype === 'savings' ? 'savings' : 'checking',
      startBalance: credit ? -Math.abs(balance) : balance,
      startDate: today(),
      plaidAccountId: bankAccount.id,
      sort: Date.now(),
    });
  } else if (choice) {
    db.put('account', { ...db.get(choice), plaidAccountId: bankAccount.id });
  }
  fillInAccounts();
  rerender();
}

const PROBLEMS = {
  ITEM_LOGIN_REQUIRED: 'The bank wants you to sign in again.',
  PENDING_EXPIRATION: 'This connection is about to expire. Sign in again to keep it.',
};

function renderItem(item) {
  const mine = accounts();
  return h(
    'div',
    { class: 'tx bank' },
    h(
      'div',
      { class: 'tx-line' },
      h('strong', {}, item.institution),
      h('span', { class: 'muted small' }, item.last_sync ? `Checked ${new Date(item.last_sync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Not checked yet')
    ),
    item.error &&
      h('div', { class: 'tx-line' }, h('span', { class: 'warn' }, PROBLEMS[item.error] || `Problem: ${item.error}`), h('button', { onclick: () => connect(item.item_id) }, 'Reconnect')),
    item.accounts.map((a) => {
      const matched = mine.find((m) => m.plaidAccountId === a.id);
      return h(
        'label',
        { class: 'field' },
        h('span', {}, `${a.name}${a.mask ? ' ••' + a.mask : ''}${a.balance !== null ? ' · ' + money(a.balance) : ''}`),
        h(
          'select',
          { class: matched ? null : 'unfiled', onchange: (e) => setMatch(a, item.institution, e.target.value) },
          h('option', { value: '', selected: !matched }, "Which account is this? (not tracked yet)"),
          mine.filter((m) => !m.plaidAccountId || m.id === matched?.id).map((m) => h('option', { value: m.id, selected: m.id === matched?.id }, m.name)),
          h('option', { value: 'new' }, 'Add it as a new account')
        )
      );
    }),
    h('p', { class: 'muted small' }, `Bringing in transactions from ${item.start_date} on.`),
    h(
      'button',
      {
        class: 'link danger',
        onclick: async () => {
          if (!confirm(`Disconnect ${item.institution}? Transactions already brought in stay.`)) return;
          await call('remove', { item_id: item.item_id }).catch((err) => (state.message = err.message));
          await refreshBank();
        },
      },
      'Disconnect'
    )
  );
}

export function renderBank() {
  if (!db.ready) return null; // running without sign-in: no server to ask
  if (!state.loaded) {
    refreshBank();
    return null;
  }
  if (!state.available) {
    return h(
      'details',
      { class: 'card' },
      h('summary', {}, 'Bank connections', h('span', { class: 'muted' }, ' not set up')),
      h('p', { class: 'muted small' }, 'Automatic bank connections need a one-time setup in Supabase and Plaid. See the README.'),
      h('p', { class: 'muted small' }, `What the server said: ${state.problem}`),
      h('button', { onclick: () => { state.loaded = false; rerender(); } }, 'Check again')
    );
  }

  const unmatched = state.items.some((i) => i.accounts.some((a) => !accounts().some((m) => m.plaidAccountId === a.id)));
  const trouble = state.items.some((i) => i.error);
  return h(
    'details',
    { class: 'card', open: state.items.length === 0 || unmatched || trouble || !!state.busy || !!state.message || undefined },
    h('summary', {}, 'Bank connections', state.items.length > 0 && h('span', { class: 'muted' }, ` ${state.items.map((i) => i.institution).join(', ')}`)),
    state.items.map(renderItem),
    state.busy && h('p', {}, state.busy),
    state.message && h('p', { class: 'small' }, state.message),
    h(
      'div',
      { class: 'bank-actions' },
      state.items.length > 0 && h('button', { disabled: !!state.busy, onclick: () => syncBank(true) }, 'Check for new transactions'),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'For a new bank, bring in transactions from'),
        h('input', { type: 'date', value: startDate, max: today(), onchange: (e) => (startDate = e.target.value || today()) })
      ),
      h('button', { class: 'primary', disabled: !!state.busy, onclick: () => connect() }, 'Connect a bank')
    ),
    h('p', { class: 'muted small' }, "You sign in to your bank in Plaid's window; this app never sees your bank password. Purchases the bank still shows as pending appear here once they're final, usually a day or two later.")
  );
}
