// functions/api/_etims-config.js — shared helper, NOT a route.
//
// Stores a client's KRA eTIMS (OSCU) registration: the PIN, branch ID, and
// environment they entered in Settings, plus — critically — the `cmcKey`
// (Communication Key) that KRA's own server hands back the FIRST time device
// initialization succeeds. That key, not the PIN, is what actually proves
// "this shop is registered" — it has to be sent with every subsequent
// eTIMS request, and there is no way to look it up again if lost; it can
// only be re-obtained by re-running initialization.
//
// IMPORTANT CONTEXT ANYONE TOUCHING THIS FILE SHOULD KNOW:
// KRA requires a business to apply for OSCU access and be approved by KRA
// BEFORE device initialization will succeed at all — this module cannot
// skip or shortcut that. Entering a PIN here and clicking "Register" will
// simply fail with an error from KRA until that approval is in place.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

const KV_KEY_PREFIX = 'etims-config:v1:';

async function readStored(env, clientId) {
  try {
    const raw = await env.mydukapos_kv.get(KV_KEY_PREFIX + clientId);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

export async function loadEtimsConfig(env, clientId) {
  const stored = await readStored(env, clientId);
  return {
    etimsEnv: stored.etimsEnv || 'sandbox',
    etimsPin: stored.etimsPin || '',
    etimsBranchId: stored.etimsBranchId || '00',
    etimsDeviceSerial: stored.etimsDeviceSerial || '',
    // Everything below is only ever set by a successful KRA initialization
    // response — never typed in by the shop directly.
    etimsCmcKey: stored.etimsCmcKey || '',
    etimsDeviceId: stored.etimsDeviceId || '',
    etimsSdcId: stored.etimsSdcId || '',
    etimsMrcNo: stored.etimsMrcNo || '',
    etimsTaxpayerName: stored.etimsTaxpayerName || '',
    etimsBranchName: stored.etimsBranchName || '',
    etimsRegisteredAt: stored.etimsRegisteredAt || null,
    // KRA requires each submitted sale to carry a strictly sequential,
    // gapless invoice number — see nextEtimsInvoiceNo() below for why this
    // has to be tracked here rather than per-device.
    etimsNextInvoiceNo: stored.etimsNextInvoiceNo || 0,
  };
}

// Saves only the fields present in `updates` — never wipes a field the
// caller didn't send.
export async function saveEtimsConfig(env, clientId, updates) {
  const stored = await readStored(env, clientId);
  const merged = { ...stored };

  const fields = [
    'etimsEnv', 'etimsPin', 'etimsBranchId', 'etimsDeviceSerial',
    'etimsCmcKey', 'etimsDeviceId', 'etimsSdcId', 'etimsMrcNo',
    'etimsTaxpayerName', 'etimsBranchName', 'etimsRegisteredAt', 'etimsNextInvoiceNo',
  ];
  fields.forEach((key) => {
    if (updates[key] !== undefined) merged[key] = updates[key];
  });

  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify(merged));
  return merged;
}

export async function clearEtimsConfig(env, clientId) {
  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify({}));
}

// A cmcKey only ever exists after a real, successful KRA registration — so
// its presence alone is the correct "is this shop actually set up" check,
// distinct from just having typed a PIN in.
export function hasEtimsConfig(cfg) {
  return !!cfg.etimsCmcKey;
}

// KRA requires each invoice's `invcNo` to be a strictly sequential, gapless
// counter — never reused, never skipped. Since more than one device for the
// same shop could in principle submit a sale around the same time, this
// counter is owned and incremented here on the backend rather than tracked
// per-device, where two devices could otherwise hand out the same number.
// Cloudflare KV has no atomic increment primitive of its own; this reads,
// increments, and writes back — the eTIMS submission route that calls this
// processes one sale at a time per shop, so this is safe in practice even
// without a true compare-and-swap.
export async function nextEtimsInvoiceNo(env, clientId) {
  const cfg = await loadEtimsConfig(env, clientId);
  const next = (cfg.etimsNextInvoiceNo || 0) + 1;
  await saveEtimsConfig(env, clientId, { etimsNextInvoiceNo: next });
  return next;
}

// Test/sandbox and production hosts, per KRA's own OSCU specification —
// note the URLs already end in a slash from KRA's own documentation.
export function etimsBaseUrl(cfg) {
  return cfg.etimsEnv === 'production'
    ? 'https://etims-api.kra.go.ke/etims-api'
    : 'https://etims-api-sbx.kra.go.ke/etims-api';
}
