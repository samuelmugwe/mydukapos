// functions/api/license-status.js — Cloudflare Pages Function
//
// The shop app (index.html) calls this on load, and every ~30s after that, to
// find out whether its link is still valid — and, for a demo link, how much
// time is left. The link may be this shop's own subdomain
// (georgehardware.mydukapos.store) or a legacy ?c=<token> query param — see
// resolveClientId() in _license.js for how that's decided.
//
// This is also the one place the front-end learns its OWN client id and slug
// when it arrived via a bare subdomain (which carries no ?c= token at all) —
// the response includes both so index.html can build staff/invite links
// without needing to know its identity ahead of time.
//
// All timing here comes from Date.now() on this server, never from the
// requesting browser, which is what makes the demo countdown immune to a
// customer changing their computer's clock.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { getLicense, evaluateLicense, resolveClientId } from './_license.js';

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const clientId = await resolveClientId(request, env);
  const record = await getLicense(env, clientId);
  const result = evaluateLicense(record);

  return jsonResponse({
    serverNow: Date.now(),
    valid: result.valid,
    reason: result.reason,
    clientId: record ? record.id : '',
    slug: record ? record.slug || '' : '',
    type: record ? record.type : null,
    expiresAt: record ? record.expiresAt : null,
    remainingMs: result.remainingMs !== undefined ? result.remainingMs : null,
    paymentClaimed: record ? !!record.paymentClaimed : false,
    label: record ? record.label : '',
    branchGroupId: record ? record.branchGroupId || null : null,
    isMainBranch: record ? !!record.isMainBranch : false,
  });
}
