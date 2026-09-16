// functions/api/cross-branch-sale.js — Cloudflare Pages Function
//
// Lets a branch sell an item that physically lives in ANOTHER branch's own
// inventory — e.g. Branch A's customer wants something only Branch B has in
// stock. The sale is recorded entirely in Branch B's own sales log and stock
// (Branch B is who actually loses the stock and earns the revenue), tagged
// with which branch and which staff member actually rang it up, so both
// Branch B's records and that staff member's own activity reflect it.
//
// This deliberately does NOT go through pos-sync.js's normal per-device sync
// path — it reads Branch B's current state, modifies just the sales log and
// one item's stock, and writes it straight back, the same safe, narrow
// read-modify-write pattern store.js already uses for taking stock from a
// shared warehouse. The same accepted tradeoff applies: if Branch B is
// syncing its own unrelated local change at the exact same instant, last
// write wins — fine at the scale this is built for, and no different from
// the risk every multi-device sync in this app already carries.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, getLicense, getBranchGroupMembers, randomToken } from './_license.js';

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

function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}

async function getState(env, clientId) {
  const raw = await env.mydukapos_kv.get(stateKey(clientId));
  return raw ? JSON.parse(raw) : null;
}

async function saveState(env, clientId, state) {
  await env.mydukapos_kv.put(stateKey(clientId), JSON.stringify({ ...state, updatedAt: Date.now() }));
}

// Deducts stock the same way the front-end's own deductStockForSaleUnit()
// does for a dual-unit item, kept here as a small, self-contained mirror of
// that logic rather than importing front-end code into a backend function.
function deductItemStock(item, qty, saleMode) {
  if (saleMode === 'piece' && item.dualUnit) {
    item.pieceQty = Math.max(0, (item.pieceQty || 0) - qty);
  } else {
    item.qty = Math.max(0, (item.qty || 0) - qty);
  }
}

