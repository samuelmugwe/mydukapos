// functions/api/sms-send.js — Cloudflare Pages Function
//
// Sends SMS through whichever provider the calling shop has saved — its
// OWN account either way (see sms-config.js) — so the shop's own balance
// is billed, never any shared/platform account.
//
// Supported providers:
//
//   Africa's Talking (default / legacy — existing shops keep working
//   with no changes needed):
//     Live:    https://api.africastalking.com/version1/messaging
//     Sandbox: https://api.sandbox.africastalking.com/version1/messaging
//     Header:  apiKey: <key>
//     Body (form-urlencoded): username, to (comma-separated E.164
//                              numbers), message, from (optional Sender
//                              ID/shortcode)
//     A username of exactly 'sandbox' is Africa's Talking's own reserved
//     test account name — that's the signal used here to pick the
//     sandbox endpoint over the live one, since sandbox credentials only
//     work against it.
//
//   Mobitech Technologies (alternative provider):
//     https://textapi.mobitechtechnologies.com/sms/sendmultiple
//     Header: h_api_key: <64-char key>, Content-Type: application/json
//     Body (JSON): { serviceId: 0, shortcode: <sender name>,
//                     messages: [{ mobile, message, client_ref }, ...] }
//     Used (rather than the single-recipient /sms/sendsms endpoint) so
//     one call always covers any number of recipients, matching how
//     Africa's Talking's comma-joined "to" field works above.
//
//   Celcom Africa (verified against celcomafrica.com/developers-center):
//     https://isms.celcomafrica.com/api/services/sendsms/
//     Header: Content-Type: application/json
//     Body (JSON): { apikey, partnerID, message, shortcode, mobile
//                     (comma-separated for multiple recipients),
//                     pass_type: 'plain' }
//     Response: { "responses": [ { "respose-code": 200,
//                  "response-description": "Success", "mobile": ...,
//                  "messageid": ..., "networkid": ... }, ... ] }
//     (Celcom's own JSON key is genuinely spelled "respose-code", no d —
//     that's their API, not a typo introduced here.)
//
//   Advanta SMS (verified against advantasms.com / advanta.africa — this
//   runs the exact same underlying gateway platform as Celcom Africa
//   above, just a different reseller domain and separate credentials —
//   same endpoint shape, same JSON body, same response format):
//     https://quicksms.advantasms.com/api/services/sendsms/
//
//   TalkSasa (base URL and payload shape confirmed from TalkSasa's own
//   published REST v3 client library; the exact endpoint path and header
//   name were not independently reachable from official docs at the time
//   this was written, since docs.talksasa.com blocks automated fetches —
//   implemented on the documented convention (Bearer token, sms/send) and
//   worth a live test send before relying on it):
//     https://bulksms.talksasa.com/api/v3/sms/send
//     Header: Authorization: Bearer <api key>, Content-Type: application/json
//     Body (JSON): { recipient: <string or array>, sender_id, type: 'plain', message }
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

