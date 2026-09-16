// functions/api/_owner-auth.js — shared helper, NOT a route.
//
// Replaces the old master.html admin dashboard + MASTER_ADMIN_PASSWORD.
// There is exactly ONE owner account for this whole deployment. It's
// created the first time anyone completes the sign-up form (see
// owner-auth.js) — after that, sign-up is permanently disabled and only
// sign-in works, using that same email/phone + password for as long as the
// account exists ("sign in once, for life" — see README-MASTER.md).
//
// The password is never stored in plain text — only a salted SHA-256 hash.
//
// On sign-up, a normal PERMANENT client license record is also created
// (see _license.js) for the owner's own device/browser, product "shop".
// This is the trick that makes the rest of the app "just work" for the
// owner without touching every other function: index.html redirects the
// owner's tab to /?c=<that id> after login, so from then on it's treated
// exactly like any licensed shop (inventory, M-Pesa, cloud sync, etc. all
// keep working via the existing ?c= mechanism). The owner's EXTRA admin
// powers — generating/managing links for other shops — are gated
// separately, by the session token below, never by that license token.

import { createClient } from './_license.js';

const OWNER_KEY = 'owner-account:v1';
const SESSION_PREFIX = 'owner-session:';
// Sessions effectively never expire on their own — logging out (or clearing
// the browser) is the only way to end one, matching "sign in for life".
const SESSION_TTL_SECONDS = 20 * 365 * 24 * 60 * 60; // ~20 years

function randomToken(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getOwnerAccount(env) {
  const raw = await env.mydukapos_kv.get(OWNER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function createOwnerAccount(env, identifier, password) {
  const existing = await getOwnerAccount(env);
  if (existing) {
    throw new Error('An owner account already exists for this deployment. Please sign in instead.');
  }

  const salt = randomToken(16);
  const passwordHash = await sha256Hex(salt + password);
  const ownerClient = await createClient(env, 'permanent', 'Owner Console (you)', 'shop');

  const account = {
    identifier: identifier.trim(),
    salt,
    passwordHash,
    ownerClientId: ownerClient.id,
    createdAt: Date.now(),
  };
  await env.mydukapos_kv.put(OWNER_KEY, JSON.stringify(account));
  return account;
}

export async function verifyOwnerLogin(env, identifier, password) {
  const account = await getOwnerAccount(env);
  if (!account) return null;
  if (account.identifier.trim().toLowerCase() !== String(identifier || '').trim().toLowerCase()) return null;
  const hash = await sha256Hex(account.salt + password);
  if (hash !== account.passwordHash) return null;
  return account;
}

export async function createOwnerSession(env) {
  const token = randomToken();
  await env.mydukapos_kv.put(SESSION_PREFIX + token, '1', { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

export async function destroyOwnerSession(env, token) {
  if (token) await env.mydukapos_kv.delete(SESSION_PREFIX + token);
}

function tokenFromRequest(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function requireOwnerAuth(context) {
  const { request, env } = context;
  const token = tokenFromRequest(request);
  if (!token) return false;
  const raw = await env.mydukapos_kv.get(SESSION_PREFIX + token);
  return !!raw;
}

export { tokenFromRequest };
