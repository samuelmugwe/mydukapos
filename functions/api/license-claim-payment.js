// functions/api/license-claim-payment.js — Cloudflare Pages Function
//
// Called when a shop owner clicks "I have made this payment" on the demo
// lock/upgrade screen after sending KES 3,000 via M-Pesa. This does NOT
// verify the payment or upgrade anything by itself — it just flags the
// client record as "awaiting confirmation" so it shows up in the Master
// admin dashboard's pending list. An admin still has to manually confirm it
// there (via owner-confirm.js, from the 🔗 Licenses tab) after checking the
// M-Pesa/till statement, which is what actually upgrades the link to
// permanent.
//
// Also handles the KES 1,500 branch add-on claim (body.kind ===
// 'branch-addon'), same "flag it, admin confirms manually" pattern — see
// owner-confirm.js's 'confirm-addon' action for the other half. An add-on
// claim always lands on the branch GROUP's main record (getGroupMainRecord),
// never on the individual branch link that happened to trigger it, since
// branchAllowance is tracked once per group, not once per branch — that
// way it doesn't matter whether the owner clicks "Add Branch" from the main
// shop's link or from an existing branch's link, the claim always shows up
// in the same place in the Licenses tab.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { getLicense, saveLicense, resolveClientId, getGroupMainRecord } from './_license.js';

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

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = await resolveClientId(request, env);
  const record = await getLicense(env, clientId);
  if (!record) {
    return jsonResponse({ error: 'Invalid or expired link.' }, 404);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    // Body is optional — the original base-tier claim call sends none.
  }

  if (body.kind === 'branch-addon') {
    if (record.type !== 'permanent') {
      return jsonResponse({ error: 'Upgrade to a permanent license before adding a branch.' }, 400);
    }
    const mainRecord = await getGroupMainRecord(env, record);
    mainRecord.branchAddonClaimed = true;
    mainRecord.branchAddonClaimedAt = Date.now();
    await saveLicense(env, mainRecord);
    return jsonResponse({ ok: true });
  }

  record.paymentClaimed = true;
  record.paymentClaimedAt = Date.now();
  await saveLicense(env, record);

  return jsonResponse({ ok: true });
}
