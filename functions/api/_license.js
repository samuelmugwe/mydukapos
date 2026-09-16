// functions/api/_license.js — shared helper, NOT a route.
//
// Every client link this master POS generates (demo or permanent) is backed
// by one record in KV, keyed by a short random token — that token is either
// resolved from the shop's own subdomain (georgehardware.mydukapos.store) or,
// for legacy links / the Owner Console / preview deployments, from the `c`
// query param, e.g. https://yoursite.pages.dev/?c=ab12cd34ef. See
// resolveClientId() below for exactly how that decision is made.
//
// STRICT, CLOCK-TAMPER-PROOF EXPIRY:
// expiresAt is a fixed millisecond timestamp computed with Date.now() on
// Cloudflare's edge server the moment the demo link is created — never from
// anything the browser sends. Every check of "is this still valid" (here,
// and in every other function that touches business data) re-reads Date.now()
// on the server and compares against that stored timestamp. A customer's PC
// clock, browser, or DevTools console has no way to influence this — the
// only two things that matter are what's stored in KV and the server's own
// clock.
//
// SCALING NOTE (see README-MASTER.md "Scaling past a few thousand clients"):
// listClients() used to fetch every single client's full record from KV on
// every load of the Licenses tab (one KV read per client). That's fine at
// dozens of clients but falls over well before 10,000 — Cloudflare Workers/
// Pages Functions cap how many subrequests one invocation can make, so a
// 10,000-client Promise.all(...) would simply fail. Instead, the index
// itself now stores a small SUMMARY object per client (id, slug, type,
// product, label, timestamps, locked/paymentClaimed flags) — everything the
// Licenses tab needs to render its list and evaluate each license's status
// — so listing clients is two KV reads total (the index, once), never N.
// Full per-client records are only fetched when something acts on ONE
// specific client (owner-lock, owner-confirm, license-claim-payment).

const LICENSE_PREFIX = 'license:';
const SLUG_PREFIX = 'slug:'; // slug:<slug> -> clientId, for O(1) subdomain resolution
const INDEX_KEY = 'license-index:v1'; // array of SUMMARY objects, not just ids — see note above

// ---------- DEMO DURATION (owner-configurable, one value shared everywhere) ----------
// Used to be a fixed 72h constant. Now a single owner-editable setting,
// stored in KV, that EVERY demo-duration mention in the whole system reads
// from — the Owner Console's "Generate Link" button/toast, the default
// "extend" bump (owner-lock.js), the public website's marketing copy
// (index.html/app.html, via website-content.js's public 'get' action), and
// the actual duration granted to a self-service account demo
// (demo-account.js). Changing it in Owner Console → 🌐 Public Website
// updates every one of those the moment it's saved — nothing here is
// cached beyond the single KV read each caller already does.
const DEMO_DURATION_CONFIG_KEY = 'config:demo-duration-hours';
const DEFAULT_DEMO_DURATION_HOURS = 72;
const MIN_DEMO_DURATION_HOURS = 1;
const MAX_DEMO_DURATION_HOURS = 24 * 90; // 90 days ceiling — a sane upper bound, not a hard business rule

export async function getDemoDurationHours(env) {
  const raw = await env.mydukapos_kv.get(DEMO_DURATION_CONFIG_KEY);
  const hours = raw ? parseFloat(raw) : NaN;
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_DEMO_DURATION_HOURS;
  return hours;
}

export async function getDemoDurationMs(env) {
  return (await getDemoDurationHours(env)) * 60 * 60 * 1000;
}

export async function setDemoDurationHours(env, hours) {
  const n = parseFloat(hours);
  if (!Number.isFinite(n) || n < MIN_DEMO_DURATION_HOURS || n > MAX_DEMO_DURATION_HOURS) {
    throw new Error(`Enter a demo duration between ${MIN_DEMO_DURATION_HOURS} and ${MAX_DEMO_DURATION_HOURS} hours.`);
  }
  await env.mydukapos_kv.put(DEMO_DURATION_CONFIG_KEY, String(n));
  return n;
}

