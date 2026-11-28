// Checks the receipt reader's request and how it treats Claude's reply.
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const copy = join(mkdtempSync(join(tmpdir(), 'receipt-')), 'fn.mjs');
copyFileSync(new URL('../supabase/functions/receipt/index.ts', import.meta.url), copy);
const { readReceipt, DEFAULT_MODEL } = await import(pathToFileURL(copy));

const items = [{ id: 'eggs', name: 'Eggs' }, { id: 'milk', name: 'Milk' }];
function fakeClient(reply, seen = []) {
  return { beta: { messages: { create: async (request) => { seen.push(request); return reply; } } } };
}
const answer = (data, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 1200, output_tokens: 300 }, ...extra });

test('sends the photo, the list and a JSON schema, and tidies the reply', async () => {
  const seen = [];
  const client = fakeClient(answer({
    store: 'ALDI', date: '2026-11-27',
    lines: [
      { receipt_text: 'LRG EGGS 12CT', name: 'Large eggs', unit_price: 2.095, quantity: 2, item_id: 'eggs' },
      { receipt_text: 'BANANAS', name: 'Bananas', unit_price: 1.37, quantity: 1, item_id: '' },
      { receipt_text: 'MYSTERY', name: 'Mystery', unit_price: 3, quantity: 0, item_id: 'not-on-the-list' },
      { receipt_text: 'FREE BAG', name: 'Bag', unit_price: 0, quantity: 1, item_id: '' },
    ],
  }), seen);
  const result = await readReceipt(client, DEFAULT_MODEL, { image: 'BASE64', items });

  const request = seen[0];
  assert.equal(request.model, 'claude-opus-5-5');
  assert.deepEqual(request.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64' } });
  assert.match(request.messages[0].content[1].text, /Grocery list:\n\[\{"id":"eggs","name":"Eggs"\}/);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.format.schema.properties.lines.items.additionalProperties, false);
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(request.thinking, undefined); // always on for this model; depth set by effort
  assert.equal(request.temperature, undefined);

  assert.equal(result.store, 'ALDI');
  assert.equal(result.date, '2026-11-27');
  assert.deepEqual(result.lines, [
    { receiptText: 'LRG EGGS 12CT', name: 'Large eggs', price: 2.1, quantity: 2, itemId: 'eggs' },
    { receiptText: 'BANANAS', name: 'Bananas', price: 1.37, quantity: 1, itemId: '' },
    { receiptText: 'MYSTERY', name: 'Mystery', price: 3, quantity: 1, itemId: '' }, // id it invented is dropped
  ]);
  assert.deepEqual(result.usage, { input: 1200, output: 300 });
});

test('pasted text works without a photo, and other models skip the fallback option', async () => {
  const seen = [];
  await readReceipt(fakeClient(answer({ store: '', date: 'yesterday', lines: [] }), seen), 'claude-haiku-5-5', { text: 'EGGS 2.09', items });
  assert.equal(seen[0].messages[0].content.length, 1);
  assert.match(seen[0].messages[0].content[0].text, /^Receipt text:\nEGGS 2\.09/);
  assert.equal(seen[0].fallbacks, undefined);
  assert.equal(seen[0].betas, undefined);
});

test('a refusal, a cut-off reply or broken JSON is reported plainly', async () => {
  await assert.rejects(readReceipt(fakeClient({ stop_reason: 'refusal', content: [] }), DEFAULT_MODEL, { text: 'x', items }), /declined/);
  await assert.rejects(readReceipt(fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"sto' }] }), DEFAULT_MODEL, { text: 'x', items }), /too long/);
  await assert.rejects(readReceipt(fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), DEFAULT_MODEL, { text: 'x', items }), /couldn't be read/);
});
