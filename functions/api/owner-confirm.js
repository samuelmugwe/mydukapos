// functions/api/owner-confirm.js — Cloudflare Pages Function
//
// Backs the "Confirm Payment" button in the 🔗 Licenses tab, shown next to
// any demo link whose shop clicked "I have made this payment" on their own
// lock screen (see license-claim-payment.js) — used for the legacy
// self-serve upgrade path. Most permanent links are now generated directly
// by ringing up a License item at the Sales Counter (see index.html), which
// needs no confirmation step since the owner is the one taking the payment.
// This manual path stays available for a shop that paid on their own
// without you physically ringing it up. Direct replacement for
// master-confirm.js, gated by owner session instead of MASTER_ADMIN_PASSWORD.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';
import { getLicense, saveLicense, getGroupMainRecord } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

  const record = await getLicense(context.env, body.c);
  if (!record) return jsonResponse({ error: 'Client not found.' }, 404);

  // Marks a claimed base-tier payment as FALSE — the client clicked "I have
  // made this payment" but nothing actually arrived (checked the M-Pesa/
  // till statement and it's not there). Just clears the claim flag so the
  // client goes back to seeing the normal "pay to upgrade" screen instead
  // of "awaiting confirmation" — does NOT lock or otherwise penalize the
  // link, since a false claim might just be a genuine mistake (wrong
  // number, paid but under a different name) rather than bad faith.
  if (body.action === 'reject-payment') {
    record.paymentClaimed = false;
    record.paymentClaimedAt = null;
    await saveLicense(context.env, record);
    return jsonResponse({ client: record });
  }

  // Same idea for a branch add-on claim — clears branchAddonClaimed on the
  // group's main record without granting the extra branch slot.
  if (body.action === 'reject-addon') {
    const mainRecord = record.branchGroupId && !record.isMainBranch
      ? await getGroupMainRecord(context.env, record)
      : record;
    mainRecord.branchAddonClaimed = false;
    mainRecord.branchAddonClaimedAt = null;
    await saveLicense(context.env, mainRecord);
    return jsonResponse({ client: mainRecord });
  }

  // Branch add-on confirmation: doesn't touch type/expiry at all, just
  // grants one more branch slot on top of whatever the base tier already
  // included. Kept as a distinct action (instead of inferring it from
  // record.type === 'permanent') so an admin can't accidentally re-confirm
  // an already-permanent record as a fresh base-tier upgrade and reset its
  // confirmedAt for no reason.
  if (body.action === 'confirm-addon') {
    if (record.type !== 'permanent') {
      return jsonResponse({ error: 'Confirm the base KES 3,000 upgrade before confirming a branch add-on.' }, 400);
    }
    record.branchAllowance = (record.branchAllowance || 0) + 1;
    record.branchAddonClaimed = false;
    await saveLicense(context.env, record);
    return jsonResponse({ client: record });
  }

  // Default action: confirm the base KES 3,000 permanent upgrade. Base tier
  // covers 1 primary shop instance + 1 branch, so branchAllowance starts at
  // 1 here — never overwritten if this record was somehow already
  // permanent with a higher allowance (e.g. re-running confirm by mistake
  // shouldn't claw back add-ons already granted).
  record.type = 'permanent';
  record.expiresAt = null;
  record.locked = false;
  record.confirmedAt = Date.now();
  record.branchAllowance = record.branchAllowance || 1;
  await saveLicense(context.env, record);

  return jsonResponse({ client: record });
}
