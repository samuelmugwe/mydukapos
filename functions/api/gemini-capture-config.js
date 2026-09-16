// functions/api/gemini-capture-config.js — Cloudflare Pages Function
//
// Holds the platform-wide pool of Google Gemini API keys (up to 10) that
// power "AI Capture List" (Inventory → Add New Items / Restock → 📸
// Capture List) across every shop on this deployment. Configured once
// from the Owner Console (Settings → AI Capture List) — NOT something
// each shop/client configures for itself, unlike sms-config.js where
// every client brings their own SMS account.
//
// WHY A POOL, NOT ONE KEY: each Gemini API key/account has its own free
// daily & per-minute quota. With many shops sharing a single key, that
// quota gets hit fast and AI Capture List starts failing for everyone.
// Keeping up to 10 keys (e.g. from 10 different Google accounts) lets
// ai-capture-list.js rotate to the next key the instant one is
// rate-limited/exhausted, instead of the request just failing — see
// callGeminiForJson()'s rotation loop there.
//
// The keys are write-only from the client's point of view: 'get' never
// returns a raw key, only a masked list (id/label/last4) — same pattern
// email-config.js and _owner-auth.js use for their own secrets.
//
// ai-capture-list.js (the actual OCR endpoint every shop's device calls)
// reads this pool directly from KV via getGeminiCaptureKeys() below — it
// does NOT go through this route, since that route is gated by each
// shop's own license, not owner auth. This is only the FALLBACK pool,
// though: a shop that has saved its own Gemini key(s) (Settings → AI
// Capture List, stored separately in KV — see SHOP_CONFIG_PREFIX in
// ai-capture-list.js) tries those first and only falls through to this
// platform pool once its own keys are exhausted.
//
// Actions (all POST, JSON body, owner-auth required):
//   { action: 'get' }
//     Returns { keys: [{ id, label, last4 }], count, max }.
//   { action: 'add', geminiApiKey, label? }
//     Appends a new key to the pool (max 10). label is optional, shown
//     in the owner console list so multiple keys/accounts are easy to
//     tell apart (e.g. "Account A"). Returns the updated masked list.
//   { action: 'remove', id }
//     Removes one key from the pool by its id.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';

const CONFIG_KEY = 'gemini-capture-config:v1';
const MAX_PLATFORM_KEYS = 10;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function last4(key) {
  const k = String(key || '');
  return k.length > 4 ? k.slice(-4) : k;
}

function maskKeys(keys) {
  return keys.map(k => ({ id: k.id, label: k.label || '', last4: last4(k.key) }));
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await requireOwnerAuth(context))) {
    return jsonResponse({ error: 'Not authorized.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const config = await getGeminiCaptureConfig(env);

  if (body.action === 'get') {
    return jsonResponse({ keys: maskKeys(config.geminiApiKeys), count: config.geminiApiKeys.length, max: MAX_PLATFORM_KEYS });
  }

  if (body.action === 'add') {
    const geminiApiKey = String(body.geminiApiKey || '').trim();
    if (!geminiApiKey) {
      return jsonResponse({ error: 'Enter a Gemini API key.' }, 400);
    }
    if (config.geminiApiKeys.length >= MAX_PLATFORM_KEYS) {
      return jsonResponse({ error: `Already at the maximum of ${MAX_PLATFORM_KEYS} platform keys — remove one first.` }, 400);
    }
    if (config.geminiApiKeys.some(k => k.key === geminiApiKey)) {
      return jsonResponse({ error: 'That key is already in the pool.' }, 400);
    }
    const label = String(body.label || '').trim().slice(0, 60);
    config.geminiApiKeys.push({ id: crypto.randomUUID().slice(0, 8), key: geminiApiKey, label, addedAt: Date.now() });
    await env.mydukapos_kv.put(CONFIG_KEY, JSON.stringify(config));
    return jsonResponse({ ok: true, keys: maskKeys(config.geminiApiKeys), count: config.geminiApiKeys.length, max: MAX_PLATFORM_KEYS });
  }

  if (body.action === 'remove') {
    const id = String(body.id || '');
    const before = config.geminiApiKeys.length;
    config.geminiApiKeys = config.geminiApiKeys.filter(k => k.id !== id);
    if (config.geminiApiKeys.length === before) {
      return jsonResponse({ error: 'Key not found.' }, 404);
    }
    await env.mydukapos_kv.put(CONFIG_KEY, JSON.stringify(config));
    return jsonResponse({ ok: true, keys: maskKeys(config.geminiApiKeys), count: config.geminiApiKeys.length, max: MAX_PLATFORM_KEYS });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}

// Normalized shape: { geminiApiKeys: [{ id, key, label, addedAt }] }.
// Transparently migrates the old single-key shape ({ geminiApiKey }) from
// before the multi-key pool existed — the migrated entry is included in
// whatever gets read/returned but isn't persisted until the owner next
// adds or removes a key (at which point the whole normalized shape is
// written back).
export async function getGeminiCaptureConfig(env) {
  const raw = await env.mydukapos_kv.get(CONFIG_KEY);
  if (!raw) return { geminiApiKeys: [] };
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.geminiApiKeys)) return parsed;
  if (parsed.geminiApiKey) {
    return { geminiApiKeys: [{ id: 'legacy', key: parsed.geminiApiKey, label: '', addedAt: 0 }] };
  }
  return { geminiApiKeys: [] };
}

// Used by ai-capture-list.js — returns the raw ordered list of platform
// key strings (never exposed to any client-facing route).
export async function getGeminiCaptureKeys(env) {
  const config = await getGeminiCaptureConfig(env);
  return config.geminiApiKeys.map(k => k.key).filter(Boolean);
}
