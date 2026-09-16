// functions/api/mpesa-c2b-confirmation.js — Cloudflare Pages Function
//
// Safaricom calls THIS endpoint automatically, in real time, whenever a
// customer pays directly to a shop's Paybill/Till — typing the number into
// their own M-Pesa menu themselves, with no STK Push and no app involvement
// at all. This is the only way to capture who paid, how much, and when for
// that kind of payment; there is no polling or app-side action that could
// otherwise learn about it.
//
// Requires a ONE-TIME setup step first: the shop's Validation and
// Confirmation URLs (this file, and mpesa-c2b-validation.js) must be
// registered with Safaricom against their Paybill/Till — see
// mpesa-c2b-register.js, called from the "Register Till URLs" button in
// Settings -> Payment Gateway. Only works once Daraja credentials (Option B)
// are saved for this shop, since the registration call needs them.
//
// Scoped per client via the `c` query param baked into the URL that was
// registered — see mpesa-c2b-register.js for how that URL is built.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

function tillPaymentKey(clientId, transId) {
  return `till-payment:${clientId}:${transId}`;
}

function tillPaymentIndexKey(clientId) {
  return `till-payment-index:${clientId}`;
}

function ack(extra = {}) {
  return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted', ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientId = new URL(request.url).searchParams.get('c') || '';
  if (!clientId) {
    // No client id in the confirmation URL — nothing we can attribute this
    // to, but Safaricom still needs a 200 or it'll retry indefinitely.
    return ack();
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return ack();
  }

  const transId = data.TransID;
  if (!transId) return ack();

  // A customer's registered name arrives as up to three separate fields —
  // joined here into one, skipping any that are genuinely blank (a
  // corporate line or an unregistered name sometimes leaves Middle/Last
  // blank rather than sending empty strings, so this can't just naively
  // join all three with spaces every time).
  const fullName = [data.FirstName, data.MiddleName, data.LastName]
    .filter((n) => n && String(n).trim())
    .join(' ');

  const record = {
    transId,
    transTime: data.TransTime || '',
    amount: parseFloat(data.TransAmount) || 0,
    phone: data.MSISDN || '',
    customerName: fullName,
    accountRef: data.BillRefNumber || '',
    businessShortCode: data.BusinessShortCode || '',
    orgBalance: data.OrgAccountBalance || '',
    matched: false, // set true once a cashier attaches this to a bill/sale
    receivedAt: Date.now(),
  };

  await env.mydukapos_kv.put(tillPaymentKey(clientId, transId), JSON.stringify(record));

  // Maintain a small index of recent till-payment ids so the Settings panel
  // can list them without needing a KV list-by-prefix scan on every load —
  // capped at the most recent 100, oldest dropped first.
  try {
    const idxRaw = await env.mydukapos_kv.get(tillPaymentIndexKey(clientId));
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    idx.unshift(transId);
    await env.mydukapos_kv.put(tillPaymentIndexKey(clientId), JSON.stringify(idx.slice(0, 100)));
  } catch (e) {
    // Index update failing shouldn't fail the confirmation itself — the
    // payment record above is already safely saved either way.
  }

  return ack();
}

export async function onRequest() {
  return ack();
}
