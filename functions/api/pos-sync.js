// functions/api/pos-sync.js — Cloudflare Pages Function
//
// Shared-state sync endpoint backed by Cloudflare KV, one record PER CLIENT
// LINK (the `c` query param — see _license.js). Every device using the same
// link (?c=<token>) reads/writes the same record; different links never see
// each other's data.
//
// GET  -> returns the current stored state for this client (or an empty
//         placeholder if nothing saved yet)
// POST -> saves the state sent in the request body, stamping it with the
//         server's received time
//
// SCHEMA-LESS BY DESIGN, WITH ONE EXCEPTION: this endpoint doesn't know or
// care whether it's talking to the Shop POS, a future Hotel POS, or
// anything else — it just stores whatever JSON object the front-end sends
// and hands back whatever was last stored. Each product's own front-end is
// responsible for the shape of its own data (inventory/sales for the shop,
// rooms/bookings for a hotel, etc.). This means adding a new product later
// never requires touching this file. The exception is every array of
// id/code-bearing records listed in MERGE_BY_ID_FIELDS below (staff,
// inventory, customers, bills, sales log, etc.) — those get merged
// record-by-record instead of replaced wholesale — see mergeIncomingState()
// below for why.
//
// Blocked with 403 if the link's license isn't currently valid (expired demo,
// admin-locked, or unknown link) — see _license.js for how that's decided.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, updateIndexBusinessName } from './_license.js';
import { maybeSnapshotBackup } from './_backups.js';

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

export function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}

// Seeds (or merges into) this client's pos-sync record — used by
// demo-account.js at account-registration time so a link created via the
// public website already carries a real password the moment it exists,
// exactly the way a POS-side direct Sign Up would (see water/index.html's
// finishDirectAuth()/doPush()). This is what lets a brand-new device open
// that link and go straight to "who's logging in?" with just a password —
// no email, so nobody gets stranded just because they'd unlinked theirs
// (see account-recovery.js). Never touches fields it isn't given — only
// merges the patch in and stamps updatedAt.
export async function seedInitialState(env, clientId, patch) {
  const raw = await env.mydukapos_kv.get(stateKey(clientId));
  const existing = raw ? JSON.parse(raw) : {};
  const merged = { ...existing, ...patch, updatedAt: Date.now() };
  await env.mydukapos_kv.put(stateKey(clientId), JSON.stringify(merged));
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const raw = await env.mydukapos_kv.get(stateKey(clientId));
  const payload = raw ? JSON.parse(raw) : { updatedAt: 0 };
  return jsonResponse(payload);
}

// Merges an incoming array of records against whatever's already stored,
// matched by a stable per-record key (id, falling back to code — inventory
// items across the app suite are keyed by `code`, not `id`), keeping
// whichever side of each conflicting record has the newer updatedAt. This
// is what turns "last full push wins" into real per-record conflict
// resolution: if Device A edits an item's price/name (or adds a staff
// member) and pushes, then Device B — still holding an older in-memory
// copy that never had that change, e.g. because B was offline at the time
// — pushes moments later, this merge means B's stale copy of THAT record
// can't silently erase A's newer one, even though B's push still carries
// its own (older) version of everything it didn't touch. A record only
// ever loses to a NEWER one, not to "whichever happened to be posted
// last." This is the fix for: edit a price/name on one device, and it
// reverts after another device (that missed the edit) syncs.
//
// Requires each record to carry an `updatedAt` (ms epoch) set by the
// front-end whenever that specific record is created or changed. Records
// missing it are treated as updatedAt: 0 — oldest possible — so a legacy
// record without one always loses to any record that does carry a real
// timestamp, and only wins against another equally timestamp-less record
// by whichever happens to be seen last (no worse than the pre-merge
// behavior for data that predates this).
//
// Deletion is a tombstone, not an absence: the front-end marks a removed
// staff member with `removed: true` rather than dropping it from the
// array, precisely so this merge has a real record — with its own
// updatedAt — to compare instead of just seeing the id vanish. A key
// present in the existing array but missing from the incoming one is left
// exactly as it was (covers a device sending a shorter, older array from
// before that record even existed — never treated as a deletion).
function recordKey(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.id != null) return `id:${r.id}`;
  if (r.code != null) return `code:${r.code}`;
  // pendingInvites records have no `id` — they're identified by `token`
  // everywhere else in the front-end (pos_pending_invites lookups, accept/
  // revoke flows all match on i.token). Without this, every invite record
  // falls back to "keyless" and this merge can't protect a freshly-created
  // invite on one device from being lost if another, staler device pushes
  // before that device has pulled it.
  if (r.token != null) return `token:${r.token}`;
  return null;
}

function mergeRecordsById(existingArr, incomingArr) {
  if (!Array.isArray(incomingArr)) return existingArr;
  if (!Array.isArray(existingArr) || existingArr.length === 0) return incomingArr;

  // Keyed records (the normal case) are merged per-record below. A record
  // with no id/code at all can't be matched against anything on the other
  // side, so — same as before this generalization existed — it just falls
  // back to "incoming wins": existing's keyless records are dropped and
  // incoming's are kept as-is. Collecting BOTH sides' keyless records here
  // (instead of only incoming's) would double them on every single push,
  // since there'd be no way to ever recognize one as "the same" as another
  // and dedupe it back down.
  const merged = new Map();
  for (const r of existingArr) {
    const key = recordKey(r);
    if (key == null) continue;
    merged.set(key, r);
  }
  const incomingKeyless = [];
  for (const incoming of incomingArr) {
    const key = recordKey(incoming);
    if (key == null) { incomingKeyless.push(incoming); continue; }
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, incoming);
      continue;
    }
    const existingTs = existing.updatedAt || 0;
    const incomingTs = incoming.updatedAt || 0;
    merged.set(key, incomingTs >= existingTs ? incoming : existing);
  }
  // Keyed records in their merged-map order (existing order, with
  // incoming-only records appended), then incoming's keyless records (if
  // any) tacked on at the end.
  return [...merged.values(), ...incomingKeyless];
}