// All providers here expect E.164 (+254...). Accepts the common Kenyan
// local formats (07..., 01..., 7........) and normalizes them, same
// shape as normalizeKenyanPhone() already used client-side for M-Pesa.
function normalizeToE164Kenya(raw) {
  const digits = (raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+254')) return digits;
  if (digits.startsWith('254')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+254${digits.slice(1)}`;
  if (digits.length === 9) return `+254${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

// Shared by both Celcom Africa and Advanta SMS — same gateway platform,
// same request/response shape, same error codes. Only the endpoint URL
// and the credential set differ between the two.
const CELCOM_STYLE_STATUS_MESSAGES = {
  1001: 'Invalid sender ID — check the Shortcode saved in Settings.',
  1002: 'That network is not allowed on this account.',
  1003: 'One of the recipient numbers looks invalid.',
  1004: 'Low bulk SMS credits — top up your account.',
  1005: 'The provider reported a system error — try again shortly.',
  1006: 'Invalid credentials — double-check the API Key and Partner ID saved in Settings.',
  1007: 'The provider reported a system error — try again shortly.',
  1008: 'No delivery report available for this message yet.',
  1009: 'The provider rejected the request format — try again shortly.',
  1010: 'The provider rejected the request type — try again shortly.',
  4090: 'Internal error at the provider — try again in a few minutes.',
  4091: 'No Partner ID is set — check Settings.',
  4092: 'No API Key is set — check Settings.',
  4093: 'Account details not found — double-check Settings.',
};

async function sendViaCelcomStyle(providerLabel, endpoint, config, apiKeyField, partnerIdField, shortcodeField, recipients, message) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: config[apiKeyField],
      partnerID: config[partnerIdField],
      message,
      shortcode: config[shortcodeField],
      mobile: recipients.map((r) => r.replace(/^\+/, '')).join(','),
      pass_type: 'plain',
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: `Couldn\u2019t connect to ${providerLabel}. Double-check your API Key, Partner ID, and Shortcode in Settings.` };
  }

  const responses = Array.isArray(data.responses) ? data.responses : null;
  if (!responses) {
    const code = Number(data['respose-code'] ?? data.code);
    const friendly = CELCOM_STYLE_STATUS_MESSAGES[code];
    return { error: friendly || data['response-description'] || `${providerLabel} rejected the request.`, raw: data };
  }

  const succeeded = responses.filter((r) => Number(r['respose-code']) === 200);
  const failed = responses.filter((r) => Number(r['respose-code']) !== 200);

  return {
    success: succeeded.length > 0,
    sentCount: succeeded.length,
    failedCount: failed.length,
    summary: responses[0] ? responses[0]['response-description'] : undefined,
    recipients: responses.map((r) => ({
      number: r.mobile,
      status: Number(r['respose-code']) === 200 ? 'Success' : (CELCOM_STYLE_STATUS_MESSAGES[Number(r['respose-code'])] || r['response-description'] || 'Failed'),
      messageId: r.messageid,
    })),
  };
}

async function sendViaAfricasTalking(config, recipients, message, from) {
  const isSandbox = (config.atUsername || '').trim().toLowerCase() === 'sandbox';
  const endpoint = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';

  const formBody = new URLSearchParams();
  // Sandbox's account name is always the literal lowercase string
  // "sandbox" as far as Africa's Talking's own auth is concerned — if the
  // shop typed "Sandbox" (capitalized, easy to do since AT's own
  // dashboard often shows it that way), sending that exact casing would
  // still fail even once the endpoint above is picked correctly.
  formBody.set('username', isSandbox ? 'sandbox' : config.atUsername);
  formBody.set('to', recipients.join(','));
  formBody.set('message', message);
  if (from) formBody.set('from', from);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apiKey: config.atApiKey,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // Africa's Talking returns plain-text/HTML rather than JSON for most
    // authentication failures — almost always either the API key doesn't
    // match the username it's paired with, or a live API key was used
    // with the username "sandbox" (or vice versa). Kept plain and
    // actionable for a shop owner — no mention of JSON, raw responses,
    // or anything else developer-facing.
    return {
      error: `Couldn't connect to Africa's Talking. Double-check your Username and API Key in Settings match exactly — if you're testing, the Username must be exactly "sandbox" and paired with a Sandbox API key, not a Live one.`,
    };
  }

  const smsData = data.SMSMessageData;
  if (!smsData || !Array.isArray(smsData.Recipients)) {
    return { error: 'Unexpected response from Africa\u2019s Talking.', raw: data };
  }

  const succeeded = smsData.Recipients.filter((r) => r.status === 'Success' || r.statusCode === 101);
  const failed = smsData.Recipients.filter((r) => !(r.status === 'Success' || r.statusCode === 101));

  return {
    success: succeeded.length > 0,
    sentCount: succeeded.length,
    failedCount: failed.length,
    summary: smsData.Message,
    recipients: smsData.Recipients,
  };
}

