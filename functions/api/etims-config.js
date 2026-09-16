// functions/api/etims-config.js — Cloudflare Pages Function
//
// Backs the Settings -> eTIMS (KRA) panel, scoped per client link (the `c`
// query param — see _license.js). A shop enters their KRA PIN and Branch
// ID and clicks "Register", which calls this with { action: 'register' }.
// This in turn calls KRA's own OSCU device-initialization endpoint
// (/selectInitOsdcInfo) — the ONE-TIME step that proves a device to KRA and
// receives back a `cmcKey` (Communication Key), which is what every future
// eTIMS request will need to send. There is nothing to configure beyond
// that from this app's side; KRA's own approval of the business for OSCU
// access has to already be in place, or this call fails with KRA's own
// error message, unrelated to anything in this code.
//
// GET    -> tells the Settings panel what's configured so far (never sends
//           the cmcKey back — only whether one exists, plus the PIN, branch,
//           and the taxpayer/branch name KRA itself confirmed at
//           registration, so the shop can see KRA recognised the right
//           business without re-exposing the secret key itself).
// POST   -> { action: 'register', pin, branchId, env } performs the KRA
//           device-initialization call and stores the result.
// DELETE -> clears the whole registration, so the shop can start over
//           (e.g. if they registered against the wrong PIN or branch).
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadEtimsConfig, saveEtimsConfig, clearEtimsConfig, hasEtimsConfig, etimsBaseUrl } from './_etims-config.js';
import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A stable, unique-enough device serial derived from the client's own id,
// rather than a random one generated fresh each time — so re-running
// registration (e.g. after switching sandbox to production) reuses the same
// device identity with KRA instead of registering a new "device" every time.
function deviceSerialFor(clientId) {
  return `mydukapos-${clientId}`.slice(0, 100); // KRA's dvcSrlNo field caps at 100 chars
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const cfg = await loadEtimsConfig(env, clientId);
  return jsonResponse({
    hasEtimsConfig: hasEtimsConfig(cfg),
    etimsEnv: cfg.etimsEnv,
    etimsPin: cfg.etimsPin,
    etimsBranchId: cfg.etimsBranchId,
    etimsTaxpayerName: cfg.etimsTaxpayerName,
    etimsBranchName: cfg.etimsBranchName,
    etimsRegisteredAt: cfg.etimsRegisteredAt,
  });
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
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action !== 'register') {
    return jsonResponse({ error: 'Unknown action.' }, 400);
  }

  const pin = String(body.pin || '').trim().toUpperCase();
  const branchId = String(body.branchId || '00').trim();
  const env_ = body.env === 'production' ? 'production' : 'sandbox';

  if (!/^[A-Z]\d{9}[A-Z]$/.test(pin)) {
    return jsonResponse({ error: 'That doesn\u2019t look like a valid KRA PIN (expected format like A123456789Z).' }, 400);
  }
  if (!/^\d{2}$/.test(branchId)) {
    return jsonResponse({ error: 'Branch ID should be two digits \u2014 "00" for your head office/main branch, or the branch code KRA assigned.' }, 400);
  }

  const deviceSerial = deviceSerialFor(clientId);
  const baseUrl = etimsBaseUrl({ etimsEnv: env_ });

  let kraData;
  try {
    const res = await fetch(`${baseUrl}/selectInitOsdcInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tin: pin, bhfId: branchId, dvcSrlNo: deviceSerial }),
    });
    kraData = await res.json();
  } catch (e) {
    return jsonResponse({ error: 'Could not reach KRA\u2019s eTIMS server \u2014 check your connection and try again.' }, 502);
  }

  if (!kraData || kraData.resultCd !== '000') {
    const kraMessage = (kraData && kraData.resultMsg) || 'KRA rejected the registration.';
    // The most common real-world cause: OSCU access hasn't been approved
    // for this PIN yet — that approval happens on KRA's side, not here.
    return jsonResponse({
      error: `KRA said: "${kraMessage}" \u2014 if this PIN hasn\u2019t been approved for OSCU/eTIMS system-to-system access yet, that has to be requested and approved on KRA\u2019s own eTIMS portal first; this page can\u2019t skip that step.`,
    }, 400);
  }

  const info = kraData.data && kraData.data.info;
  if (!info || !info.cmcKey) {
    return jsonResponse({ error: 'KRA accepted the request but didn\u2019t return a communication key \u2014 try again, or contact KRA support if this persists.' }, 502);
  }

  const saved = await saveEtimsConfig(env, clientId, {
    etimsEnv: env_,
    etimsPin: pin,
    etimsBranchId: branchId,
    etimsDeviceSerial: deviceSerial,
    etimsCmcKey: info.cmcKey,
    etimsDeviceId: info.dvcId || '',
    etimsSdcId: info.sdcId || '',
    etimsMrcNo: info.mrcNo || '',
    etimsTaxpayerName: info.taxprNm || '',
    etimsBranchName: info.bhfNm || '',
    etimsRegisteredAt: Date.now(),
  });

  return jsonResponse({
    hasEtimsConfig: true,
    etimsEnv: saved.etimsEnv,
    etimsPin: saved.etimsPin,
    etimsBranchId: saved.etimsBranchId,
    etimsTaxpayerName: saved.etimsTaxpayerName,
    etimsBranchName: saved.etimsBranchName,
    etimsRegisteredAt: saved.etimsRegisteredAt,
  });
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  await clearEtimsConfig(env, license.clientId);
  return jsonResponse({ ok: true });
}