function getAvailableQty(item, saleMode) {
  if (saleMode === 'piece' && item.dualUnit) return item.pieceQty || 0;
  return item.qty || 0;
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

  const callerRecord = await getLicense(env, license.clientId);
  if (!callerRecord) return jsonResponse({ error: 'Client not found.' }, 404);
  if (!callerRecord.branchGroupId) {
    return jsonResponse({ error: 'This shop is not part of a branch group.' }, 400);
  }

  // Every action below only ever touches clients confirmed to be in the
  // caller's own branch group — never an arbitrary client ID handed in by
  // the request, however this endpoint is called.
  const memberIds = await getBranchGroupMembers(env, callerRecord.branchGroupId);

  if (body.action === 'searchOtherBranches') {
    const query = String(body.query || '').trim().toLowerCase();
    if (!query) return jsonResponse({ results: [] });

    // Every other branch is fetched in parallel rather than one at a time —
    // a sequential loop here meant a group with several branches took
    // noticeably longer to search than a group with just two, which is
    // exactly the "some branches are slow" symptom this was rewritten to fix.
    const otherMemberIds = memberIds.filter((id) => id !== license.clientId);
    const perBranch = await Promise.all(otherMemberIds.map(async (memberId) => {
      const [memberRecord, state] = await Promise.all([getLicense(env, memberId), getState(env, memberId)]);
      if (!memberRecord) return [];
      const items = Array.isArray(state && state.inventory) ? state.inventory : [];
      const matches = [];
      items.forEach((item) => {
        if (item.type === 'service' || item.type === 'ingredient') return; // never sold directly
        const haystack = `${item.name} ${item.code}`.toLowerCase();
        if (!haystack.includes(query)) return;
        const available = getAvailableQty(item, undefined);
        if (available <= 0 && !(item.dualUnit && getAvailableQty(item, 'piece') > 0)) return;
        matches.push({
          branchClientId: memberId,
          branchLabel: memberRecord.label,
          code: item.code,
          name: item.name,
          price: item.price,
          unit: item.unit || 'pcs',
          qty: item.qty || 0,
          dualUnit: !!item.dualUnit,
          piecePrice: item.piecePrice || 0,
          pieceQty: item.pieceQty || 0,
        });
      });
      return matches;
    }));
    const results = perBranch.flat();
    return jsonResponse({ results: results.slice(0, 30) });
  }

  if (body.action === 'sellBatch') {
    const targetClientId = String(body.targetClientId || '');
    if (!memberIds.includes(targetClientId)) {
      return jsonResponse({ error: 'That branch is not part of this shop\u2019s branch group.' }, 400);
    }
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    if (requestedItems.length === 0) {
      return jsonResponse({ error: 'No items provided.' }, 400);
    }

    const targetState = await getState(env, targetClientId);
    if (!targetState || !Array.isArray(targetState.inventory)) {
      return jsonResponse({ error: 'That branch has no inventory recorded yet.' }, 400);
    }

    // Resolve and validate every item BEFORE deducting any stock, so a
    // shortfall partway through a multi-item cart never leaves stock
    // half-deducted for that branch.
    const resolved = [];
    for (const reqItem of requestedItems) {
      const itemCode = String(reqItem.itemCode || '');
      const qty = parseFloat(reqItem.qty);
      const saleMode = reqItem.saleMode === 'piece' ? 'piece' : undefined;
      if (!itemCode || isNaN(qty) || qty <= 0) {
        return jsonResponse({ error: 'Invalid item or quantity.' }, 400);
      }
      const item = targetState.inventory.find((p) => p.code === itemCode);
      if (!item) return jsonResponse({ error: `"${itemCode}" no longer exists in that branch\u2019s inventory.` }, 404);
      const available = getAvailableQty(item, saleMode);
      if (qty > available) {
        return jsonResponse({ error: `Only ${available} of "${item.name}" available at that branch now \u2014 someone else may have just bought it.` }, 409);
      }
      resolved.push({ item, qty, saleMode });
    }

    const total = resolved.reduce((sum, r) => {
      const unitPrice = r.saleMode === 'piece' ? (r.item.piecePrice || 0) : (r.item.price || 0);
      return sum + unitPrice * r.qty;
    }, 0);

    resolved.forEach((r) => deductItemStock(r.item, r.qty, r.saleMode));

    const cashAmount = typeof body.cashAmount === 'number' ? body.cashAmount : (body.paymentMethod === 'mpesa' ? 0 : total);
    const mpesaAmount = typeof body.mpesaAmount === 'number' ? body.mpesaAmount : (body.paymentMethod === 'mpesa' ? total : 0);

    const saleRecord = {
      id: randomToken(12),
      timestamp: new Date().toISOString(),
      paymentMethod: body.paymentMethod || 'cash',
      paid: true,
      cashAmount,
      mpesaAmount,
      amountTendered: total,
      change: 0,
      servedBy: body.servedBy || '?',
      customerName: body.customerName || null,
      receivingAccount: body.receivingAccount || null,
      // What makes this a cross-branch sale rather than an ordinary one —
      // both this branch's own sales log and the selling branch's own staff
      // records can key off these two fields. The customer's own printed
      // receipt is built separately, client-side, combining this with
      // whatever they also bought locally — this record here is purely the
      // owning branch's own accounting, so it stays scoped to just the
      // items that were actually theirs.
      soldViaBranch: callerRecord.label,
      soldViaBranchId: license.clientId,
      items: resolved.map((r) => {
        const unitPrice = r.saleMode === 'piece' ? (r.item.piecePrice || 0) : (r.item.price || 0);
        return {
          code: r.item.code, name: r.item.name, qty: r.qty, price: unitPrice,
          wholesalePrice: r.saleMode === 'piece' ? (r.item.pieceWholesalePrice || 0) : (r.item.wholesalePrice || 0),
          unit: r.item.unit || 'pcs', isService: false, vatCategory: r.item.vatCategory || 'A',
          saleMode: r.saleMode || null,
        };
      }),
    };

    targetState.salesLog = Array.isArray(targetState.salesLog) ? targetState.salesLog : [];
    targetState.salesLog.push(saleRecord);
    await saveState(env, targetClientId, targetState);

    return jsonResponse({ sale: saleRecord });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
