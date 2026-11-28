// Checks the notification sender: that a device could actually decrypt
// what it sends, that its signature verifies, and what the daily summary
// says. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const copy = join(mkdtempSync(join(tmpdir(), 'notify-')), 'fn.mjs');
copyFileSync(new URL('../supabase/functions/notify/index.ts', import.meta.url), copy);
const { generateKeys, vapidHeader, encryptFor, sendPush, digest, localDate } = await import(pathToFileURL(copy));

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// A pretend phone: its own key pair and secret, as a browser would make.
function makeDevice() {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { ecdh, auth, subscription: { endpoint: 'https://push.example.com/send/abc123', keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}

// What the phone does to read a message, written separately from the
// sender using Node's own crypto, following RFC 8291 step by step.
function decryptOnDevice(device, body) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body[20];
  const senderPublic = body.subarray(21, 21 + keyLength);
  const sealed = body.subarray(21 + keyLength);
  const shared = device.ecdh.computeSecret(senderPublic);
  const hkdf = (saltBytes, secret, info, length) => Buffer.from(nodeCrypto.hkdfSync('sha256', secret, saltBytes, info, length));
  const material = hkdf(device.auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), senderPublic]), 32);
  const key = hkdf(salt, material, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, material, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = nodeCrypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return { recordSize, keyLength, last: plain[plain.length - 1], message: plain.subarray(0, plain.length - 1).toString('utf8') };
}

test('a device can decrypt what is sent to it, and nobody else can', async () => {
  const phone = makeDevice();
  const message = JSON.stringify({ title: '2 bills need attention', body: 'Due tomorrow: Rent, Utilities. Café ☕' });
  const body = Buffer.from(await encryptFor(phone.subscription, message));
  const read = decryptOnDevice(phone, body);
  assert.equal(read.message, message);
  assert.equal(read.recordSize, 4096);
  assert.equal(read.keyLength, 65);
  assert.equal(read.last, 2); // the "last chunk" marker

  // Each send uses a fresh salt and key, so the same message never looks the same twice.
  const again = Buffer.from(await encryptFor(phone.subscription, message));
  assert.notDeepEqual(again, body);
  // A different phone can't read it.
  assert.throws(() => decryptOnDevice(makeDevice(), body));
  // And tampering is caught.
  body[body.length - 1] ^= 1;
  assert.throws(() => decryptOnDevice(phone, body));
});

test('the signature names the push service and verifies with the public key', async () => {
  const keys = await generateKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const header = await vapidHeader('https://web.push.apple.com/QGk3...', keys, 'https://example.supabase.co', 1_800_000_000);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { aud: 'https://web.push.apple.com', exp: 1_800_000_000 + 43200, sub: 'https://example.supabase.co' });

  // Verify the way a push service would, from the raw public key alone.
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  const ok = nodeCrypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  assert.equal(ok, true);
});

test('sending posts the encrypted message with the headers push services expect', async () => {
  const phone = makeDevice();
  const keys = await generateKeys();
  const seen = [];
  const status = await sendPush(phone.subscription, { title: 'Hi', body: 'There' }, keys, 'https://example.supabase.co', async (url, init) => {
    seen.push({ url, init });
    return { status: 201 };
  });
  assert.equal(status, 201);
  assert.equal(seen[0].url, phone.subscription.endpoint);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen[0].init.headers.TTL, '86400');
  assert.match(seen[0].init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(JSON.parse(decryptOnDevice(phone, Buffer.from(seen[0].init.body)).message), { title: 'Hi', body: 'There' });
});

const rec = (kind, id, data, deleted = false) => ({ id, kind, data, deleted });

test('the daily summary covers bills due and overspent envelopes', () => {
  const records = [
    rec('bill', 'b1', { name: 'Rent', nextDue: '2026-12-01' }),
    rec('bill', 'b2', { name: 'Utilities', nextDue: '2026-12-01' }),
    rec('bill', 'b3', { name: 'Internet', nextDue: '2026-11-30' }),
    rec('bill', 'b4', { name: 'Gym', nextDue: '2026-11-20' }),
    rec('bill', 'b5', { name: 'Later', nextDue: '2026-12-15' }),
    rec('bill', 'b6', { name: 'Removed', nextDue: '2026-11-30' }, true),
    rec('envelope', 'groc', { name: 'Groceries' }),
    rec('envelope', 'gas', { name: 'Gas' }),
    rec('envelope', 'old', { name: 'Old', archived: true }),
    rec('assign', 'a1', { week: '2026-11-27', envelopeId: 'groc', amount: 100 }),
    rec('assign', 'a2', { week: '2026-11-27', envelopeId: 'gas', amount: 50 }),
    rec('assign', 'a3', { week: '2026-12-04', envelopeId: 'groc', amount: 500 }), // next week: not there yet
    rec('tx', 't1', { date: '2026-11-28', amount: -130, envelopeId: 'groc' }),
    rec('tx', 't2', { date: '2026-11-29', amount: -60, envelopeId: 'split', splits: [{ envelopeId: 'gas', amount: -20 }, { envelopeId: 'old', amount: -40 }] }),
  ];
  assert.deepEqual(digest(records, '2026-11-30'), {
    title: '4 bills need attention',
    body: 'Overdue: Gym. Due today: Internet. Due tomorrow: Rent, Utilities. Overspent: Groceries.',
  });
  assert.equal(digest(records, '2026-12-08').body, 'Overdue: Rent, Utilities, Internet and 1 more.'); // by then next week's money is in
  assert.deepEqual(digest([rec('envelope', 'e', { name: 'Gas' }), rec('tx', 't', { date: '2026-11-01', amount: -5, envelopeId: 'e' })], '2026-11-30'), { title: '1 envelope overspent', body: 'Overspent: Gas.' });
  assert.equal(digest([rec('bill', 'b', { name: 'Rent', nextDue: '2026-12-20' })], '2026-11-30'), null);
});

test("today's date follows the family's time zone, not the server's", () => {
  const lateEvening = new Date('2026-12-01T03:30:00Z'); // still Nov 30 in Georgia
  assert.equal(localDate('America/New_York', lateEvening), '2026-11-30');
  assert.equal(localDate('UTC', lateEvening), '2026-12-01');
});
