// functions/api/_gateway-config.js — shared helper, NOT a route.
//
// Cloudflare Pages Functions turns every .js file under functions/api into a
// route, EXCEPT files/folders whose name starts with "_" — those are treated
// as regular JS modules that other functions can import. This file is one of
// those: gateway-config.js, mpesa-stkpush.js, mpesa-status.js, and
// paystack-webhook.js all import it.
//
// Why this file exists:
// The Settings -> Payment Gateway panel in index.html lets the shop owner
// paste in their Paystack key, Daraja credentials, or KCB Buni credentials
// and click "Save" — that calls POST /api/gateway-config, which stores them
// here in mydukapos_kv. Without this file (and the accompanying
// gateway-config.js route), that Save button had nowhere to send the keys,
// so anything typed into Settings was silently lost and the app kept
// relying on Cloudflare Pages environment variables instead — which is why
// "adding the keys through Settings" didn't actually turn payments on.
//
// Environment variables still work as a FALLBACK: if a field was never saved
// through Settings, we fall back to the matching Cloudflare Pages env var (if
// someone set one directly in the dashboard). Whatever was saved through
// Settings always wins over the env var of the same name.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

const KV_KEY_PREFIX = 'gateway-config:v1:';

async function readStored(env, clientId) {
  try {
    const raw = await env.mydukapos_kv.get(KV_KEY_PREFIX + clientId);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

// Merges what's saved in KV for this client with env-var fallbacks into one
// config object every other function can just read fields off of.
export async function loadGatewayConfig(env, clientId) {
  const stored = await readStored(env, clientId);

  return {
    paystackSecretKey: stored.paystackSecretKey || env.PAYSTACK_SECRET_KEY || '',
    mpesaEnv: stored.mpesaEnv || env.MPESA_ENV || 'sandbox',
    mpesaConsumerKey: stored.mpesaConsumerKey || env.MPESA_CONSUMER_KEY || '',
    mpesaConsumerSecret: stored.mpesaConsumerSecret || env.MPESA_CONSUMER_SECRET || '',
    mpesaShortcode: stored.mpesaShortcode || env.MPESA_SHORTCODE || '',
    mpesaPasskey: stored.mpesaPasskey || env.MPESA_PASSKEY || '',
    mpesaTransactionType: stored.mpesaTransactionType || env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    // KCB Buni — a second way to send the exact same kind of M-Pesa STK
    // Push prompt, through KCB's bank-direct API instead of Safaricom's own
    // Daraja. sharedShortCode defaults true, matching every example in
    // KCB's own docs — most integrators pay into KCB's shared paybill
    // (522522) with their own invoiceNumber/account ref telling them apart,
    // rather than having their own dedicated Till.
    kcbEnv: stored.kcbEnv || env.KCB_ENV || 'sandbox',
    kcbConsumerKey: stored.kcbConsumerKey || env.KCB_CONSUMER_KEY || '',
    kcbConsumerSecret: stored.kcbConsumerSecret || env.KCB_CONSUMER_SECRET || '',
    kcbOrgShortCode: stored.kcbOrgShortCode || env.KCB_ORG_SHORT_CODE || '',
    kcbOrgPassKey: stored.kcbOrgPassKey || env.KCB_ORG_PASS_KEY || '',
    kcbSharedShortCode: stored.kcbSharedShortCode !== undefined ? stored.kcbSharedShortCode : true,
    // Paywave Express — a hosted aggregator that wraps Daraja for you (see
    // paywavexpress.co.ke/documentation). Just an API key + the email on the
    // Paywave Express account; no Daraja app/certs needed.
    paywaveApiKey: stored.paywaveApiKey || env.PAYWAVE_API_KEY || '',
    paywaveEmail: stored.paywaveEmail || env.PAYWAVE_EMAIL || '',
    forcedProvider: (stored.forcedProvider !== undefined ? stored.forcedProvider : (env.PAYMENT_PROVIDER || '')).toLowerCase(),
  };
}

// Saves only the fields present in `updates`, merged field-by-field into
// whatever's already stored for this client — never wipes fields the caller
// didn't send.
export async function saveGatewayConfig(env, clientId, updates) {
  const stored = await readStored(env, clientId);
  const merged = { ...stored };

  if (updates.provider !== undefined) merged.forcedProvider = updates.provider;
  if (updates.kcbSharedShortCode !== undefined) merged.kcbSharedShortCode = !!updates.kcbSharedShortCode;

  const fields = [
    'paystackSecretKey',
    'mpesaEnv',
    'mpesaConsumerKey',
    'mpesaConsumerSecret',
    'mpesaShortcode',
    'mpesaPasskey',
    'mpesaTransactionType',
    'kcbEnv',
    'kcbConsumerKey',
    'kcbConsumerSecret',
    'kcbOrgShortCode',
    'kcbOrgPassKey',
    'paywaveApiKey',
    'paywaveEmail',
  ];
  fields.forEach((key) => {
    if (updates[key] !== undefined && updates[key] !== '') merged[key] = updates[key];
  });

  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify(merged));
  return merged;
}

// Used by the Settings panel's "Reset" button for one provider — clears just
// that provider's fields (and, if it was the forced choice, the force too)
// without touching the other providers' saved config.
export async function clearGatewayProvider(env, clientId, which) {
  const stored = await readStored(env, clientId);
  const merged = { ...stored };

  const fieldsByProvider = {
    paystack: ['paystackSecretKey'],
    daraja: ['mpesaConsumerKey', 'mpesaConsumerSecret', 'mpesaShortcode', 'mpesaPasskey'],
    kcb: ['kcbConsumerKey', 'kcbConsumerSecret', 'kcbOrgShortCode', 'kcbOrgPassKey'],
    paywave: ['paywaveApiKey', 'paywaveEmail'],
  };
  const fields = fieldsByProvider[which] || [];
  fields.forEach((key) => { delete merged[key]; });
  if (merged.forcedProvider === which) delete merged.forcedProvider;

  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify(merged));
  return merged;
}

export function hasDarajaConfig(cfg) {
  return !!(cfg.mpesaConsumerKey && cfg.mpesaConsumerSecret && cfg.mpesaShortcode && cfg.mpesaPasskey);
}

export function hasPaystackConfig(cfg) {
  return !!cfg.paystackSecretKey;
}

export function hasKcbConfig(cfg) {
  return !!(cfg.kcbConsumerKey && cfg.kcbConsumerSecret);
}

export function hasPaywaveConfig(cfg) {
  return !!(cfg.paywaveApiKey && cfg.paywaveEmail);
}

// An explicit forcedProvider wins (if that provider is actually configured);
// otherwise Paystack is preferred if more than one happens to be configured.
export function resolveProvider(cfg) {
  const forced = (cfg.forcedProvider || '').trim().toLowerCase();
  if (forced === 'paystack' && hasPaystackConfig(cfg)) return 'paystack';
  if (forced === 'daraja' && hasDarajaConfig(cfg)) return 'daraja';
  if (forced === 'kcb' && hasKcbConfig(cfg)) return 'kcb';
  if (forced === 'paywave' && hasPaywaveConfig(cfg)) return 'paywave';
  if (hasPaystackConfig(cfg)) return 'paystack';
  if (hasDarajaConfig(cfg)) return 'daraja';
  if (hasKcbConfig(cfg)) return 'kcb';
  if (hasPaywaveConfig(cfg)) return 'paywave';
  return null;
}
