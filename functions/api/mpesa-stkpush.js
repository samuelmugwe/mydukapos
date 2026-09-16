// functions/api/mpesa-stkpush.js — Cloudflare Pages Function
//
// Sends the M-Pesa STK push prompt to the customer's phone, scoped to one
// client link (the `c` query param — see _license.js). The POS calls this
// when the cashier clicks "Send M-Pesa Prompt", and does a GET to check which
// gateway is configured (used by the Settings panel's status readout).
//
// Three interchangeable gateways are supported — configure ONE of them from
// inside the app, in Settings -> Payment Gateway (this saves into mydukapos_kv via
// /api/gateway-config, scoped to this client's link). Nothing in the code or
// the rest of the front-end needs to change either way.
//
// OPTION A — Paystack (simplest: one key, no Daraja app/certs needed)
//   Paystack secret key (sk_live_... or sk_test_...)
//   Also add a webhook in your Paystack Dashboard -> Settings -> API Keys & Webhooks,
//   using the URL shown in Settings -> Payment Gateway (already includes ?c=...).
//
// OPTION B — Safaricom Daraja directly
//   Environment (sandbox/production), Consumer Key, Consumer Secret,
//   Shortcode (Paybill/Till), Passkey, and optionally the transaction type —
//   all entered in Settings -> Payment Gateway. The callback URL is generated
//   automatically and includes this client's ?c=... token, so Safaricom's
//   callback lands back on the right shop's data.
//
// OPTION C — KCB Buni (bank-direct M-Pesa STK Push, via KCB rather than
//   Safaricom's own Daraja)
//   Environment (sandbox/production), Consumer Key, Consumer Secret, and the
//   Till/Short Code KCB provisions for this specific merchant during their
//   own onboarding — confirmed directly from a real merchant's KCB portal
//   that there's no shared/default code that works for everyone; every
//   shop's Till is specific to them. KCB's callback payload is shaped
//   identically to Safaricom's, so it's handled by the exact same
//   mpesa-callback.js — no separate callback URL needed. Also note: KCB
//   requires a manual production-approval step (emailing buni@kcbgroup.com
//   with the Consumer Key, Till, and callback URL) before a Consumer Key can
//   actually move real money — this app has no way to automate that step.
//
// OPTION D — Paywave Express (a hosted aggregator that wraps Daraja for you —
//   just an API key + the email on your Paywave Express account, no Daraja
//   app/certs of your own needed)
//   Docs: https://paywavexpress.co.ke/documentation. Their STK push endpoint
//   takes no callback_url — Paywave sends webhooks to whatever URL you paste
//   into YOUR Paywave Express dashboard, so the URL shown in Settings ->
//   Payment Gateway (already includes ?c=...) needs to be pasted in there
//   once, same as the Paystack setup step above.
//
// If you set up more than one, Paystack is used by default. Force a specific
// one with the "Force a specific provider" dropdown in Settings.
//
// Blocked with 403 if this link's license isn't currently valid (expired
// demo, admin-locked, or unknown link).
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadGatewayConfig, resolveProvider } from './_gateway-config.js';
import { requireValidLicense, resolveClientId } from './_license.js';

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

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

