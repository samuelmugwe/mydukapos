// functions/api/sms-inbound.js — Cloudflare Pages Function
//
// Africa's Talking POSTs here whenever a customer replies to THIS shop's
// own number/shortcode — resolved from the hostname the same way every
// other endpoint in this app resolves which client a request belongs to,
// so each shop's callback URL is simply their own domain:
//   https://{their-slug}.mydukapos.store/api/sms-inbound
// (or the bare root domain + ?c=CLIENT_ID for links without a slug yet).
// That's the exact URL a shop pastes into their own Africa's Talking
// dashboard under SMS -> Callback URLs -> Incoming Messages.
//
// Real payload, verified against a working Africa's Talking integration —
// POSTed as application/x-www-form-urlencoded:
//   from, to, text, id, linkId, date
//
// Africa's Talking retries a non-200 response roughly every minute for up
// to 12 hours, so this always returns 200 even on errors it can't recover
// from — there's nothing useful AT itself can do with a failure response
// here, and retried duplicate STOP/START processing is harmless (adding an
// already-opted-out number again, or removing one that's already gone, are
// both no-ops).

import { requireValidLicense } from './_license.js';

function textResponse(body) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let from = '';
  let text = '';
  try {
    const form = await request.formData();
    from = (form.get('from') || '').trim();
    text = (form.get('text') || '').trim();
  } catch (e) {
    return textResponse('ok');
  }
  if (!from) return textResponse('ok');

  const license = await requireValidLicense(request, env);
  if (!license.valid) return textResponse('ok');
  const clientId = license.clientId;

  const normalized = text.toUpperCase();
  const optOutsKey = `sms-optouts:${clientId}`;
  const existingRaw = await env.mydukapos_kv.get(optOutsKey);
  let optOuts = existingRaw ? JSON.parse(existingRaw) : [];

  if (normalized === 'STOP') {
    if (!optOuts.includes(from)) {
      optOuts.push(from);
      await env.mydukapos_kv.put(optOutsKey, JSON.stringify(optOuts));
    }
  } else if (normalized === 'START') {
    if (optOuts.includes(from)) {
      optOuts = optOuts.filter((p) => p !== from);
      await env.mydukapos_kv.put(optOutsKey, JSON.stringify(optOuts));
    }
  }
  // Any other reply is just received and otherwise ignored — this endpoint
  // only exists to catch STOP/START, not to be a general inbox.

  return textResponse('ok');
}

export async function onRequestGet(context) {
  // Lets Settings show how many numbers are currently opted out, and the
  // list itself, without needing a separate endpoint.
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return new Response(JSON.stringify({ error: 'This link is not active.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const optOutsRaw = await env.mydukapos_kv.get(`sms-optouts:${license.clientId}`);
  const optOuts = optOutsRaw ? JSON.parse(optOutsRaw) : [];
  return new Response(JSON.stringify({ optOuts }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
