// wildcard-router/worker.js — Cloudflare Worker (separate from the mydukapos
// Pages project — deployed with `wrangler deploy`, not `wrangler pages deploy`)
//
// WHY THIS EXISTS: Cloudflare Pages does not support wildcard custom domains
// (confirmed current as of 2026 — see developers.cloudflare.com/dns/manage-
// dns-records/reference/wildcard-dns-records/). So *.mydukapos.store can't be
// added directly in the Pages project's Custom Domains settings the way a
// single domain can. This Worker is the actual thing bound to the wildcard
// route (*.mydukapos.store/*, configured below and in the Cloudflare
// dashboard) — all it does is forward every request through to the Pages
// deployment.
//
// IMPORTANT: rewriting the hostname to reach the Pages origin means the
// outgoing request's own Host header no longer carries the original
// subdomain (georgehardware.mydukapos.store) — it would say mydukapos.pages.dev
// instead. Without fixing that, every client's requests would look
// identical to the backend and subdomain-based client resolution
// (_license.js's resolveClientId) would silently break for everyone. So this
// Worker sets X-Forwarded-Host to the ORIGINAL hostname before forwarding —
// _license.js reads that header first (falling back to the raw URL hostname
// for direct pages.dev/preview access, which never passes through here).

const PAGES_ORIGIN = 'mydukapos.pages.dev'; // <-- your Pages project's own *.pages.dev domain

// Subdomains that should NOT be routed into the app — add to this if you
// ever want e.g. "www" or "status" to do something else. Everything else
// (any client's slug) falls through to the Pages deployment.
const EXCLUDED_SUBDOMAINS = [];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const label = url.hostname.split('.')[0];

    if (EXCLUDED_SUBDOMAINS.includes(label)) {
      return fetch(request);
    }

    const originalHost = url.hostname;
    url.hostname = PAGES_ORIGIN;

    const proxied = new Request(url.toString(), request);
    proxied.headers.set('X-Forwarded-Host', originalHost);

    // fetch() here tunnels a WebSocket upgrade (e.g. a device connecting to
    // /api/sync-ws) through to the Pages deployment exactly the same way it
    // tunnels any other request — Cloudflare's runtime forwards the
    // Upgrade: websocket handshake end-to-end and hands back a 101 Response
    // carrying the live socket, which just flows straight back out through
    // this `return` to the original client. No special-casing needed here.
    return fetch(proxied);
  },
};

// ---------- SyncRoom Durable Object ----------
//
// WHY THIS LIVES HERE: Cloudflare Pages Functions (the mydukapos Pages
// project's /functions directory) can BIND to a Durable Object class, but
// cannot DEFINE one — the class itself must be exported from an actual
// Worker script that's deployed with `wrangler deploy`. This file is the
// only plain Worker in the whole project, so it's the natural (and only
// currently viable) home for it. The Pages project's own wrangler.toml
// binds to this class cross-script via `script_name = "mydukapos-wildcard-
// router"` — see the durable_objects.bindings block added there, and the
// migration below that actually registers the class with this Worker.
//
// WHAT IT DOES: one instance per client link (keyed by the same clientId
// pos-sync.js already uses for KV), holding every device's live WebSocket
// connection for that one business. pos-sync.js's POST handler calls this
// instance's /broadcast endpoint right after it writes a fresh record to
// KV, and every connected socket gets that record pushed to it immediately
// — see functions/api/sync-ws.js (the WebSocket entry point devices
// connect to) and functions/api/pos-sync.js (the broadcast trigger).
//
// Uses the Hibernatable WebSockets API (ctx.acceptWebSocket / getWebSockets)
// so an idle room with connections open costs nothing while hibernated —
// the instance only wakes to handle an actual message or broadcast.
//
// Deliberately holds NO business data of its own — KV via pos-sync.js
// remains the single source of truth. This object is purely a connection
// registry + broadcaster; if it's ever unreachable, missing, or not yet
// deployed, every device's own 7-second poll (see each app's
// startPolling()/pullState()) is what keeps things eventually correct.
export class SyncRoom {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.text();
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(body);
          delivered += 1;
        } catch (e) {
          // A dead/closing socket that hasn't been cleaned up yet — ignore
          // it, webSocketClose below (or the next connect) tidies it up.
        }
      }
      return new Response(JSON.stringify({ delivered }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Devices never send anything meaningful over this socket today — it's
  // server-to-client push only. Still required by the hibernation API, and
  // left ready for a future heartbeat/ping without needing a protocol
  // change.
  async webSocketMessage() {}

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (e) {}
  }
}
