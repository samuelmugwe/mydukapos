// functions/api/backups.js — Cloudflare Pages Function
//
// Backs the Settings -> Backups panel in each product's front-end. Scoped
// per client link the same way as pos-sync.js — see _license.js. Every
// daily snapshot pos-sync.js takes (see maybeSnapshotBackup in _backups.js)
// lives under a per-client KV prefix; this endpoint lists what's available
// for THIS client and lets the admin restore one of them back onto their
// own live state.
//
// GET  -> { dates: ["2026-08-01", "2026-07-31", ...] }  (newest first)
// POST { date } -> restores that day's snapshot as this client's current
//                  live state.
//
// Restoring is destructive (it replaces whatever every device on this link
// would sync next), so the front-end gates this behind the management
// password before calling it — this endpoint itself has no way to verify
// that password (it's hashed and only ever compared client-side), so the
// license check below is the real gate: only a currently-valid link can
// restore its own backups, never someone else's.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';
import { listBackupDates, restoreBackup } from './_backups.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

export async function onRequestGet(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  const dates = await listBackupDates(env, license.clientId);
  return jsonResponse({ dates });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const result = await restoreBackup(env, license.clientId, body && body.date);
  if (result.error) return jsonResponse({ error: result.error }, result.status || 400);
  return jsonResponse(result);
}
