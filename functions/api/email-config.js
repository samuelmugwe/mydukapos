// functions/api/email-config.js — Cloudflare Pages Function
//
// Holds the ONE platform-wide Resend account used to send transactional
// email — right now just "forgot password" reset links for registered
// demo accounts (see demo-account.js's forgot-password/reset-password
// actions). This is Samuel's own Resend account, configured once from the
// Owner Console (Settings → Email), not something each shop/client
// configures — unlike sms-config.js, where every CLIENT brings their own
// SMS account. There's exactly one of these per deployment, same spirit
// as the single owner account in _owner-auth.js.
//
// The API key is write-only from the client's point of view: 'get' never
// returns it, only whether one is configured and the from-address label,
// same pattern _owner-auth.js uses for the account password.
//
// Actions (all POST, JSON body):
//   { action: 'get' }
//     Owner-auth required — returns { configured, fromEmail, fromName }.
//   { action: 'set', resendApiKey, fromEmail, fromName }
//     Owner-auth required — replaces the stored config wholesale.
//     Pass resendApiKey: '' (empty string) to intentionally clear a
//     previously saved key without setting a new one.
//   { action: 'test', to }
//     Owner-auth required — sends a one-off test email to `to` using the
//     currently saved config, so the Owner Console can confirm the key
//     actually works before relying on it for real reset emails.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireOwnerAuth } from './_owner-auth.js';
import { sendEmail } from './_email.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await requireOwnerAuth(context))) {
    return jsonResponse({ error: 'Not authorized.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'get') {
    const config = await getEmailConfig(env);
    return jsonResponse({
      configured: !!config.resendApiKey,
      fromEmail: config.fromEmail || '',
      fromName: config.fromName || '',
    });
  }

  if (body.action === 'set') {
    const existing = await getEmailConfig(env);
    const fromEmail = String(body.fromEmail || '').trim();
    const fromName = String(body.fromName || '').trim();
    if (fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      return jsonResponse({ error: 'Enter a valid "from" email address.' }, 400);
    }
    // '' explicitly clears the key; undefined/omitted leaves it unchanged
    // (so the Owner Console can update just the from-name without having
    // to re-paste the secret key every time).
    const resendApiKey = body.resendApiKey === undefined ? existing.resendApiKey : String(body.resendApiKey || '').trim();
    const config = { resendApiKey, fromEmail, fromName };
    await env.mydukapos_kv.put('email-config:v1', JSON.stringify(config));
    return jsonResponse({ ok: true, configured: !!config.resendApiKey });
  }

  if (body.action === 'test') {
    const to = String(body.to || '').trim();
    if (!to) return jsonResponse({ error: 'Enter an email address to send the test to.' }, 400);
    const result = await sendEmail(env, {
      to,
      subject: 'mydukapos — test email',
      html: '<p>This is a test email from your mydukapos Owner Console. If you got this, your Resend setup is working.</p>',
    });
    if (!result.ok) return jsonResponse({ error: result.error || 'Could not send the test email.' }, 502);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}

export async function getEmailConfig(env) {
  const raw = await env.mydukapos_kv.get('email-config:v1');
  return raw ? JSON.parse(raw) : { resendApiKey: '', fromEmail: '', fromName: '' };
}
