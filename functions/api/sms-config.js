// functions/api/sms-config.js — Cloudflare Pages Function
//
// Saves/reports each shop's OWN SMS gateway account. Every client picks
// ONE provider, pays for, and sends their own bulk SMS through their own
// account there — same pattern as the payment gateway keys and the
// Pixabay key: nothing is ever shared or baked into this codebase.
//
// Supported providers (see sms-send.js for the actual send logic):
//   'africastalking' — username + API key
//   'mobitech'        — API key + Sender Name
//   'celcom'          — API key + Partner ID + Shortcode (Celcom Africa)
//   'advanta'         — API key + Partner ID + Shortcode (Advanta SMS —
//                        same underlying gateway platform as Celcom, just
//                        a different reseller/domain)
//   'talksasa'        — API key + Sender ID (TalkSasa REST v3)
//
// Existing shops saved before `provider` existed have no value here,
// which is treated as 'africastalking' everywhere it's read (see
// sms-send.js) — the only provider that ever existed until now, so
// nobody needs to re-save.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';

const VALID_PROVIDERS = ['africastalking', 'mobitech', 'celcom', 'advanta', 'talksasa'];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const configRaw = await env.mydukapos_kv.get(`sms-config:${clientId}`);
  const config = configRaw ? JSON.parse(configRaw) : {};

  const provider = VALID_PROVIDERS.includes(config.provider) ? config.provider : 'africastalking';

  const configuredByProvider = {
    africastalking: !!(config.atUsername && config.atApiKey),
    mobitech: !!(config.mobitechApiKey && config.mobitechSenderName),
    celcom: !!(config.celcomApiKey && config.celcomPartnerId && config.celcomShortcode),
    advanta: !!(config.advantaApiKey && config.advantaPartnerId && config.advantaShortcode),
    talksasa: !!(config.talksasaApiKey && config.talksasaSenderId),
  };
  const configured = configuredByProvider[provider];

  // The account label shown in Settings so the shop can confirm which
  // account is active without ever seeing the secret key itself back.
  const usernameByProvider = {
    africastalking: config.atUsername || null,
    mobitech: config.mobitechSenderName || null,
    celcom: config.celcomShortcode || null,
    advanta: config.advantaShortcode || null,
    talksasa: config.talksasaSenderId || null,
  };

  return jsonResponse({
    configured,
    provider,
    username: usernameByProvider[provider],
    senderName: config.mobitechSenderName || null,
    autoThankYouEnabled: !!config.autoThankYouEnabled,
    thankYouTemplate: config.thankYouTemplate || null,
    hireConfirmationTemplate: config.hireConfirmationTemplate || null,
    clientId,
  });
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
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const configRaw = await env.mydukapos_kv.get(`sms-config:${clientId}`);
  const existing = configRaw ? JSON.parse(configRaw) : {};

  // A blank field for the active provider clears its credentials (the
  // "reset"/"turn off" path) without needing a separate DELETE handler —
  // same convention as the Pixabay config endpoint.
  const provider = VALID_PROVIDERS.includes(body.provider) ? body.provider : (existing.provider || 'africastalking');
  const str = (v, fallback) => (typeof v === 'string' ? v.trim() : fallback);

  const atUsername = str(body.atUsername, existing.atUsername);
  const atApiKey = str(body.atApiKey, existing.atApiKey);
  const mobitechApiKey = str(body.mobitechApiKey, existing.mobitechApiKey);
  const mobitechSenderName = str(body.mobitechSenderName, existing.mobitechSenderName);
  const celcomApiKey = str(body.celcomApiKey, existing.celcomApiKey);
  const celcomPartnerId = str(body.celcomPartnerId, existing.celcomPartnerId);
  const celcomShortcode = str(body.celcomShortcode, existing.celcomShortcode);
  const advantaApiKey = str(body.advantaApiKey, existing.advantaApiKey);
  const advantaPartnerId = str(body.advantaPartnerId, existing.advantaPartnerId);
  const advantaShortcode = str(body.advantaShortcode, existing.advantaShortcode);
  const talksasaApiKey = str(body.talksasaApiKey, existing.talksasaApiKey);
  const talksasaSenderId = str(body.talksasaSenderId, existing.talksasaSenderId);
  const autoThankYouEnabled = typeof body.autoThankYouEnabled === 'boolean' ? body.autoThankYouEnabled : !!existing.autoThankYouEnabled;
  const thankYouTemplate = str(body.thankYouTemplate, existing.thankYouTemplate);
  const hireConfirmationTemplate = str(body.hireConfirmationTemplate, existing.hireConfirmationTemplate);

  const updated = {
    provider,
    atUsername: atUsername || '',
    atApiKey: atApiKey || '',
    mobitechApiKey: mobitechApiKey || '',
    mobitechSenderName: mobitechSenderName || '',
    celcomApiKey: celcomApiKey || '',
    celcomPartnerId: celcomPartnerId || '',
    celcomShortcode: celcomShortcode || '',
    advantaApiKey: advantaApiKey || '',
    advantaPartnerId: advantaPartnerId || '',
    advantaShortcode: advantaShortcode || '',
    talksasaApiKey: talksasaApiKey || '',
    talksasaSenderId: talksasaSenderId || '',
    autoThankYouEnabled,
    thankYouTemplate: thankYouTemplate || '',
    hireConfirmationTemplate: hireConfirmationTemplate || '',
  };
  await env.mydukapos_kv.put(`sms-config:${clientId}`, JSON.stringify(updated));

  return jsonResponse({ success: true });
}
