// Notifications: turning them on for this device, testing them, and seeing
// which devices get them. The sending is done by the server-side "notify"
// function; this is the part each phone or computer does for itself.

import { h, num, rerender, rerenderWhenIdle } from '../ui.js';
import { today } from '../money.js';
import { stableId } from '../storage.js';
import * as db from '../db.js';

// The version of supabase/functions/notify/index.ts this app expects.
const FUNCTION_VERSION = 2;

// The family's choices about what to be told. Keep the defaults in step
// with DEFAULT_ALERTS in supabase/functions/notify/index.ts.
const SETTINGS_ID = '00000000-0000-4000-8000-000000000008';
const DEFAULTS = { summary: true, toFile: true, income: true, large: true, largeOver: 200, overspent: true, low: true, lowUnder: 100, quietFrom: 21, quietTo: 7 };
const choices = () => ({ ...DEFAULTS, ...(db.get(SETTINGS_ID)?.alerts || {}) });
const choose = (changes) => {
  db.put('settings', { ...db.get(SETTINGS_ID), id: SETTINGS_ID, alerts: { ...choices(), ...changes } });
  rerender();
};
const clock = (hour) => `${((hour + 11) % 12) + 1}${hour < 12 ? 'am' : 'pm'}`;

function renderChoices() {
  const c = choices();
  const tick = (key, ...label) =>
    h('label', { class: 'check alert-choice' }, h('input', { type: 'checkbox', checked: !!c[key], onchange: (e) => choose({ [key]: e.target.checked }) }), h('span', {}, label));
  const amount = (key) =>
    h('input', { type: 'number', min: '0', step: 'any', inputMode: 'decimal', class: 'inline-number', value: c[key], 'aria-label': 'Amount', data: { key: `alert-${key}` }, onchange: (e) => choose({ [key]: num(e.target.value) ?? DEFAULTS[key] }) });
  const hour = (key, label) =>
    h('select', { 'aria-label': label, onchange: (e) => choose({ [key]: Number(e.target.value) }) }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === Number(c[key]) }, clock(i))));
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'What to tell us'),
    h('p', { class: 'muted small' }, "These are the family's shared choices. The app checks about once an hour."),
    tick('summary', 'A summary each morning: bills overdue, due today or due tomorrow, and overspent envelopes'),
    tick('income', 'Money arriving (a deposit of $200 or more)'),
    tick('large', 'A purchase over $', amount('largeOver')),
    tick('toFile', 'New bank transactions that need an envelope'),
    tick('overspent', 'An envelope going into the red'),
    tick('low', 'A checking account dropping below $', amount('lowUnder')),
    h('div', { class: 'quiet' }, h('span', {}, 'Quiet from'), hour('quietFrom', 'Quiet from'), h('span', {}, 'until'), hour('quietTo', 'Quiet until')),
    h('p', { class: 'muted small' }, 'Nothing is sent during quiet hours. Whatever happened then arrives together when they end.')
  );
}

const state = { loaded: false, loading: false, available: false, outdated: false, problem: '', publicKey: '', endpoint: null, busy: '', message: '' };

const call = (action) => db.callFunction('notify', { action });
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// On an iPhone or iPad, notifications only work from the home-screen app.
const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function deviceName() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Computer';
  const who = (db.userEmail() || '').split('@')[0];
  return who ? `${kind} (${who})` : kind;
}

// The key arrives as text; the browser wants it as raw bytes.
function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  try {
    const reply = await call('config');
    if (typeof reply?.publicKey !== 'string') throw new Error('The "notify" function gave an unexpected reply. It may still contain sample code.');
    state.publicKey = reply.publicKey;
    state.outdated = (reply.version || 1) < FUNCTION_VERSION;
    state.available = true;
    if (supported()) {
      const registration = await navigator.serviceWorker.ready;
      state.endpoint = (await registration.pushManager.getSubscription())?.endpoint || null;
    }
  } catch (err) {
    state.available = false;
    state.problem = err.message;
  }
  state.loaded = true;
  state.loading = false;
  rerenderWhenIdle();
}

async function turnOn() {
  state.message = '';
  try {
    // The browser shows its own "Allow notifications?" question here.
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') {
      state.message = "Notifications weren't allowed. You can change that in this device's settings for the app.";
      return rerender();
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.publicKey) });
    const details = subscription.toJSON();
    db.put('push', { id: stableId('push:' + details.endpoint), endpoint: details.endpoint, keys: details.keys, device: deviceName(), added: today() });
    state.endpoint = details.endpoint;
    state.message = 'Notifications are on for this device. Send a test to make sure.';
  } catch (err) {
    state.message = `Couldn't turn notifications on: ${err.message}`;
  }
  rerender();
}

