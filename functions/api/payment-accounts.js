// functions/api/payment-accounts.js — Cloudflare Pages Function
//
// A shop's payment accounts (tills, bank accounts, mobile money lines) are a
// branch-group-wide resource, not something each branch keeps its own copy
// of — add one from any branch and every branch sees it immediately, and
// connecting an account to a branch from anywhere updates for everyone. For
// a standalone shop with no branches, it's just that shop's own account
// list. Either way it lives in its own KV entry (payment-accounts:<groupId>
// or payment-accounts:<clientId> when there's no group), completely
// separate from any individual client's synced state — same pattern as
// store.js, for the same reason.
//
// Actions (all POST, JSON body — caller identified by license the same way
// as every other endpoint in this app):
//   { action: 'get' }
//     Returns the current account list for the caller's branch group.
//   { action: 'add', name }
//     Adds a new account, starting out not connected to any branch.
//   { action: 'setBranch', accountId, branchClientId }
//     Connects (or, with branchClientId empty/null, disconnects) an account
//     to a specific branch. branchClientId, when set, must be a member of
//     the caller's own branch group.
//   { action: 'remove', accountId }
//     Deletes an account entirely.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense, getBranchGroupMembers, randomToken } from './_license.js';

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

function accountsKey(groupId) {
  return `payment-accounts:${groupId}`;
}

async function getAccounts(env, groupId) {
  const raw = await env.mydukapos_kv.get(accountsKey(groupId));
  return raw ? JSON.parse(raw) : [];
}

async function saveAccounts(env, groupId, accounts) {
  await env.mydukapos_kv.put(accountsKey(groupId), JSON.stringify(accounts));
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
  // A shop in a branch group shares one account list with every branch
  // (keyed by the group). A standalone shop with no branches still gets an
  // account list of its own, keyed to itself.
  const groupId = record.branchGroupId || record.id;

  if (body.action === 'get') {
    const accounts = await getAccounts(env, groupId);
    return jsonResponse({ accounts });
  }

  if (body.action === 'add') {
    const name = String(body.name || '').trim();
    if (!name) return jsonResponse({ error: 'Enter an account name.' }, 400);
    const accounts = await getAccounts(env, groupId);
    accounts.push({ id: randomToken(10), name, branchClientId: null, createdAt: Date.now() });
    await saveAccounts(env, groupId, accounts);
    return jsonResponse({ accounts });
  }

  if (body.action === 'setBranch') {
    const accounts = await getAccounts(env, groupId);
    const account = accounts.find((a) => a.id === body.accountId);
    if (!account) return jsonResponse({ error: 'Account not found.' }, 404);

    const branchClientId = String(body.branchClientId || '').trim();
    if (branchClientId) {
      const memberIds = record.branchGroupId ? await getBranchGroupMembers(env, record.branchGroupId) : [record.id];
      if (!memberIds.includes(branchClientId)) {
        return jsonResponse({ error: 'That branch is not part of this shop\u2019s branch group.' }, 400);
      }
      account.branchClientId = branchClientId;
    } else {
      account.branchClientId = null;
    }
    await saveAccounts(env, groupId, accounts);
    return jsonResponse({ accounts });
  }

  if (body.action === 'remove') {
    const accounts = await getAccounts(env, groupId);
    const remaining = accounts.filter((a) => a.id !== body.accountId);
    await saveAccounts(env, groupId, remaining);
    return jsonResponse({ accounts: remaining });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