// Human-friendly rendering shared by every caller that shows this value as
// text (owner console button/toast, public site copy) — "72 hours" below a
// day, "3 days" for a whole number of days above that, "1.5 days" style
// fallback otherwise, so an odd value like 40 or 100 still reads sensibly
// instead of forcing every caller to invent its own formatting.
export function formatDemoDuration(hours) {
  const n = Number(hours) || 0;
  if (n < 24) return `${n % 1 === 0 ? n : n.toFixed(1)} hour${n === 1 ? '' : 's'}`;
  const days = n / 24;
  const daysRounded = Math.round(days * 10) / 10;
  return `${daysRounded % 1 === 0 ? daysRounded : daysRounded.toFixed(1)} day${daysRounded === 1 ? '' : 's'}`;
}

// The base domain clients' subdomains live under, e.g. "mydukapos.store" so
// a client's link is "https://<slug>.mydukapos.store/". Override per-
// environment by setting a ROOT_DOMAIN Cloudflare Pages env var (handy for
// staging domains) — this default is just a fallback.
const DEFAULT_ROOT_DOMAIN = 'mydukapos.store';

export function getRootDomain(env) {
  return ((env && env.ROOT_DOMAIN) || DEFAULT_ROOT_DOMAIN).toLowerCase().replace(/^\.+/, '');
}

// Registry of POS products this master deployment can issue links for. Each
// entry's `path` is where that product's front-end lives (a static folder
// alongside index.html — e.g. /hotel/index.html for the "hotel" product) —
// this is the ONLY place a new product needs to be registered for the
// Master dashboard to know it exists and build correct links for it. The
// product itself still needs its own front-end folder deployed; adding it
// here just makes the master admin dashboard and link-building aware of it.
export const PRODUCTS = {
  shop: { label: 'Shop POS', path: '/' },
  hotel: { label: 'Hotel/Restaurant/Bar POS', path: '/hotel/' },
  hospital: { label: 'Hospital Management', path: '/hospital/' },
  school: { label: 'School Fees Management', path: '/school/' },
  production: { label: 'Production POS', path: '/production/' },
  pharmacy: { label: 'Pharmacy POS', path: '/pharmacy/' },
  services: { label: 'Services POS (Bookings)', path: '/services/' },
  water: { label: 'Water Refill Station POS (AquaPOS)', path: '/water/' },
};
const DEFAULT_PRODUCT = 'shop';

export function listProducts() {
  return Object.keys(PRODUCTS).map((key) => ({ id: key, ...PRODUCTS[key] }));
}

export function productPath(product) {
  return (PRODUCTS[product] || PRODUCTS[DEFAULT_PRODUCT]).path;
}

// Builds the public link for a client record: a subdomain when it has a
// slug, falling back to the old ?c= query-param form (used for the Owner
// Console's own record and anything created before slugs existed).
//
// A slugged link also carries ?c=<id> even though normal subdomain
// resolution never reads it — it's the belt-and-braces input
// resolveClientId() checks during the few seconds right after creation
// when the slug->id KV write may not have reached every edge location yet
// (see the comment there). Once the slug is resolving normally (almost
// always well under a minute), the param is simply unused dead weight in
// the URL — harmless either way, and never a way to reach a different
// client's subdomain since resolveClientId() checks it belongs to THIS slug.
export function clientLink(env, record, origin) {
  const path = productPath(record.product);
  if (record.slug) {
    return `https://${record.slug}.${getRootDomain(env)}${path}?c=${record.id}`;
  }
  return `${origin}${path}?c=${record.id}`;
}

