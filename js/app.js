// The app's frame: signing in, the tabs, and redrawing the screen.
// Each tab's contents live in js/views/.

import { h, icon, setRenderer } from './ui.js';
import * as db from './db.js';
import { renderOverview } from './views/overview.js';
import { renderBudget } from './views/budget.js';
import { renderTransactions } from './views/transactions.js';
import { renderBills } from './views/bills.js';
import { renderDebts } from './views/debts.js';
import { renderGroceries, GROCERY_ID } from './views/groceries.js';
import { refreshBank, syncBank, resumeBankLink } from './views/bank.js';

const TABS = [
  ['overview', 'Overview', renderOverview],
  ['budget', 'Budget', renderBudget],
  ['tx', 'Transactions', renderTransactions],
  ['bills', 'Bills', renderBills],
  ['debts', 'Debts', renderDebts],
  ['groceries', 'Groceries', renderGroceries],
];

const main = document.getElementById('main');
const nav = document.querySelector('nav');
const statusEl = document.getElementById('save-note');
const signOutButton = document.getElementById('sign-out');
let view = 'budget';
let open = false; // true once the tabs are showing

const isTyping = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);

function render() {
  if (!open) return;
  for (const tab of nav.children) {
    tab.setAttribute('aria-current', tab.dataset.view === view ? 'page' : 'false');
  }
  // Put the cursor back in the box it was in before the redraw.
  const key = document.activeElement?.dataset?.key;
  let content;
  try {
    content = TABS.find(([id]) => id === view)[2]().filter(Boolean);
  } catch (err) {
    // A bug in one tab should say so, not leave the old tab on screen.
    console.error(err);
    content = [h('div', { class: 'card' }, h('h2', {}, "This page couldn't be shown"), h('p', { class: 'warn' }, String(err?.message || err)), h('p', { class: 'muted small' }, 'Your data is safe. Send this message to whoever looks after the app.'))];
  }
  main.replaceChildren(...content);
  if (key) main.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function goTo(next) {
  view = next;
  render();
  window.scrollTo(0, 0);
}

nav.replaceChildren(
  ...TABS.map(([id, label]) => h('button', { data: { view: id }, onclick: () => goTo(id) }, icon(id), h('span', {}, label)))
);
setRenderer(render, goTo);

// When another device changes something, redraw, but never while someone
// is in the middle of typing.
function onRemoteChange() {
  if (isTyping()) return setTimeout(onRemoteChange, 2000);
  render();
}
db.listen(onRemoteChange, (text) => (statusEl.textContent = text));

function showMessage(title, text, action) {
  document.body.classList.add('signed-out');
  main.replaceChildren(h('div', { class: 'card sign-in' }, h('h2', {}, title), h('p', { class: 'warn' }, text), action));
}

function renderSignIn() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'warn' });
  const button = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  document.body.classList.add('signed-out');
  main.replaceChildren(
    h(
      'form',
      {
        class: 'card sign-in',
        onsubmit: async (e) => {
          e.preventDefault();
          button.disabled = true;
          error.textContent = '';
          try {
            await db.signIn(email.value.trim(), password.value);
            await openApp();
          } catch (err) {
            button.disabled = false;
            error.textContent = err?.message || 'Sign-in failed.';
          }
        },
      },
      h('h2', {}, 'Sign in'),
      h('label', { class: 'field' }, h('span', {}, 'Email'), email),
      h('label', { class: 'field' }, h('span', {}, 'Password'), password),
      button,
      error
    )
  );
}

async function openApp() {
  signOutButton.hidden = false;
  try {
    if (!(await db.isMember())) {
      return showMessage('Not set up yet', "This login isn't on the family list. Add its email in supabase/setup-finance.sql and run that in Supabase.");
    }
  } catch (err) {
    // Offline is fine if this device already has the data; a database
    // error (like the tables not existing yet) is not.
    if (err?.code) return showMessage("Couldn't load", err.message, h('button', { class: 'primary', onclick: openApp }, 'Try again'));
  }
  await db.sync();
  if (!db.get(GROCERY_ID)) {
    // Carry over the list from the first version of the app, once.
    const old = await db.oldGroceryList().catch(() => null);
    if (old) db.put('groceries', { ...old, id: GROCERY_ID });
  }
  document.body.classList.remove('signed-out');
  open = true;
  // Start on the overview, unless there's nothing set up to summarise yet.
  view = db.all('envelope').length > 0 ? 'overview' : 'budget';
  if (/[?&]oauth_state_id=/.test(location.search)) view = 'tx'; // back from the bank's sign-in
  render();
  // Bank connections: finish one in progress, then fetch anything new.
  resumeBankLink();
  refreshBank().then(() => syncBank(false));
}

async function start() {
  if (db.configured && !db.ready) {
    return main.replaceChildren(h('p', { class: 'empty' }, "The app didn't load completely. Check your connection and reload the page."));
  }
  const user = await db.start();
  if (!db.configured) {
    open = true;
    view = db.all('envelope').length > 0 ? 'overview' : 'budget';
    return render();
  }
  if (!user) return renderSignIn();
  await openApp();
}

signOutButton.addEventListener('click', async () => {
  await db.sync();
  if (db.hasUnsaved() && !confirm("Your latest changes haven't uploaded yet. Sign out and lose them?")) return;
  await db.signOut();
  location.reload();
});

const check = () => { if (open && !document.hidden) db.sync(); };
setInterval(check, 15000);
window.addEventListener('focus', check);
// Leaving the page (or locking the phone): upload right away.
document.addEventListener('visibilitychange', () => (document.hidden ? open && db.sync() : check()));

start();
