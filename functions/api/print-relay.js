// functions/api/print-relay.js — Cloudflare Pages Function
//
// Multi-device print network for a single shop (same clientId, never across
// branches — each branch prints on its own devices, same scoping as before).
//
// Two layers:
//   1. DEVICE REGISTRY — every open till/phone/tablet heartbeats itself in
//      (name, station, whether it currently has a real printer connected)
//      so an admin panel can list "all active devices" and their printer
//      status, per the Device & Printer Discovery requirement.
//   2. ROUTING — a print job (receipt / kitchen-ticket) submitted by any
//      device is fanned out to one or more DESTINATION devices, decided by
//      admin-configured rules (e.g. "Receipt -> Front Counter station").
//      A shop with no rules configured falls back to the original
//      single-relay behaviour (send to whichever one device is currently
//      accepting jobs) so nothing breaks for existing shops.
//
// Actions (all POST, JSON body — caller identified by license the same way
// as every other endpoint in this app):
//   { action: 'registerDevice', deviceId, name, station, printerMode,
//     hasPrinter, acceptsRelay }
//     Upserts this device's entry in the shop's device registry and marks
//     it as seen right now. Called on every app launch and whenever the
//     device's own name/station/printer status changes.
//   { action: 'listDevices' }
//     Returns every device seen at this shop recently enough to still be
//     considered known, each with an `online` flag (heartbeated within the
//     stale window) — for the Device Discovery admin panel.
//   { action: 'heartbeat', deviceId }
//     Lightweight keep-alive for a device already registered (cheaper than
//     resending the full registerDevice payload every few seconds).
//   { action: 'getRules' } / { action: 'saveRules', rules }
//     Read/write the shop's print-routing rules array. Shape per rule:
//     { id, trigger: 'receipt'|'kitchen-ticket', sourceStation: 'any'|<station>,
//       destinations: [ '<station name>' | 'device:<deviceId>', ... ], active }
//   { action: 'checkAvailable' }
//     True if at least one device at this shop is online, has a printer,
//     and is currently accepting relayed jobs — used by a printer-less
//     device to decide whether to relay at all before falling back to its
//     own local print dialog.
//   { action: 'submit', jobType, text, sourceDeviceId, sourceStation, meta }
//     Resolves destination device(s) via the routing rules (falling back to
//     a single available device if none match) and queues the job on each.
//     Returns the number of devices it was queued to.
//   { action: 'poll', deviceId }
//     Called by a device willing to print jobs — fetches jobs waiting in
//     ITS OWN queue and marks them claimed. Also counts as a heartbeat.
//     deviceId is optional for backward compatibility: water/index.html
//     (Aqua POS) predates the device registry and polls with no deviceId
//     at all — that's folded into a fixed LEGACY_DEVICE_ID entry that's
//     always treated as present/printer-equipped/accepting, matching the
//     old single-relay behaviour it was already relying on.
//   { action: 'ack', deviceId, jobId }
//     Confirms a job actually printed (or was given up on) — removes it
//     from that device's queue. deviceId optional, same legacy fallback
//     as 'poll'.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';

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

function devicesKey(clientId) {
  return `print-relay-devices:${clientId}`;
}

function rulesKey(clientId) {
  return `print-relay-rules:${clientId}`;
}

function queueKey(clientId, deviceId) {
  return `print-relay-queue:${clientId}:${deviceId}`;
}

// A device is considered offline if it hasn't heartbeat'd within this
// window — short, since "is this printer available right now" needs to be
// a near-real-time answer, not "was online at some point". Must stay
// comfortably above the frontend's own re-registration interval (20s,
// see heartbeatDeviceNetwork()) or a perfectly healthy device flickers
// "offline" for the last few seconds of every cycle.
const HEARTBEAT_STALE_MS = 30000;
// A device dropped entirely from the registry (not just shown offline) once
// it's been silent this long, so a phone that was used once months ago
// doesn't clutter the discovery list forever.
const DEVICE_FORGET_MS = 24 * 60 * 60 * 1000;
// A job nobody's picked up within this window is dropped rather than
// printed late — a receipt from 5+ minutes ago surprise-printing later
// would be more confusing than just not printing it.
const JOB_MAX_AGE_MS = 5 * 60 * 1000;
// If a device claims a job but never acks it (crashed, lost connection,
// closed the tab mid-print), it becomes claimable again after this so the
// job isn't lost forever waiting on a device that's gone.
const JOB_CLAIM_TIMEOUT_MS = 20000;