// Mobitech's own published status codes, used to turn a batch-level
// failure (e.g. bad API key) into the same kind of plain, actionable
// message Africa's Talking gets above — never developer-facing jargon.
const MOBITECH_STATUS_MESSAGES = {
  1001: 'Invalid short code — check the Sender Name saved in Settings.',
  1002: 'That network is not allowed on this Mobitech account.',
  1003: 'One of the recipient numbers looks invalid.',
  1004: 'Low bulk SMS credits — top up your Mobitech account.',
  1005: 'Mobitech reported an internal system error — try again shortly.',
  1006: 'Invalid credentials — double-check the API Key saved in Settings.',
  1007: 'Mobitech reported a database connection error — try again shortly.',
  1008: 'Mobitech reported a database error — try again shortly.',
  1009: 'Mobitech rejected the request format — try again shortly.',
  1010: 'Mobitech rejected the request type — try again shortly.',
  1011: 'This Mobitech account is suspended or in an invalid state.',
  1012: 'That number is registered as Do-Not-Disturb and can\u2019t receive SMS.',
  1013: 'Invalid API Key — double-check the API Key saved in Settings.',
  1014: 'This server\u2019s IP isn\u2019t allowed on this Mobitech account yet.',
  1015: 'Mobitech says a required field is missing from the request.',
  1016: 'Monthly SMS credit limit reached on this Mobitech account.',
};

async function sendViaMobitech(config, recipients, message) {
  const endpoint = 'https://textapi.mobitechtechnologies.com/sms/sendmultiple';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      h_api_key: config.mobitechApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      serviceId: 0,
      shortcode: config.mobitechSenderName,
      messages: recipients.map((mobile, i) => ({ mobile, message, client_ref: i + 1 })),
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: 'Couldn\u2019t connect to Mobitech. Double-check your API Key and Sender Name in Settings.' };
  }

  // A batch-level failure (bad key, suspended account, etc.) has no
  // schedule_details at all — everything failed together.
  if (String(data.status_code) !== '1000' || !Array.isArray(data.schedule_details)) {
    const friendly = MOBITECH_STATUS_MESSAGES[Number(data.status_code)];
    return {
      error: friendly || data.status_desc || 'Mobitech rejected the request.',
      raw: data,
    };
  }

  const succeeded = data.schedule_details.filter((r) => String(r.schedule_status) === '1');
  const failed = data.schedule_details.filter((r) => String(r.schedule_status) !== '1');

  return {
    success: succeeded.length > 0,
    sentCount: succeeded.length,
    failedCount: failed.length,
    summary: data.status_desc,
    recipients: data.schedule_details.map((r) => ({
      number: r.mobile,
      status: String(r.schedule_status) === '1' ? 'Success' : (r.schedule_desc || 'Failed'),
      cost: r.message_cost,
      messageId: r.message_id,
    })),
  };
}

