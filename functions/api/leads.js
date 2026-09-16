// functions/api/leads.js — Cloudflare Pages Function
//
// Backend for the Owner Console's "Leads" tab — ported from the standalone
// Monarch Digital leads tracker (sheet.js, sheets.js, search.js,
// meetings.js), consolidated into one action-based route and adapted to
// live inside mydukapos rather than as a separate app:
//   - Storage: mydukapos_kv (prefixed keys) instead of a separate MONARCH_KV
//     namespace — see key naming below.
//   - Auth: requireOwnerAuth() (same as every other Owner Console endpoint)
//     instead of Monarch's own email/password session system. Staff access
//     to the Leads tab itself is gated client-side, the same way every
//     other Owner Console tab is granted to a staff PIN — there is no
//     separate multi-user backend anymore.
//   - "Business type" is now one of the 6 mydukapos products (shop, hotel,
//     hospital, school, production, pharmacy) rather than a general
//     category list — a lead's product IS which mydukapos product it's a
//     prospect for.
//   - The whole "Projects" concept (ownership, assignment, invoicing) is
//     gone. In its place: a lead can have a real mydukapos client generated
//     for it directly (action: 'generateLink'), which is what "closed" now
//     means — a lead stops carrying forward once it's been converted into
//     an actual client record, the same way it used to stop carrying once
//     it had a linked project.
//
// KV key layout (all under mydukapos_kv, distinct prefixes so nothing here
// can collide with existing client/license/website keys):
//   leads-sheet:<YYYY-MM-DD>   -> array of lead objects for that day
//   leads-meetings             -> array of meeting objects

import { requireOwnerAuth } from './_owner-auth.js';
import { createClient, clientLink, listProducts, getLicense, saveLicense } from './_license.js';

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

function sheetKey(date) {
  return `leads-sheet:${date}`;
}
const MEETINGS_KEY = 'leads-meetings';
// A short list of names ("Admin" plus whichever staff the owner adds) a
// lead can be assigned to, and whose name auto-fills onto a lead the
// moment it's marked Contacted — see 'listStaff'/'saveStaff' below and the
// Leads tab's "Working as" selector in index.html. Admin always exists
// implicitly and is never stored in this list itself.
const STAFF_KEY = 'leads-staff-list';

