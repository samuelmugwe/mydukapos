// functions/api/demo-account.js — Cloudflare Pages Function
//
// Replaces the old anonymous, IP-only rate-limited flow in public-demo.js
// with account-gated demo provisioning:
//   - A visitor registers once (name, phone, email, master password).
//   - That account gets exactly ONE demo, ever, across ANY product,
//     lasting 7 days from generation. Expiring naturally or deleting the
//     demo early both permanently consume the allowance — only the
//     platform Super Admin (Owner Console) can reset it.
//   - The account's own User Dashboard (public-site/dashboard.html) shows
//     status and lets them re-open or delete their demo link.
//   - The Owner Console can list every registered demo account as a lead
//     (owner-list) and manually reset one back to unused (owner-reset).
//
// This does NOT replace or remove public-demo.js — that endpoint still
// exists for any legacy/anonymous entry point. New product-page demo
// panels should call THIS endpoint instead.
//
// Storage (all in the same mydukapos_kv namespace as _license.js):
//   demo-account:<lowercased email>   -> account record (JSON)
//   demo-account-session:<token>      -> email (session lookup)
//   demo-account-index:v1             -> array of lead summaries, newest first
//   demo-account-reg-rate:<ip>        -> registration rate-limit counter

import { createClient, clientLink, listProducts, evaluateLicense, getLicense, deleteClient, getDemoDurationMs } from './_license.js';
import { requireOwnerAuth } from './_owner-auth.js';
import { sendEmail } from './_email.js';
import { removeClientLink } from './account-recovery.js';
import { seedInitialState } from './pos-sync.js';
import {
  normalizeEmail, isValidEmail, sha256Hex, randomToken,
  getAccount, saveAccount, createSession, emailFromToken, readIndex,
  createAccount, verifyPassword, deleteAccount,
} from './_account.js';

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

// Account storage constants (ACCOUNT_PREFIX, SESSION_PREFIX, INDEX_KEY) now
// live in _account.js, shared with pos-account-auth.js — see that file for
// why this moved: one account store, not two, so the website and direct-POS
// login/signup flows can never end up with a different password for the
// same email.
const REG_RATE_PREFIX = 'demo-account-reg-rate:';
const RESET_PREFIX = 'demo-account-reset:'; // reset token -> email
const RESET_RATE_PREFIX = 'demo-account-reset-rate:'; // per-email rate limit on requesting a link
// Demo duration used to be its own fixed 7-day constant here, independent
// of _license.js's old fixed 72h. Both now read the SAME owner-configurable
// setting (see getDemoDurationMs in _license.js) — one number, set once in
// Owner Console → 🌐 Public Website, governs every demo issued anywhere in
// the system, including the ones this file provisions for a registered
// account. This also fixes a real pre-existing inconsistency: the public
// site's marketing copy always said "72-hour demo" while this endpoint was
// silently handing out 7 days — now both are the same live value.
const RESET_TOKEN_TTL_SECONDS = 60 * 60; // reset links expire in 1 hour
const RESET_RATE_MAX = 3;
const RESET_RATE_WINDOW_SECONDS = 60 * 60;
const REG_RATE_MAX = 50;
const REG_RATE_WINDOW_SECONDS = 24 * 60 * 60;

