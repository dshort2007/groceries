// Server-side helper for Kroger prices. It runs on Supabase, not in the
// browser, because it holds the Kroger API secret.
//
// The app calls it with { action: ... }:
//   locations  find Kroger-family stores near a zip code
//   search     look up products by name at one store, with prices
//   prices     get today's price for products already picked
//
// Settings it needs (Supabase > Edge Functions > Secrets):
//   KROGER_CLIENT_ID, KROGER_CLIENT_SECRET

export const VERSION = 1;
const API = 'https://api.kroger.com/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Kroger's own labels, so their products can be marked as the store brand.
const STORE_BRANDS = ['kroger', 'simple truth', 'simple truth organic', 'private selection', 'heritage farm', 'smart way', 'big k', 'comforts', 'home chef', 'murray\'s cheese', 'bakery fresh goodness'];

// ---------- Pure helpers (tested in tests/kroger.test.js) ----------

// Boil one of Kroger's product records down to what the app needs.
export function toProduct(p) {
  const item = (p.items || [])[0] || {};
  const regular = Number(item.price?.regular) || 0;
  const promo = Number(item.price?.promo) || 0;
  const onSale = promo > 0 && promo < regular;
  return {
    productId: p.productId,
    name: p.description || '',
    brand: p.brand || '',
    size: item.size || '',
    price: onSale ? promo : regular,
    regular,
    onSale,
    storeBrand: STORE_BRANDS.includes(String(p.brand || '').toLowerCase()),
  };
}

export function toLocation(l) {
  const a = l.address || {};
  return {
    locationId: l.locationId,
    name: l.name || l.chain || 'Store',
    address: [a.addressLine1, a.city, a.state].filter(Boolean).join(', '),
  };
}

// ---------- Talking to Kroger ----------

let token = null; // reused until shortly before it expires

export function makeKroger(env, fetchFn = fetch) {
  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) throw new Error('KROGER_CLIENT_ID and KROGER_CLIENT_SECRET are not set.');

  async function getToken() {
    if (token && token.expires > Date.now()) return token.value;
    const res = await fetchFn(`${API}/connect/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`),
      },
      body: 'grant_type=client_credentials&scope=product.compact',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`Kroger wouldn't sign in: ${json.error_description || json.error || res.status}. Check the client ID and secret.`);
    token = { value: json.access_token, expires: Date.now() + ((Number(json.expires_in) || 1800) - 60) * 1000 };
    return token.value;
  }

  return async (path, params) => {
    const query = new URLSearchParams(params).toString();
    const res = await fetchFn(`${API}${path}?${query}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${await getToken()}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Kroger said no (${res.status}): ${json.errors?.reason || json.error_description || json.error || 'unknown reason'}`);
    return json.data || [];
  };
}

export async function run(action, body, kroger) {
  if (action === 'status') return { version: VERSION };

  if (action === 'locations') {
    const zip = String(body.zip || '').trim();
    if (!/^\d{5}$/.test(zip)) throw new Error('Enter a 5-digit zip code.');
    const data = await kroger('/locations', { 'filter.zipCode.near': zip, 'filter.radiusInMiles': '15', 'filter.limit': '8' });
    return { version: VERSION, locations: data.map(toLocation) };
  }

  if (action === 'search') {
    const term = String(body.term || '').trim().slice(0, 60);
    if (term.length < 3) throw new Error('Search for at least 3 letters.');
    if (!body.locationId) throw new Error('Choose which Kroger store first.');
    const data = await kroger('/products', { 'filter.term': term, 'filter.locationId': String(body.locationId), 'filter.limit': '15' });
    return { version: VERSION, products: data.map(toProduct).filter((p) => p.price > 0) };
  }

  if (action === 'prices') {
    const ids = [...new Set((body.productIds || []).map(String))].slice(0, 200);
    if (!body.locationId) throw new Error('Choose which Kroger store first.');
    const products = [];
    for (let i = 0; i < ids.length; i += 25) {
      const data = await kroger('/products', { 'filter.productId': ids.slice(i, i + 25).join(','), 'filter.locationId': String(body.locationId), 'filter.limit': '50' });
      products.push(...data.map(toProduct));
    }
    return { version: VERSION, products };
  }

  throw new Error('Unknown action.');
}

// ---------- The web entry point ----------

async function handle(req) {
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const env = Deno.env.toObject();
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Only signed-in family members may use the family's Kroger key.
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    const { data: auth } = await db.auth.getUser(jwt);
    if (!auth?.user) return reply({ error: 'Please sign in again.' }, 401);
    const { data: member } = await db.from('members').select('user_id').eq('user_id', auth.user.id);
    if (!member?.length) return reply({ error: 'This login is not on the family list.' }, 403);

    const body = await req.json();
    return reply(await run(body.action, body, makeKroger(env)));
  } catch (err) {
    return reply({ error: err.message || 'Something went wrong.' }, 400);
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handle);
