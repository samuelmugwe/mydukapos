// functions/api/website-marketing.js — Cloudflare Pages Function
//
// Holds everything the public marketing site shows that ISN'T already in
// website-content.js (price, payment methods, testimonials, visible
// products) — specifically the larger, image-heavy stuff: a site-wide logo,
// the hero headline/subhead, and per-product tagline/feature-list/
// screenshot. Deliberately a SEPARATE record from website-content.js rather
// than folded into it, for one specific reason: website-content.js is
// fetched by every product app's login screen (to show the current
// upgrade-prompt price), on every single load, for every demo and every
// paying client. Adding several megabytes of screenshots and a logo to
// that same record would mean every POS app — which never displays any of
// this — pays the cost of downloading it anyway. This record is fetched
// ONLY by the public marketing site (public-site/index.html and app.html),
// never by any product app.
//
// Actions (all POST, JSON body):
//   { action: 'get' }
//     Public, no auth — returns the current marketing content. Falls back
//     to sensible defaults (matching what was originally hardcoded on the
//     public site) if nothing's been saved yet.
//   { action: 'set', content }
//     Owner-auth required — replaces the stored content wholesale.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';
import { listProducts } from './_license.js';

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

const CONTENT_KEY = 'website-marketing';

// Matches what was originally hardcoded into public-site/index.html and
// app.html, so switching to this system doesn't change anything visible
// until the owner actually edits something.
const DEFAULT_CONTENT = {
  logoDataUrl: '',
  heroHeadline: 'The till that keeps working even when the internet doesn\u2019t.',
  heroSubhead: 'One app for your shop, hotel, restaurant, bar, hospital, school, or workshop. Every sale recorded, every receipt printed, every shilling accounted for \u2014 online or off.',
  // The homepage's 6-icon feature grid ("Inventory", "Receipts", etc.) —
  // icon/background color stay fixed in the page's own code (design system,
  // not content), but the tag/title/description text shown on each card is
  // editable here.
  featureGrid: [
    { tag: 'Inventory', title: 'Stock that matches the shelf', desc: 'Scan to sell, scan to restock \u2014 every branch, one accurate count, always up to date.' },
    { tag: 'Receipts', title: 'A receipt for every sale', desc: 'Printed on Bluetooth, USB, or any system printer \u2014 or shared straight to WhatsApp.' },
    { tag: 'Insights', title: 'Know your numbers, daily', desc: 'Sales summaries and charts that show exactly where the money came from \u2014 and went.' },
    { tag: 'Alerts', title: 'Never sell out by surprise', desc: 'Low-stock warnings before an item runs out, not after a customer walks away empty-handed.' },
    { tag: 'Any business', title: 'Built for six industries', desc: 'Shop, hotel, restaurant, bar, hospital, school, or workshop \u2014 the same reliable core, tailored.' },
    { tag: 'Staff', title: 'Everyone gets their own login', desc: 'Give each till worker their own account, and see exactly who served what, and when.' },
  ],
  // The homepage's second feature section ("Why owners switch and stay") —
  // three plain text cards, no icons.
  whySwitchCards: [
    { tag: 'Reliability', title: 'Never loses a sale', desc: 'The till works with no internet at all \u2014 every sale is saved on the device the moment it happens, and syncs the second you\u2019re back online. Load shedding, weak signal, none of it stops business.' },
    { tag: 'Simplicity', title: 'Learn it in minutes', desc: 'No manuals, no training courses. If your staff can use WhatsApp, they can run a till on mydukapos on day one \u2014 search, tap, paid.' },
    { tag: 'Fair pricing', title: 'You own it, outright', desc: 'One payment, and it\u2019s yours \u2014 permanently, for that business. No monthly bill eating your margins, no surprise renewal, ever.' },
  ],
  // The two "in real life" photo sections further down the homepage.
  showcases: [
    { eyebrow: 'At the till, in real life', title: 'This is what checkout actually looks like', desc: 'Scan, ring it up, and the customer pays by M-Pesa without you touching another app. The receipt\u2019s printing before they\u2019ve even put their phone away.', imageDataUrl: '' },
    { eyebrow: 'Any business, not just shops', title: 'KRA-compliant, whatever you sell', desc: 'Every sale can submit to eTIMS in real time, with the signature right there on the receipt \u2014 from a supermarket counter to a wines & spirits shelf.', imageDataUrl: '' },
  ],
  products: {
    shop: {
      tagline: 'For retail shops, hardware stores, supermarkets, and minimarts \u2014 inventory that actually matches what\u2019s on the shelf.',
      screenshotDataUrl: '',
      screenshots: [],
      features: [
        { title: 'Barcode-ready inventory', desc: 'Scan to sell, scan to add stock \u2014 with wholesale and retail pricing on every item.' },
        { title: 'Multi-branch, one view', desc: 'Run several branches and see stock, staff, and sales across all of them from your own phone.' },
        { title: 'Shared warehouse ("Store")', desc: 'Keep stock that isn\u2019t assigned to any one branch yet, and pull it into a branch when needed.' },
        { title: 'Cross-branch sales', desc: 'Sell an item from another branch\u2019s stock right at your own counter \u2014 the sale and revenue land at the right branch automatically.' },
        { title: 'Wholesale Contracts', desc: 'Hand stock to an agent or reseller, track what they\u2019ve sold versus what they still owe, all in one place.' },
        { title: 'Trade Credits', desc: 'Track money owed to or from outside parties, separate from day-to-day sales.' },
        { title: 'M-Pesa built in', desc: 'Send an STK push straight from checkout \u2014 no separate till number to manage.' },
        { title: 'KRA eTIMS compliant', desc: 'Every sale can submit to KRA in real time, with the signature shown on the receipt.' },
        { title: 'Works with zero signal', desc: 'Every sale is saved on the device first, and syncs the moment you\u2019re back online.' },
      ],
    },
    hotel: {
      tagline: 'One product for hotels, restaurants, and bars \u2014 tables, rooms, takeaway, and the kitchen, all connected.',
      screenshotDataUrl: '',
      screenshots: [],
      features: [
        { title: 'Tables, rooms, and takeaway', desc: 'Assign a sale to a table or a room, or mark it takeaway \u2014 tracked separately, billed correctly.' },
        { title: 'Kitchen tickets print themselves', desc: 'The moment an order is taken, the kitchen gets its own ticket \u2014 no shouting orders across the room.' },
        { title: 'Takeaway orders, tracked', desc: 'Preparing, ready, or collected \u2014 see exactly where every takeaway order stands.' },
        { title: 'Dish recipes', desc: 'Build a dish from its ingredients, and stock automatically adjusts as dishes sell.' },
        { title: 'Bills and running tabs', desc: 'Let a table run a tab and settle it later \u2014 nothing is forgotten at close.' },
        { title: 'Dual pricing', desc: 'Different pricing for dine-in versus takeaway or wholesale, selectable right at checkout.' },
        { title: 'M-Pesa built in', desc: 'Send an STK push straight from checkout \u2014 no separate till number to manage.' },
        { title: 'Works with zero signal', desc: 'Every sale is saved on the device first, and syncs the moment you\u2019re back online.' },
      ],
    },
    hospital: {
      tagline: 'A lightweight hospital management system \u2014 patient records, consultations, and billing without the complexity of enterprise HMIS software.',
      screenshotDataUrl: '',
      screenshots: [],
      features: [
        { title: 'Patient records', desc: 'Register a patient once, and their history is there every time they come back.' },
        { title: 'Consultations and billing together', desc: 'A visit\u2019s charges build up naturally as care happens, not as a separate step afterward.' },
        { title: 'Pharmacy dispensing', desc: 'Dispense straight from the same system that recorded the consultation.' },
        { title: 'Multi-staff, one record', desc: 'Reception, nursing, and billing all work from the same patient file.' },
        { title: 'Trade Credits & Bills', desc: 'Track outstanding balances and money owed to or from outside parties.' },
        { title: 'M-Pesa built in', desc: 'Send an STK push straight from checkout \u2014 no separate till number to manage.' },
        { title: 'Works with zero signal', desc: 'A clinic with unreliable power or internet still runs, uninterrupted.' },
      ],
    },
    school: {
      tagline: 'Fee collection and student records built for how a Kenyan school bursar\u2019s office actually works.',
      screenshotDataUrl: '',
      screenshots: [],
      features: [
        { title: 'Student registry', desc: 'Admission number, class, guardian details \u2014 searchable in seconds.' },
        { title: 'Fee balances at a glance', desc: 'See who\u2019s paid, who owes, and how much, without digging through a ledger.' },
        { title: 'Instant receipts', desc: 'Every payment gets a receipt on the spot \u2014 no disputes at term opening.' },
        { title: 'Canteen sales too', desc: 'A shop/canteen counter runs alongside fee collection in the same app.' },
        { title: 'M-Pesa built in', desc: 'Parents can pay by STK push directly at the counter.' },
        { title: 'Works with zero signal', desc: 'Every payment is saved on the device first, and syncs the moment you\u2019re back online.' },
      ],
    },
    production: {
      tagline: 'For businesses that build what they sell \u2014 assemble finished goods from raw components, and hire equipment out.',
      screenshotDataUrl: '',
      screenshots: [],
      features: [
        { title: 'Recipes for finished goods', desc: 'Define what a product is built from \u2014 components are only used the moment it actually sells.' },
        { title: 'Hire equipment out', desc: 'Track what\u2019s out, to whom, and when it\u2019s due back \u2014 settled per client, not per item.' },
        { title: 'Add more to an existing hire', desc: 'A returning client\u2019s new items join their existing hire record, not a new one each visit.' },
        { title: 'Client-grouped hires', desc: 'See everything one client has out, their history, and share it to them directly on WhatsApp.' },
        { title: 'Cross-branch sales', desc: 'Sell an item from another branch\u2019s stock right at your own counter.' },
        { title: 'M-Pesa built in', desc: 'Send an STK push straight from checkout \u2014 no separate till number to manage.' },
        { title: 'Works with zero signal', desc: 'A workshop floor with no signal still runs the till without interruption.' },
      ],
    },
    pharmacy: {
      tagline: 'Batch-level expiry tracking and prescription records \u2014 built for how a real pharmacy actually needs to sell.',
      screenshotDataUrl: '',
      screenshots: [],
      features: [
        { title: 'Batch-level expiry', desc: 'Track multiple batches of the same drug, each with its own expiry date.' },
        { title: 'Sells the soonest-expiring batch first', desc: 'Automatic First-Expired-First-Out stock rotation at checkout \u2014 nothing goes to waste at the back of the shelf.' },
        { title: 'Prescription records', desc: 'Capture prescriber and patient details at the point of sale for anything that requires one.' },
        { title: 'Controlled substance flagging', desc: 'Mark an item as controlled, and every sale of it is logged separately.' },
        { title: 'M-Pesa built in', desc: 'Send an STK push straight from checkout \u2014 no separate till number to manage.' },
        { title: 'Works with zero signal', desc: 'A pharmacy till that keeps ringing up sales through a power cut.' },
      ],
    },
    water: {
      tagline: 'Built for water refill stations and bottling shops \u2014 dispensers, sealed bottles, bales, and bulk tanks, all with pricing that matches how you actually sell.',
      screenshotDataUrl: '',
      screenshots: [
        { dataUrl: 'img/shot-aquapos-sales-counter.jpg', caption: 'The Sales Counter \u2014 refills, sealed bottles, dispensers, and bales, all one tap away.' },
      ],
      features: [
        { title: 'Refills, bottles, dispensers & bales', desc: 'One counter for every way you sell water \u2014 by the refill size, the sealed bottle, or the bale, side by side.' },
        { title: 'Bulk tank tracking', desc: 'Refill sales deduct straight from your bulk tank\u2019s level, so you always know exactly how much is left.' },
        { title: 'Delivery zones & agents', desc: 'Set delivery pricing by zone so a driver never has to guess a customer\u2019s rate, and assign every delivery to an agent.' },
        { title: 'Pay-on-delivery billing', desc: 'Send a delivery out unpaid and settle it as a bill once the agent collects \u2014 nothing falls through the cracks.' },
        { title: 'Bulk order & returned-goods tracking', desc: 'Track standing bulk orders and returned empties separately from one-off counter sales.' },
        { title: 'Demand trends', desc: 'See which sizes and products actually move, so you know what to keep stocked.' },
        { title: 'Customer loyalty tokens', desc: 'Reward repeat customers with tokens that carry real shilling value at checkout.' },
        { title: 'M-Pesa built in', desc: 'Send an STK push straight from checkout \u2014 no separate till number to manage.' },
        { title: 'Works with zero signal', desc: 'Every sale is saved on the device first, and syncs the moment you\u2019re back online.' },
      ],
    },
  },
};

