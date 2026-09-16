// functions/api/ai-capture-list.js — Cloudflare Pages Function
//
// Powers the "📸 Capture List" feature (Inventory → Add New Items / Restock):
// a photo of an invoice, handwritten note, delivery sheet, or receipt gets
// sent here, and this calls Google Gemini's vision API to pull out a
// line-by-line list of { name, code, quantity, unit cost, retail price,
// wholesale price } — even when the source has no column headers at all
// ("Chair 0001  5  Kes200"). Every field but name-or-code is optional.
//
// The same endpoint also recognizes a second kind of photo: a recipe /
// dish-costing sheet (a dish name heading over an ingredient table with
// Unit/Quantity/Unit Price columns, e.g. "Chapati" with Flour/Cooking
// Oil/Water/Salt rows). When it detects that shape it returns
// document_type: 'recipe' with a `recipes` array instead of `items` — see
// openRecipeCaptureReviewModal() in index.html for how that gets turned
// into a Dish + its ingredient recipe.
//
// PUT accepts either { imageDataUrl } (a photo, the original mode) or
// { textDocument } (a plain-text rendering of a spreadsheet's rows,
// columns separated by " | "). The "📄 Import Recipe Excel" button in the
// hotel module's Add New Items tab uses textDocument as a fallback: its
// own fast, offline, zero-cost structured parser (Yield row → Ingredient/
// Unit/Quantity/Unit Price table) handles well-formed costing sheets
// directly with no AI call at all, and only reaches this endpoint when
// that parser can't confidently make sense of a sheet's layout.
//
// There's a PLATFORM-wide POOL of up to 10 Gemini API keys, set from the
// Owner Console (Settings → AI Capture List) and stored in KV by
// gemini-capture-config.js — see getGeminiCaptureKeys() there. That pool
// is the fallback every shop uses out of the box. On top of that, same
// pattern as image-search.js's per-shop Pixabay key, a shop can save up
// to 2 of its OWN Gemini keys (Settings → AI Capture List → "Use your own
// Gemini API key") — stored in KV under SHOP_CONFIG_PREFIX + clientId.
// Whenever a shop has saved key(s), every request from that shop tries
// them FIRST, in order, and only falls through to the platform pool once
// the shop's own are exhausted — see resolveGeminiKeys() below. Within
// whichever pool is in play, callGeminiForJson() rotates to the next key
// the moment one comes back rate-limited/exhausted or invalid, instead of
// the request just failing — this is what raises the feature's real-world
// success rate when a shop or the platform has several Gemini accounts
// to draw on. A shop's only gate here is having a currently valid license
// (checked below), exactly as with every other data-touching endpoint.
// Nothing here ever sees or needs the shop's inventory — matching a
// detected line against existing stock is done entirely client-side (see
// fuzzyMatchInventory() in index.html) so this endpoint stays small, fast,
// and independent of catalog size.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project
// (already required by image-search.js / other endpoints).

import { requireValidLicense } from './_license.js';
import { getGeminiCaptureKeys } from './gemini-capture-config.js';

const GEMINI_MODEL = 'gemini-3.6-flash';
const SHOP_CONFIG_PREFIX = 'ai-capture-shop-config:';
const MAX_SHOP_KEYS = 2;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

function last4(key) {
  const k = String(key || '');
  return k.length > 4 ? k.slice(-4) : k;
}

// Normalized shape: { geminiApiKeys: [{ id, key, label, addedAt }] }.
// Transparently migrates the pre-pool single-key shape ({ geminiApiKey })
// on read — nothing is persisted until the shop next adds/removes a key.
async function getShopGeminiConfig(env, clientId) {
  const raw = await env.mydukapos_kv.get(SHOP_CONFIG_PREFIX + clientId);
  if (!raw) return { geminiApiKeys: [] };
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.geminiApiKeys)) return parsed;
  if (parsed.geminiApiKey) {
    return { geminiApiKeys: [{ id: 'legacy', key: parsed.geminiApiKey, label: '', addedAt: 0 }] };
  }
  return { geminiApiKeys: [] };
}

// Resolves the FULL ordered list of keys this shop's requests should try,
// shop keys first (in the order the shop added them, up to
// MAX_SHOP_KEYS), then every platform-pool key (in the order the owner
// added them) as the fallback once the shop's own are exhausted. Returns
// [{ geminiApiKey, source }] — empty when nothing is configured anywhere.
// `source` is 'shop' | 'platform', used only to keep error messages and
// the Settings status display pointed at whichever pool a given key came
// from. Pass an already-fetched shopConfig to skip a redundant KV read
// (onRequestGet needs shopConfig for `shopKeys` anyway).
async function resolveGeminiKeys(env, clientId, shopConfig) {
  const shop = shopConfig || await getShopGeminiConfig(env, clientId);
  const shopKeys = shop.geminiApiKeys
    .filter(k => k.key)
    .map(k => ({ geminiApiKey: k.key, source: 'shop' }));
  const platformKeys = (await getGeminiCaptureKeys(env))
    .map(key => ({ geminiApiKey: key, source: 'platform' }));
  return [...shopKeys, ...platformKeys];
}

// GET /api/ai-capture-list?status=1 — reports whether AI Capture List is
// available for THIS shop (never the keys themselves) and where its keys
// are coming from, so Settings can show "using your own key(s)" vs
// "using the platform's shared pool" vs "not enabled yet", plus a masked
// list of the shop's own saved keys so it can manage them (add up to 2,
// remove one). Still gated by a valid license, same as every other route
// here, so the check itself can't be probed by an unlicensed device.
export async function onRequestGet(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  const url = new URL(request.url);
  if (url.searchParams.get('status') === '1') {
    const shopConfig = await getShopGeminiConfig(env, license.clientId);
    const keys = await resolveGeminiKeys(env, license.clientId, shopConfig);
    const platformCount = keys.filter(k => k.source === 'platform').length;
    return jsonResponse({
      configured: keys.length > 0,
      source: keys.length > 0 ? keys[0].source : null,   // which pool the NEXT call tries first
      shopConfigured: shopConfig.geminiApiKeys.length > 0,
      shopKeys: shopConfig.geminiApiKeys.map(k => ({ id: k.id, label: k.label || '', last4: last4(k.key) })),
      shopKeyMax: MAX_SHOP_KEYS,
      platformAvailable: platformCount > 0,
    });
  }
  return jsonResponse({ error: 'Unsupported request.' }, 400);
}