export function randomToken(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous 0/O/1/l/i
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// Turns a free-text label ("George's Hardware!") into a DNS-safe subdomain
// piece ("georges-hardware"). Falls back to a short random slug if the label
// has no usable characters at all (e.g. it was empty, or pure emoji).
function slugify(label) {
  const base = String(label || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `shop-${randomToken(6)}`;
}

async function slugTaken(env, slug) {
  const existing = await env.mydukapos_kv.get(SLUG_PREFIX + slug);
  return !!existing;
}

// Finds a free, unique subdomain slug based on the label, appending -2, -3,
// etc. on collision. Reserves nothing by itself — call claimSlug() once the
// client record is actually being created.
async function pickUniqueSlug(env, label) {
  const wanted = slugify(label);
  let candidate = wanted;
  let n = 2;
  while (await slugTaken(env, candidate)) {
    candidate = `${wanted}-${n}`;
    n += 1;
  }
  return candidate;
}

// Branch-specific slug pattern: mainslug1, mainslug2, mainslug3... — no
// separate name typed by the client at all. Starts at 1 (not pickUniqueSlug's
// -2 collision-suffix pattern, which is for ordinary clients and leaves the
// first candidate bare) since every branch, including the first, gets a
// number here. Auto-advances past any slug that's somehow already taken —
// a prior branch, a coincidental match with an unrelated client, or (rare)
// a race with a concurrent request — same "keep trying the next one" logic
// as pickUniqueSlug, just with this numbering scheme instead.
export async function pickNextBranchSlug(env, mainSlug) {
  const base = slugify(mainSlug);
  let n = 1;
  let candidate = `${base}${n}`;
  while (await slugTaken(env, candidate)) {
    n += 1;
    candidate = `${base}${n}`;
  }
  return candidate;
}

async function claimSlug(env, slug, clientId) {
  await env.mydukapos_kv.put(SLUG_PREFIX + slug, clientId);
}

export async function getLicenseBySlug(env, slug) {
  if (!slug) return null;
  const id = await env.mydukapos_kv.get(SLUG_PREFIX + slug.toLowerCase());
  if (!id) return null;
  return getLicense(env, id);
}

/* ---------- index (client summaries, used by the Licenses tab) ---------- */

async function readIndex(env) {
  const raw = await env.mydukapos_kv.get(INDEX_KEY);
  if (!raw) return [];
  const list = JSON.parse(raw);
  // Backward-compat: older deployments stored the index as a plain array of
  // id strings. Upgrade those entries to summary shape on the fly (they'll
  // be missing fields like slug/type until the record is next touched).
  return list.map((entry) => (typeof entry === 'string' ? { id: entry } : entry));
}

function summaryFromRecord(record) {
  return {
    id: record.id,
    slug: record.slug || '',
    type: record.type,
    product: record.product,
    label: record.label || '',
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    locked: !!record.locked,
    paymentClaimed: !!record.paymentClaimed,
    paymentClaimedAt: record.paymentClaimedAt || null,
    confirmedAt: record.confirmedAt || null,
    branchGroupId: record.branchGroupId || null,
    isMainBranch: !!record.isMainBranch,
    branchAllowance: record.branchAllowance || 0,
    branchAddonClaimed: !!record.branchAddonClaimed,
    clientName: record.clientName || '',
    preferredName: record.preferredName || '',
    notes: record.notes || '',
    phone: record.phone || '',
    email: record.email || '',
    source: record.source || 'owner',
    agreedAmount: record.agreedAmount || 0,
    paidAmount: record.paidAmount || 0,
    balanceOwed: record.balanceOwed || 0,
  };
}

async function upsertIndexSummary(env, record) {
  const list = await readIndex(env);
  const idx = list.findIndex((e) => e.id === record.id);
  const summary = summaryFromRecord(record);
  if (idx === -1) list.push(summary);
  else list[idx] = summary;
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(list));
}

// Call this after saveLicense() any time a change should be reflected in the
// Licenses tab's list (lock/unlock/extend, payment claimed, confirmed,
// slug/label changes). createClient() already does this for new records.
export const refreshIndexSummary = upsertIndexSummary;

// Lighter-weight than upsertIndexSummary — updates just the businessName
// field on a client's existing index entry, without needing the full
// license record (businessName lives in the client's synced POS state, a
// separate KV entry entirely — see pos-sync.js, which calls this). This is
// what lets Owner Console's Clients tab show the real business name a
// branch's own setup was given, instead of its auto-generated slug, without
// adding a per-client read to the list endpoint itself — the name is kept
// current on the index as it changes, not looked up fresh on every list load.
export async function updateIndexBusinessName(env, clientId, businessName) {
  const list = await readIndex(env);
  const idx = list.findIndex((e) => e.id === clientId);
  if (idx === -1) return; // client not in the index yet (shouldn't normally happen) — nothing to update
  if (list[idx].businessName === businessName) return; // unchanged — skip the write
  list[idx] = { ...list[idx], businessName };
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(list));
}

