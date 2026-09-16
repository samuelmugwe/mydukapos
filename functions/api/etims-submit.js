// functions/api/etims-submit.js — Cloudflare Pages Function
//
// Submits one completed sale to KRA as a real tax invoice, via their OSCU
// /saveTrnsSalesOsdc endpoint. Called by the POS after a sale is already
// committed locally — this never blocks or delays checkout itself; it's a
// best-effort follow-up call the app makes in the background afterward
// (see the sync/retry logic in index.html). If this fails or the shop
// isn't registered for eTIMS at all, the sale still stands — nothing here
// can undo a completed sale, it only adds KRA's own receipt signature to
// it once/if that succeeds.
//
// IMPORTANT — a mapping this file owns and nowhere else should duplicate:
// This app's own item.vatCategory ('A' = standard rate, 'B' = reduced rate,
// 'C' = zero-rated/exempt — see the Add Item form) uses the SAME LETTERS as
// KRA's own eTIMS tax type codes, but they mean DIFFERENT THINGS entirely
// (KRA: A = exempt/0%, B = 16%, C = 0% zero-rated, D = non-VAT, E = 8%).
// Passing this app's vatCategory straight through as KRA's taxTyCd would
// silently submit the WRONG tax bracket for every sale. See
// mapVatCategoryToKra() below — that function is the single place this
// translation happens; nothing else in this codebase should attempt it.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadEtimsConfig, hasEtimsConfig, etimsBaseUrl, nextEtimsInvoiceNo } from './_etims-config.js';
import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// This app's vatCategory -> KRA's taxTyCd + rate. See the file header for
// why these can't just be passed through even though the letters overlap.
//
// The rates below are hardcoded to KRA's own legally fixed brackets (16%
// standard, 8% reduced, 0% zero-rated) rather than reading this shop's own
// VAT_RATE_A / VAT_RATE_B settings (Settings -> Tax & Alerts) — those are
// user-editable for the shop's own internal reporting, but eTIMS itself has
// no concept of a shop choosing its own rate. If a shop's local setting
// ever drifted from KRA's actual rate (typo, testing, a future rate
// change), submitting that drifted number to KRA would itself be a
// compliance error — so this always uses the correct legal rate,
// independent of whatever the shop has configured locally.
function mapVatCategoryToKra(vatCategory) {
  switch (vatCategory) {
    case 'A': return { taxTyCd: 'B', rate: 0.16 }; // this app's "Standard rate" -> KRA's 16% bracket
    case 'B': return { taxTyCd: 'E', rate: 0.08 }; // this app's "Reduced rate (fuel)" -> KRA's 8% bracket
    case 'C': return { taxTyCd: 'C', rate: 0 };    // this app's "Zero-rated/exempt" -> KRA's zero-rated bracket
    default: return { taxTyCd: 'B', rate: 0.16 };  // unrecognized — safest default is the standard rate, not silently exempting a sale
  }
}

function mapPaymentMethodToKra(paymentMethod) {
  // KRA's own payment type codes: 01 Cash, 02 Credit, 03 Cash/Credit, 04
  // Bank Check, 05 Debit/Credit Card, 06 Mobile Money, 07 Other.
  if (paymentMethod === 'mpesa') return '06';
  if (paymentMethod === 'bill') return '02'; // "Pay Later" is credit until settled
  if (paymentMethod === 'split') return '03';
  return '01'; // cash
}

