// functions/api/till-payments.js — Cloudflare Pages Function
//
// Backs a small panel in Settings -> Payment Gateway listing customers who
// paid directly to the till (no STK Push) — captured by
// mpesa-c2b-confirmation.js (Daraja) or kcb-ipn.js (KCB Buni). Paystack and
// Paywave Express don't have an equivalent "customer pays independently"
// concept — both are always initiated by the shop itself (STK Push or a
// hosted checkout page), so there's nothing for either of those to capture
// here.
//
// GET    -> the most recent till payments for this client (newest first).
// POST   -> marks one as matched/unmatched (body: { transId, matched }) —
//           purely a bookkeeping flag so the cashier can tell at a glance
//           which incoming payments they've already accounted for in a
//           sale/bill and which are still unmatched.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tillPaymentKey(clientId, transId) {
  return `till-payment:${clientId}:${transId}`;
}

function tillPaymentIndexKey(clientId) {
  return `till-payment-index:${clientId}`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const idxRaw = await env.mydukapos_kv.get(tillPaymentIndexKey(clientId));
  const idx = idxRaw ? JSON.parse(idxRaw) : [];

  const records = await Promise.all(
    idx.slice(0, 50).map(async (transId) => {
      const raw = await env.mydukapos_kv.get(tillPaymentKey(clientId, transId));
      return raw ? JSON.parse(raw) : null;
    })
  );

  return jsonResponse({ payments: records.filter(Boolean) });
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
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }
  if (!body.transId) return jsonResponse({ error: 'Missing transId.' }, 400);

  const key = tillPaymentKey(clientId, body.transId);
  const raw = await env.mydukapos_kv.get(key);
  if (!raw) return jsonResponse({ error: 'Payment not found.' }, 404);

  const record = JSON.parse(raw);
  record.matched = !!body.matched;
  await env.mydukapos_kv.put(key, JSON.stringify(record));

  return jsonResponse({ success: true });
}