// NOTE ON CONCURRENT WRITES: this read-modify-write on a single JSON blob is
// fine for the volume of admin actions (creating/locking/confirming links)
// even at thousands of clients, but Workers KV has no compare-and-swap, so
// two of these landing in the same instant can still clobber one another —
// the same risk existed in the old id-only index. If you're issuing many
// links concurrently (e.g. a bulk-import script), serialize those calls, or
// migrate this index to Cloudflare D1 (a real database, with proper
// transactions) once that becomes a real workload rather than an edge case.

export async function createClient(env, type, label, product, extra = {}) {
  const id = randomToken(10);
  const now = Date.now();
  const slug = await pickUniqueSlug(env, label);
  // Every caller gets the owner-configured demo window (default 72h — see
  // getDemoDurationHours above) unless it explicitly passes its own
  // extra.durationMs — nothing currently does, but the override stays
  // available for a future caller that genuinely needs a one-off duration.
  const durationMs = extra.durationMs || (await getDemoDurationMs(env));
  const record = {
    id,
    slug,
    type: type === 'permanent' ? 'permanent' : 'demo',
    product: PRODUCTS[product] ? product : DEFAULT_PRODUCT,
    label: label || '',
    createdAt: now,
    expiresAt: type === 'permanent' ? null : now + durationMs,
    locked: false,
    paymentClaimed: false,
    paymentClaimedAt: null,
    confirmedAt: type === 'permanent' ? now : null,
    // Branch fields — see branches.js. Absent/null for an ordinary client
    // that isn't part of any branch group.
    branchGroupId: extra.branchGroupId || null,
    isMainBranch: !!extra.isMainBranch,
    // Tiered branch billing (spec: Base Tier KES 3,000 includes the shop +
    // 1 branch; each further branch is a KES 1,500 add-on). This count
    // lives on whichever record currently holds isMainBranch — see
    // getGroupMainRecord() below — and starts at 0 for a brand-new record;
    // owner-confirm.js sets it to 1 the moment the base tier is confirmed
    // permanent. A demo or not-yet-confirmed record has no allowance at
    // all, which is fine since branches.js already blocks demo accounts
    // from creating branches outright.
    branchAllowance: extra.branchAllowance || 0,
    branchAddonClaimed: false,
    branchAddonClaimedAt: null,
    // For the owner's own records — never shown to the client, never used
    // for the subdomain/slug (label still drives that). clientName is the
    // real person/business behind this link; preferredName is however they
    // actually like to be addressed, when that differs.
    clientName: extra.clientName || '',
    preferredName: extra.preferredName || '',
    // Free-text notes the owner can leave on a link — e.g. "paid via
    // M-Pesa", "prefers WhatsApp" — never shown to the client, editable
    // any time via owner-lock.js's 'edit' action.
    notes: extra.notes || '',
    // Optional — populated when a client is generated from a Lead Tracker
    // entry that had a phone number on file, or from a public-site/dashboard
    // self-signup (demo-account.js passes the account's own phone/email
    // through here). Never required; most clients created directly via
    // "Generate Link" won't have either unless the owner types them in.
    phone: extra.phone || '',
    email: extra.email || '',
    // Where this client link came from — 'website' (public-site self-signup
    // in demo-account.js, or the legacy anonymous flow in public-demo.js),
    // 'lead' (closed out of the Owner Console's own Leads tracker, see
    // leads.js's generateLink action), or 'owner' (typed directly into the
    // 🔗 Licenses tab's "Generate Demo Link", the default for everything
    // else). Purely informational — shown as a badge in the Demo/Permanent
    // Links lists so a website- or lead-sourced link is identifiable there.
    source: extra.source || 'owner',
    // Simple one-off billing record for what THIS client (the shop owner
    // using mydukapos, not one of their own customers) agreed to pay for
    // the service and how much of that has actually been paid — set when a
    // Leads-tab lead is closed (see leads.js) and editable afterwards from
    // either the Leads tab or this client's own detail view (owner-lock.js's
    // 'edit' action). balanceOwed is just agreedAmount minus paidAmount,
    // recomputed any time either changes — this IS the "bill" the owner
    // asked to track, no separate ledger needed.
    agreedAmount: extra.agreedAmount || 0,
    paidAmount: extra.paidAmount || 0,
    balanceOwed: Math.max(0, (extra.agreedAmount || 0) - (extra.paidAmount || 0)),
  };
  await env.mydukapos_kv.put(LICENSE_PREFIX + id, JSON.stringify(record));
  await claimSlug(env, slug, id);
  await upsertIndexSummary(env, record);
  return record;
}

