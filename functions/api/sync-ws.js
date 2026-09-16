// functions/api/sync-ws.js — Cloudflare Pages Function
//
// WebSocket entry point for cross-device LIVE push. Each POS app's
// connectSyncSocket() (see e.g. water/index.html) opens a connection here on
// launch. This function's only job is to validate the license exactly the
// way every other business-data endpoint does (see _license.js), then hand
// the raw upgrade request off to that client's own SyncRoom Durable Object
// instance — see the bottom of wildcard-router/worker.js for the class
// itself, and pos-sync.js's onRequestPost for the broadcast trigger that
// pushes a fresh record to every socket in the room the moment any device
// saves a change.
//
// Requires the SYNC_ROOM Durable Object binding (see wrangler.toml) to be
// deployed and configured. If it isn't, this returns a plain error and the
// calling device's own 7-second poll (already running regardless) keeps
// working exactly as it always has — this endpoint is a pure enhancement,
// never a dependency for correctness.

import { requireValidLicense } from './_license.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const upgradeHeader = request.headers.get('Upgrade') || '';
  if (upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade request.', { status: 426 });
  }

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return new Response(JSON.stringify({ error: 'This link is not active.', reason: license.reason }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.SYNC_ROOM) {
    // Binding not configured yet (see wrangler.toml's comment) — fail
    // plainly rather than throwing, so the client's own reconnect/backoff
    // logic treats this the same as any other closed connection.
    return new Response('Live sync is not configured on this deployment.', { status: 501 });
  }

  const roomId = env.SYNC_ROOM.idFromName(license.clientId);
  const room = env.SYNC_ROOM.get(roomId);
  return room.fetch(request);
}