// POST /api/ai-capture-list — manage THIS shop's own Gemini API key(s),
// up to MAX_SHOP_KEYS.
// Body: { action: 'add', geminiApiKey, label? } — appends a key.
// Body: { action: 'remove', id } — removes one previously-added key.
// A shop with zero keys saved here falls back entirely to the platform
// pool; one with 1-2 saved tries those first, in order, before falling
// back to the platform pool — see resolveGeminiKeys() above.
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
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const config = await getShopGeminiConfig(env, license.clientId);

  if (body.action === 'add') {
    const geminiApiKey = String(body.geminiApiKey || '').trim();
    if (!geminiApiKey) {
      return jsonResponse({ error: 'Enter your Gemini API key.' }, 400);
    }
    if (config.geminiApiKeys.length >= MAX_SHOP_KEYS) {
      return jsonResponse({ error: `You can save up to ${MAX_SHOP_KEYS} keys — remove one first.` }, 400);
    }
    if (config.geminiApiKeys.some(k => k.key === geminiApiKey)) {
      return jsonResponse({ error: 'That key is already saved.' }, 400);
    }
    const label = String(body.label || '').trim().slice(0, 60);
    config.geminiApiKeys.push({ id: crypto.randomUUID().slice(0, 8), key: geminiApiKey, label, addedAt: Date.now() });
    await env.mydukapos_kv.put(SHOP_CONFIG_PREFIX + license.clientId, JSON.stringify(config));
    return jsonResponse({ success: true, configured: true, count: config.geminiApiKeys.length, max: MAX_SHOP_KEYS });
  }

  if (body.action === 'remove') {
    const id = String(body.id || '');
    const before = config.geminiApiKeys.length;
    config.geminiApiKeys = config.geminiApiKeys.filter(k => k.id !== id);
    if (config.geminiApiKeys.length === before) {
      return jsonResponse({ error: 'Key not found.' }, 404);
    }
    await env.mydukapos_kv.put(SHOP_CONFIG_PREFIX + license.clientId, JSON.stringify(config));
    return jsonResponse({ success: true, configured: config.geminiApiKeys.length > 0, count: config.geminiApiKeys.length, max: MAX_SHOP_KEYS });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}

// Fires ONE Gemini call against ONE key, with a short same-key retry for
// transient 500/503 service errors (unrelated to which key is used, so
// retrying the same key is the right move there — rotating keys wouldn't
// help). Returns:
//   { ok: true, data }
//   { ok: false, status, errText, rotate: true }   — this key is exhausted
//     (rate/quota limit) or invalid/revoked; the caller should try the
//     NEXT configured key before giving up.
//   { ok: false, status, errText, rotate: false }  — a general failure
//     (service outage, empty/unparseable response); switching keys won't
//     fix this, so the caller stops here.
const GEMINI_SAME_KEY_MAX_ATTEMPTS = 2;
const GEMINI_SAME_KEY_RETRYABLE_STATUS = new Set([500, 503]);

// Gemini's forced-JSON output has a hard ceiling (maxOutputTokens below);
// a big spreadsheet — many rows, each needing several fields — can run
// past it mid-array, and the response comes back cut off mid-object with
// invalid JSON. Rather than treating that as a total failure (which used
// to mean a large file could come back with the review screen showing
// almost nothing — or nothing at all — despite the model having read
// most of it correctly), walk the truncated text once, remember every
// point where we're sitting right after a cleanly-closed value at the
// top array's depth, cut there, and close whatever brackets are still
// open. Returns the parsed object on success or null if even that isn't
// recoverable (e.g. truncated before a single complete item).
function repairTruncatedJson(text) {
  let inString = false;
  let escape = false;
  let lastSafe = -1;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); }
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length >= 1) lastSafe = i; // a value closed cleanly, still inside the outer object
    }
  }
  if (lastSafe === -1 || stack.length === 0) return null;
  let truncated = text.slice(0, lastSafe + 1);
  let closer = '';
  for (let i = stack.length - 1; i >= 0; i--) closer += (stack[i] === '{' ? '}' : ']');
  try {
    return JSON.parse(truncated + closer);
  } catch (e) {
    return null;
  }
}

function isKeyExhaustedOrInvalid(status, errText) {
  if (status === 429) return true;  // rate limit / quota — the whole reason to have a pool of keys
  if (status === 403) return true;  // key rejected/forbidden
  if (status === 400) {
    try {
      const parsed = JSON.parse(errText);
      const msg = (parsed && parsed.error && parsed.error.message) || '';
      if (/API key not valid|API_KEY_INVALID/i.test(msg)) return true;
    } catch (e) { /* not JSON — not a recognizable invalid-key error */ }
  }
  return false;
}