// ---------- BRANCH GROUPS ----------
// A branch group links a shop and its branches together — one flat list of
// client ids under a shared key, no hierarchy baked into the storage itself.
// "Which one is main" is just a per-client boolean flag (isMainBranch on the
// record above), reassignable at any time — the group membership list never
// needs to change when that flag moves.

const BRANCH_GROUP_PREFIX = 'branch-group:'; // branch-group:<groupId> -> array of client ids

export async function getBranchGroupMembers(env, groupId) {
  if (!groupId) return [];
  const raw = await env.mydukapos_kv.get(BRANCH_GROUP_PREFIX + groupId);
  return raw ? JSON.parse(raw) : [];
}

export async function addToBranchGroup(env, groupId, clientId) {
  const members = await getBranchGroupMembers(env, groupId);
  if (!members.includes(clientId)) {
    members.push(clientId);
    await env.mydukapos_kv.put(BRANCH_GROUP_PREFIX + groupId, JSON.stringify(members));
  }
}

// Removes one member from a branch group's flat id list — used when a
// branch is permanently deleted (see the 'delete' action in branches.js).
// Deliberately leaves the group key in place even if this empties it down
// to one remaining member; a lone member with a branchGroupId still set is
// harmless (getBranchGroupMembers/getGroupMainRecord both handle a
// single-member group fine), and it preserves branchGroupId as a stable
// "has ever branched" marker rather than needing extra cleanup logic.
export async function removeFromBranchGroup(env, groupId, clientId) {
  if (!groupId) return;
  const members = await getBranchGroupMembers(env, groupId);
  const next = members.filter((id) => id !== clientId);
  if (next.length !== members.length) {
    await env.mydukapos_kv.put(BRANCH_GROUP_PREFIX + groupId, JSON.stringify(next));
  }
}

// The record that holds tier/allowance state for a whole branch group is
// whichever member currently has isMainBranch — this is the one place that
// resolves it, given ANY member's own record. Returns the record itself
// unchanged when it isn't part of a group yet (a not-yet-branched shop is,
// in effect, its own future main branch, and branchAllowance already lives
// on it directly). Used by branches.js (create/allowance check) and
// license-claim-payment.js (branch add-on claims) so both apply an add-on
// to the same record no matter which group member's link triggered it.
export async function getGroupMainRecord(env, record) {
  if (!record || !record.branchGroupId) return record;
  if (record.isMainBranch) return record;
  const members = await getBranchGroupMembers(env, record.branchGroupId);
  for (const memberId of members) {
    const memberRecord = await getLicense(env, memberId);
    if (memberRecord && memberRecord.isMainBranch) return memberRecord;
  }
  return record; // no main flagged yet (shouldn't normally happen) — fall back to caller's own
}