// Accepts 07XXXXXXXX, 7XXXXXXXX, 01XXXXXXXX or 2547XXXXXXXX and normalizes to 2547XXXXXXXX / 2541XXXXXXXX
function normalizePhone(raw) {
  let p = (raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

/* ---------- Daraja (Safaricom) ---------- */

function darajaBaseUrl(cfg) {
  const envName = (cfg.mpesaEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

function darajaTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function darajaAccessToken(cfg) {
  const auth = btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`);

  const res = await fetch(`${darajaBaseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error('Could not authenticate with M-Pesa. Check the Consumer Key / Consumer Secret saved in Settings.');
  }
  const data = await res.json();
  return data.access_token;
}

async function sendViaDaraja({ phone, amount, accountRef, description }, cfg, callbackUrl) {
  const token = await darajaAccessToken(cfg);
  const shortcode = cfg.mpesaShortcode;
  const passkey = cfg.mpesaPasskey;
  const timestamp = darajaTimestamp();
  const password = btoa(`${shortcode}${passkey}${timestamp}`);

  const stkRes = await fetch(`${darajaBaseUrl(cfg)}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: cfg.mpesaTransactionType || 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: description,
    }),
  });

  const stkData = await stkRes.json();
  if (!stkRes.ok || stkData.ResponseCode !== '0') {
    throw new Error(stkData.errorMessage || stkData.ResponseDescription || 'M-Pesa declined the STK Push request.');
  }

  return {
    id: stkData.CheckoutRequestID,
    merchantRequestId: stkData.MerchantRequestID,
    customerMessage: stkData.CustomerMessage || 'Prompt sent to customer phone.',
  };
}

/* ---------- KCB Buni ---------- */
// Docs: https://sandbox.buni.kcbgroup.com/devportal/apis (STK Push product).
// Sandbox/UAT base confirmed as uat.buni.kcbgroup.com by KCB's own walkthrough;
// production is the bare buni.kcbgroup.com host, dropping the "uat." prefix —
// the same pattern KCB uses for sandbox.buni.kcbgroup.com elsewhere in their
// docs. Worth double-checking with KCB directly before a first production
// run, since this specific detail wasn't in an official reference doc.

function kcbBaseUrl(cfg) {
  const envName = (cfg.kcbEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://buni.kcbgroup.com' : 'https://uat.buni.kcbgroup.com';
}

// Confirmed directly from a shop's own KCB developer portal: production
// token requests go to a SEPARATE identity domain, not the same host as
// the STK push API itself (kcbBaseUrl above). Sandbox, by contrast, really
// does use the same uat.buni.kcbgroup.com host for both — confirmed by
// KCB's own widely-cited integration walkthrough. These aren't the same
// pattern with an environment swapped in; they're genuinely different URL
// shapes, so this can't be derived from kcbBaseUrl() the way the STK push
// call is.
function kcbTokenUrl(cfg) {
  const envName = (cfg.kcbEnv || 'sandbox').toLowerCase();
  return envName === 'production'
    ? 'https://accounts.buni.kcbgroup.com/oauth2/token?grant_type=client_credentials'
    : 'https://uat.buni.kcbgroup.com/token?grant_type=client_credentials';
}

async function kcbAccessToken(cfg) {
  const auth = btoa(`${cfg.kcbConsumerKey}:${cfg.kcbConsumerSecret}`);
  const res = await fetch(kcbTokenUrl(cfg), {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error('Could not authenticate with KCB Buni. Check the Consumer Key / Consumer Secret saved in Settings.');
  }
  const data = await res.json();
  return data.access_token;
}

async function sendViaKcb({ phone, amount, accountRef, description }, cfg, callbackUrl) {
  // Confirmed directly from a real merchant's own KCB onboarding: their
  // Till/shortcode is provisioned specifically for them as part of getting
  // production access approved — it's never optional, and there's no
  // generic fallback code that works for everyone. Silently defaulting to
  // a guessed shortcode here would mean money going to the wrong place, so
  // this fails loudly instead if it's missing.
  if (!cfg.kcbOrgShortCode) {
    throw new Error('No KCB Till/Short Code saved. Enter the Till Number KCB provisioned for this shop in Settings \u2014 there is no shared/default code that works for every merchant.');
  }

  const token = await kcbAccessToken(cfg);

  const payload = {
    phoneNumber: phone,
    amount: String(amount),
    invoiceNumber: accountRef,
    // Defaults to false — a shop's own provisioned Till is normally NOT a
    // shared code (see above). This only needs to be true in the rarer
    // case KCB has actually told a merchant they're on a shared shortcode.
    sharedShortCode: cfg.kcbSharedShortCode === true,
    orgShortCode: cfg.kcbOrgShortCode,
    orgPassKey: cfg.kcbOrgPassKey || '',
    callbackUrl,
    transactionDescription: description,
  };

  const stkRes = await fetch(`${kcbBaseUrl(cfg)}/mm/api/request/1.0.0/stkpush`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const stkData = await stkRes.json();
  const resp = stkData && stkData.response;
  if (!stkRes.ok || !resp || String(resp.ResponseCode) !== '0') {
    throw new Error((resp && resp.ResponseDescription) || 'KCB declined the STK Push request.');
  }

  return {
    id: resp.CheckoutRequestID,
    merchantRequestId: resp.MerchantRequestID,
    customerMessage: resp.CustomerMessage || 'Prompt sent to customer phone.',
  };
}

/* ---------- Paywave Express ---------- */
// Docs: https://paywavexpress.co.ke/documentation — a hosted aggregator that
// wraps Daraja for you. No callback_url param on their STK push request at
// all (unlike Daraja/KCB) — Paywave posts to whatever webhook URL is saved
// in YOUR Paywave Express account dashboard instead, which is why the
// webhook route (paywave-webhook.js) exists as its own separate file rather
// than reusing mpesa-callback.js.
async function sendViaPaywaveExpress({ phone, amount, accountRef }, cfg) {
  if (!cfg.paywaveApiKey || !cfg.paywaveEmail) {
    throw new Error('Paywave Express is missing its API key or account email — enter both in Settings.');
  }

  const res = await fetch('https://paywavexpress.co.ke/v1/stkpush', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.paywaveApiKey,
      email: cfg.paywaveEmail,
      amount: String(amount),
      msisdn: phone,
      reference: accountRef,
    }),
  });

  let data;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    // Not JSON at all — surface the raw text directly, since that's the
    // most likely place to see something like an HTML error page from an
    // upstream gateway/proxy rather than Paywave's own API.
    throw new Error(`Paywave Express returned an unexpected (non-JSON) response: ${rawText.slice(0, 300) || `HTTP ${res.status}`}`);
  }

  // Accepts several plausible shapes for "this succeeded" rather than one
  // specific field name — built from Paywave's public docs without a live
  // account to verify the exact response against, so this stays lenient on
  // purpose: any one clear success signal is enough, and the *first*
  // real-world failure's raw response (surfaced below) is what should
  // narrow this down precisely, rather than guessing a second time blind.
  const succeeded = res.ok && (
    String(data.ResponseCode) === '0' ||
    data.success === true ||
    data.success === '200' ||
    String(data.success).toLowerCase() === 'true' ||
    String(data.status).toLowerCase() === 'success' ||
    !!data.CheckoutRequestID
  );

  if (!succeeded) {
    // Includes the raw JSON so whatever Paywave actually sent back is
    // visible in the error shown to the person trying to pay — the fastest
    // way to pin down the exact field names their API really uses if this
    // still doesn't match.
    const detail = data.errorMessage || data.message || data.error || JSON.stringify(data).slice(0, 300);
    throw new Error(`Paywave Express declined the STK Push request (HTTP ${res.status}): ${detail}`);
  }

  return {
    // CheckoutRequestID matches the shape mpesa-status.js already polls by
    // for every other provider — transactionRequestId is kept alongside it
    // for refreshFromPaywaveExpress()'s own /v1/tstatus fallback query.
    id: data.CheckoutRequestID,
    transactionRequestId: data.transaction_request_id,
    merchantRequestId: data.MerchantRequestID,
    customerMessage: data.message || 'Prompt sent to customer phone.',
  };
}

/* ---------- Paystack ---------- */

async function sendViaPaystack({ phone, amount, accountRef }, cfg) {
  const secret = cfg.paystackSecretKey;

  // Paystack's Charge API always requires an email to identify the "customer" —
  // the POS doesn't collect one, so we synthesize a stable placeholder from the phone.
  // NOTE: must NOT use a reserved pseudo-TLD like .local/.invalid/.test/.example —
  // Paystack's email validation rejects those outright with "Invalid Email Address
  // Passed", even though the rest of the address is well-formed. Use a real TLD.
  const email = `${phone}@pos-customer.co.ke`;

  const res = await fetch('https://api.paystack.co/charge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      amount: Math.round(amount * 100), // Paystack amounts are in the currency's subunit (cents)
      currency: 'KES',
      mobile_money: { phone: `+${phone}`, provider: 'mpesa' },
      metadata: { accountRef },
    }),
  });

  const data = await res.json();
  if (!res.ok || data.status !== true || !data.data || !data.data.reference) {
    throw new Error((data && (data.message || data.data?.gateway_response)) || 'Paystack declined the charge request.');
  }
  if (data.data.status === 'failed' || data.data.status === 'abandoned') {
    throw new Error(data.data.display_text || 'Paystack could not start the M-Pesa prompt.');
  }

  return {
    id: data.data.reference,
    merchantRequestId: data.data.reference,
    customerMessage: data.data.display_text || 'Prompt sent to customer phone.',
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Lightweight status check used by the Settings panel — no charge is made.
export async function onRequestGet(context) {
  const { request, env } = context;
  const clientId = await resolveClientId(request, env);
  const cfg = await loadGatewayConfig(env, clientId);
  return jsonResponse({ provider: resolveProvider(cfg) });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const cfg = await loadGatewayConfig(env, clientId);
  const provider = resolveProvider(cfg);
  if (!provider) {
    return jsonResponse({
      error: 'No payment gateway configured. Go to Settings -> Payment Gateway and save your Paystack secret key, your Daraja credentials, your KCB Buni credentials, or your Paywave Express API key.',
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const phone = normalizePhone(body.phone);
  const amount = Math.max(1, Math.round(Number(body.amount) || 0));
  const accountRef = String(body.accountRef || 'POS Sale').slice(0, 12);
  const description = String(body.description || 'POS Sale').slice(0, 13);

  if (!/^254(7|1)\d{8}$/.test(phone)) {
    return jsonResponse({ error: 'Invalid phone number. Use format 07XXXXXXXX or 2547XXXXXXXX.' }, 400);
  }
  if (!amount) {
    return jsonResponse({ error: 'Invalid amount.' }, 400);
  }

  try {
    const origin = new URL(request.url).origin;
    // The client id is embedded in the callback URL itself, so Safaricom's
    // POST to mpesa-callback.js carries it right back to us.
    const callbackUrl = `${origin}/api/mpesa-callback?c=${encodeURIComponent(clientId)}`;

    const result = provider === 'paystack'
      ? await sendViaPaystack({ phone, amount, accountRef, description }, cfg)
      : provider === 'kcb'
        ? await sendViaKcb({ phone, amount, accountRef, description }, cfg, callbackUrl)
        : provider === 'paywave'
          ? await sendViaPaywaveExpress({ phone, amount, accountRef, description }, cfg)
          : await sendViaDaraja({ phone, amount, accountRef, description }, cfg, callbackUrl);

    // Save a "pending" placeholder — keyed by the same id in both gateways —
    // so the status endpoint (and, for Paystack, the webhook) has an immediate
    // record to find and update.
    await env.mydukapos_kv.put(txKey(clientId, result.id), JSON.stringify({
      provider,
      status: 'pending',
      phone,
      amount,
      accountRef,
      transactionRequestId: result.transactionRequestId,
      createdAt: Date.now(),
    }));

    return jsonResponse({
      checkoutRequestId: result.id,
      merchantRequestId: result.merchantRequestId,
      customerMessage: result.customerMessage,
    });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected error contacting the payment gateway.' }, 500);
  }
}