// Comma-separated IPs exempt from the registration rate limit — set
// RATE_LIMIT_BYPASS_IPS in the Pages project's environment variables (e.g.
// your own office/dev IP) so repeated testing never trips the same cap a
// real visitor is subject to.
function isBypassIp(env, ip) {
  const list = String(env.RATE_LIMIT_BYPASS_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(ip);
}

function escapeHtmlBasic(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Recomputes demoStatus/expiresAt against the live license record (server
// clock only, same rule as everywhere else in this app — see _license.js).
// Deleted demos stay 'deleted' regardless of what a stale license lookup
// would say, since deleteClient() already removed that record.
async function liveDemoState(env, account) {
  if (account.demoStatus === 'deleted' || !account.demoClientId) {
    return { demoStatus: account.demoStatus || 'none', expiresAt: account.expiresAt || null };
  }
  const record = await getLicense(env, account.demoClientId);
  const evald = evaluateLicense(record);
  return {
    demoStatus: evald.valid ? 'active' : 'expired',
    expiresAt: record ? record.expiresAt : account.expiresAt || null,
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const action = body.action;

  /* ---------------- owner-console actions (Super Admin) ---------------- */

  if (action === 'owner-list') {
    if (!(await requireOwnerAuth(context))) return jsonResponse({ error: 'Not authorized.' }, 401);
    const list = await readIndex(env);
    return jsonResponse({ leads: list });
  }

  if (action === 'owner-reset') {
    if (!(await requireOwnerAuth(context))) return jsonResponse({ error: 'Not authorized.' }, 401);
    const email = normalizeEmail(body.email);
    const account = await getAccount(env, email);
    if (!account) return jsonResponse({ error: 'No account with that email.' }, 404);
    // Manual reset by the Super Admin — the one documented way around the
    // one-demo-lifetime rule. Does not touch an existing still-active demo
    // license; it only clears the account's "used" flag so they can
    // generate a fresh one. If a prior demo is still live, leave it alone
    // (owner can separately lock/delete it from the Licenses tab).
    account.demoUsed = false;
    account.demoStatus = 'none';
    account.demoClientId = null;
    account.product = '';
    account.branchName = body.branchName != null ? String(body.branchName).trim() : account.branchName;
    await saveAccount(env, account);
    return jsonResponse({ ok: true });
  }

  if (action === 'owner-delete') {
    // Permanently removes a Web Signups row (the Owner Console's "🗑️
    // Delete" button) — distinct from 'owner-reset', which just clears the
    // one-demo-lifetime flag and leaves the account itself intact. This
    // removes the account entirely. If it still has a live demo link, that
    // gets deleted first (same cleanup 'delete-demo' below does — license
    // record, slug, index entry, AND the linked-email unbind) so nothing is
    // left dangling; then the account record and its Web Signups index
    // entry are gone for good. No undo.
    if (!(await requireOwnerAuth(context))) return jsonResponse({ error: 'Not authorized.' }, 401);
    const email = normalizeEmail(body.email);
    const account = await getAccount(env, email);
    if (!account) return jsonResponse({ error: 'No account with that email.' }, 404);
    if (account.demoClientId) {
      await deleteClient(env, account.demoClientId);
      await removeClientLink(env, account.demoClientId);
    }
    await deleteAccount(env, email);
    return jsonResponse({ ok: true });
  }

  /* ---------------------- visitor / account-holder actions --------------------- */

  if (action === 'register') {
    const email = normalizeEmail(body.email);
    const phone = String(body.phone || '').trim();

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const bypass = isBypassIp(env, ip);
    const rateKey = REG_RATE_PREFIX + ip;
    const rawCount = bypass ? 0 : await env.mydukapos_kv.get(rateKey);
    const count = rawCount ? parseInt(rawCount, 10) : 0;
    if (!bypass && count >= REG_RATE_MAX) {
      return jsonResponse({ error: 'Too many accounts created from this connection today — please try again tomorrow.' }, 429);
    }

    let account;
    try {
      account = await createAccount(env, body);
    } catch (e) {
      return jsonResponse({ error: e.message || 'Could not create account.' }, e.message && e.message.includes('already exists') ? 409 : 400);
    }
    if (!bypass) {
      await env.mydukapos_kv.put(rateKey, String(count + 1), { expirationTtl: REG_RATE_WINDOW_SECONDS });
    }

    const token = await createSession(env, email);

    // If the visitor registered from a specific product's page (the common
    // case — see public-site/app.html), provision that one demo right away
    // in the same request so the UX matches the old single-button flow.
    let link = null;
    let expiresAt = null;
    const product = body.product;
    const businessName = String(body.businessName || '').trim();
    if (product && businessName) {
      const validProducts = listProducts().map((p) => p.id);
      if (!validProducts.includes(product)) {
        return jsonResponse({ error: 'Unknown product.' }, 400);
      }
      const record = await createClient(env, 'demo', businessName, product, {
        durationMs: await getDemoDurationMs(env),
        phone,
        clientName: account.fullName,
        email,
        source: 'website',
      });
      account.demoUsed = true;
      account.demoClientId = record.id;
      account.demoStatus = 'active';
      account.product = product;
      account.branchName = businessName;
      account.generatedAt = Date.now();
      account.expiresAt = record.expiresAt;
      await saveAccount(env, account);
      // Seed this brand-new link with a real password right away — the
      // SAME password just typed into this registration form (hashed the
      // same unsalted way the POS apps hash their own local password — see
      // water/index.html's hashPassword()) — so opening the link on ANY
      // device, even one that's never touched this account before, can go
      // straight to "who's logging in?" and unlock with just that
      // password. No email lookup involved, so this never breaks for
      // someone who later unlinks their email in Settings.
      const posPwHash = await sha256Hex(body.password || '');
      await seedInitialState(env, record.id, { businessName, pwHash: posPwHash, adminPwHash: posPwHash });
      const origin = new URL(request.url).origin;
      link = clientLink(env, record, origin);
      expiresAt = record.expiresAt;
    }

    return jsonResponse({ token, link, expiresAt, product: account.product || null });
  }

  if (action === 'login') {
    const email = normalizeEmail(body.email);
    const account = await verifyPassword(env, email, body.password);
    if (!account) return jsonResponse({ error: 'Incorrect email or password.' }, 401);
    const token = await createSession(env, email);
    return jsonResponse({ token });
  }

  if (action === 'forgot-password') {
    const email = normalizeEmail(body.email);
    // Always return the same generic success message regardless of whether
    // the account exists, so this endpoint can't be used to check which
    // emails are registered. The rate limit below is keyed by the
    // submitted email itself (not IP) — cheap since KV writes are cheap,
    // and it stops someone hammering one specific address with reset mail.
    const genericResponse = { ok: true, message: "If that email has an account, we've sent a password reset link to it." };
    if (!isValidEmail(email)) return jsonResponse(genericResponse);

    const rateKey = RESET_RATE_PREFIX + email;
    const rawCount = await env.mydukapos_kv.get(rateKey);
    const count = rawCount ? parseInt(rawCount, 10) : 0;
    if (count >= RESET_RATE_MAX) return jsonResponse(genericResponse);

    const account = await getAccount(env, email);
    if (account) {
      const token = randomToken();
      await env.mydukapos_kv.put(RESET_PREFIX + token, email, { expirationTtl: RESET_TOKEN_TTL_SECONDS });
      const origin = new URL(request.url).origin;
      const resetLink = `${origin}/dashboard.html?reset=${token}`;
      await sendEmail(env, {
        to: email,
        subject: 'Reset your mydukapos password',
        html: `
          <p>Hi ${escapeHtmlBasic(account.fullName || '')},</p>
          <p>Someone requested a password reset for your mydukapos account. Click the link below to set a new password — it expires in 1 hour.</p>
          <p><a href="${resetLink}">${resetLink}</a></p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
      });
      // Deliberately not checking sendEmail's result here — a misconfigured
      // or missing Resend key must not leak "this account exists" through a
      // different error path than an unknown email would take.
    }
    await env.mydukapos_kv.put(rateKey, String(count + 1), { expirationTtl: RESET_RATE_WINDOW_SECONDS });
    return jsonResponse(genericResponse);
  }

  if (action === 'reset-password') {
    const token = String(body.token || '');
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    if (!token) return jsonResponse({ error: 'Missing reset token.' }, 400);
    if (password.length < 6) return jsonResponse({ error: 'Password must be at least 6 characters.' }, 400);
    if (password !== confirmPassword) return jsonResponse({ error: 'Passwords do not match.' }, 400);

    const email = await env.mydukapos_kv.get(RESET_PREFIX + token);
    if (!email) return jsonResponse({ error: 'This reset link has expired or already been used. Please request a new one.' }, 400);

    const account = await getAccount(env, email);
    if (!account) return jsonResponse({ error: 'Account not found.' }, 404);

    const salt = randomToken(16);
    account.passwordHash = await sha256Hex(salt + password);
    account.salt = salt;
    await saveAccount(env, account);
    await env.mydukapos_kv.delete(RESET_PREFIX + token);

    const sessionToken = await createSession(env, email);
    return jsonResponse({ ok: true, token: sessionToken });
  }

  if (action === 'dashboard') {
    const email = await emailFromToken(env, body.token);
    if (!email) return jsonResponse({ error: 'Session expired — please sign in again.' }, 401);
    const account = await getAccount(env, email);
    if (!account) return jsonResponse({ error: 'Account not found.' }, 404);
    const live = await liveDemoState(env, account);
    let link = null;
    if (account.demoClientId && live.demoStatus === 'active') {
      const record = await getLicense(env, account.demoClientId);
      const origin = new URL(request.url).origin;
      link = record ? clientLink(env, record, origin) : null;
    }
    return jsonResponse({
      fullName: account.fullName,
      phone: account.phone,
      email: account.email,
      product: account.product || null,
      demoUsed: !!account.demoUsed,
      demoStatus: live.demoStatus,
      expiresAt: live.expiresAt,
      link,
    });
  }

  if (action === 'generate-demo') {
    const email = await emailFromToken(env, body.token);
    if (!email) return jsonResponse({ error: 'Session expired — please sign in again.' }, 401);
    const account = await getAccount(env, email);
    if (!account) return jsonResponse({ error: 'Account not found.' }, 404);
    if (account.demoUsed) {
      return jsonResponse({ error: 'Your one free demo has already been used. Contact us if you need it reset.' }, 403);
    }
    const product = body.product;
    const businessName = String(body.businessName || '').trim();
    const validProducts = listProducts().map((p) => p.id);
    if (!validProducts.includes(product)) return jsonResponse({ error: 'Unknown product.' }, 400);
    if (!businessName) return jsonResponse({ error: 'Enter your business name.' }, 400);

    const record = await createClient(env, 'demo', businessName, product, {
      durationMs: await getDemoDurationMs(env),
      phone: account.phone,
      clientName: account.fullName,
      email: account.email,
    });
    account.demoUsed = true;
    account.demoClientId = record.id;
    account.demoStatus = 'active';
    account.product = product;
    account.branchName = businessName;
    account.generatedAt = Date.now();
    account.expiresAt = record.expiresAt;
    await saveAccount(env, account);
    // NOTE: unlike the combined register+demo path above, this action is
    // reached from an already-open dashboard session — there's no
    // plaintext password in this request to seed the link's pos-sync
    // record with (see seedInitialState() there for why that matters).
    // Until this account's password is re-verified somewhere in this
    // flow, a link generated here still needs its own device-side Sign Up
    // the first time it's opened, same as a link with no account behind
    // it at all.

    const origin = new URL(request.url).origin;
    return jsonResponse({ link: clientLink(env, record, origin), expiresAt: record.expiresAt });
  }

  if (action === 'delete-demo') {
    const email = await emailFromToken(env, body.token);
    if (!email) return jsonResponse({ error: 'Session expired — please sign in again.' }, 401);
    const account = await getAccount(env, email);
    if (!account) return jsonResponse({ error: 'Account not found.' }, 404);
    if (account.demoClientId) {
      await deleteClient(env, account.demoClientId);
      // Frees up any email that demo link itself was signed up/logged in
      // with (see account-recovery.js) — separate from this account's own
      // central login, which stays untouched. Without this, that email
      // would stay stuck "already linked" to a demo clientId that no
      // longer exists.
      await removeClientLink(env, account.demoClientId);
    }
    // Deleting early still permanently consumes the lifetime allowance —
    // demoUsed stays true. Only owner-reset clears it.
    account.demoStatus = 'deleted';
    await saveAccount(env, account);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