async function turnOff() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      db.remove(stableId('push:' + subscription.endpoint));
      await subscription.unsubscribe();
    }
    state.endpoint = null;
    state.message = 'Notifications are off for this device.';
  } catch (err) {
    state.message = err.message;
  }
  rerender();
}

async function run(action, describe) {
  state.busy = action;
  state.message = '';
  rerender();
  try {
    await db.sync(); // make sure the server has this device before asking it to send
    state.message = describe(await call(action));
  } catch (err) {
    state.message = err.message;
  }
  state.busy = '';
  rerender();
}

export function renderAlerts() {
  if (!db.ready) return [h('p', { class: 'empty' }, 'Notifications need the app to be signed in.')];
  if (!state.loaded) {
    load();
    return [h('p', { class: 'empty' }, 'Checking notifications…')];
  }
  if (!state.available) {
    return [
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Notifications aren\'t set up yet'),
        h('p', { class: 'muted' }, 'They need a one-time setup in Supabase. See the README.'),
        h('p', { class: 'muted small' }, `What the server said: ${state.problem}`),
        h('button', { onclick: () => { state.loaded = false; rerender(); } }, 'Check again')
      ),
    ];
  }

  const devices = db.all('push');
  const mine = state.endpoint && devices.find((d) => d.endpoint === state.endpoint);
  let thisDevice;
  if (!supported()) {
    thisDevice = h(
      'p',
      { class: 'warn' },
      isApple() && !installed()
        ? 'On an iPhone or iPad, notifications only work from the home-screen app. Open Family Budget from its icon on your home screen and come back to this page.'
        : "This browser can't receive notifications."
    );
  } else if (mine) {
    thisDevice = h(
      'div',
      {},
      h('p', {}, h('span', { class: 'badge good' }, 'On'), ' This device gets notifications.'),
      h('div', { class: 'button-row' }, h('button', { onclick: turnOff }, 'Turn off for this device'))
    );
  } else {
    thisDevice = h(
      'div',
      {},
      Notification.permission === 'denied' && h('p', { class: 'warn' }, "Notifications are blocked for this app in the device's settings. Allow them there first."),
      h('div', { class: 'button-row' }, h('button', { class: 'primary', onclick: turnOn }, 'Turn on notifications for this device'))
    );
  }

  return [
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'This device'),
      thisDevice,
      h('p', { class: 'muted small' }, 'Each phone and computer is turned on separately, so do this once on every device that should be told.')
    ),
    state.outdated &&
      h('p', { class: 'card warn' }, 'The "notify" function on Supabase is an older version, so only the morning summary is sent. Paste in the latest supabase/functions/notify/index.ts and deploy to get alerts as things happen.'),
    renderChoices(),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Try it'),
      h(
        'div',
        { class: 'button-row' },
        h('button', { disabled: !!state.busy || devices.length === 0, onclick: () => run('test', (r) => (r.sent > 0 ? `Test sent to ${r.sent} of ${r.devices} device${r.devices === 1 ? '' : 's'}. It should arrive within a few seconds.` : `Nothing could be sent${r.failed?.length ? ` (${r.failed.join(', ')})` : ''}.`)) }, state.busy === 'test' ? 'Sending…' : 'Send a test'),
        h('button', { disabled: !!state.busy, onclick: () => run('preview', (r) => (r.summary ? `Today's would say: "${r.summary.title}. ${r.summary.body}"` : "Nothing to report today, so no notification would be sent.")) }, "What would today's say?")
      ),
      state.message && h('p', {}, state.message)
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'list-head' }, h('h2', {}, 'Devices'), h('span', { class: 'muted' }, String(devices.length))),
      devices.length === 0 && h('p', { class: 'muted' }, 'No device has notifications turned on yet.'),
      devices.map((d) =>
        h(
          'div',
          { class: 'tx-line report-env' },
          h('span', {}, d.device || 'Device', d.endpoint === state.endpoint && h('span', { class: 'badge good' }, 'This one'), h('span', { class: 'muted small' }, ` since ${d.added || 'earlier'}`)),
          d.endpoint !== state.endpoint && h('button', { class: 'link', onclick: () => { if (confirm(`Stop sending notifications to ${d.device || 'this device'}?`)) { db.remove(d.id); rerender(); } } }, 'Remove')
        )
      )
    ),
  ];
}
