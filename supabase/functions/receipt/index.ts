// Server-side helper that reads a grocery receipt. It runs on Supabase, not
// in the browser, because it holds the Anthropic API key.
//
// The app sends a photo of a receipt (or its text) and the names on the
// grocery list. Claude reads the receipt and returns each line with its
// price, matched to a list item where it can tell they're the same thing.
//
// Settings it needs (Supabase > Edge Functions > Secrets):
//   ANTHROPIC_API_KEY
//   RECEIPT_MODEL   optional; which Claude model to use (see DEFAULT_MODEL)

export const VERSION = 1;
export const DEFAULT_MODEL = 'claude-opus-5-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const INSTRUCTIONS = `You read grocery store receipts for a household price tracker.

You are given a receipt (a photo or its text) and the household's grocery list as JSON: [{"id": "...", "name": "..."}].

Return every purchased product line on the receipt. For each one:
- receipt_text: the line as printed, abbreviations and all.
- name: what the product is in plain words ("KRO LRG EGGS 12CT" is "Large eggs, 12 count").
- unit_price: the price of ONE unit after any discount printed for that line. If 2 were bought for 5.00, the unit price is 2.50. For items sold by weight, use the total paid for that line.
- quantity: how many units were bought (1 for items sold by weight).
- item_id: the id of the grocery list item this clearly is, or "" if none fits. Match on what the product is, not exact wording: "2% MILK GAL" matches a list item named "Milk". Leave it "" when unsure; a wrong match puts a wrong price on the list.

Leave out anything that is not a product: tax, totals, payment and change lines, bag fees, deposits, loyalty savings summaries, store coupons not tied to a line.

Also return store (the store's name as printed, or "") and date (the purchase date as YYYY-MM-DD, or "").`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['store', 'date', 'lines'],
  properties: {
    store: { type: 'string' },
    date: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['receipt_text', 'name', 'unit_price', 'quantity', 'item_id'],
        properties: {
          receipt_text: { type: 'string' },
          name: { type: 'string' },
          unit_price: { type: 'number' },
          quantity: { type: 'number' },
          item_id: { type: 'string' },
        },
      },
    },
  },
};

// Models that can hand a declined request to another model on the server.
const HAS_FALLBACKS = /^claude-(opus-5|fable-5-[12]|sonnet-5-5)/;

// ---------- The part that talks to Claude (tested in tests/receipt.test.js) ----------

// `client` is an Anthropic SDK client. `input` is { image, text, items }.
export async function readReceipt(client, model, input) {
  const items = (input.items || []).slice(0, 500).map((i) => ({ id: String(i.id), name: String(i.name).slice(0, 80) }));
  const content = [];
  if (input.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image } });
  }
  content.push({
    type: 'text',
    text: (input.text ? `Receipt text:\n${input.text}\n\n` : '') + `Grocery list:\n${JSON.stringify(items)}`,
  });

  const request = {
    model,
    max_tokens: 16000,
    system: INSTRUCTIONS,
    // A receipt is a reading task, not a reasoning one.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  if (HAS_FALLBACKS.test(model)) {
    // If the model's safety checks decline the request, let the API retry
    // it on its recommended fallback model instead of failing outright.
    request.betas = ['server-side-fallback-2026-07-01'];
    request.fallbacks = 'default';
  }
  const response = await client.beta.messages.create(request);

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read this. Try typing the prices in instead.');
  if (response.stop_reason === 'max_tokens') throw new Error('The receipt was too long to read in one go. Try photographing it in two halves.');
  const text = response.content.find((block) => block.type === 'text')?.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Claude's reply couldn't be read. Try again.");
  }

  // Never trust a match to an id that wasn't on the list we sent.
  const known = new Set(items.map((i) => i.id));
  return {
    store: String(parsed.store || ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : '',
    lines: (parsed.lines || [])
      .filter((l) => Number(l.unit_price) > 0)
      .map((l) => ({
        receiptText: String(l.receipt_text || ''),
        name: String(l.name || l.receipt_text || 'Item'),
        price: Math.round(Number(l.unit_price) * 100) / 100,
        quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
        itemId: known.has(l.item_id) ? l.item_id : '',
      })),
    usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 },
  };
}

// ---------- The web entry point ----------

async function handle(req) {
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  let Anthropic;
  try {
    const env = Deno.env.toObject();
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Only signed-in family members may spend the family's API credit.
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    const { data: auth } = await db.auth.getUser(jwt);
    if (!auth?.user) return reply({ error: 'Please sign in again.' }, 401);
    const { data: member } = await db.from('members').select('user_id').eq('user_id', auth.user.id);
    if (!member?.length) return reply({ error: 'This login is not on the family list.' }, 403);

    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
    const body = await req.json();
    if (body.action === 'status') return reply({ version: VERSION });
    if (body.action !== 'read') throw new Error('Unknown action.');
    if (!body.image && !String(body.text || '').trim()) throw new Error('Send a photo of the receipt or its text.');
    if (body.image && body.image.length > 6_000_000) throw new Error('That photo is too large. Try again with a smaller one.');

    ({ default: Anthropic } = await import('npm:@anthropic-ai/sdk'));
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const result = await readReceipt(client, env.RECEIPT_MODEL || DEFAULT_MODEL, body);
    return reply({ version: VERSION, ...result });
  } catch (err) {
    // Say what went wrong in terms the person can act on.
    if (Anthropic && err instanceof Anthropic.AuthenticationError) return reply({ error: 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.' }, 400);
    if (Anthropic && err instanceof Anthropic.PermissionDeniedError) return reply({ error: "This API key isn't allowed to use that model." }, 400);
    if (Anthropic && err instanceof Anthropic.NotFoundError) return reply({ error: 'That model name was not found. Check RECEIPT_MODEL.' }, 400);
    if (Anthropic && err instanceof Anthropic.RateLimitError) return reply({ error: 'Too many requests just now. Wait a minute and try again.' }, 400);
    if (Anthropic && err instanceof Anthropic.APIError) return reply({ error: `Claude couldn't read it (${err.status ?? 'network'}): ${err.message}` }, 400);
    return reply({ error: err.message || 'Something went wrong.' }, 400);
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handle);
