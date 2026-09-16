// functions/api/image-search.js — Cloudflare Pages Function
//
// Auto-fetches one relevant stock photo for a new inventory item (e.g.
// "Chips", "Chicken") when the shop hasn't uploaded one of their own —
// only ever runs when the device is online, and only ever a fallback: a
// manually uploaded/captured photo always takes priority and this is never
// called if one already exists.
//
// Uses Pixabay's free API (https://pixabay.com/api/docs/) — genuinely
// free-to-use images (Pixabay License permits commercial use, no
// attribution required for most images), a simple key-based REST API with
// no OAuth, and it's well stocked with exactly the kind of generic food/
// product photography a POS item needs. Each shop uses their own free
// Pixabay account/key, same pattern as the payment gateway keys — this
// endpoint never ships with a shared key baked in.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const url = new URL(request.url);
  const configRaw = await env.mydukapos_kv.get(`image-search-config:${clientId}`);
  const config = configRaw ? JSON.parse(configRaw) : {};

  // Status-check mode — just reports whether a key is saved, never the key
  // itself, so Settings can show a "configured" badge without a search.
  if (url.searchParams.get('status') === '1') {
    return jsonResponse({ configured: !!config.pixabayApiKey });
  }

  const query = url.searchParams.get('q');
  if (!query || !query.trim()) {
    return jsonResponse({ error: 'Missing search query.' }, 400);
  }
  if (!config.pixabayApiKey) {
    return jsonResponse({ error: 'No Pixabay API key saved for this shop yet — add one in Settings first.' }, 400);
  }

  try {
    const apiUrl = `https://pixabay.com/api/?key=${encodeURIComponent(config.pixabayApiKey)}&q=${encodeURIComponent(query.trim())}&image_type=photo&category=food&safesearch=true&per_page=3`;
    const res = await fetch(apiUrl);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pixabay declined the request: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.hits || data.hits.length === 0) {
      return jsonResponse({ error: 'No matching image found.' }, 404);
    }
    // webformatURL is a reasonably sized (usually ~640px-wide) JPEG — plenty
    // for a product thumbnail without pulling down a full-resolution photo.
    // Fetched server-side and returned as a ready-to-use data URL, rather
    // than handing back a bare external URL for the browser to fetch
    // itself — this way the result works the same regardless of whether
    // Pixabay's own CDN happens to allow cross-origin image fetches from a
    // page's own JavaScript, which isn't something to depend on.
    const imageUrl = data.hits[0].webformatURL;
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error('Could not download the matched image.');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const bytes = await imgRes.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    return jsonResponse({ imageDataUrl: `data:${contentType};base64,${base64}`, source: 'Pixabay' });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected error contacting Pixabay.' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }
  const apiKey = (body.pixabayApiKey || '').trim();
  if (!apiKey) {
    return jsonResponse({ error: 'Enter a Pixabay API key.' }, 400);
  }

  await env.mydukapos_kv.put(`image-search-config:${clientId}`, JSON.stringify({ pixabayApiKey: apiKey }));
  return jsonResponse({ success: true });
}
