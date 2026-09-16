// functions/api/mpesa-status.js — Cloudflare Pages Function
//
// The POS polls this every few seconds after sending an STK Push, to find out
// whether the customer has completed (or cancelled) the payment yet. Scoped
// per client link (the `c` query param — see _license.js). Works the same
// regardless of which gateway sent the prompt (Paystack, Daraja, or KCB
// Buni) — the stored record's `provider` field decides which fallback check
// to use.
//
// Normally the result comes from a webhook having already written it to the
// shared store (mpesa-callback.js for Daraja AND KCB — their callback shapes
// are identical — paystack-webhook.js for Paystack). As a safety net for
// lost/delayed webhooks, this also falls back to actively asking the gateway
// directly if we've been waiting a while with no update yet — except for
// KCB, which has no documented status-query endpoint to fall back on, so it
// relies on the callback alone.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadGatewayConfig } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';

const FALLBACK_QUERY_AFTER_MS = 15000; // only bother querying the gateway directly after this long

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

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

/* ---------- Daraja fallback ---------- */

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
  if (!res.ok) throw new Error('OAuth failed');
  const data = await res.json();
  return data.access_token;
}

// Directly asks Safaricom for the outcome — used only as a fallback when our
// own callback hasn't arrived yet. Note: this endpoint confirms success/failure
// but does NOT return the M-Pesa receipt number, so we still rely on the
// callback for that. We only use this fallback to unblock a definite FAILURE
// (e.g. customer cancelled) rather than leaving the cashier waiting needlessly.
async function queryDarajaStatus(checkoutRequestId, cfg) {
  const shortcode = cfg.mpesaShortcode;
  const passkey = cfg.mpesaPasskey;
  if (!shortcode || !passkey) return null;

  const token = await darajaAccessToken(cfg);
  const timestamp = darajaTimestamp();
  const password = btoa(`${shortcode}${passkey}${timestamp}`);

  const res = await fetch(`${darajaBaseUrl(cfg)}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function refreshFromDaraja(record, checkoutRequestId, cfg) {
  const queryResult = await queryDarajaStatus(checkoutRequestId, cfg);
  if (queryResult && String(queryResult.ResultCode) !== '0') {
    return {
      ...record,
      status: 'failed',
      resultDesc: queryResult.ResultDesc || 'Payment was not completed.',
    };
  }
  // If ResultCode is "0" (success) we deliberately do NOT mark it success here —
  // we wait for the real callback so we have the M-Pesa receipt number too.
  return null;
}

/* ---------- Paywave Express fallback ---------- */
// Their /v1/tstatus endpoint returns everything needed (status, receipt,
// amount) in one call — used the same safety-net way as the Daraja/Paystack
// fallbacks above, in case their webhook is ever lost or delayed.
async function refreshFromPaywaveExpress(record, checkoutRequestId, cfg) {
  if (!cfg.paywaveApiKey || !cfg.paywaveEmail) return null;
  // Sends whichever identifier is actually available — the initial push's
  // response may or may not have included transaction_request_id under
  // that exact name (unverified against a live Paywave account), so the
  // CheckoutRequestID this record is already keyed by is included too, on
  // the chance their status endpoint accepts either.
  if (!record.transactionRequestId && !checkoutRequestId) return null;

  const res = await fetch('https://paywavexpress.co.ke/v1/tstatus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.paywaveApiKey,
      email: cfg.paywaveEmail,
      transaction_request_id: record.transactionRequestId || checkoutRequestId,
      checkout_request_id: checkoutRequestId,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();

  const status = (data.TransactionStatus || data.status || data.ResultDesc || '').toString().toLowerCase();
  const succeeded = status.includes('complet') || status.includes('success') || String(data.ResponseCode) === '0';
  const failed = status.includes('fail') || status.includes('cancel');

  if (succeeded) {
    return {
      ...record,
      status: 'success',
      resultDesc: data.ResultDesc || 'Payment received.',
      receiptNumber: data.TransactionReceipt,
      amount: data.TransactionAmount ? Number(data.TransactionAmount) : record.amount,
      transactionDate: data.TransactionDate,
      completedAt: Date.now(),
    };
  }
  if (failed) {
    return {
      ...record,
      status: 'failed',
      resultDesc: data.ResultDesc || 'Payment was not completed.',
    };
  }
  // Pending — leave as-is, keep waiting.
  return null;
}

/* ---------- Paystack fallback ---------- */

// Unlike Daraja's query endpoint, Paystack's Verify Transaction endpoint returns
// everything we need (status, receipt_number, amount) — so on a successful
// verify we can resolve the sale directly, without waiting for the webhook.
async function refreshFromPaystack(record, reference, cfg) {
  const secret = cfg.paystackSecretKey;
  if (!secret) return null;

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const data = body && body.data;
  if (!data) return null;

  if (data.status === 'success') {
    return {
      ...record,
      status: 'success',
      resultDesc: data.gateway_response || 'Payment received.',
      receiptNumber: data.receipt_number || data.reference,
      amount: typeof data.amount === 'number' ? Math.round(data.amount / 100) : record.amount,
      transactionDate: data.paid_at,
      completedAt: Date.now(),
    };
  }
  if (['failed', 'abandoned', 'reversed'].includes(data.status)) {
    return {
      ...record,
      status: 'failed',
      resultDesc: data.gateway_response || data.message || 'Payment was not completed.',
    };
  }
  // ongoing / pending / processing / queued — leave as-is, keep waiting
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const checkoutRequestId = url.searchParams.get('checkoutRequestId');
  if (!checkoutRequestId) {
    return jsonResponse({ error: 'Missing checkoutRequestId' }, 400);
  }

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const kvKey = txKey(clientId, checkoutRequestId);
  const raw = await env.mydukapos_kv.get(kvKey);
  let record = raw ? JSON.parse(raw) : null;

  if (!record) {
    return jsonResponse({ status: 'unknown' });
  }

  if (record.status === 'pending' && Date.now() - (record.createdAt || 0) > FALLBACK_QUERY_AFTER_MS) {
    try {
      const cfg = await loadGatewayConfig(env, clientId);
      const provider = record.provider || 'daraja'; // records saved before this update default to daraja
      // KCB Buni has no documented "query STK status" endpoint to fall back
      // on the way Daraja and Paystack do, so a KCB transaction just keeps
      // reporting "pending" here until its callback arrives — the callback
      // (mpesa-callback.js) is still the primary, reliable path either way;
      // this fallback only exists as a safety net for the other two.
      const updated = provider === 'paystack'
        ? await refreshFromPaystack(record, checkoutRequestId, cfg)
        : provider === 'kcb'
          ? null
          : provider === 'paywave'
            ? await refreshFromPaywaveExpress(record, checkoutRequestId, cfg)
            : await refreshFromDaraja(record, checkoutRequestId, cfg);
      if (updated) {
        record = updated;
        await env.mydukapos_kv.put(kvKey, JSON.stringify(record));
      }
    } catch (e) {
      // Fallback query failed (e.g. credentials not set) — just keep reporting "pending"
    }
  }

  return jsonResponse({
    status: record.status,
    receiptNumber: record.receiptNumber,
    phone: record.phone,
    amount: record.amount,
    resultDesc: record.resultDesc,
  });
}