async function getContent(env) {
  const raw = await env.mydukapos_kv.get(CONTENT_KEY);
  if (!raw) return DEFAULT_CONTENT;
  const stored = JSON.parse(raw);
  // Merge per-product too, not just top-level — a product added to the
  // defaults after the owner's last save should still show up with sane
  // fallback content rather than being missing entirely.
  const products = { ...DEFAULT_CONTENT.products };
  for (const key of Object.keys(products)) {
    if (stored.products && stored.products[key]) {
      products[key] = { ...products[key], ...stored.products[key] };
    }
  }
  return { ...DEFAULT_CONTENT, ...stored, products };
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
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
    return jsonResponse({ content });
  }

  if (body.action === 'set') {
    const ok = await requireOwnerAuth(context);
    if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

    if (!body.content || typeof body.content !== 'object') {
      return jsonResponse({ error: 'No content provided.' }, 400);
    }

    const logoDataUrl = String(body.content.logoDataUrl || '');
    if (logoDataUrl && !logoDataUrl.startsWith('data:image/')) {
      return jsonResponse({ error: 'Logo must be an image.' }, 400);
    }
    // ~500KB of actual image data (base64 runs ~33% larger than the source
    // bytes) — generous for a logo, which should be small to begin with.
    if (logoDataUrl.length > 700000) {
      return jsonResponse({ error: 'Logo is too large \u2014 please use a smaller image (under ~500KB).' }, 400);
    }

    const heroHeadline = String(body.content.heroHeadline || '').trim();
    const heroSubhead = String(body.content.heroSubhead || '').trim();
    if (!heroHeadline) return jsonResponse({ error: 'Enter a hero headline.' }, 400);

    // Simple text-only card lists — no images, so no size limits needed
    // beyond keeping the shape sane. Always saved as a complete set (the
    // owner UI always sends all 6 / all 3 cards), so a straight overwrite
    // is correct here — unlike products below, there's no "added after the
    // owner's last save" case to merge against.
    function sanitizeCards(raw, count) {
      const arr = Array.isArray(raw) ? raw : [];
      const out = [];
      for (let i = 0; i < count; i++) {
        const c = arr[i] || {};
        out.push({
          tag: String(c.tag || '').trim().slice(0, 40),
          title: String(c.title || '').trim().slice(0, 80),
          desc: String(c.desc || '').trim().slice(0, 300),
        });
      }
      return out;
    }
    const featureGrid = sanitizeCards(body.content.featureGrid, 6);
    const whySwitchCards = sanitizeCards(body.content.whySwitchCards, 3);

    const rawShowcases = Array.isArray(body.content.showcases) ? body.content.showcases : [];
    const showcases = [];
    for (let i = 0; i < 2; i++) {
      const s = rawShowcases[i] || {};
      const imageDataUrl = String(s.imageDataUrl || '');
      if (imageDataUrl && !imageDataUrl.startsWith('data:image/')) {
        return jsonResponse({ error: `Showcase photo ${i + 1}: must be an image.` }, 400);
      }
      if (imageDataUrl.length > 1100000) {
        return jsonResponse({ error: `Showcase photo ${i + 1}: too large \u2014 please use a smaller image (under ~800KB).` }, 400);
      }
      showcases.push({
        eyebrow: String(s.eyebrow || '').trim().slice(0, 60),
        title: String(s.title || '').trim().slice(0, 100),
        desc: String(s.desc || '').trim().slice(0, 300),
        imageDataUrl,
      });
    }

    const validKeys = listProducts().map((p) => p.id);
    const rawProducts = body.content.products && typeof body.content.products === 'object' ? body.content.products : {};
    const products = {};
    for (const key of validKeys) {
      const p = rawProducts[key] || {};
      const tagline = String(p.tagline || '').trim();
      const screenshotDataUrl = String(p.screenshotDataUrl || '');
      if (screenshotDataUrl && !screenshotDataUrl.startsWith('data:image/')) {
        return jsonResponse({ error: `${key}: screenshot must be an image.` }, 400);
      }
      // ~800KB of actual image data — a full app screenshot needs more
      // headroom than the logo above, but this still keeps the whole
      // record well within KV's own limits even with all 6 products set.
      if (screenshotDataUrl.length > 1100000) {
        return jsonResponse({ error: `${key}: screenshot is too large \u2014 please use a smaller image (under ~800KB).` }, 400);
      }
      // Multiple screenshots per product, for the swipeable "a look inside"
      // gallery on that product's app.html page — capped at 6 so one
      // product can't balloon the whole record (all 6 products share this
      // one KV record) into KV's own size limits.
      const rawScreenshots = Array.isArray(p.screenshots) ? p.screenshots : [];
      const screenshots = [];
      for (const shot of rawScreenshots.slice(0, 6)) {
        const dataUrl = String((shot && shot.dataUrl) || '');
        if (!dataUrl) continue;
        if (!dataUrl.startsWith('data:image/')) {
          return jsonResponse({ error: `${key}: one of the gallery photos must be an image.` }, 400);
        }
        if (dataUrl.length > 1100000) {
          return jsonResponse({ error: `${key}: a gallery photo is too large \u2014 please use a smaller image (under ~800KB).` }, 400);
        }
        screenshots.push({ dataUrl, caption: String((shot && shot.caption) || '').trim().slice(0, 100) });
      }
      const rawFeatures = Array.isArray(p.features) ? p.features : [];
      const features = rawFeatures
        .map((f) => ({ title: String(f.title || '').trim(), desc: String(f.desc || '').trim() }))
        .filter((f) => f.title && f.desc);
      products[key] = { tagline, screenshotDataUrl, screenshots, features };
    }

    const content = { logoDataUrl, heroHeadline, heroSubhead, featureGrid, whySwitchCards, showcases, products };
    await env.mydukapos_kv.put(CONTENT_KEY, JSON.stringify(content));
    return jsonResponse({ content });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