// Returns the lightweight summaries directly — no per-client KV fetch, so
// this stays cheap however many clients exist. Accepts an optional case-
// insensitive text filter (matched against label/slug) for the Licenses
// tab's search box once the list gets long.
export async function listClientSummaries(env, { q } = {}) {
  const list = await readIndex(env);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!q) return list;
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((e) =>
    (e.label || '').toLowerCase().includes(needle) || (e.slug || '').toLowerCase().includes(needle)
  );
}

export async function getLicense(env, clientId) {
  if (!clientId) return null;
  const raw = await env.mydukapos_kv.get(LICENSE_PREFIX + clientId);
  return raw ? JSON.parse(raw) : null;
}

export async function saveLicense(env, record) {
  await env.mydukapos_kv.put(LICENSE_PREFIX + record.id, JSON.stringify(record));
  await upsertIndexSummary(env, record);
}

async function removeIndexSummary(env, clientId) {
  const list = await readIndex(env);
  const next = list.filter((e) => e.id !== clientId);
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(next));
}

// Permanently removes a client link — the license record, its slug
// reservation (so the subdomain becomes available again for a future link),
// and its entry in the Licenses tab's index. This is NOT the same as
// locking: a locked link still exists and can be unlocked later; this one
// is gone for good, and there's no undo. Deliberately does not touch that
// client's own pos-sync state/backups (pos-data:state:<id>,
// pos-data:backup:<id>:*) — those are cheap to leave behind and harmless
// since nothing can reach them without the deleted id, but could be added
// here later if reclaiming that storage ever matters. It also does NOT
// unlink any account-recovery email tied to this clientId — callers that
// need that (Owner Console's "delete" in owner-lock.js, and a demo
// account deleting its own demo in demo-account.js) call
// removeClientLink() from account-recovery.js right after this, so the
// email frees up for a brand-new link instead of staying stuck "already
// linked" to an id that no longer exists.
export async function deleteClient(env, clientId) {
  const record = await getLicense(env, clientId);
  if (!record) return false;

  await env.mydukapos_kv.delete(LICENSE_PREFIX + clientId);
  if (record.slug) {
    await env.mydukapos_kv.delete(SLUG_PREFIX + record.slug);
  }
  await removeIndexSummary(env, clientId);
  return true;
}

// The single source of truth for "can this client use the app right now" —
// server clock only. Used both by license-status.js (for the on-screen
// countdown) and by every business-data endpoint (pos-sync, mpesa-*,
// gateway-config, barcode-lookup) to actually block requests once expired.
// Works identically whether given a full record or just its summary shape
// (both carry type/locked/expiresAt), which is what makes the cheap
// summary-only listing above safe to reuse for status checks too.
export function evaluateLicense(record) {
  const now = Date.now();
  if (!record) return { valid: false, reason: 'not_found', now };
  if (record.locked) return { valid: false, reason: 'locked', record, now };
  if (record.type === 'permanent') return { valid: true, reason: 'permanent', record, now };
  const remainingMs = (record.expiresAt || 0) - now;
  if (remainingMs <= 0) return { valid: false, reason: 'expired', record, now, remainingMs: 0 };
  return { valid: true, reason: 'demo_active', record, now, remainingMs };
}

/* ---------- resolving WHICH client a request is for ---------- */

