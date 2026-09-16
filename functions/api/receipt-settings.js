// functions/api/receipt-settings.js — Cloudflare Pages Function
//
// Lets a branch group choose between two modes for what prints at the top
// and bottom of every receipt (logo, contact details, QR, paper size, etc.):
// each branch keeping its own separate settings (the default, and how this
// app has always worked), or one shared set of settings used by every
// branch, managed centrally. Only the group's main branch can turn sharing
// on/off or edit the shared settings — every other branch just reads them.
//
// Lives in its own KV entry (receipt-settings:<branchGroupId>), completely
// separate from any individual client's synced state — same pattern as
// store.js and payment-accounts.js, for the same reason: this needs to be
// readable by every branch regardless of which one last wrote it, and a
// per-client sync payload can't do that.
//
// Actions (all POST, JSON body — caller identified by license the same way
// as every other endpoint in this app):
//   { action: 'get' }
//     Returns { useShared, settings, isMainBranch } for the caller's branch
//     group. isMainBranch tells the frontend whether this caller is allowed
//     to change any of it.
//   { action: 'setUseShared', useShared }
//     Turns shared mode on/off. Main branch only.
//   { action: 'save', settings }
//     Overwrites the shared settings object wholesale. Main branch only,
//     and only takes effect if shared mode is already on.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense } from './_license.js';

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

function settingsKey(groupId) {
  return `receipt-settings:${groupId}`;
}

async function getStored(env, groupId) {
  const raw = await env.mydukapos_kv.get(settingsKey(groupId));
  return raw ? JSON.parse(raw) : { useShared: false, settings: null };
}

async function saveStored(env, groupId, data) {
  await env.mydukapos_kv.put(settingsKey(groupId), JSON.stringify(data));
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
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const record = await getLicense(env, license.clientId);
  if (!record) return jsonResponse({ error: 'Client not found.' }, 404);
  if (!record.branchGroupId) {
    return jsonResponse({ error: 'This shop is not part of a branch group.' }, 400);
  }
  const groupId = record.branchGroupId;
  const isMainBranch = !!record.isMainBranch;

  if (body.action === 'get') {
    const data = await getStored(env, groupId);
    return jsonResponse({ ...data, isMainBranch });
  }

  if (body.action === 'setUseShared') {
    if (!isMainBranch) return jsonResponse({ error: 'Only the main branch can change this.' }, 403);
    const data = await getStored(env, groupId);
    data.useShared = !!body.useShared;
    await saveStored(env, groupId, data);
    return jsonResponse({ ...data, isMainBranch });
  }

  if (body.action === 'save') {
    if (!isMainBranch) return jsonResponse({ error: 'Only the main branch can change this.' }, 403);
    const data = await getStored(env, groupId);
    if (!data.useShared) return jsonResponse({ error: 'Turn on shared receipt settings first.' }, 400);
    data.settings = body.settings || {};
    await saveStored(env, groupId, data);
    return jsonResponse({ ...data, isMainBranch });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