// KRA date format is YYYYMMDD / YYYYMMDDHHmmss with no separators.
function kraDate(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function kraDateTime(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${kraDate(isoString)}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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

  const sale = body.sale;
  if (!sale || !Array.isArray(sale.items) || sale.items.length === 0) {
    return jsonResponse({ error: 'No sale data provided.' }, 400);
  }

  const cfg = await loadEtimsConfig(env, clientId);
  if (!hasEtimsConfig(cfg)) {
    // Not an error the caller needs to alarm the cashier over — this shop
    // simply hasn't registered for eTIMS. The sale itself already went
    // through locally regardless.
    return jsonResponse({ skipped: true, reason: 'not_registered' });
  }

  // Only items that are actually sold count toward the tax bracket totals —
  // a borrowed/adhoc line with no real product behind it, or a service with
  // no separate VAT handling of its own, still carries whatever vatCategory
  // was recorded on it at sale time, same as every other line.
  const perBracket = { B: { taxbl: 0, tax: 0 }, C: { taxbl: 0, tax: 0 }, E: { taxbl: 0, tax: 0 } };
  const itemList = sale.items.map((item, idx) => {
    const { taxTyCd, rate } = mapVatCategoryToKra(item.vatCategory);
    const lineTotal = (item.price || 0) * (item.qty || 0);
    // KRA's taxable amount is VAT-inclusive gross for a bracket with a rate,
    // and equals the line total outright for the zero-rated bracket.
    const taxAmt = rate > 0 ? lineTotal - (lineTotal / (1 + rate)) : 0;
    const taxblAmt = lineTotal - taxAmt;

    if (perBracket[taxTyCd]) {
      perBracket[taxTyCd].taxbl += taxblAmt;
      perBracket[taxTyCd].tax += taxAmt;
    }

    return {
      itemSeq: idx + 1,
      itemCd: item.code || `ADHOC-${idx + 1}`,
      itemClsCd: '5059690800', // KRA's generic "unclassified goods/services" class — this app has no per-item KRA classification code of its own
      itemNm: item.name,
      pkgUnitCd: 'NT', // "Not packaged" — this app doesn't track KRA's packaging-unit codes
      pkg: 1,
      qtyUnitCd: 'U', // generic "unit" — this app's own free-text units (pcs, kg, etc.) don't map to KRA's controlled list
      qty: item.qty || 0,
      prc: item.price || 0,
      splyAmt: lineTotal,
      dcRt: 0,
      dcAmt: 0,
      taxTyCd,
      taxblAmt: Math.round(taxblAmt * 100) / 100,
      taxAmt: Math.round(taxAmt * 100) / 100,
      totAmt: Math.round(lineTotal * 100) / 100,
    };
  });

  const totTaxblAmt = Math.round((perBracket.B.taxbl + perBracket.C.taxbl + perBracket.E.taxbl) * 100) / 100;
  const totTaxAmt = Math.round((perBracket.B.tax + perBracket.C.tax + perBracket.E.tax) * 100) / 100;
  const totAmt = Math.round((totTaxblAmt + totTaxAmt) * 100) / 100;

  const invcNo = await nextEtimsInvoiceNo(env, clientId);
  const payload = {
    tin: cfg.etimsPin,
    bhfId: cfg.etimsBranchId,
    cmcKey: cfg.etimsCmcKey,
    trdInvcNo: String(sale.id || invcNo),
    invcNo,
    orgInvcNo: 0, // 0 for a normal sale; only a credit note references an earlier invoice here
    custTin: null,
    custNm: sale.customerName || null,
    rcptTyCd: 'S', // Sale — this app doesn't yet submit credit notes/refunds to eTIMS
    pmtTyCd: mapPaymentMethodToKra(sale.paymentMethod),
    salesSttsCd: '02', // Approved — this app never submits a sale it hasn't already committed
    cfmDt: kraDateTime(sale.timestamp),
    salesDt: kraDate(sale.timestamp),
    stockRlsDt: kraDateTime(sale.timestamp),
    totItemCnt: itemList.length,
    taxblAmtB: Math.round(perBracket.B.taxbl * 100) / 100,
    taxblAmtC: Math.round(perBracket.C.taxbl * 100) / 100,
    taxblAmtE: Math.round(perBracket.E.taxbl * 100) / 100,
    taxRtB: 16,
    taxRtC: 0,
    taxRtE: 8,
    taxAmtB: Math.round(perBracket.B.tax * 100) / 100,
    taxAmtC: Math.round(perBracket.C.tax * 100) / 100,
    taxAmtE: Math.round(perBracket.E.tax * 100) / 100,
    totTaxblAmt,
    totTaxAmt,
    totAmt,
    itemList,
    receipt: {
      custTin: null,
      custMblNo: null,
      rcptPbctDt: kraDateTime(sale.timestamp),
      trdeNm: cfg.etimsTaxpayerName || '',
      adrs: null,
      topMsg: null,
      btmMsg: null,
      prchrAcptcYn: 'N',
    },
  };

  let kraData;
  try {
    const res = await fetch(`${etimsBaseUrl(cfg)}/mm/api/request/1.0.0/saveTrnsSalesOsdc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    kraData = await res.json();
  } catch (e) {
    // Network/KRA-side failure — the caller's retry logic handles trying
    // again later. The invoice number already issued above is NOT reused;
    // KRA's own numbering tolerates a retry submitting the same invcNo
    // again more safely than silently skipping a number would.
    return jsonResponse({ error: 'Could not reach KRA\u2019s eTIMS server.', retryable: true }, 502);
  }

  if (!kraData || kraData.resultCd !== '000') {
    const kraMessage = (kraData && kraData.resultMsg) || 'KRA rejected this invoice.';
    return jsonResponse({ error: `KRA said: "${kraMessage}"`, retryable: true }, 400);
  }

  const info = kraData.data;
  return jsonResponse({
    submitted: true,
    invcNo,
    curRcptNo: info.curRcptNo,
    totRcptNo: info.totRcptNo,
    intrlData: info.intrlData,
    rcptSign: info.rcptSign,
    sdcDateTime: info.sdcDateTime,
    mrcNo: cfg.etimsMrcNo,
  });
}
