// functions/api/_email.js — shared helper, NOT a route.
//
// Thin wrapper around the Resend API (https://api.resend.com/emails) using
// whichever platform-wide key is currently saved via email-config.js. If
// no key has been configured yet, sendEmail() fails soft — it returns
// { ok: false, error: ... } rather than throwing, so callers (like
// demo-account.js's forgot-password flow) can degrade gracefully instead
// of crashing the whole request.

import { getEmailConfig } from './email-config.js';

const DEFAULT_FROM_NAME = 'mydukapos';
// Resend's own shared sandbox sender — works with any Resend account with
// zero setup, but can only send to the account owner's own verified email.
// Once Samuel verifies a real domain in Resend and sets fromEmail in the
// Owner Console, that address is used instead and mail can go to anyone.
const DEFAULT_FROM_EMAIL = 'onboarding@resend.dev';

export async function sendEmail(env, { to, subject, html }) {
  const config = await getEmailConfig(env);
  if (!config.resendApiKey) {
    return { ok: false, error: 'No email service is configured yet. Ask the platform admin to add a Resend API key in the Owner Console.' };
  }

  const fromEmail = config.fromEmail || DEFAULT_FROM_EMAIL;
  const fromName = config.fromName || DEFAULT_FROM_NAME;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [to],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody.message || JSON.stringify(errBody);
      } catch (e) {
        detail = await res.text().catch(() => '');
      }
      return { ok: false, error: `Resend rejected the email (${res.status}): ${detail}` };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach Resend: ${e.message || e}` };
  }
}
