// functions/api/paywave-webhook.js — Cloudflare Pages Function
//
// Receives Paywave Express's payment notifications, scoped to one client
// link. Paywave Express's STK push request has no callback_url param at
// all (unlike Daraja/KCB) — instead you configure ONE webhook URL in your
// own Paywave Express account dashboard, so each shop must paste the URL
// shown in Settings -> Payment Gateway on their own link — it already
// includes ?c=<their client id> — into their own Paywave Express dashboard.
// That's how this single shared route knows which shop's transaction record
// to update.
//
// Only needed if you're using Paywave Express as the payment gateway (see
// mpesa-stkpush.js). Requires a KV namespace bound as `mydukapos_kv`.
//
// Paywave Express's docs don't describe a signature scheme for their
// webhooks (unlike Paystack's HMAC-signed payload), so this trusts the
// payload's own ResponseCode the same way their own sample PHP handler
// does — there's nothing stronger to verify against.

function txKey(clientId, id) {
  return `mpesa-tx:${clientId}:${id}`;
}

function ack() {
  return new Response(JSON.stringify({ status: 'received' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';
  if (!clientId) {
    // No client id in the webhook URL — nothing we can attribute this to.
    return ack();
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return ack();
  }

  // Tries several plausible field names for the transaction identifier —
  // built from Paywave's public docs without a live account to verify the
  // exact webhook payload shape against, so this stays lenient on purpose
  // rather than silently dropping a real webhook over a field-name guess
  // that turns out wrong.
  const checkoutId = data && (data.CheckoutRequestID || data.checkout_request_id || data.CheckoutRequestId
    || data.transaction_reference || data.TransactionReference || data.reference);
  if (!checkoutId) {
    return ack();
  }

  const kvKey = txKey(clientId, checkoutId);
  const existingRaw = await env.mydukapos_kv.get(kvKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const statusText = (data.status || data.Status || data.TransactionStatus || '').toString().toLowerCase();
  const succeeded = String(data.ResponseCode) === '0'
    || statusText.includes('success') || statusText.includes('complet')
    || data.success === true || String(data.success).toLowerCase() === 'true';

  await env.mydukapos_kv.put(kvKey, JSON.stringify({
    ...existing,
    provider: 'paywave',
    status: succeeded ? 'success' : 'failed',
    resultDesc: data.ResponseDescription || (succeeded ? 'Payment received.' : 'Payment was not completed.'),
    receiptNumber: succeeded ? (data.TransactionReceipt || data.TransactionID) : existing.receiptNumber,
    phone: data.Msisdn || existing.phone,
    amount: typeof data.TransactionAmount === 'number' ? data.TransactionAmount : existing.amount,
    transactionDate: data.TransactionDate,
    completedAt: succeeded ? Date.now() : existing.completedAt,
  }));

  return ack();
}

export async function onRequest() {
  return ack();
}