async function sendViaTalkSasa(config, recipients, message) {
  const endpoint = 'https://bulksms.talksasa.com/api/v3/sms/send';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.talksasaApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      recipient: recipients,
      sender_id: config.talksasaSenderId,
      type: 'plain',
      message,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: 'Couldn\u2019t connect to TalkSasa. Double-check your API Key and Sender ID in Settings.' };
  }

  if (!res.ok || data.status === 'error' || data.success === false) {
    return {
      error: data.message || data.error || 'TalkSasa rejected the request — double-check your API Key and Sender ID in Settings.',
      raw: data,
    };
  }

  // TalkSasa's own success response shape wasn't independently confirmed
  // (see the header note above) — this treats any non-error HTTP 200/201
  // as a full-batch success rather than trying to parse a per-recipient
  // breakdown that may not exist in the form assumed here.
  return {
    success: true,
    sentCount: recipients.length,
    failedCount: 0,
    summary: data.message || 'Sent',
    recipients: recipients.map((number) => ({ number, status: 'Success', messageId: data.uid || data.id || undefined })),
  };
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

  const message = (body.message || '').trim();
  if (!message) return jsonResponse({ error: 'Message text is required.' }, 400);

  const rawRecipients = Array.isArray(body.to) ? body.to : [body.to];
  const recipients = rawRecipients
    .filter((r) => typeof r === 'string' && r.trim())
    .map(normalizeToE164Kenya);
  if (recipients.length === 0) {
    return jsonResponse({ error: 'At least one recipient phone number is required.' }, 400);
  }

  // Applies to EVERY send through this endpoint — transactional (thank-you,
  // bill reminder, hire confirmation) or promotional — once someone's
  // replied STOP, they stop hearing from this shop entirely until they
  // text START again. Centralizing the check here (rather than in each
  // individual caller) means it can never be accidentally skipped.
  // Provider-agnostic: applies the same way regardless of which gateway
  // ends up sending the message below.
  const optOutsRaw = await env.mydukapos_kv.get(`sms-optouts:${clientId}`);
  const optOuts = optOutsRaw ? JSON.parse(optOutsRaw) : [];
  const filteredRecipients = recipients.filter((r) => !optOuts.includes(r));
  const skippedForOptOut = recipients.length - filteredRecipients.length;
  if (filteredRecipients.length === 0) {
    return jsonResponse({ success: false, sentCount: 0, failedCount: 0, skippedForOptOut, error: 'Every recipient has opted out of SMS.' });
  }

  const configRaw = await env.mydukapos_kv.get(`sms-config:${clientId}`);
  const config = configRaw ? JSON.parse(configRaw) : {};

  // Existing shops never saved a `provider` field, so no value here means
  // Africa's Talking — the only provider that ever existed until now.
  const VALID_PROVIDERS = ['africastalking', 'mobitech', 'celcom', 'advanta', 'talksasa'];
  const provider = VALID_PROVIDERS.includes(config.provider) ? config.provider : 'africastalking';

  const PROVIDER_LABELS = {
    africastalking: 'Africa\u2019s Talking',
    mobitech: 'Mobitech',
    celcom: 'Celcom Africa',
    advanta: 'Advanta SMS',
    talksasa: 'TalkSasa',
  };

  try {
    let result;
    if (provider === 'mobitech') {
      if (!config.mobitechApiKey || !config.mobitechSenderName) {
        return jsonResponse({ error: 'No SMS account saved for this shop yet \u2014 add your Mobitech API key and Sender Name in Settings first.' }, 400);
      }
      result = await sendViaMobitech(config, filteredRecipients, message);
    } else if (provider === 'celcom') {
      if (!config.celcomApiKey || !config.celcomPartnerId || !config.celcomShortcode) {
        return jsonResponse({ error: 'No SMS account saved for this shop yet \u2014 add your Celcom Africa API key, Partner ID, and Shortcode in Settings first.' }, 400);
      }
      result = await sendViaCelcomStyle('Celcom Africa', 'https://isms.celcomafrica.com/api/services/sendsms/', config, 'celcomApiKey', 'celcomPartnerId', 'celcomShortcode', filteredRecipients, message);
    } else if (provider === 'advanta') {
      if (!config.advantaApiKey || !config.advantaPartnerId || !config.advantaShortcode) {
        return jsonResponse({ error: 'No SMS account saved for this shop yet \u2014 add your Advanta SMS API key, Partner ID, and Shortcode in Settings first.' }, 400);
      }
      result = await sendViaCelcomStyle('Advanta SMS', 'https://quicksms.advantasms.com/api/services/sendsms/', config, 'advantaApiKey', 'advantaPartnerId', 'advantaShortcode', filteredRecipients, message);
    } else if (provider === 'talksasa') {
      if (!config.talksasaApiKey || !config.talksasaSenderId) {
        return jsonResponse({ error: 'No SMS account saved for this shop yet \u2014 add your TalkSasa API key and Sender ID in Settings first.' }, 400);
      }
      result = await sendViaTalkSasa(config, filteredRecipients, message);
    } else {
      if (!config.atUsername || !config.atApiKey) {
        return jsonResponse({ error: 'No SMS account saved for this shop yet \u2014 add your Africa\u2019s Talking username and API key in Settings first.' }, 400);
      }
      result = await sendViaAfricasTalking(config, filteredRecipients, message, typeof body.from === 'string' ? body.from.trim() : '');
    }

    if (result.error) {
      return jsonResponse({ error: result.error, raw: result.raw }, 502);
    }

    return jsonResponse({ ...result, skippedForOptOut, provider });
  } catch (err) {
    return jsonResponse({ error: err.message || `Unexpected error contacting ${PROVIDER_LABELS[provider] || provider}.` }, 500);
  }
}
