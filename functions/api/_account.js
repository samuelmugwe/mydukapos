// functions/api/_account.js — shared helper, NOT a route.
//
// The single account store behind demo-account.js (website registration,
// login, password reset, demo dashboard) AND pos-account-auth.js (direct
// POS login/signup, business-name linking). Pulled out of demo-account.js
// so there is exactly ONE place that reads/writes an account record and
// hashes a password — the spec's "password set during initial signup
// becomes the single unified password for both web account management and
// POS administration" only holds if both entry points share this file
// instead of each keeping their own copy that could drift apart.
//
// Storage (same mydukapos_kv namespace as _license.js):
//   demo-account:<lowercased email>   -> account record (JSON)
//   demo-account-session:<token>      -> email (session lookup)
//   demo-account-index:v1             -> array of lead summaries, newest first

export const ACCOUNT_PREFIX = 'demo-account:';
export const SESSION_PREFIX = 'demo-account-session:';
export const INDEX_KEY = 'demo-account-index:v1';
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export function randomToken(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function getAccount(env, email) {
  const raw = await env.mydukapos_kv.get(ACCOUNT_PREFIX + normalizeEmail(email));
  return raw ? JSON.parse(raw) : null;
}

export async function readIndex(env) {
  const raw = await env.mydukapos_kv.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

export function summaryFromAccount(account) {
  return {
    fullName: account.fullName,
    phone: account.phone,
    email: account.email,
    product: account.product || '',
    demoClientId: account.demoClientId || null,
    demoStatus: account.demoStatus || 'none', // 'none' | 'active' | 'expired' | 'deleted'
    approvalStatus: account.approvalStatus || 'pending',
    branchName: account.branchName || '',
    createdAt: account.createdAt,
    generatedAt: account.generatedAt || null,
    expiresAt: account.expiresAt || null,
  };
}

export async function upsertIndexSummary(env, account) {
  const list = await readIndex(env);
  const idx = list.findIndex((e) => e.email === account.email);
  const summary = summaryFromAccount(account);
  if (idx === -1) list.unshift(summary);
  else list[idx] = summary;
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(list));
}

export async function saveAccount(env, account) {
  await env.mydukapos_kv.put(ACCOUNT_PREFIX + account.email, JSON.stringify(account));
  await upsertIndexSummary(env, account);
}

// Permanently removes a Web Signups account record and its entry in the
// index — used by demo-account.js's 'owner-delete' action (the Owner
// Console's "🗑️ Delete" button on the Web Signups sub-tab). This does NOT
// touch any license/demo link the account may still have live — callers
// that need that gone too should deleteClient()+removeClientLink() it
// FIRST, same as demo-account.js's own 'delete-demo' action already does,
// before calling this. There's no undo.
export async function deleteAccount(env, email) {
  const normalized = normalizeEmail(email);
  await env.mydukapos_kv.delete(ACCOUNT_PREFIX + normalized);
  const list = await readIndex(env);
  const next = list.filter((e) => e.email !== normalized);
  await env.mydukapos_kv.put(INDEX_KEY, JSON.stringify(next));
}

export async function createSession(env, email) {
  const token = randomToken();
  await env.mydukapos_kv.put(SESSION_PREFIX + token, email, { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

export async function emailFromToken(env, token) {
  if (!token) return '';
  return (await env.mydukapos_kv.get(SESSION_PREFIX + token)) || '';
}

// Verifies a plaintext password against a stored account. Returns the
// account on success, null on any failure (unknown email, wrong password) —
// deliberately not distinguishing the two in the return value so callers
// can give the same generic "incorrect email or password" message rather
// than confirming which emails exist.
export async function verifyPassword(env, email, password) {
  const account = await getAccount(env, email);
  if (!account) return null;
  const hash = await sha256Hex(account.salt + String(password || ''));
  if (hash !== account.passwordHash) return null;
  return account;
}

// Creates a brand-new account with a hashed password. Throws with a short
// message (caller wraps in jsonResponse) on validation failure or if the
// email is already taken — same rules demo-account.js's 'register' action
// already enforced, kept identical here so POS-side signup can't create an
// account that's weaker than a website signup would allow.
export async function createAccount(env, { fullName, phone, email, password, confirmPassword }) {
  fullName = String(fullName || '').trim();
  phone = String(phone || '').trim();
  email = normalizeEmail(email);
  password = String(password || '');
  confirmPassword = String(confirmPassword || '');

  if (!fullName) throw new Error('Enter your full name.');
  if (!phone) throw new Error('Enter your phone number.');
  if (!isValidEmail(email)) throw new Error('Enter a valid email address.');
  if (password.length < 4) throw new Error('Password must be at least 4 characters (a 4-digit PIN works fine).');
  if (password !== confirmPassword) throw new Error('Passwords do not match.');

  const existing = await getAccount(env, email);
  if (existing) throw new Error('An account already exists for that email. Please sign in instead.');

  const salt = randomToken(16);
  const passwordHash = await sha256Hex(salt + password);
  const now = Date.now();
  const account = {
    fullName, phone, email, salt, passwordHash, createdAt: now,
    demoUsed: false, demoClientId: null, demoStatus: 'none',
    approvalStatus: 'pending', branchName: '', product: '',
    generatedAt: null, expiresAt: null,
  };
  await saveAccount(env, account);
  return account;
}
