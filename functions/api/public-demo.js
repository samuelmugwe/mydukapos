// functions/api/public-demo.js — Cloudflare Pages Function
//
// The self-serve "generate a demo" button on the public marketing site
// (public-site/app.html) — deliberately the ONLY client-creation endpoint in
// this whole app that requires no authentication at all, since a visitor
// browsing the public site has no owner login. Always creates a 72-hour
// demo, never a permanent client — upgrading to permanent still only
// happens through the owner (see owner-confirm.js), the same as every other
// demo generated any other way.
//
// Rate-limited by IP (not by client, since there's no login here to key
// off) — a generous but real cap, so this can't be turned into an
// unlimited link-generation tool by an automated script.
//
// Actions (all POST, JSON body):
//   { action: 'generate', product, businessName }
//     Creates a 72-hour demo for the given product. businessName becomes
//     the link's label (and therefore its subdomain slug) — same as typing
//     a "Link Display Name" in Owner Console's own Generate Link tab, just
//     typed by the visitor instead of the owner. Returns { link, product }.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { createClient, clientLink, listProducts } from './_license.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function rateLimitKey(ip) {
  return `public-demo-rate:${ip}`;
}

// Same bypass mechanism as demo-account.js — shares the RATE_LIMIT_BYPASS_IPS
// env var so one setting covers both signup and demo-generation limits.
function isBypassIp(env, ip) {
  const list = String(env.RATE_LIMIT_BYPASS_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(ip);
}

// 5 demos per IP per rolling 24 hours — generous for a real visitor trying
// a couple of products, but a hard ceiling on automated abuse. KV's own
// expirationTtl handles the 24-hour rolling window without needing a
// separate cleanup job.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action !== 'generate') {
    return jsonResponse({ error: 'Unknown action.' }, 400);
  }

  const validProducts = listProducts().map((p) => p.id);
  if (!validProducts.includes(body.product)) {
    return jsonResponse({ error: 'Unknown product.' }, 400);
  }

  const businessName = String(body.businessName || '').trim();
  if (!businessName) {
    return jsonResponse({ error: 'Enter your business name.' }, 400);
  }
  if (businessName.length > 60) {
    return jsonResponse({ error: 'Business name is too long.' }, 400);
  }

  // Cloudflare always sets this on requests that reach a Pages Function —
  // falling back to a constant only protects against a local/dev request
  // that has no such header, not something a real visitor would hit.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bypass = isBypassIp(env, ip);
  const rateKey = rateLimitKey(ip);
  const rawCount = bypass ? 0 : await env.mydukapos_kv.get(rateKey);
  const count = rawCount ? parseInt(rawCount, 10) : 0;
  if (!bypass && count >= RATE_LIMIT_MAX) {
    return jsonResponse({ error: 'Too many demos generated from this connection today \u2014 please try again tomorrow, or contact us directly.' }, 429);
  }

  const record = await createClient(env, 'demo', businessName, body.product, { source: 'website' });
  if (!bypass) {
    await env.mydukapos_kv.put(rateKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  }

  const origin = new URL(request.url).origin;
  return jsonResponse({ link: clientLink(env, record, origin), product: body.product, expiresAt: record.expiresAt });
}
