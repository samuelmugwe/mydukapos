// functions/api/website-content.js — Cloudflare Pages Function
//
// A single, centrally-editable source for everything that used to be
// hardcoded in multiple places: the public marketing site's price and
// testimonials, AND the "send money to X" upgrade prompt that appears on
// EVERY product app's license-lock screen when a demo expires. Before this
// existed, changing the price meant editing it separately in 7 different
// app files plus the public site — now it's one value, read everywhere.
//
// Actions (all POST, JSON body):
//   { action: 'get' }
//     Public, no auth — returns the current content. Called by the public
//     site on every page load, and by every product app's license-lock
//     screen. Falls back to sensible defaults if nothing's been saved yet,
//     so a fresh deployment isn't left blank.
//   { action: 'set', content }
//     Owner-auth required — replaces the stored content wholesale. Called
//     from Owner Console's Website tab.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';
import { listProducts, getDemoDurationHours, setDemoDurationHours } from './_license.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const CONTENT_KEY = 'website-content';

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// What a fresh deployment shows before the owner has ever saved anything —
// matches what was previously hardcoded, so switching to this system
// doesn't change anything visible until the owner actually edits it.
const DEFAULT_CONTENT = {
  price: 3000,
  paymentPhone: '0113607529',
  // Which products appear in the public site's homepage grid and app.html's
  // switcher — a hidden product's own detail page (app.html?product=X)
  // still works fine for anyone with a direct link; this only controls
  // discovery surfaces, not whether the page itself exists.
  visibleProducts: ['shop', 'hotel', 'hospital', 'school', 'production', 'pharmacy', 'services', 'water'],
  // Extra ways to pay, shown alongside the main M-Pesa number — e.g. a bank
  // transfer written out as text, or a till/QR code as a photo. Empty by
  // default; the M-Pesa number above is the only option until the owner
  // adds more.
  alternatePaymentMethods: [],
  testimonials: [
    { quote: 'I used to close my books at midnight trying to figure out where the day\u2019s money went. Now I just open the Daily Sales tab. It has genuinely given me my evenings back.', name: 'Grace Wambui', role: 'Duka owner, Kikuyu' },
    { quote: 'We lost power for two days during a storm and I panicked \u2014 but the till kept ringing up sales the whole time. Everything synced the moment the lights came back. I didn\u2019t lose a single receipt.', name: 'Peter Otieno', role: 'Hardware shop, Kisumu' },
    { quote: 'Running two branches used to mean two sets of books and constant phone calls to check stock. Now I see both branches from my own phone, in real time, from home.', name: 'Faith Njeri', role: 'Minimart owner, Nakuru \u2014 2 branches' },
    { quote: 'My waiters used to argue with guests over the bill. Now the kitchen ticket prints itself the second an order\u2019s taken, and the receipt matches every time. Guests trust us more for it.', name: 'Samuel Kariuki', role: 'Restaurant manager, Thika' },
    { quote: 'I was paying almost this much every single month for a system that still went down constantly. Paid once for mydukapos over a year ago and it has never asked me for another shilling.', name: 'Dorcas Achieng', role: 'Pharmacy owner, Mombasa' },
    { quote: 'Fee collection during term opening used to be chaos \u2014 long queues, lost receipts, parents disputing balances. Now every parent gets an instant receipt and I can see exactly who still owes what.', name: 'Mr. James Mwangi', role: 'School bursar, Eldoret' },
  ],
};