async function attemptGeminiKey(geminiApiKey, systemPrompt, userParts, responseSchema, maxOutputTokens) {
  async function callGemini() {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    return fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
          maxOutputTokens: maxOutputTokens || 4096,
        },
      }),
    });
  }

  let geminiRes;
  let errText = '';
  for (let attempt = 1; attempt <= GEMINI_SAME_KEY_MAX_ATTEMPTS; attempt++) {
    geminiRes = await callGemini();
    if (geminiRes.ok) break;
    errText = await geminiRes.text();
    const shouldRetrySameKey = attempt < GEMINI_SAME_KEY_MAX_ATTEMPTS && GEMINI_SAME_KEY_RETRYABLE_STATUS.has(geminiRes.status);
    if (!shouldRetrySameKey) break;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  if (!geminiRes.ok) {
    return { ok: false, status: geminiRes.status, errText, rotate: isKeyExhaustedOrInvalid(geminiRes.status, errText) };
  }

  const data = await geminiRes.json();
  const candidate = (data.candidates || [])[0];
  const textPart = candidate && candidate.content && (candidate.content.parts || []).find(p => typeof p.text === 'string');
  if (!textPart) {
    return { ok: false, status: 0, errText: '', rotate: false, noContent: true };
  }

  const cleaned = textPart.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (e) {
    // The response may simply have been cut off at the maxOutputTokens
    // ceiling (candidate.finishReason === 'MAX_TOKENS') — try to salvage
    // whatever complete items came through before the cutoff rather than
    // failing the whole import outright.
    const repaired = repairTruncatedJson(cleaned);
    if (repaired) {
      return { ok: true, data: repaired, truncated: true };
    }
    return { ok: false, status: 0, errText: cleaned, rotate: false, parseFail: true };
  }
}

// Shared by every PUT mode below: tries each configured key IN ORDER
// (shop keys first, then the platform pool — see resolveGeminiKeys()),
// moving to the next key only when the current one comes back exhausted
// or invalid (attempt.rotate === true). This is the whole point of
// supporting multiple keys: if key A (e.g. one Gemini account) has hit
// its quota, key B (a different account) picks up the very next request
// automatically, raising the feature's real-world success rate instead
// of the shopkeeper just seeing a "try again later" error. A general
// service failure (500/503 after its own same-key retry, empty response,
// bad JSON) does NOT burn through the rest of the list, since switching
// keys can't fix a Gemini-side outage — that fails immediately with its
// own message. Returns { ok: true, data } or { ok: false, response } —
// callers just return `response` verbatim on failure.
async function callGeminiForJson({ keys, systemPrompt, userParts, responseSchema, maxOutputTokens, contextLabel }) {
  if (!keys || keys.length === 0) {
    return { ok: false, response: jsonResponse({ error: 'AI Capture List has not been enabled by the platform admin yet — or add your own Gemini API key in Settings.' }, 400) };
  }

  for (let i = 0; i < keys.length; i++) {
    const { geminiApiKey, source } = keys[i];
    const attempt = await attemptGeminiKey(geminiApiKey, systemPrompt, userParts, responseSchema, maxOutputTokens);
    if (attempt.ok) return { ok: true, data: attempt.data, truncated: !!attempt.truncated };

    const isLastKey = i === keys.length - 1;
    if (attempt.rotate && !isLastKey) continue; // try the next configured key

    if (attempt.noContent) {
      return { ok: false, response: jsonResponse({ error: 'The AI service returned no readable content.' }, 502) };
    }
    if (attempt.parseFail) {
      return { ok: false, response: jsonResponse({ error: 'Could not parse the AI response as JSON.', detail: attempt.errText.slice(0, 300) }, 502) };
    }
    const describeError = makeGeminiErrorDescriber(source, contextLabel, { totalKeys: keys.length, allRotated: attempt.rotate });
    const friendly = describeError(attempt.status, attempt.errText);
    return { ok: false, response: jsonResponse({ error: friendly, detail: attempt.errText.slice(0, 300) }, 502) };
  }
}

// Turns Gemini's raw error body into something a shopkeeper can actually
// act on. Gemini's error responses are JSON — { error: { code, message,
// status } } — so pull the real message/status out instead of only
// showing the bare HTTP code, and fall it back gracefully if the body
// isn't JSON (e.g. an upstream proxy error page). `keySource` changes who
// the shopkeeper needs to act on; `contextLabel` (e.g. "image", "spreadsheet",
// "column layout") tunes the size/format-limit wording to whichever mode
// called this. `rotationInfo` describes how many keys were configured and
// whether every single one of them came back exhausted/invalid, so the
// message can say so plainly instead of sounding like only one key exists.
function makeGeminiErrorDescriber(keySource, contextLabel, rotationInfo) {
  const { totalKeys = 1, allRotated = false } = rotationInfo || {};
  return function describeGeminiError(status, errText) {
    let apiMessage = '';
    let apiStatus = '';
    try {
      const parsedErr = JSON.parse(errText);
      apiMessage = (parsedErr && parsedErr.error && parsedErr.error.message) || '';
      apiStatus = (parsedErr && parsedErr.error && parsedErr.error.status) || '';
    } catch (e) {
      // Not JSON — leave apiMessage/apiStatus blank and fall through to the
      // generic per-status messages below.
    }

    const keyOwnerHint = keySource === 'shop'
      ? 'your own saved Gemini API key(s) in Settings → AI Capture List'
      : "the platform's shared Gemini keys (ask the platform admin to check them) — or add your own key in Settings → AI Capture List to stop depending on them";

    if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
      if (totalKeys > 1 && allRotated) {
        return `All ${totalKeys} configured Gemini API keys have hit their quota or rate limit right now — this clears up on its own. Wait a bit and try again, or add another free key in Settings → AI Capture List.`;
      }
      if (/quota/i.test(apiMessage)) {
        return keySource === 'shop'
          ? 'Your own Gemini API key has hit its daily/per-minute quota. Wait a bit and try again, or attach billing to your Gemini key to raise the limit.'
          : "The platform's shared free Gemini API key has hit its daily/per-minute quota — this happens faster when many shops share one key. Wait a bit and try again, or add your own free Gemini API key in Settings → AI Capture List so you're not competing for the shared quota.";
      }
      return 'Rate limited by the AI service (common on the free tier under load) — wait a moment and try again.';
    }
    if (status === 503 || apiStatus === 'UNAVAILABLE') {
      return "Gemini's free tier is temporarily overloaded — this clears up on its own. Please try again in a few seconds.";
    }
    if (status === 500 || apiStatus === 'INTERNAL') {
      return `The AI service hit an internal error processing this ${contextLabel} — try again${contextLabel === 'image' ? ', and use a clearer/smaller photo if it keeps happening' : ' if it keeps happening'}.`;
    }
    if (status === 400) {
      if (/API key not valid|API_KEY_INVALID/i.test(apiMessage)) {
        return totalKeys > 1 && allRotated
          ? `Every configured Gemini API key was rejected as invalid — check ${keyOwnerHint}.`
          : `The saved Gemini API key is invalid — check ${keyOwnerHint}.`;
      }
      if (/large|size/i.test(apiMessage)) {
        return `That ${contextLabel} is too large for the AI service to accept — try a smaller file.`;
      }
      return apiMessage ? `The AI service rejected the request: ${apiMessage}` : `The AI service rejected the request — check ${keyOwnerHint}.`;
    }
    if (status === 403) {
      return apiMessage ? `That Gemini API key was rejected: ${apiMessage}` : `That Gemini API key was rejected — check ${keyOwnerHint}.`;
    }
    return apiMessage ? `The AI service declined the request: ${apiMessage}` : `The AI service declined the request (HTTP ${status}).`;
  };
}

