# Live cross-device sync — setup

Every app already polls the server every 7 seconds and applies whatever's
newer, so cross-device sync works even with zero setup below. This adds a
second, instant layer on top: a WebSocket push that lands changes in well
under a second, backed by a Cloudflare Durable Object (needs Workers Paid).

If you skip these steps, nothing breaks — every device just quietly falls
back to the 7-second poll it was already using.

## One-time setup

1. **Deploy the wildcard-router Worker first** (it now defines the
   `SyncRoom` Durable Object class, and its migration has to run before
   anything can bind to it):

   ```
   cd wildcard-router
   wrangler deploy
   ```

2. **Redeploy the main Pages project** (`mydukapos`) as you normally would.
   Its `wrangler.toml` now has a `durable_objects.bindings` block pointing
   at `mydukapos-wildcard-router` — if you deploy via the Cloudflare
   dashboard's Git integration instead of the CLI, add the same binding
   manually under **Pages project → Settings → Functions → Durable Object
   bindings**: variable name `SYNC_ROOM`, class `SyncRoom`, script
   `mydukapos-wildcard-router`.

3. That's it. Open the same client link on two devices — an item added,
   restocked, or a sale rung up on one should now appear on the other
   within about a second, not 7.

## Why two layers

- **Poll (7s, always on):** the safety net. Works everywhere, needs no
  extra setup, and is what quietly keeps everything correct if the socket
  is ever down.
- **WebSocket push (needs the setup above):** the speed. One Durable
  Object instance per client link holds that link's live connections and
  broadcasts the moment any device saves.

## Where the pieces live

- `wildcard-router/worker.js` — the `SyncRoom` Durable Object class
- `wildcard-router/wrangler.toml` — its migration (registers the class)
- `wrangler.toml` (root) — the Pages project's cross-script binding to it
- `functions/api/sync-ws.js` — WebSocket entry point each app connects to
- `functions/api/pos-sync.js` — broadcasts to the room right after every
  successful save
- Each app's `index.html` — `connectSyncSocket()` / `scheduleSyncSocketReconnect()`,
  called from `startPolling()`
