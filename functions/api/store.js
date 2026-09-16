// functions/api/store.js — Cloudflare Pages Function
//
// A "store" is a warehouse — for a branch group, shared stock that doesn't
// belong to any single branch but that any branch can draw from; for a
// standalone shop with no branches, it's just that shop's own separate
// warehouse. Either way it lives in its own KV entry (store:<branchGroupId>
// or store:<clientId> when there's no group), completely separate from any
// individual client's synced inventory.
//
// Actions (all POST, JSON body — caller identified by license the same way
// as every other endpoint in this app):
//   { action: 'get' }
//     Returns the store's current item list for the caller's branch group.
//   { action: 'getLog' }
//     Returns this branch group's store transaction log — every add, edit,
//     quantity correction, withdrawal, and delete, newest first, up to the
//     500 most recent. Every other action below that changes the store also
//     appends one entry here automatically; nothing needs to call this
//     separately to keep the log current.
//   { action: 'addManual', item: { name, unit, price, wholesalePrice, qty } }
//     Adds a new store item, or — if an item with the same name already
//     exists — adds the quantity to it instead of creating a duplicate.
//   { action: 'addFromCsv', items: [...] }
//     Same add-or-increment logic as addManual, for a whole batch parsed
//     client-side from a CSV file (this endpoint doesn't parse CSV itself).
//   { action: 'addFromInventory', items: [{ name, unit, price, wholesalePrice, qty }] }
//     Same add-or-increment logic — the frontend is what decides these came
//     from the caller's own inventory rather than a fresh CSV/manual entry;
//     the caller's own inventory itself is never touched by this action.
//     qty may be 0 (or omitted) to register an item's code/name/price in the
//     store without transferring any stock — that's a normal, common case
//     here, not an error, unlike addManual/addFromCsv which still require a
//     positive qty on the frontend side.
//   { action: 'setQty', storeItemId, qty }
//     Directly sets a store item's quantity to an exact value — for manual
//     correction or a stock-take, not for normal stock movement (that's what
//     removeFromStore/addFromInventory are for). Never touches the caller's
//     own inventory.
//   { action: 'updateFields', storeItemId, fields: { name?, code?, price?, wholesalePrice?, wholesaleSellingPrice?, unit? } }
//     Edits one or more of a store item's own details directly — its name,
//     code, or pricing, none of which touch quantity/stock at all. Only the
//     fields actually present in the body are changed; anything omitted is
//     left as-is.
//   { action: 'removeFromStore', items: [{ storeItemId, qty }] }
//     Deducts the given quantities from the store (never below zero, and
//     never more than what's actually there). Does NOT touch the caller's
//     own inventory — the frontend adds the withdrawn quantity to its own
//     local stock after this succeeds, then syncs that itself the normal
//     way, so this endpoint only ever has to reason about the store side.
//   { action: 'deleteItem', storeItemId }
//     Removes an item from the store entirely, regardless of its quantity —
//     for correcting a mistaken entry, not for normal stock movement (that's
//     what removeFromStore is for).
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense, randomToken } from './_license.js';

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

function storeKey(groupId) {
  return `store:${groupId}`;
}

function logKey(groupId) {
  return `store-log:${groupId}`;
}

async function getStoreItems(env, groupId) {
  const raw = await env.mydukapos_kv.get(storeKey(groupId));
  return raw ? JSON.parse(raw) : [];
}

async function saveStoreItems(env, groupId, items) {
  await env.mydukapos_kv.put(storeKey(groupId), JSON.stringify(items));
}

async function getStoreLog(env, groupId) {
  const raw = await env.mydukapos_kv.get(logKey(groupId));
  return raw ? JSON.parse(raw) : [];
}

// Appends one entry and keeps only the most recent 500 — a running log like
// this would otherwise grow forever; 500 entries is well past what anyone
// needs to look back through in the UI, and keeps this KV value small.
async function appendStoreLog(env, groupId, entry) {
  const log = await getStoreLog(env, groupId);
  log.push({ id: randomToken(10), timestamp: new Date().toISOString(), ...entry });
  const trimmed = log.slice(-500);
  await env.mydukapos_kv.put(logKey(groupId), JSON.stringify(trimmed));
}

