// functions/api/paystack-webhook.js — Cloudflare Pages Function
//
// Receives Paystack's payment notifications, scoped to one client link. Since
// Paystack webhooks are configured once per Paystack account (Dashboard ->
// Settings -> API Keys & Webhooks -> Webhook URL), each shop must set THEIR
// webhook URL to the one shown in Settings -> Payment Gateway on their own
// link, which already includes ?c=<their client id> — that's how this single
// shared route knows which shop's transaction record to update.
//
// Only needed if you're using Paystack as the payment gateway (see mpesa-stkpush.js).
// Uses that client's own Paystack secret key saved via Settings -> Payment
// Gateway. Requires a KV namespace bound as `mydukapos_kv`.

import { loadGatewayConfig } from './_gateway-config.js';

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

function ack() {
  return new Response('ok', { status: 200 });
}

// Paystack signs the raw request body with HMAC-SHA512 using your secret key.
// Uses the Web Crypto API (available natively in the Workers runtime) instead
// of Node's `crypto` module.
async function hmacSha512Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';
  if (!clientId) {
    // No client id in the webhook URL — nothing we can attribute this to.
    return ack();
  }

  const cfg = await loadGatewayConfig(env, clientId);
  const secret = cfg.paystackSecretKey;
  if (!secret) {
    // Not configured for Paystack — nothing we can safely verify or act on.
    return ack();
  }

  // We must hash the RAW text (not a re-serialized/re-parsed copy) or the
  // signature will never match.
  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature') || '';
  const expected = await hmacSha512Hex(secret, rawBody);

  if (!signature || signature !== expected) {
    // Reject anything that isn't genuinely from Paystack.
    return new Response('Invalid signature', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return ack();
  }

  if (event && event.event === 'charge.success' && event.data && event.data.reference) {
    const data = event.data;
    const kvKey = txKey(clientId, data.reference);
    const existingRaw = await env.mydukapos_kv.get(kvKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};

    await env.mydukapos_kv.put(kvKey, JSON.stringify({
      ...existing,
      provider: 'paystack',
      status: 'success',
      resultDesc: data.gateway_response || 'Payment received.',
      receiptNumber: data.receipt_number || data.reference,
      phone: (data.customer && data.customer.phone) || existing.phone,
      amount: typeof data.amount === 'number' ? Math.round(data.amount / 100) : existing.amount,
      transactionDate: data.paid_at,
      completedAt: Date.now(),
    }));
  }

  // Paystack only sends charge.success for mobile money — a failed/abandoned
  // STK push simply never fires a webhook, which is why mpesa-status.js also
  // falls back to actively verifying with Paystack after a short wait.

  return ack();
}

export async function onRequest() {
  return ack();
}