// Fields this merge applies to, each matched by whichever stable key its
// records actually carry (`id` for most; `code` for inventory/products,
// see recordKey() above). This covers every synced list that's genuinely
// edited in place after creation — not just appended to — since those are
// exactly the lists where "whichever device's push landed last wins"
// silently reverts someone's edit: staff and pendingInvites (roles/access),
// inventory/products (price, name, qty), customers, suppliers, delivery
// zones/agents, offers, bills, debts, recurringExpenses, contracts,
// staffShifts, attendanceRoster. Also included: the append-only transaction
// logs (salesLog, stockMovementLog, returns, expenses, tradeCredits,
// crossBranchSalesFacilitated, savedBarcodes, attendanceLog,
// adminActivityLog, billNotifications, pendingExchanges) —
// even though those are rarely edited after creation, merging them by id
// is still strictly safer than a wholesale replace: it unions two devices'
// concurrent new entries instead of one push's log silently clobbering the
// other's, at no extra cost since an unedited record's id simply doesn't
// conflict. Each front-end stamps `updatedAt` on a record at the moment
// it's actually written to (see each app's collectSyncPayload()/doPush()
// and their generalized stampDirtyInventory()/stampDirtyExtraSyncedFields()
// — they run a dirty-check against the last-known-synced snapshot right
// before serializing, so ANY change to a record gets a fresh timestamp
// without every individual edit site needing to set it by hand).
// Deliberately NOT applied to fields that aren't arrays of id/code-bearing
// records at all — tables/rooms are plain strings ("Table 01"), not
// objects, so there's no key to merge on (they fall back to ordinary
// wholesale replace, same as always); tableStates/roomStates are single
// keyed objects, not arrays; loyaltyTiers has no per-tier id.
const MERGE_BY_ID_FIELDS = [
  'staff', 'pendingInvites', 'inventory', 'products',
  'customers', 'suppliers', 'deliveryZones', 'deliveryAgents', 'offers',
  'bills', 'debts', 'recurringExpenses', 'contracts', 'staffShifts',
  'attendanceRoster', 'sites',
  'salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits',
  'crossBranchSalesFacilitated', 'savedBarcodes', 'attendanceLog',
  'adminActivityLog', 'billNotifications', 'pendingExchanges', 'dispatchLog',
];

function mergeIncomingState(existing, incoming) {
  const merged = { ...existing, ...incoming };
  for (const field of MERGE_BY_ID_FIELDS) {
    if (Array.isArray(incoming[field])) {
      merged[field] = mergeRecordsById(existing[field], incoming[field]);
    }
  }
  return merged;
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
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Request body must be a JSON object.' }, 400);
  }

  // Snapshot whatever's currently live (about to be overwritten) into today's
  // backup slot for this client — a no-op if already done today. Must happen
  // BEFORE the write below, or there'd be nothing left to snapshot.
  await maybeSnapshotBackup(env, clientId);

  // Read what's currently stored so the MERGE_BY_ID_FIELDS above can be
  // merged record-by-record instead of just replaced wholesale — see
  // mergeIncomingState() above. Everything else keeps the previous
  // behavior (incoming replaces existing) via the plain spread inside it.
  const existingRaw = await env.mydukapos_kv.get(stateKey(clientId));
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  // Always stamp with the server's clock so all devices agree on ordering,
  // regardless of each device's local clock drift.
  const record = { ...mergeIncomingState(existing, body), updatedAt: Date.now() };

  await env.mydukapos_kv.put(stateKey(clientId), JSON.stringify(record));

  // LIVE PUSH: broadcast the fresh record to every device currently
  // connected via WebSocket for this client (see sync-ws.js and SyncRoom in
  // wildcard-router/worker.js), so other devices update in well under a
  // second instead of waiting for their next 7-second poll. context.waitUntil
  // lets this finish after the response is already on its way back to the
  // caller, and the try/catch plus the SYNC_ROOM existence check mean a
  // missing binding, an undeployed Worker, or any other failure here is
  // always silent — the save itself must never be slowed down or fail
  // because of it, and every device's own poll is the fallback regardless.
  if (env.SYNC_ROOM) {
    try {
      const roomId = env.SYNC_ROOM.idFromName(clientId);
      const room = env.SYNC_ROOM.get(roomId);
      context.waitUntil(
        room.fetch('https://sync-room/broadcast', {
          method: 'POST',
          body: JSON.stringify(record),
        }).catch(() => {})
      );
    } catch (e) {
      // Binding misconfigured or the DO call threw synchronously — ignore,
      // same reasoning as above.
    }
  }

  // The one deliberate exception to "schema-less by design" above: Owner
  // Console's Clients tab wants to show each client's real business name
  // (as entered during their own POS setup) instead of a raw slug, without
  // adding a per-client read to that list — see updateIndexBusinessName's
  // own comment in _license.js for the full reasoning. A no-op write (the
  // helper itself skips it) whenever this field is absent or unchanged.
  if (typeof body.businessName === 'string') {
    await updateIndexBusinessName(env, clientId, body.businessName);
  }

  return jsonResponse(record);
}
