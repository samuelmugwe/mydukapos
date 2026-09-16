// functions/api/owner-auth.js — Cloudflare Pages Function
//
// Backs the Owner sign-up / sign-in screen that appears at the root ("/")
// of this deployment when nobody is signed in yet — this is what replaced
// master.html and its single MASTER_ADMIN_PASSWORD. See _owner-auth.js for
// the account/session model.
//
// GET  -> { hasAccount, authenticated, ownerClientId? }
//         hasAccount tells index.html whether to show the sign-up form
//         (first run) or the sign-in form (every time after). If an
//         Authorization: Bearer <token> header is sent and it's a valid
//         session, authenticated is true and ownerClientId is included so
//         the page can confirm/refresh its redirect target.
//
// POST -> body: { action: "signup" | "login" | "logout", identifier?, password? }
//   signup — only works once, ever, for this whole deployment. Creates the
//            one owner account plus a permanent client license for the
//            owner's own device. Returns { token, ownerClientId }.
//   login  — checks identifier + password against the one stored account.
//            Returns { token, ownerClientId }.
//   logout — invalidates the session token sent in the Authorization header.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import {
  getOwnerAccount,
  createOwnerAccount,
  verifyOwnerLogin,
  createOwnerSession,
  destroyOwnerSession,
  requireOwnerAuth,
  tokenFromRequest,
} from './_owner-auth.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const account = await getOwnerAccount(env);
  const authenticated = await requireOwnerAuth(context);

  return jsonResponse({
    hasAccount: !!account,
    authenticated,
    ownerClientId: authenticated && account ? account.ownerClientId : undefined,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const action = body.action;

  if (action === 'signup') {
    const identifier = String(body.identifier || '').trim();
    const password = String(body.password || '');
    if (!identifier) {
      return jsonResponse({ error: 'Please enter an email or phone number.' }, 400);
    }
    if (password.length < 6) {
      return jsonResponse({ error: 'Password must be at least 6 characters.' }, 400);
    }
    const existing = await getOwnerAccount(env);
    if (existing) {
      return jsonResponse({ error: 'An owner account already exists. Please sign in instead.' }, 409);
    }
    try {
      const account = await createOwnerAccount(env, identifier, password);
      const token = await createOwnerSession(env);
      return jsonResponse({ token, ownerClientId: account.ownerClientId });
    } catch (e) {
      return jsonResponse({ error: e.message || 'Could not create the owner account.' }, 500);
    }
  }

  if (action === 'login') {
    const identifier = String(body.identifier || '').trim();
    const password = String(body.password || '');
    const account = await verifyOwnerLogin(env, identifier, password);
    if (!account) {
      return jsonResponse({ error: 'Incorrect email/phone or password.' }, 401);
    }
    const token = await createOwnerSession(env);
    return jsonResponse({ token, ownerClientId: account.ownerClientId });
  }

  if (action === 'logout') {
    const token = tokenFromRequest(request);
    await destroyOwnerSession(env, token);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Unknown action.' }, 400);
}