// Adds each incoming line to the store — matched to an existing store item
// by code first (if both have one), falling back to name (case-insensitive)
// otherwise, so re-importing the same item's CSV row twice (or importing
// something already added manually) increases its quantity rather than
// creating a second entry for the same thing.
function mergeItemsIntoStore(storeItems, incoming) {
  incoming.forEach((inc) => {
    const name = String(inc.name || '').trim();
    if (!name) return;
    // Unlike removeFromStore/setQty, a negative or non-numeric qty here just
    // means "register this item with no stock yet" (e.g. importing from
    // inventory to only carry over code/name/price) — never an error, and
    // never treated as "nothing to do" the way it used to be.
    const qty = Math.max(0, parseFloat(inc.qty) || 0);
    const code = String(inc.code || '').trim();

    const existing = code
      ? storeItems.find((s) => s.code && s.code.toLowerCase() === code.toLowerCase())
      : storeItems.find((s) => !s.code && s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.qty += qty;
      if (inc.price !== undefined && inc.price !== '') existing.price = parseFloat(inc.price) || existing.price;
      if (inc.wholesaleSellingPrice !== undefined && inc.wholesaleSellingPrice !== '') existing.wholesaleSellingPrice = parseFloat(inc.wholesaleSellingPrice) || existing.wholesaleSellingPrice;
      if (inc.wholesalePrice !== undefined && inc.wholesalePrice !== '') existing.wholesalePrice = parseFloat(inc.wholesalePrice) || existing.wholesalePrice;
      if (inc.unit) existing.unit = inc.unit;
    } else {
      storeItems.push({
        id: randomToken(10),
        code: code || null,
        name,
        unit: inc.unit || 'pcs',
        price: parseFloat(inc.price) || 0,
        wholesaleSellingPrice: parseFloat(inc.wholesaleSellingPrice) || 0,
        wholesalePrice: parseFloat(inc.wholesalePrice) || 0,
        qty,
      });
    }
  });
  return storeItems;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const record = await getLicense(env, license.clientId);
  if (!record) return jsonResponse({ error: 'Client not found.' }, 404);
  // A shop in a branch group shares one store with every branch (keyed by the
  // group). A standalone shop with no branches still gets a store of its
  // own, keyed to itself, so this never requires setting up branches first.
  const groupId = record.branchGroupId || record.id;

  if (body.action === 'get') {
    const items = await getStoreItems(env, groupId);
    return jsonResponse({ items });
  }

  if (body.action === 'getLog') {
    const log = await getStoreLog(env, groupId);
    return jsonResponse({ log: log.slice().reverse() });
  }

  if (body.action === 'addManual') {
    if (!body.item || !body.item.name) return jsonResponse({ error: 'Item name is required.' }, 400);
    let items = await getStoreItems(env, groupId);
    items = mergeItemsIntoStore(items, [body.item]);
    await saveStoreItems(env, groupId, items);
    await appendStoreLog(env, groupId, {
      action: 'add',
      itemName: body.item.name,
      detail: `Added manually \u2014 ${parseFloat(body.item.qty) || 0} ${body.item.unit || 'pcs'}`,
      servedBy: body.servedBy || null,
    });
    return jsonResponse({ items });
  }

  if (body.action === 'addFromCsv' || body.action === 'addFromInventory') {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return jsonResponse({ error: 'No items to add.' }, 400);
    }
    let items = await getStoreItems(env, groupId);
    items = mergeItemsIntoStore(items, body.items);
    await saveStoreItems(env, groupId, items);
    // One summary entry rather than one per item — a CSV/inventory import is
    // often dozens of items at once, and a line-by-line log of a single bulk
    // action would drown out everything else in the log almost immediately.
    await appendStoreLog(env, groupId, {
      action: 'add',
      itemName: body.items.length === 1 ? body.items[0].name : `${body.items.length} items`,
      detail: body.action === 'addFromCsv' ? 'Imported via CSV' : 'Imported from inventory (code/name/price only)',
      servedBy: body.servedBy || null,
    });
    return jsonResponse({ items });
  }

  if (body.action === 'setQty') {
    if (!body.storeItemId) return jsonResponse({ error: 'No item specified.' }, 400);
    const qty = parseFloat(body.qty);
    if (isNaN(qty) || qty < 0) return jsonResponse({ error: 'Enter a valid quantity.' }, 400);
    const items = await getStoreItems(env, groupId);
    const storeItem = items.find((s) => s.id === body.storeItemId);
    if (!storeItem) return jsonResponse({ error: 'Item not found.' }, 404);
    const oldQty = storeItem.qty;
    storeItem.qty = qty;
    await saveStoreItems(env, groupId, items);
    await appendStoreLog(env, groupId, {
      action: 'qty_change',
      itemName: storeItem.name,
      detail: `Quantity corrected from ${oldQty} to ${qty} ${storeItem.unit || 'pcs'}`,
      servedBy: body.servedBy || null,
    });
    return jsonResponse({ items });
  }

  if (body.action === 'updateFields') {
    if (!body.storeItemId) return jsonResponse({ error: 'No item specified.' }, 400);
    if (!body.fields || typeof body.fields !== 'object') return jsonResponse({ error: 'No fields to update.' }, 400);
    const items = await getStoreItems(env, groupId);
    const storeItem = items.find((s) => s.id === body.storeItemId);
    if (!storeItem) return jsonResponse({ error: 'Item not found.' }, 404);

    const f = body.fields;
    if (f.name !== undefined) {
      const name = String(f.name).trim();
      if (!name) return jsonResponse({ error: 'Item name cannot be blank.' }, 400);
      storeItem.name = name;
    }
    if (f.code !== undefined) {
      const code = String(f.code).trim();
      if (code) {
        const collision = items.some((s) => s.id !== storeItem.id && s.code && s.code.toLowerCase() === code.toLowerCase());
        if (collision) return jsonResponse({ error: `"${code}" is already used by another store item.` }, 400);
      }
      storeItem.code = code || null;
    }
    for (const priceField of ['price', 'wholesalePrice', 'wholesaleSellingPrice']) {
      if (f[priceField] !== undefined) {
        const val = parseFloat(f[priceField]);
        if (isNaN(val) || val < 0) return jsonResponse({ error: `Enter a valid ${priceField}.` }, 400);
        storeItem[priceField] = val;
      }
    }
    if (f.unit !== undefined) {
      const unit = String(f.unit).trim();
      if (unit) storeItem.unit = unit;
    }

    await saveStoreItems(env, groupId, items);
    await appendStoreLog(env, groupId, {
      action: 'edit',
      itemName: storeItem.name,
      detail: `Updated: ${Object.keys(f).join(', ')}`,
      servedBy: body.servedBy || null,
    });
    return jsonResponse({ items });
  }

  if (body.action === 'removeFromStore') {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return jsonResponse({ error: 'No items selected.' }, 400);
    }
    const items = await getStoreItems(env, groupId);
    const withdrawn = [];
    for (const req of body.items) {
      const storeItem = items.find((s) => s.id === req.storeItemId);
      if (!storeItem) continue;
      const qty = Math.max(0, Math.min(parseFloat(req.qty) || 0, storeItem.qty));
      if (qty <= 0) continue;
      storeItem.qty -= qty;
      withdrawn.push({ code: storeItem.code, name: storeItem.name, unit: storeItem.unit, price: storeItem.price, wholesaleSellingPrice: storeItem.wholesaleSellingPrice, wholesalePrice: storeItem.wholesalePrice, qty });
    }
    const remaining = items.filter((s) => s.qty > 0.0001);
    await saveStoreItems(env, groupId, remaining);
    for (const w of withdrawn) {
      await appendStoreLog(env, groupId, {
        action: 'withdraw',
        itemName: w.name,
        detail: `${w.qty} ${w.unit || 'pcs'} taken to own inventory`,
        servedBy: body.servedBy || null,
      });
    }
    return jsonResponse({ items: remaining, withdrawn });
  }

  if (body.action === 'deleteItem') {
    if (!body.storeItemId) return jsonResponse({ error: 'No item specified.' }, 400);
    const items = await getStoreItems(env, groupId);
    const deleted = items.find((s) => s.id === body.storeItemId);
    const remaining = items.filter((s) => s.id !== body.storeItemId);
    await saveStoreItems(env, groupId, remaining);
    if (deleted) {
      await appendStoreLog(env, groupId, {
        action: 'delete',
        itemName: deleted.name,
        detail: `Removed from store entirely (had ${deleted.qty} ${deleted.unit || 'pcs'})`,
        servedBy: body.servedBy || null,
      });
    }
    return jsonResponse({ items: remaining });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