async function getStaffList(env) {
  const raw = await env.mydukapos_kv.get(STAFF_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function getSheetRaw(env, date) {
  const raw = await env.mydukapos_kv.get(sheetKey(date));
  return raw ? JSON.parse(raw) : null;
}
async function putSheet(env, date, leads) {
  await env.mydukapos_kv.put(sheetKey(date), JSON.stringify(leads));
}
async function getMeetings(env) {
  const raw = await env.mydukapos_kv.get(MEETINGS_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function putMeetings(env, meetings) {
  await env.mydukapos_kv.put(MEETINGS_KEY, JSON.stringify(meetings));
}

// Same loose phone comparison used throughout the rest of the app
// (normalizeKenyanPhone-adjacent) — ignores spaces, dashes, and a leading
// 0/+254/254 so different formats of the same number still match.
function normalizePhone(p) {
  return (p || '').replace(/\D/g, '').slice(-9);
}

function randomId() {
  return crypto.randomUUID();
}

// Moves any lead with a scheduled meeting onto the meetings list instead of
// letting it carry forward — same dedup-by-phone logic as the original
// Monarch meetings-store.js, minus the projectId field (projects are gone).
async function moveLeadsToMeetings(env, leads, sourceDate) {
  if (!leads || !leads.length) return;
  const existing = await getMeetings(env);
  const now = new Date().toISOString();

  leads.forEach((l) => {
    const phoneKey = normalizePhone(l.phone);
    const dup = phoneKey ? existing.find((m) => !m.done && normalizePhone(m.phone) === phoneKey) : null;

    if (dup) {
      dup.leadName = l.name || dup.leadName;
      dup.product = l.product || dup.product;
      dup.meetingDate = l.meetingDate || dup.meetingDate;
      dup.sourceDate = sourceDate;
      dup.updatedAt = now;
    } else {
      existing.push({
        id: randomId(),
        leadId: l.id,
        leadName: l.name || '',
        phone: l.phone || '',
        product: l.product || 'shop',
        meetingDate: l.meetingDate || '',
        notes: '',
        done: false,
        sourceDate,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  await putMeetings(env, existing);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const ok = await requireOwnerAuth(context);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const action = body.action;

  // ---------- getSheet ----------
  // Same rollover behaviour as the original: a sheet is created on first
  // request for a given date, carrying forward only leads that are still
  // genuinely uncontacted — not dead, not scheduled (those move to
  // meetings), and not closed (those are now real clients, tracked by
  // their own client record instead).
  if (action === 'getSheet') {
    const date = body.date;
    if (!date) return jsonResponse({ error: 'Missing date' }, 400);

    let leads = await getSheetRaw(env, date);

    if (leads === null) {
      const listRes = await env.mydukapos_kv.list({ prefix: 'leads-sheet:' });
      const priorDates = listRes.keys.map((k) => k.name.slice('leads-sheet:'.length)).filter((d) => d < date).sort();
      const lastDate = priorDates[priorDates.length - 1];

      let carried = [];
      if (lastDate) {
        const priorLeads = (await getSheetRaw(env, lastDate)) || [];

        const withMeetings = priorLeads.filter((l) => !l.dead && l.scheduled);
        if (withMeetings.length) await moveLeadsToMeetings(env, withMeetings, lastDate);

        carried = priorLeads
          .filter((l) => !l.dead && !l.contacted && !l.scheduled && !l.closed)
          .map((l) => ({
            ...l,
            id: randomId(),
            contacted: false,
            scheduled: false,
            meetingDate: '',
            carriedFrom: lastDate,
          }));
      }
      leads = carried;
      await putSheet(env, date, leads);
    }

    return jsonResponse({ date, leads });
  }

  // ---------- saveSheet ----------
  if (action === 'saveSheet') {
    const date = body.date;
    if (!date) return jsonResponse({ error: 'Missing date' }, 400);
    if (!Array.isArray(body.leads)) return jsonResponse({ error: 'leads must be an array' }, 400);
    await putSheet(env, date, body.leads);
    return jsonResponse({ ok: true });
  }

  // ---------- listSheets ----------
  if (action === 'listSheets') {
    const listRes = await env.mydukapos_kv.list({ prefix: 'leads-sheet:' });
    const dates = listRes.keys.map((k) => k.name.slice('leads-sheet:'.length)).sort().reverse();
    return jsonResponse({ dates });
  }

  // ---------- search ----------
  if (action === 'search') {
    const q = (body.q || '').trim();
    if (!q) return jsonResponse({ results: [] });

    const qLower = q.toLowerCase();
    const qPhone = normalizePhone(q);

    const listRes = await env.mydukapos_kv.list({ prefix: 'leads-sheet:' });
    const results = [];
    for (const k of listRes.keys) {
      const date = k.name.slice('leads-sheet:'.length);
      const leads = (await getSheetRaw(env, date)) || [];
      leads.forEach((lead) => {
        const nameMatch = lead.name && lead.name.toLowerCase().includes(qLower);
        const phoneMatch = qPhone.length >= 3 && lead.phone && normalizePhone(lead.phone).includes(qPhone);
        if (nameMatch || phoneMatch) results.push({ ...lead, sheetDate: date });
      });
    }
    results.sort((a, b) => b.sheetDate.localeCompare(a.sheetDate));
    return jsonResponse({ results });
  }

  // ---------- getMeetings ----------
  if (action === 'getMeetings') {
    const meetings = await getMeetings(env);
    return jsonResponse({ meetings });
  }

  // ---------- saveMeetings ----------
  if (action === 'saveMeetings') {
    if (!Array.isArray(body.meetings)) return jsonResponse({ error: 'meetings must be an array' }, 400);
    await putMeetings(env, body.meetings);
    return jsonResponse({ ok: true });
  }

  // ---------- generateLink ----------
  // Creates a real mydukapos client record for this lead (reusing the exact
  // same createClient() the rest of Owner Console uses to issue links), then
  // writes the resulting link back onto the lead's own record in its sheet
  // AND marks it closed — this is the direct replacement for the old
  // "closed once its linked project completes" behaviour, since there's no
  // project step in between anymore.
  if (action === 'generateLink') {
    const { date, leadId, product, name, type, agreedAmount, paidAmount } = body;
    if (!date || !leadId) return jsonResponse({ error: 'Missing date or leadId' }, 400);

    const validKeys = listProducts().map((p) => p.id);
    const chosenProduct = validKeys.includes(product) ? product : 'shop';
    const clientType = type === 'permanent' ? 'permanent' : 'demo';

    const leads = await getSheetRaw(env, date);
    if (!leads) return jsonResponse({ error: 'Sheet not found' }, 404);
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

    // What was agreed vs actually collected at close time — the difference
    // becomes the client's outstanding balanceOwed, i.e. the "bill" left
    // over from closing this lead (see createClient in _license.js).
    const agreed = Math.max(0, Number(agreedAmount) || 0);
    const paid = Math.max(0, Number(paidAmount) || 0);

    const record = await createClient(env, clientType, name || lead.name || '', chosenProduct, {
      phone: lead.phone || '', source: 'lead', agreedAmount: agreed, paidAmount: paid,
    });
    const origin = new URL(request.url).origin;
    const link = clientLink(env, record, origin);

    lead.clientId = record.id;
    lead.clientLink = link;
    lead.closed = true;
    lead.agreedAmount = agreed;
    lead.paidAmount = paid;
    lead.balanceOwed = Math.max(0, agreed - paid);
    lead.updatedAt = new Date().toISOString();

    await putSheet(env, date, leads);

    return jsonResponse({ link, clientId: record.id, lead });
  }

  // ---------- updateBilling ----------
  // Records additional payment against a lead that's already closed — used
  // by the "Record payment" control in a closed lead's detail view. Keeps
  // the lead's own copy of agreed/paid/balance in sync with the underlying
  // client license record (the one thing the Demo/Permanent Links tabs
  // actually read from), so both places always agree on the balance owed.
  if (action === 'updateBilling') {
    const { date, leadId, agreedAmount, paidAmount } = body;
    if (!date || !leadId) return jsonResponse({ error: 'Missing date or leadId' }, 400);

    const leads = await getSheetRaw(env, date);
    if (!leads) return jsonResponse({ error: 'Sheet not found' }, 404);
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return jsonResponse({ error: 'Lead not found' }, 404);

    const agreed = Math.max(0, Number(agreedAmount) || 0);
    const paid = Math.max(0, Number(paidAmount) || 0);
    lead.agreedAmount = agreed;
    lead.paidAmount = paid;
    lead.balanceOwed = Math.max(0, agreed - paid);
    lead.updatedAt = new Date().toISOString();
    await putSheet(env, date, leads);

    if (lead.clientId) {
      const record = await getLicense(env, lead.clientId);
      if (record) {
        record.agreedAmount = agreed;
        record.paidAmount = paid;
        record.balanceOwed = Math.max(0, agreed - paid);
        await saveLicense(env, record);
      }
    }

    return jsonResponse({ ok: true, lead });
  }

  // ---------- listStaff ----------
  if (action === 'listStaff') {
    const staff = await getStaffList(env);
    return jsonResponse({ staff });
  }

  // ---------- saveStaff ----------
  if (action === 'saveStaff') {
    if (!Array.isArray(body.staff)) return jsonResponse({ error: 'staff must be an array' }, 400);
    const cleaned = body.staff.map((s) => String(s || '').trim()).filter(Boolean);
    await env.mydukapos_kv.put(STAFF_KEY, JSON.stringify(cleaned));
    return jsonResponse({ ok: true, staff: cleaned });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
