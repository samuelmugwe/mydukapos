// functions/api/mpesa-c2b-validation.js — Cloudflare Pages Function
//
// Safaricom calls this BEFORE mpesa-c2b-confirmation.js, asking "should I
// even accept this payment?" — only if ValidationURL was included when
// registering (see mpesa-c2b-register.js; it's optional, and most Paybill/
// Till setups skip it and go straight to auto-accepting like this always
// does). There's no real reason for a shop to reject an incoming till
// payment here — if it's real money landing in their account, they want to
// know about it regardless — so this always accepts, and
// mpesa-c2b-confirmation.js is where the actual capture happens.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project
// (not actually used here, kept only for consistency with the confirmation
// endpoint's signature).

function accept() {
  return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost() {
  return accept();
}

export async function onRequest() {
  return accept();
}
