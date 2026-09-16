// functions/api/barcode-lookup.js — Cloudflare Pages Function
//
// Called from the "Add New Items" tab when a barcode is scanned and the code
// isn't already in this shop's inventory. Looks the code up against public
// product databases so the item's name (and category, if there is one) can
// be auto-filled — the cashier still has to enter price, quantity, and any
// expiry date themselves, since those are shop-specific.
//
// Runs server-side (not called directly from the browser) for two reasons:
//   1. Some product-lookup APIs don't send CORS headers, so a direct browser
//      fetch would just fail silently.
//   2. If a paid-tier API key is ever added (see UPCITEMDB_API_KEY below), it
//      stays server-side instead of being exposed in the page's JS.
//
// Tries two free, keyless sources in order:
//   1. UPCitemdb "trial" endpoint (100 lookups/day, general retail products)
//   2. Open Food Facts (unlimited, but food/grocery items only)
// Returns { found: false } if neither has the code — the front-end falls
// back to fully manual entry in that case, which is expected to happen
// often for local/unbranded stock that isn't in any public database.

import { requireValidLicense } from './_license.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Optional: set UPCITEMDB_API_KEY + UPCITEMDB_KEY_TYPE as Cloudflare Pages
// environment variables if you upgrade off the free trial plan later (raises
// the 100/day cap). Not required — the trial endpoint works with no signup at all.
async function lookupUpcItemDb(code, env) {
  const apiKey = env.UPCITEMDB_API_KEY;
  const base = apiKey ? 'https://api.upcitemdb.com/prod/v1/lookup' : 'https://api.upcitemdb.com/prod/trial/lookup';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['user_key'] = apiKey;
    headers['key_type'] = env.UPCITEMDB_KEY_TYPE || '3scale';
  }

  const res = await fetch(`${base}?upc=${encodeURIComponent(code)}`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  const item = data && Array.isArray(data.items) ? data.items[0] : null;
  if (!item || !item.title) return null;

  return {
    found: true,
    source: 'upcitemdb',
    name: item.title,
    brand: item.brand || '',
    category: item.category || '',
    image: (Array.isArray(item.images) && item.images[0]) || null,
  };
}

async function lookupOpenFoodFacts(code) {
  const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;

  const p = data.product;
  const name = p.product_name || p.generic_name;
  if (!name) return null;

  return {
    found: true,
    source: 'openfoodfacts',
    name: p.brands ? `${name} (${p.brands})` : name,
    brand: p.brands || '',
    category: (p.categories || '').split(',')[0] || '',
    image: p.image_front_small_url || p.image_small_url || null,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (!code) {
    return jsonResponse({ error: 'Missing code' }, 400);
  }

  // Resolves to this shop whether they're on their own subdomain
  // (georgehardware.mydukapos.store) or a legacy ?c= link — see _license.js.
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  try {
    const fromUpc = await lookupUpcItemDb(code, env);
    if (fromUpc) return jsonResponse(fromUpc);
  } catch (e) {
    // fall through to the next source
  }

  try {
    const fromOff = await lookupOpenFoodFacts(code);
    if (fromOff) return jsonResponse(fromOff);
  } catch (e) {
    // fall through to "not found"
  }

  return jsonResponse({ found: false });
}
