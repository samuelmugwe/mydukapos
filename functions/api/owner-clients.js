// functions/api/owner-clients.js — Cloudflare Pages Function
//
// Backs the 🔗 Licenses tab in index.html (owner-only — see _owner-auth.js).
// This is the direct replacement for the old master-clients.js, just gated
// by the owner session token instead of MASTER_ADMIN_PASSWORD.
//
// GET  -> list client links, newest first. Optional ?q=<text> filters by
//         label/subdomain (handy once you have a lot of these). This reads
//         the lightweight per-client SUMMARY kept in the index (see
//         listClientSummaries in _license.js) rather than fetching every
//         client's full record — the old version did one KV read per
//         client, which works fine at a few dozen clients but hits
//         Cloudflare's per-request subrequest cap long before 10,000. The
//         summary already carries everything this list needs.
// POST -> create a new client link directly (used by the 🔗 Licenses tab's
//         "Generate Demo Link" button, and internally by the Sales Counter
//         when a License item is checked out — see index.html). Body:
//         { type: "demo" | "permanent", label?: string, product?: "shop"|"hotel" }.
//         The label also becomes the client's subdomain (e.g. "George's
//         Hardware" -> georges-hardware.mydukapos.store), auto-deduplicated
//         if that subdomain is already taken.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth, getOwnerAccount } from './_owner-auth.js';
import { listClientSummaries, createClient, evaluateLicense, listProducts, clientLink, getRootDomain } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const ok = await requireOwnerAuth(context);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';

  const summaries = await listClientSummaries(env, { q });
  // The owner's own account has a real, permanent client record behind it
  // (see _owner-auth.js — this is what lets the owner actually use Shop POS
  // themselves, not just the admin dashboard). It's infrastructure, not a
  // client in the business sense, so it never belongs in a list where Lock/
  // Delete/Extend sit one click away — deleting or locking it would break
  // the owner's own POS access, not a real client's.
  const ownerAccount = await getOwnerAccount(env);
  const filtered = ownerAccount
    ? summaries.filter((s) => s.id !== ownerAccount.ownerClientId)
    : summaries;

  const origin = url.origin;
  const enriched = filtered.map((summary) => {
    const evalResult = evaluateLicense(summary); // summary carries type/locked/expiresAt
    return {
      ...summary,
      link: clientLink(env, summary, origin),
      valid: evalResult.valid,
      liveReason: evalResult.reason,
      remainingMs: evalResult.remainingMs !== undefined ? evalResult.remainingMs : null,
    };
  });

  return jsonResponse({
    clients: enriched,
    serverNow: Date.now(),
    products: listProducts(),
    rootDomain: getRootDomain(env),
  });
}

export async function onRequestPost(context) {
  const ok = await requireOwnerAuth(context);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const type = body.type === 'permanent' ? 'permanent' : 'demo';
  const record = await createClient(context.env, type, body.label, body.product, {
    clientName: body.clientName,
    preferredName: body.preferredName,
    phone: body.phone,
    email: body.email,
  });
  const origin = new URL(context.request.url).origin;

  return jsonResponse({ client: record, link: clientLink(context.env, record, origin) });
}