async function getContent(env) {
  const raw = await env.mydukapos_kv.get(CONTENT_KEY);
  if (!raw) return DEFAULT_CONTENT;
  // Merge over the defaults rather than trust the stored value alone, so a
  // partially-saved record (or one saved before a field like paymentPhone
  // existed) still returns every field the callers expect.
  const stored = JSON.parse(raw);
  const merged = { ...DEFAULT_CONTENT, ...stored };

  // Migration: a product added to the codebase AFTER this record was last
  // saved (e.g. water/AquaPOS, or any future product) is missing from the
  // stored visibleProducts array — not because the owner ever chose to
  // hide it, but because it didn't exist yet. Left alone, that product
  // would stay invisible on the public site and app switcher forever,
  // even after being fully built and deployed, until the owner happened
  // to revisit the Website tab and manually tick its checkbox.
  //
  // `knownProducts` snapshots every product key that existed the last
  // time the owner saved. Anything valid now that isn't in that snapshot
  // is newly added and defaults to visible. Records saved before this
  // snapshot field existed (like the one that predates water) treat their
  // own old visibleProducts list as the snapshot, so any product missing
  // from it is correctly recognized as new-since-last-save and shown.
  const validKeys = listProducts().map((p) => p.id);
  const knownProducts = Array.isArray(stored.knownProducts)
    ? stored.knownProducts
    : (Array.isArray(stored.visibleProducts) ? stored.visibleProducts : validKeys);
  const newlyAdded = validKeys.filter((k) => !knownProducts.includes(k));
  if (newlyAdded.length) {
    const visible = new Set(Array.isArray(merged.visibleProducts) ? merged.visibleProducts : []);
    newlyAdded.forEach((k) => visible.add(k));
    merged.visibleProducts = validKeys.filter((k) => visible.has(k));
  }
  return merged;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'get') {
    const content = await getContent(env);
    // Sourced from _license.js's own KV key (not this record) so it stays
    // the exact single value createClient()/owner-lock.js's "extend" also
    // read — this is just where the public site and Owner Console's
    // Website tab fetch it from for display/editing.
    content.demoDurationHours = await getDemoDurationHours(env);
    return jsonResponse({ content });
  }

  if (body.action === 'set') {
    const ok = await requireOwnerAuth(context);
    if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

    if (!body.content || typeof body.content !== 'object') {
      return jsonResponse({ error: 'No content provided.' }, 400);
    }

    const price = parseFloat(body.content.price);
    if (isNaN(price) || price < 0) {
      return jsonResponse({ error: 'Enter a valid price.' }, 400);
    }
    const paymentPhone = String(body.content.paymentPhone || '').trim();
    if (!paymentPhone) {
      return jsonResponse({ error: 'Enter a payment phone number.' }, 400);
    }
    let demoDurationHours;
    try {
      demoDurationHours = await setDemoDurationHours(env, body.content.demoDurationHours);
    } catch (e) {
      return jsonResponse({ error: e.message || 'Enter a valid demo duration.' }, 400);
    }
    const testimonials = Array.isArray(body.content.testimonials) ? body.content.testimonials : [];
    const cleanTestimonials = testimonials
      .map((t) => ({ quote: String(t.quote || '').trim(), name: String(t.name || '').trim(), role: String(t.role || '').trim() }))
      .filter((t) => t.quote && t.name);

    const validKeys = listProducts().map((p) => p.id);
    const visibleProducts = Array.isArray(body.content.visibleProducts)
      ? body.content.visibleProducts.filter((p) => validKeys.includes(p))
      : validKeys;

    const rawMethods = Array.isArray(body.content.alternatePaymentMethods) ? body.content.alternatePaymentMethods : [];
    if (rawMethods.length > 10) {
      return jsonResponse({ error: 'Too many alternate payment methods \u2014 keep it to 10 or fewer.' }, 400);
    }
    const alternatePaymentMethods = [];
    for (const m of rawMethods) {
      const label = String(m.label || '').trim();
      if (!label) return jsonResponse({ error: 'Every alternate payment method needs a label.' }, 400);
      if (m.type === 'photo') {
        const photoDataUrl = String(m.photoDataUrl || '');
        if (!photoDataUrl.startsWith('data:image/')) {
          return jsonResponse({ error: `"${label}" needs a photo.` }, 400);
        }
        // ~500KB of actual image data (base64 runs ~33% larger than the
        // source bytes) — this whole record is fetched on every page load
        // of the public site and every product app, so it needs to stay
        // small regardless of how generous KV's own 25MB ceiling is.
        if (photoDataUrl.length > 700000) {
          return jsonResponse({ error: `"${label}"'s photo is too large \u2014 please use a smaller image (under ~500KB).` }, 400);
        }
        alternatePaymentMethods.push({ id: m.id || randomId(), label, type: 'photo', photoDataUrl });
      } else {
        const details = String(m.details || '').trim();
        if (!details) return jsonResponse({ error: `"${label}" needs some details text.` }, 400);
        alternatePaymentMethods.push({ id: m.id || randomId(), label, type: 'text', details });
      }
    }

    // Snapshot every product key valid at save time, so a product added
    // to the codebase later is recognized as "new since last save" and
    // defaults to visible (see the migration logic in getContent above)
    // instead of silently vanishing until someone notices and re-checks it.
    const content = { price, paymentPhone, visibleProducts, alternatePaymentMethods, testimonials: cleanTestimonials, knownProducts: validKeys };
    await env.mydukapos_kv.put(CONTENT_KEY, JSON.stringify(content));
    content.demoDurationHours = demoDurationHours;
    return jsonResponse({ content });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
