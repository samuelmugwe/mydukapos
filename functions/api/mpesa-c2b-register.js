// functions/api/mpesa-c2b-register.js — Cloudflare Pages Function
//
// Runs Safaricom's C2B RegisterURL call, telling them where to send
// Validation/Confirmation notifications for this shop's Paybill/Till from
// now on. A ONE-TIME step (re-run it if the shop's Shortcode ever changes),
// triggered from "Register Till URLs" in Settings -> Payment Gateway.
// Requires Daraja credentials (Option B) to already be saved for this shop.
//
// After this succeeds, any customer paying directly to the till — no STK
// Push, no app involvement — gets captured automatically by
// mpesa-c2b-confirmation.js.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadGatewayConfig, hasDarajaConfig } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function darajaBaseUrl(cfg) {
  const envName = (cfg.mpesaEnv || 'sandbox').toLowerCase();
  return envName === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

async function darajaAccessToken(cfg) {
  const auth = btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`);
  const res = await fetch(`${darajaBaseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error('Could not authenticate with M-Pesa. Check the Consumer Key / Consumer Secret saved in Settings.');
  }
  const data = await res.json();
  return data.access_token;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  }
  const clientId = license.clientId;

  const cfg = await loadGatewayConfig(env, clientId);
  if (!hasDarajaConfig(cfg)) {
    return jsonResponse({ error: 'Save your Daraja credentials (Option B) in Settings -> Payment Gateway first \u2014 registering till URLs needs them.' }, 400);
  }

  const origin = new URL(request.url).origin;
  const confirmationUrl = `${origin}/api/mpesa-c2b-confirmation?c=${encodeURIComponent(clientId)}`;
  const validationUrl = `${origin}/api/mpesa-c2b-validation?c=${encodeURIComponent(clientId)}`;

  try {
    const token = await darajaAccessToken(cfg);
    const res = await fetch(`${darajaBaseUrl(cfg)}/mpesa/c2b/v1/registerurl`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ShortCode: cfg.mpesaShortcode,
        ResponseType: 'Completed',
        ConfirmationURL: confirmationUrl,
        ValidationURL: validationUrl,
      }),
    });
    const data = await res.json();
    if (!res.ok || (data.ResponseCode !== undefined && String(data.ResponseCode) !== '0')) {
      throw new Error(data.errorMessage || data.ResponseDescription || 'Safaricom declined the URL registration request.');
    }
    return jsonResponse({ success: true, confirmationUrl, validationUrl, message: data.ResponseDescription || 'Registered.' });
  } catch (err) {
    return jsonResponse({ error: err.message || 'Unexpected error contacting Safaricom.' }, 500);
  }
}