// Cloudflare Pages does not support wildcard custom domains (confirmed as of
// 2026 — see developers.cloudflare.com/dns/manage-dns-records/reference/
// wildcard-dns-records/, "wildcard custom domains are not supported"). The
// working alternative is a Cloudflare Worker on a wildcard route
// (*.mydukapos.store/*) that proxies each request to this Pages deployment —
// see the deploy guide for that Worker's exact code. A naive proxy rewrites
// the outgoing Host header to the pages.dev domain, which would make every
// request here look identical regardless of which client's subdomain it
// actually came in on — breaking subdomain resolution entirely. The Worker
// is written to set X-Forwarded-Host to the ORIGINAL hostname before
// forwarding, so that's checked first; the raw request URL is still the
// fallback for direct pages.dev / preview-deployment access (which never
// goes through that Worker, so has no such header) and for local dev.
export function hostnameFromRequest(request) {
  try {
    const forwarded = request.headers.get('X-Forwarded-Host');
    if (forwarded) return forwarded.toLowerCase().split(',')[0].trim();
    return new URL(request.url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// Pulls the subdomain label out of a hostname, given the configured root
// domain — e.g. ("georgehardware.mydukapos.store", "mydukapos.store") ->
// "georgehardware". Returns '' for the bare apex domain, "www", any host
// that isn't under the root domain at all (e.g. a *.pages.dev preview URL),
// or a multi-level subdomain (only one level of nesting is supported).
export function subdomainLabel(hostname, rootDomain) {
  if (!hostname || !rootDomain) return '';
  if (hostname === rootDomain || hostname === `www.${rootDomain}`) return '';
  const suffix = `.${rootDomain}`;
  if (!hostname.endsWith(suffix)) return '';
  const label = hostname.slice(0, -suffix.length);
  if (!label || label.includes('.')) return ''; // no bare-apex or nested subdomains
  return label;
}

// THE single place every route decides which client a request belongs to.
// Priority: 1) this request's own subdomain (georgehardware.mydukapos.store),
// 2) the legacy/manual ?c=<token> query param — still supported for the
// Owner Console (served from /owner/ on the apex domain — see the deploy
// guide; it must NOT live at the shop product's own path, or every
// generated "General Shop" client link would open the console instead of
// an actual point of sale), Cloudflare Pages preview deployments
// (*.pages.dev, which never match the root domain), and any link generated
// before subdomains existed.
export async function resolveClientId(request, env) {
  const url = new URL(request.url);
  const hostname = hostnameFromRequest(request);
  const rootDomain = getRootDomain(env);
  const label = subdomainLabel(hostname, rootDomain);

  if (label) {
    const record = await getLicenseBySlug(env, label);
    if (record) return record.id;

    // Subdomain lookup came up empty. Normally that's a genuine typo/stale
    // link and we report "not_found" — see the comment above about not
    // trusting a query param on someone else's link. But Workers KV writes
    // are only eventually consistent across edge locations (the docs note
    // up to ~60s to fully propagate): claimSlug() in createClient() can
    // still be invisible to the colo serving THIS request for a few
    // seconds right after a demo is generated, even though the record
    // itself and its slug were written successfully. That race showed up
    // as the freshly-created demo loading for an instant, then the
    // license-lock screen taking over almost immediately ("appears for
    // less than a second and disappears").
    //
    // Safe to bridge with the ?c= param ONLY when the record it points to
    // actually claims THIS SAME slug — that check means a stale/garbage or
    // someone-else's c= value can never grant access to a subdomain it
    // doesn't belong to; it only ever rescues the narrow propagation-delay
    // case where the id and slug genuinely agree.
    const fallbackId = url.searchParams.get('c') || '';
    if (fallbackId) {
      const fallbackRecord = await getLicense(env, fallbackId);
      if (fallbackRecord && fallbackRecord.slug && fallbackRecord.slug.toLowerCase() === label.toLowerCase()) {
        return fallbackRecord.id;
      }
    }
    return '';
  }

  return url.searchParams.get('c') || '';
}

export async function requireValidLicense(request, env) {
  const clientId = await resolveClientId(request, env);
  const record = await getLicense(env, clientId);
  const result = evaluateLicense(record);
  return { ...result, clientId };
}