// Column fields the "AI-powered Inventory Import" mode below can place —
// kept as one list so the prompt text, the response schema, and the
// mapping-object sanitizing all stay in sync with each other.
const INVENTORY_COLUMN_FIELDS = [
  'name', 'code', 'category', 'price', 'wholesaleSelling', 'wholesale',
  'qty', 'unit', 'location', 'vat', 'expiry', 'dual', 'unitsPerBox',
  'piecePrice', 'pieceWholesale', 'image',
];

// Renders a header row + a handful of sample data rows as plain, labelled
// text for the model — same "columns are 0-indexed" framing whether or not
// a real header is present, since deciding that IS part of the model's job
// here (see header_is_data in the schema below).
function renderInventoryColumnsPrompt(headerRow, sampleRows) {
  const fmtRow = (r) => r.map((c, i) => `[${i}] ${(c === null || c === undefined) ? '' : String(c).trim()}`).join('  ');
  const lines = [];
  lines.push('First row of the file: ' + fmtRow(headerRow));
  sampleRows.forEach((r, i) => lines.push(`Sample data row ${i + 1}: ` + fmtRow(r)));
  return lines.join('\n');
}

// PUT /api/ai-capture-list — three request shapes share this one route:
//   1. { imageDataUrl } — the original photo-OCR mode.
//   2. { textDocument } — plain-text spreadsheet rows, used by "Import
//      Recipe Excel" when its own offline parser can't read a sheet.
//   3. { inventoryColumns: { headerRow, sampleRows } } — AI-powered column
//      detection for the Inventory List's "⬆️ Import from Excel/CSV"
//      button (see detectCsvColumnsAI() in index.html). Instead of reading
//      a whole document, this mode looks at one header row plus a few
//      sample data rows and returns which column holds which inventory
//      field — using BOTH the header text (any language/wording/order)
//      AND the shape of the actual values, so it still works on files
//      with unusual, abbreviated, or missing headers that the fixed
//      alias list in index.html can't recognize. The offline alias list
//      and manual Column Mapping Modal remain the fallback chain when
//      this mode isn't configured or the call fails — see
//      beginInventoryFileImport() in index.html.
export async function onRequestPut(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }

  const keys = await resolveGeminiKeys(env, license.clientId);
  if (keys.length === 0) {
    return jsonResponse({ error: 'AI Capture List has not been enabled by the platform admin yet — or add your own Gemini API key in Settings.' }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  // Mode 3 — AI-powered inventory column detection. Handled and returned
  // here, entirely separately from the image/textDocument modes below
  // (different prompt, different schema, much smaller payload).
  if (body.inventoryColumns && typeof body.inventoryColumns === 'object') {
    const headerRowRaw = Array.isArray(body.inventoryColumns.headerRow) ? body.inventoryColumns.headerRow : [];
    const sampleRowsRaw = Array.isArray(body.inventoryColumns.sampleRows) ? body.inventoryColumns.sampleRows : [];
    if (headerRowRaw.length === 0 && sampleRowsRaw.length === 0) {
      return jsonResponse({ error: 'No columns were provided to detect.' }, 400);
    }
    // Cap generously but firmly — this is a header row plus a few sample
    // rows, never a whole file, so anything past this points at a caller
    // bug rather than a legitimately wide sheet.
    const MAX_COLS = 60;
    const MAX_SAMPLE_ROWS = 10;
    const headerRow = headerRowRaw.slice(0, MAX_COLS).map(c => String(c == null ? '' : c).slice(0, 200));
    const sampleRows = sampleRowsRaw.slice(0, MAX_SAMPLE_ROWS).map(r => (Array.isArray(r) ? r : []).slice(0, MAX_COLS).map(c => String(c == null ? '' : c).slice(0, 200)));

    const SYSTEM_PROMPT = `You are analyzing a spreadsheet a shopkeeper is importing into a point-of-sale system's inventory. You are given the first row of the file and a few sample data rows below it, with each cell shown as "[column index] value" (columns are 0-based, left to right). The first row MAY be a genuine header row (field labels), or it MAY already be a data row — some exports have no header at all. Decide which, and separately decide which column (if any) holds each of these inventory fields. Use BOTH the header text — in any language, abbreviation, wording, or column order — AND the actual values in the sample rows, since a header may be missing, unusual, or misleading: a column of small whole numbers is very likely quantity; a column of currency-like numbers is very likely a price or cost; a column of long descriptive text is very likely the item name.

Fields to place (each is a 0-based column index, or -1 if genuinely not present anywhere in this file):
- name: the item/product's descriptive name.
- code: a separate SKU, barcode, model, or product code — distinct from the descriptive name. Don't reuse the name column here.
- category: a product category or department label.
- price: the retail/selling price per unit.
- wholesaleSelling: a bulk/wholesale SELLING price per unit — distinct from cost/buying price.
- wholesale: the cost/buying price per unit (what the shop itself pays a supplier).
- qty: the quantity/stock count.
- unit: the unit of measure (e.g. pcs, kg, box, ltr).
- location: a shelf, warehouse, or storage location label.
- vat: a VAT or tax category.
- expiry: an expiry date.
- dual: a yes/no flag for whether the item is also sold in a secondary ("dual") unit.
- unitsPerBox: how many individual pieces make up one box/carton, when items are sold both by the piece and by the box.
- piecePrice: the selling price of a single piece, when the item is normally sold by the box.
- pieceWholesale: the wholesale/cost price of a single piece, when the item is normally sold by the box.
- image: an image filename or URL.

Rules:
- Watch for a row-numbering / serial-number column — header text like "No", "No.", "S/No", "SN", "#", "Sl No", "Sr", or (with no header at all) a column whose values simply count 1, 2, 3, 4, 5... one per row in order. That column is a row label, NEVER the qty field or any other field — always -1 for it, even though it is numeric and even though it sits right next to the real quantity column.
- Every value must be either a real 0-based column index present in the rows you were given, or -1.
- Never point two different fields at the same column, except when the sheet genuinely only has one price column doing double duty for two of these fields — otherwise prefer -1 for whichever field doesn't clearly apply rather than guessing.
- Also return header_is_data: true if the first row is itself a data row with no real header present (already contains a product name/numbers rather than field labels), false if it's a genuine header row that should be skipped when the caller reads data.
- If nothing in the file resembles a usable name or code column at all, set both name and code to -1 rather than guessing a column just to fill it in.

Respond with a JSON object matching the schema exactly — no commentary.`;

    const RESPONSE_SCHEMA = {
      type: 'OBJECT',
      properties: {
        header_is_data: { type: 'BOOLEAN' },
        mapping: {
          type: 'OBJECT',
          properties: Object.fromEntries(INVENTORY_COLUMN_FIELDS.map(f => [f, { type: 'NUMBER' }])),
          required: ['name', 'code', 'qty', 'wholesale'],
        },
      },
      required: ['mapping', 'header_is_data'],
    };

    const userParts = [
      { text: 'Determine the column mapping for this spreadsheet, following the schema exactly:\n\n' + renderInventoryColumnsPrompt(headerRow, sampleRows) },
    ];

    const result = await callGeminiForJson({
      keys,
      systemPrompt: SYSTEM_PROMPT,
      userParts,
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 1024,
      contextLabel: 'column layout',
    });
    if (!result.ok) return result.response;

    const rawMapping = (result.data && typeof result.data.mapping === 'object') ? result.data.mapping : {};
    const maxIdx = Math.max(headerRow.length, ...sampleRows.map(r => r.length), 0) - 1;
    const mapping = {};
    INVENTORY_COLUMN_FIELDS.forEach(f => {
      const n = Number(rawMapping[f]);
      mapping[f] = (Number.isInteger(n) && n >= 0 && n <= maxIdx) ? n : -1;
    });

    return jsonResponse({ mapping, header_is_data: !!result.data.header_is_data });
  }

  // Mode 4 — AI-powered "Business Data Import" (Settings → 📥 Data
  // Import). Reads a single, often messy, multi-category spreadsheet —
  // exactly the shape of a typical shop/bar day-sheet, which mixes a
  // stock table, a "DEBTS" section, and an "EXPENSES" section on one tab
  // with no clean, consistent headers — and sorts it into stock rows and
  // debt rows for the client's review-before-commit UI. Expense rows are
  // deliberately NOT extracted yet (out of scope for this pass); the
  // prompt tells the model to skip that section entirely rather than
  // guess at a shape the client doesn't act on.
  if (body.stockDebtImport && typeof body.stockDebtImport === 'object') {
    const textDocument = typeof body.stockDebtImport.textDocument === 'string' ? body.stockDebtImport.textDocument : '';
    const itemsOnly = !!body.stockDebtImport.itemsOnly;
    if (!textDocument.trim()) {
      return jsonResponse({ error: 'No spreadsheet content was provided.' }, 400);
    }
    if (textDocument.length > 120000) {
      return jsonResponse({ error: 'That spreadsheet has too many rows for the AI reader — trim it down or split it into smaller files.' }, 400);
    }

    // itemsOnly (the "Only import stock items — skip Debts and Expenses"
    // checkbox) drops the whole debts extraction task, not just the
    // result: a shorter prompt AND a smaller response schema means every
    // token of the output budget goes toward stock rows instead of being
    // split with debt rows the caller doesn't want anyway — which also
    // directly helps large, item-heavy sheets stay under the token
    // ceiling in the first place.
    const SYSTEM_PROMPT = itemsOnly ? `You are reading a spreadsheet of stock/inventory rows from a small shop, bar, or restaurant — given as plain-text rows, columns separated by " | ", one row per line. Extract every stock item row (usually with a header row containing words like ITEM, SKU, RETAIL, OPEN, ADD, TOT, BAL, SALE, BP, or similar, but sometimes with no header at all). This is normally a stock-take/day-sheet with SEVERAL quantity columns tracking one item's movement over a period, not just one number — read as many of these as the sheet actually shows, since the importing system uses them to continue the shop's stock history instead of resetting it to zero:
   - name: the item/product description (e.g. "4th Street", "Sugar 2kg").
   - sku: a separate size/variant/code shown for that item if present (e.g. "750ml", "SKU1042") — distinct from the name; leave blank ("") if not present.
   - retail_price: the per-unit selling price shown for that row.
   - buying_price: the per-unit cost/buying price shown for that row, often labelled BP, Cost, or Buying Price.
   - opening_qty: the stock count at the START of the period — a column labelled OPEN or Opening. 0 if not shown.
   - added_qty: stock added/restocked DURING the period — a column labelled ADD, Added, or Restocked. 0 if not shown.
   - sold_qty: units sold DURING the period — a column labelled SALE, Sold, or Qty Sold. 0 if not shown.
   - closing_qty: the CURRENT/closing stock count, i.e. what's physically on the shelf right now — prefer a column labelled BAL, Balance, Closing, or Stock. If the sheet has no closing/balance column but does have opening_qty, added_qty, and sold_qty, leave closing_qty as 0 and the importing system will compute it itself (opening + added − sold); only report closing_qty directly when a real balance-style column is present.

Ignore and skip completely: the stock table's own header row, any row that is clearly a section title/running total/blank, and any separate "DEBTS" or "EXPENSES" section elsewhere on the sheet — the caller only wants stock items from this sheet, nothing else, even if those other sections are present. If the sheet has multiple stock-like blocks, extract all of them together into the one stock_items list. Respond with a JSON object matching the schema exactly — no commentary.` : `You are reading a single spreadsheet tab from a small shop, bar, or restaurant — given as plain-text rows, columns separated by " | ", one row per line. These day-sheets commonly pack several unrelated sections onto one tab with no consistent formatting: a stock/inventory table, a section headed something like "DEBTS" or "DEBT" listing customers who owe money, and a section headed something like "EXPENSES" — in any order, anywhere on the sheet.

Extract exactly two things:

1. STOCK ITEMS — rows from the stock/inventory table (usually the largest block, often with a header row containing words like ITEM, SKU, RETAIL, OPEN, ADD, TOT, BAL, SALE, BP, or similar, but sometimes with no header at all). This is normally a stock-take/day-sheet with SEVERAL quantity columns tracking one item's movement over a period, not just one number — read as many of these as the sheet actually shows, since the importing system uses them to continue the shop's stock history instead of resetting it to zero:
   - name: the item/product description (e.g. "4th Street", "Sugar 2kg").
   - sku: a separate size/variant/code shown for that item if present (e.g. "750ml", "SKU1042") — distinct from the name; leave blank ("") if not present.
   - retail_price: the per-unit selling price shown for that row.
   - buying_price: the per-unit cost/buying price shown for that row, often labelled BP, Cost, or Buying Price.
   - opening_qty: the stock count at the START of the period — a column labelled OPEN or Opening. 0 if not shown.
   - added_qty: stock added/restocked DURING the period — a column labelled ADD, Added, or Restocked. 0 if not shown.
   - sold_qty: units sold DURING the period — a column labelled SALE, Sold, or Qty Sold. 0 if not shown.
   - closing_qty: the CURRENT/closing stock count, i.e. what's physically on the shelf right now — prefer a column labelled BAL, Balance, Closing, or Stock. If the sheet has no closing/balance column but does have opening_qty, added_qty, and sold_qty, leave closing_qty as 0 and the importing system will compute it itself (opening + added − sold); only report closing_qty directly when a real balance-style column is present.
   Skip the stock table's own header row, and skip any row that is clearly a section title, a running total, or blank.

2. DEBTS — rows from a section whose heading contains "DEBT" (e.g. "DEBTS", "Customer Debts", "Bills/Fines" when it clearly lists people owing money). Each debt row is normally just a person's name next to one number (the balance they owe). Report:
   - customer_name: the person's name.
   - amount: the amount they owe.
   Do not include a "TOTAL" row itself as a debt. Do not confuse a DEBTS section with an EXPENSES or SALARIES section — those track the business's own spending, not money owed TO the business, and must be completely ignored; never return them as either stock or debts.

If the sheet has multiple stock-like blocks, extract all of them together into the one stock_items list. If no DEBTS section exists at all, return an empty debts array — never invent one from unrelated numbers. Respond with a JSON object matching the schema exactly — no commentary.`;

    const STOCK_ITEM_SCHEMA = {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        sku: { type: 'STRING' },
        retail_price: { type: 'NUMBER' },
        buying_price: { type: 'NUMBER' },
        opening_qty: { type: 'NUMBER' },
        added_qty: { type: 'NUMBER' },
        sold_qty: { type: 'NUMBER' },
        closing_qty: { type: 'NUMBER' },
      },
      required: ['name'],
    };

    const RESPONSE_SCHEMA = itemsOnly ? {
      type: 'OBJECT',
      properties: {
        stock_items: { type: 'ARRAY', items: STOCK_ITEM_SCHEMA },
      },
      required: ['stock_items'],
    } : {
      type: 'OBJECT',
      properties: {
        stock_items: { type: 'ARRAY', items: STOCK_ITEM_SCHEMA },
        debts: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              customer_name: { type: 'STRING' },
              amount: { type: 'NUMBER' },
            },
            required: ['customer_name', 'amount'],
          },
        },
      },
      required: ['stock_items', 'debts'],
    };

    const userParts = [
      { text: (itemsOnly ? 'Extract the stock items from these spreadsheet rows' : 'Extract the stock items and debts from these spreadsheet rows') + ', following the schema exactly:\n\n' + textDocument },
    ];

    // 8192 (up from the original 4096) — a sheet with 100+ item rows,
    // each needing up to 8 fields, can otherwise run past the token
    // ceiling before the array closes, which is what silently cut a
    // large upload down to only its first few rows before. If a sheet
    // is still large enough to hit even this ceiling, repairTruncatedJson()
    // (see callGeminiForJson) salvages whatever complete rows came
    // through rather than failing the whole import, and `truncated: true`
    // below tells the caller to say so.
    const result = await callGeminiForJson({
      keys,
      systemPrompt: SYSTEM_PROMPT,
      userParts,
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192,
      contextLabel: 'spreadsheet',
    });
    if (!result.ok) return result.response;

    const stock_items = Array.isArray(result.data.stock_items) ? result.data.stock_items
      .filter(it => it && typeof it === 'object' && String(it.name || '').trim())
      .map(it => ({
        name: String(it.name || '').trim().slice(0, 200),
        sku: String(it.sku || '').trim().slice(0, 50),
        retail_price: Number.isFinite(Number(it.retail_price)) ? Number(it.retail_price) : 0,
        buying_price: Number.isFinite(Number(it.buying_price)) ? Number(it.buying_price) : 0,
        opening_qty: Number.isFinite(Number(it.opening_qty)) ? Number(it.opening_qty) : 0,
        added_qty: Number.isFinite(Number(it.added_qty)) ? Number(it.added_qty) : 0,
        sold_qty: Number.isFinite(Number(it.sold_qty)) ? Number(it.sold_qty) : 0,
        closing_qty: Number.isFinite(Number(it.closing_qty)) ? Number(it.closing_qty) : 0,
      })) : [];

    const debts = itemsOnly || !Array.isArray(result.data.debts) ? [] : result.data.debts
      .filter(d => d && typeof d === 'object' && String(d.customer_name || '').trim() && Number(d.amount) > 0)
      .map(d => ({
        customer_name: String(d.customer_name || '').trim().slice(0, 200),
        amount: Number(d.amount),
      }));

    return jsonResponse({ stock_items, debts, truncated: !!result.truncated });
  }

  // Two source modes share everything below the point where a Gemini
  // `parts` array gets built: a photographed/scanned document
  // (imageDataUrl, the original mode) and a plain-text rendering of a
  // spreadsheet's rows (textDocument — added for "📄 Import Recipe Excel",
  // used when the file's structured Yield/Ingredient/Unit/Quantity/Unit
  // Price parser can't confidently read a sheet's layout). Exactly one of
  // the two must be present.
  const imageDataUrl = body.imageDataUrl || '';
  const textDocument = typeof body.textDocument === 'string' ? body.textDocument : '';

  let sourceKind, mediaType, base64Data;
  if (imageDataUrl) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(imageDataUrl);
    if (!match) {
      return jsonResponse({ error: 'No usable image was captured.' }, 400);
    }
    [, mediaType, base64Data] = match;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
      return jsonResponse({ error: 'Unsupported image type — use a JPEG, PNG, or WebP photo.' }, 400);
    }
    sourceKind = 'image';
  } else if (textDocument.trim()) {
    if (textDocument.length > 120000) {
      return jsonResponse({ error: 'That spreadsheet has too many rows for the AI reader — trim it down or split it into smaller files.' }, 400);
    }
    sourceKind = 'text';
  } else {
    return jsonResponse({ error: 'No usable image or spreadsheet content was provided.' }, 400);
  }

  // The instruction the whole feature rests on: infer structure from plain,
  // unlabelled rows rather than requiring a table. Kept as data (not code)
  // so it's easy to tune later without touching the parsing/response logic
  // below.
  const SYSTEM_PROMPT = `You are reading a shop document for a point-of-sale system's inventory intake — either a photograph/scan of a paper document, or the plain-text rows extracted from a spreadsheet file (columns separated by " | ", one row per line). First decide which of two kinds of document this is, then extract it accordingly.

KIND 1 — an invoice, a handwritten stock note, a printed delivery sheet, or a receipt listing goods bought/delivered. Set document_type to "items".

The document will very often have NO column headers, no ruled dividers, and inconsistent formatting — a real line might look like "Chair 0001 5. Kes200" or "Sugar 2kg x3 @150" or "Bread   10   45/=". Read each line the way a person restocking a shop would, using these patterns:

- Item code: a separate SKU, barcode, or product code shown as its own token on the line — distinct from the descriptive name — such as a short alphanumeric string, a leading/trailing numeric code, or anything under a "code"/"SKU"/"item no." style column (e.g. "SKU1042  Sugar 2kg  x3  @150" → code "SKU1042"). Only report a code when it's genuinely a separate identifier from the description; don't invent one and don't split an ordinary product name into a fake code.
- Item name: the text/product description on the line (e.g. "Chair 0001", "Sugar 2kg"). A line may have a name with no code, a code with no separate name (e.g. a delivery sheet that only lists SKUs), or both — report whichever is actually present; never leave both blank for a line you're including.
- Quantity: a bare count, or a number followed by a unit (e.g. "5", "5pcs", "0.5", "10 bales", "x3").
- Unit cost: a number tagged with a currency marker — "Kes", "Ksh", "KES", "$", "/=", or preceded by "@" (e.g. "Kes200", "@200", "150/=") — as the PER-UNIT cost, not a line total. If only one currency number appears on a line and it looks like a line total (equals roughly quantity × a round unit price), still report it as unit_cost divided by quantity when that division is clean; otherwise report the number as given and lower your confidence for that line.
- Retail price: a per-unit selling price if one is shown, tagged "Retail", "SP", "Selling Price", or similar — separate from unit_cost. Omit (0) if the line has no such column.
- Wholesale price: a per-unit wholesale/bulk selling price if shown, tagged "Wholesale", "WS", "Bulk", or similar. Omit (0) if not present.

Skip lines that are clearly headers, totals, dates, addresses, or signatures — only return actual item lines. If a line is ambiguous (unclear quantity or cost), still include it with your best guess and a lower confidence_score. Put these lines in the top-level "items" array and leave "recipes" empty.

KIND 2 — a recipe / dish-costing sheet: a dish or menu-item name (e.g. "Chapati", "Ugali") acting as a section header, followed by a table of raw ingredients with columns such as Unit, Quantity, Unit Price, Total, and usually a "Yield" number nearby (how many finished units/plates the listed quantities make). A single photo may show more than one such dish block stacked vertically (e.g. Chapati then Ugali) — extract every one you can read. Set document_type to "recipe" for this kind, put each dish in the top-level "recipes" array, and leave "items" empty. For each dish:
- dish_name: the dish/menu-item name heading that block (e.g. "Chapati").
- yield_qty: the number next to "Yield" for that block, if shown.
- selling_price: only if a clearly labelled "Selling Price" row/cell for the finished dish is visible in that block; otherwise omit (0).
- ingredients: one entry per raw-ingredient row under that dish, each with:
  - name: the ingredient's name as written (e.g. "Flour", "Cooking Oil", "Water", "Salt").
  - unit: the unit shown in that row's Unit column (e.g. "Kg", "Ltrs", "pinc"), normalized to a short lowercase form (kg, g, ltr, ml, pcs, pinch, tbsp, tsp). If the sheet's unit is missing or unreadable for a row, infer the most likely real-world unit for that ingredient from ordinary kitchen/hotel knowledge (flour, maize flour, sugar, rice → kg; cooking oil, milk, water → ltr; salt, spices, baking powder → g or pinch) — but always prefer the unit actually printed on the sheet when it's legible, even if it looks unusual.
  - quantity: the total amount of that ingredient used for the whole batch (the Quantity column) — NOT divided by yield.
  - unit_cost: the per-unit price for that ingredient (the Unit Price column), if shown.

If a document is ambiguous between the two kinds, prefer "recipe" only when there's a clear dish-name heading above an ingredient table with a Unit column — a plain price list of foods with no such structure is still "items".

Respond with a JSON object matching the schema exactly. For "items" lines, every entry must have at least one of detected_name or detected_code — omit or leave blank ("") whichever one genuinely isn't present, rather than guessing. confidence_score is your own confidence (0.0–1.0) that a line/ingredient was read correctly. If the document contains no readable item lines or recipe at all, respond with document_type "items" and an empty items array.`;

  // responseMimeType + responseSchema below force Gemini to return exactly
  // this shape as the text part — no markdown fences, no commentary — so
  // the parsing logic further down can stay simple.
  const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      document_type: { type: 'STRING' }, // 'items' | 'recipe'
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            detected_name: { type: 'STRING' },
            detected_code: { type: 'STRING' },
            quantity: { type: 'NUMBER' },
            unit_cost: { type: 'NUMBER' },
            retail_price: { type: 'NUMBER' },
            wholesale_price: { type: 'NUMBER' },
            confidence_score: { type: 'NUMBER' },
          },
          required: ['quantity', 'unit_cost', 'confidence_score'],
        },
      },
      recipes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            dish_name: { type: 'STRING' },
            yield_qty: { type: 'NUMBER' },
            selling_price: { type: 'NUMBER' },
            ingredients: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  unit: { type: 'STRING' },
                  quantity: { type: 'NUMBER' },
                  unit_cost: { type: 'NUMBER' },
                  confidence_score: { type: 'NUMBER' },
                },
                required: ['name', 'quantity', 'confidence_score'],
              },
            },
          },
          required: ['dish_name', 'ingredients'],
        },
      },
    },
    required: ['document_type'],
  };

  const userParts = sourceKind === 'image'
    ? [
        { inline_data: { mime_type: mediaType, data: base64Data } },
        { text: 'Extract the item list or recipe(s) from this photo, following the schema exactly.' },
      ]
    : [
        { text: 'Extract the item list or recipe(s) from these spreadsheet rows, following the schema exactly:\n\n' + textDocument },
      ];

  try {
    const result = await callGeminiForJson({
      keys,
      systemPrompt: SYSTEM_PROMPT,
      userParts,
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192,
      contextLabel: sourceKind === 'image' ? 'image' : 'spreadsheet',
    });
    if (!result.ok) return result.response;
    const parsed = result.data;

    // A line is usable as long as it has a name OR a code — a delivery
    // sheet that only lists SKUs (no description) is just as valid a line
    // as one with only a name, so neither field alone gates inclusion.
    const items = Array.isArray(parsed.items) ? parsed.items
      .filter(it => it && typeof it === 'object' && (String(it.detected_name || '').trim() || String(it.detected_code || '').trim()))
      .map(it => ({
        detected_name: String(it.detected_name || '').trim().slice(0, 200),
        detected_code: String(it.detected_code || '').trim().slice(0, 100),
        quantity: Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 0,
        unit_cost: Number.isFinite(Number(it.unit_cost)) ? Number(it.unit_cost) : 0,
        retail_price: Number.isFinite(Number(it.retail_price)) ? Number(it.retail_price) : 0,
        wholesale_price: Number.isFinite(Number(it.wholesale_price)) ? Number(it.wholesale_price) : 0,
        confidence_score: Number.isFinite(Number(it.confidence_score)) ? Math.max(0, Math.min(1, Number(it.confidence_score))) : 0.5,
      })) : [];

    // Same "at least a name" gate for recipe ingredients — an ingredient
    // line with no name at all isn't usable, unlike an items line which
    // can lean on a code instead.
    const recipes = Array.isArray(parsed.recipes) ? parsed.recipes
      .filter(r => r && typeof r === 'object' && String(r.dish_name || '').trim())
      .map(r => ({
        dish_name: String(r.dish_name || '').trim().slice(0, 200),
        yield_qty: Number.isFinite(Number(r.yield_qty)) ? Number(r.yield_qty) : 0,
        selling_price: Number.isFinite(Number(r.selling_price)) ? Number(r.selling_price) : 0,
        ingredients: Array.isArray(r.ingredients) ? r.ingredients
          .filter(ing => ing && typeof ing === 'object' && String(ing.name || '').trim())
          .map(ing => ({
            name: String(ing.name || '').trim().slice(0, 200),
            unit: String(ing.unit || '').trim().slice(0, 20),
            quantity: Number.isFinite(Number(ing.quantity)) ? Number(ing.quantity) : 0,
            unit_cost: Number.isFinite(Number(ing.unit_cost)) ? Number(ing.unit_cost) : 0,
            confidence_score: Number.isFinite(Number(ing.confidence_score)) ? Math.max(0, Math.min(1, Number(ing.confidence_score))) : 0.5,
          })) : [],
      }))
      .filter(r => r.ingredients.length > 0) : [];

    // Trust the presence of usable recipes over the model's own
    // document_type label — a stray/misclassified label shouldn't hide a
    // recipe that was otherwise read out correctly, and vice versa.
    const document_type = recipes.length > 0 ? 'recipe' : 'items';

    return jsonResponse({ document_type, items, recipes });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected error contacting the AI service.' }, 500);
  }
}