// water/index.html (Aqua POS) predates the device registry — it still
// calls 'poll'/'ack' the old single-relay way, with no deviceId at all,
// and never calls 'registerDevice'. Rather than breaking that caller, we
// fold it into the registry as one fixed, well-known device: polling at
// all only ever happens (per water's own frontend gating) when it has a
// real printer connected and relay accepting is turned on, so a poll from
// this id is treated as an implicit heartbeat with hasPrinter/acceptsRelay
// true — exactly the old "whichever single device is currently online and
// accepting jobs" behaviour, just expressed as a registry entry instead of
// a special case.
const LEGACY_DEVICE_ID = 'legacy-single-relay';

function randomToken(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function getDevices(env, clientId) {
  const raw = await env.mydukapos_kv.get(devicesKey(clientId));
  return raw ? JSON.parse(raw) : {};
}

async function saveDevices(env, clientId, devices) {
  await env.mydukapos_kv.put(devicesKey(clientId), JSON.stringify(devices));
}

function pruneStaleDevices(devices) {
  const now = Date.now();
  const kept = {};
  for (const [id, d] of Object.entries(devices)) {
    if (now - (d.lastSeen || 0) < DEVICE_FORGET_MS) kept[id] = d;
  }
  return kept;
}

function decorateOnline(devices) {
  const now = Date.now();
  return Object.entries(devices).map(([deviceId, d]) => ({
    deviceId,
    name: d.name || 'Device',
    station: d.station || 'Other',
    printerMode: d.printerMode || 'system',
    hasPrinter: !!d.hasPrinter,
    acceptsRelay: !!d.acceptsRelay,
    online: (now - (d.lastSeen || 0)) < HEARTBEAT_STALE_MS,
  })).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
}

async function getRules(env, clientId) {
  const raw = await env.mydukapos_kv.get(rulesKey(clientId));
  return raw ? JSON.parse(raw) : [];
}

async function getQueue(env, clientId, deviceId) {
  const raw = await env.mydukapos_kv.get(queueKey(clientId, deviceId));
  return raw ? JSON.parse(raw) : [];
}

async function saveQueue(env, clientId, deviceId, queue) {
  await env.mydukapos_kv.put(queueKey(clientId, deviceId), JSON.stringify(queue));
}

async function pushJob(env, clientId, deviceId, job) {
  const queue = await getQueue(env, clientId, deviceId);
  const now = Date.now();
  const fresh = queue.filter((j) => now - j.createdAt < JOB_MAX_AGE_MS);
  fresh.push(job);
  await saveQueue(env, clientId, deviceId, fresh);
}

// Resolves a rule's destination list ('<station>' or 'device:<id>') plus a
// resolved device-registry snapshot into the actual set of eligible,
// currently-online device ids to deliver to.
function resolveDestinationDeviceIds(destinations, onlineDevices) {
  const ids = new Set();
  for (const dest of destinations) {
    if (typeof dest !== 'string') continue;
    if (dest.startsWith('device:')) {
      const id = dest.slice('device:'.length);
      const d = onlineDevices.find((x) => x.deviceId === id);
      if (d && d.online && d.hasPrinter && d.acceptsRelay) ids.add(id);
    } else {
      // Station name — every online, printer-holding, relay-accepting
      // device currently assigned to that station.
      onlineDevices
        .filter((d) => d.station === dest && d.online && d.hasPrinter && d.acceptsRelay)
        .forEach((d) => ids.add(d.deviceId));
    }
  }
  return Array.from(ids);
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

  /* ---------- Device registry ---------- */

  if (body.action === 'registerDevice') {
    if (!body.deviceId) return jsonResponse({ error: 'Missing deviceId.' }, 400);
    let devices = pruneStaleDevices(await getDevices(env, clientId));
    devices[body.deviceId] = {
      name: String(body.name || 'Device').slice(0, 40),
      station: String(body.station || 'Other').slice(0, 30),
      printerMode: body.printerMode || 'system',
      hasPrinter: !!body.hasPrinter,
      acceptsRelay: !!body.acceptsRelay,
      lastSeen: Date.now(),
    };
    await saveDevices(env, clientId, devices);
    return jsonResponse({ ok: true });
  }

  if (body.action === 'listDevices') {
    const devices = pruneStaleDevices(await getDevices(env, clientId));
    await saveDevices(env, clientId, devices);
    return jsonResponse({ devices: decorateOnline(devices) });
  }

  if (body.action === 'heartbeat') {
    if (!body.deviceId) return jsonResponse({ error: 'Missing deviceId.' }, 400);
    const devices = await getDevices(env, clientId);
    if (devices[body.deviceId]) {
      devices[body.deviceId].lastSeen = Date.now();
      if (typeof body.hasPrinter === 'boolean') devices[body.deviceId].hasPrinter = body.hasPrinter;
      await saveDevices(env, clientId, devices);
    }
    return jsonResponse({ ok: true });
  }

  /* ---------- Routing rules ---------- */

  if (body.action === 'getRules') {
    return jsonResponse({ rules: await getRules(env, clientId) });
  }

  if (body.action === 'saveRules') {
    const rules = Array.isArray(body.rules) ? body.rules : [];
    await env.mydukapos_kv.put(rulesKey(clientId), JSON.stringify(rules));
    return jsonResponse({ ok: true });
  }

  /* ---------- Availability check (legacy single-relay fallback) ---------- */

  if (body.action === 'checkAvailable') {
    const devices = decorateOnline(pruneStaleDevices(await getDevices(env, clientId)));
    const available = devices.some((d) => d.online && d.hasPrinter && d.acceptsRelay);
    return jsonResponse({ available });
  }

  /* ---------- Job submission / routing ---------- */

  if (body.action === 'submit') {
    if (!body.jobType || !body.text) return jsonResponse({ error: 'Missing job content.' }, 400);

    const devices = decorateOnline(pruneStaleDevices(await getDevices(env, clientId)));
    const rules = (await getRules(env, clientId)).filter((r) => r.active !== false && r.trigger === body.jobType);
    const sourceStation = body.sourceStation || null;

    // A rule applies if it's not scoped to a source station, or its source
    // station matches the submitting device's own station.
    const matching = rules.filter((r) => !r.sourceStation || r.sourceStation === 'any' || r.sourceStation === sourceStation);

    let destinationIds = [];
    for (const rule of matching) {
      destinationIds = destinationIds.concat(resolveDestinationDeviceIds(rule.destinations || [], devices));
    }
    destinationIds = Array.from(new Set(destinationIds));

    // No matching rule (or a matching rule resolved to nobody currently
    // online) — fall back to the original behaviour: whichever single
    // device is available right now, so an un-configured shop keeps
    // working exactly as before this feature existed.
    if (!destinationIds.length) {
      const fallback = devices.find((d) => d.online && d.hasPrinter && d.acceptsRelay);
      if (fallback) destinationIds = [fallback.deviceId];
    }

    if (!destinationIds.length) {
      return jsonResponse({ ok: false, delivered: 0, error: 'No printer currently accepting jobs.' });
    }

    const job = {
      id: randomToken(12),
      jobType: body.jobType,
      text: body.text,
      meta: body.meta || {},
      createdAt: Date.now(),
      claimedAt: null,
    };
    for (const deviceId of destinationIds) {
      await pushJob(env, clientId, deviceId, job);
    }
    return jsonResponse({ ok: true, jobId: job.id, delivered: destinationIds.length });
  }

  /* ---------- Per-device polling ---------- */

  if (body.action === 'poll') {
    const deviceId = body.deviceId || LEGACY_DEVICE_ID;

    // Polling itself counts as a heartbeat — a device actively asking for
    // jobs is obviously online right now.
    const devices = await getDevices(env, clientId);
    if (deviceId === LEGACY_DEVICE_ID) {
      // See LEGACY_DEVICE_ID above — a no-deviceId poller is always
      // treated as present, with a printer, accepting jobs, so it keeps
      // surfacing in listDevices/decorateOnline and in submit()'s
      // fallback exactly like the old single-relay device did.
      devices[deviceId] = {
        ...(devices[deviceId] || {}),
        name: devices[deviceId]?.name || 'Aqua POS printer',
        station: devices[deviceId]?.station || 'Other',
        printerMode: devices[deviceId]?.printerMode || 'legacy',
        hasPrinter: true,
        acceptsRelay: true,
        lastSeen: Date.now(),
      };
      await saveDevices(env, clientId, devices);
    } else if (devices[deviceId]) {
      devices[deviceId].lastSeen = Date.now();
      await saveDevices(env, clientId, devices);
    }

    const queue = await getQueue(env, clientId, deviceId);
    const now = Date.now();
    const fresh = queue.filter((j) => now - j.createdAt < JOB_MAX_AGE_MS);

    const claimable = fresh.filter((j) => !j.claimedAt || (now - j.claimedAt) > JOB_CLAIM_TIMEOUT_MS);
    const toReturn = claimable.slice(0, 5);
    toReturn.forEach((j) => { j.claimedAt = now; });

    await saveQueue(env, clientId, deviceId, fresh);
    return jsonResponse({ jobs: toReturn });
  }

  if (body.action === 'ack') {
    if (!body.jobId) return jsonResponse({ error: 'Missing jobId.' }, 400);
    const deviceId = body.deviceId || LEGACY_DEVICE_ID;
    const queue = await getQueue(env, clientId, deviceId);
    const remaining = queue.filter((j) => j.id !== body.jobId);
    await saveQueue(env, clientId, deviceId, remaining);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
