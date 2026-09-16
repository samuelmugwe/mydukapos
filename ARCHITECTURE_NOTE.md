# Multi-Printer Network & Routing — Architecture Note

**Ported to root (MinimartPOS), hotel, hospital, school, production, services,
and pharmacy.** `water/index.html` (Aqua POS) was left untouched — its printer
settings section has a different structure from the shared template the other
7 apps were forked from (no `checkPrintRelayAvailable`/`submitPrintRelayJob`/
`initPrinterModeUI`/`updatePrintRelaySectionVisibility` functions to hook
into), the same reason it's been excluded from other recent hardware-adjacent
ports. It would need this feature adapted to its own printer-settings code
rather than a mechanical copy — flagging it here rather than silently
skipping it.

**Backend** (`functions/api/print-relay.js`, shared by every app on this
Pages project) was rewritten from a single shop-wide relay (one job queue,
one implicit "server" device per shop) to:
- a **device registry** (`registerDevice`/`listDevices`/`heartbeat`) — every
  open till/phone/tablet checks itself in with a name, station, and whether
  it currently has a real printer connected, so a settings panel can show
  "everything connected to this shop's POS" with live online/offline status;
- **per-device job queues**, replacing the old single shop-wide queue, so a
  job can be delivered to more than one destination device for one print
  event;
- **routing rules** (`getRules`/`saveRules`) — `{trigger, sourceStation,
  destinations, active}`, where a destination is either a whole station
  (every online device currently assigned to it) or one specific device.
  `submit` resolves matching rules into a destination-device set and pushes
  the job onto each device's own queue.

**Backward compatible by design:** a shop with no routing rules configured
falls back to the exact old behaviour — `submit` picks whichever single
device is currently online, has a printer, and has "let other devices print
here too" on. Nothing breaks for a shop that never touches the new Settings
panel.

**Frontend**, added identically to each of the 7 apps (mechanical, since all
7 share the same `printerMode`/`printRelayServerEnabled`/print-relay function
shapes):
- a persistent per-browser device identity (`localStorage` `pos_device_id`),
  with an editable name and a station (Front Counter / Kitchen / Bar /
  Delivery / Other);
- a 20-second heartbeat (`heartbeatDeviceNetwork`, started alongside the
  existing `initPrinterModeUI()` call at app launch) that re-registers the
  device — so a printer connecting/disconnecting or a name/station edit
  shows up for the rest of the shop within one tick;
- a new **🌐 Multi-Printer Network & Routing** section in Settings → Hardware
  (right after the existing Kitchen Order Tickets section): a live device
  list, and an add/pause/delete UI for routing rules;
- `submitPrintRelayJob()` now sends `sourceDeviceId`/`sourceStation` so rules
  can be scoped by where a job originated; `poll`/`ack` now pass this
  device's own `deviceId` since jobs live in per-device queues, not one
  shared queue.

Every new function, DOM id, and CSS class uses distinct names not already
used elsewhere in these apps — checked with the same duplicate-function/
duplicate-id scan used for previous ports, clean on all 7.

### Still to do
- Adapt the feature to `water/index.html`'s different printer-settings
  structure (device identity, name/station picker, discovery panel, and
  routing rules are still Aqua POS's one missing piece — see fix below for
  what was patched in the meantime).

### Bugfix pass — backward-compat break + display bugs
A follow-up review of this port found three bugs, all now fixed in
`functions/api/print-relay.js` and (for #3) identically across the 7
ported apps:

1. **Water's existing relay was silently broken.** The rewrite made
   `poll`/`ack` require a `deviceId`, but `water/index.html` was
   deliberately left untouched and still calls both with none (and never
   calls `registerDevice`). Every poll from Aqua POS was getting HTTP 400
   and failing silently — its "let other devices print here" feature
   stopped working entirely, with no visible error. Fixed by treating a
   missing `deviceId` as a fixed `LEGACY_DEVICE_ID` entry that's always
   upserted as present/printer-equipped/accepting on each poll — the same
   "whichever single device is currently polling" behaviour water already
   depended on, just expressed through the new registry instead of a
   special case.
2. **Heartbeat/stale-window mismatch caused phantom "offline" flicker.**
   `HEARTBEAT_STALE_MS` (15s) was shorter than the frontend's own
   re-registration interval (20s, `heartbeatDeviceNetwork`), so any device
   that wasn't itself polling for relay jobs showed `⚪ Offline` for ~5 of
   every 20 seconds despite being perfectly healthy. Raised to 30s so it
   comfortably clears the heartbeat interval.
3. **Routing-rule labels could get stuck on "a removed device."**
   `refreshDeviceNetworkList()` and `loadPrintRoutingRules()` fire in
   parallel from `initDeviceNetworkUI()`; if the rules finished loading
   before the device list did, a device-based destination would render as
   "a removed device" and stay that way (nothing re-rendered the rules
   list once the device list actually arrived). Fixed by calling
   `renderPrintRoutingRulesList()` again once `refreshDeviceNetworkList()`
   gets its data.

# Header Logo + Promotional Offers Engine — Architecture Note

Implemented and tested in **`water/index.html` (Aqua POS)** only, per the requested
implementation order. Nothing in `hotel/`, `production/`, or `services/` was touched yet.

## Feature 1 — Header Logo

**Reused, not duplicated:** AquaPOS already had a "Shop Logo" upload under
`Settings → Receipt Settings`, stored in `receiptLogoData` (a base64 data URL) and
synced like any other shop-wide setting. Rather than adding a second, competing
upload field, the header now reads from that same value — one upload now powers
both the receipt and the header. The settings copy was updated to say so.

- **Markup:** `<header>` now wraps the title in `.header-brand`, with a new
  `#header-logo <img>` immediately before `#app-title`.
- **CSS:** `.header-brand` / `#header-logo` rules (plus a smaller mobile variant in
  the existing `@media (max-width: 600px)` block) — max height 36px (26px on
  mobile), `object-fit: contain`, rounded corners, white padding so it reads
  cleanly on the dark header bar regardless of the logo's own background.
- **Logic:** a single `renderHeaderBranding()` function sets both the business-name
  text and the logo `<img>` (hidden with no broken-icon fallback when
  `receiptLogoData` is empty, and hidden again `onerror` for a corrupt image). It
  replaced five separate places that used to set `#app-title.textContent` directly
  (login, staff-PIN login, app launch, sync pull, business-name edit) plus the two
  logo upload/remove handlers — so the header now stays in sync everywhere the old
  title-only code did, with no new call sites to forget.

**Porting to the rest of the suite:** each of the other 6 apps has the same
`<h1 id="app-title">` header pattern and (in most cases) the same
`receiptLogoData`/`uploadReceiptLogo`/`removeReceiptLogo` scaffolding already. The
port is: copy the `.header-brand`/`#header-logo` markup + CSS, add
`renderHeaderBranding()`, and swap in the same call sites. Any app whose receipt
settings don't yet have a logo upload needs that added first (a smaller, separate
task) before it has anything to render.

## Follow-up — "☰ More" tab overflow + Help button (Aqua POS)

The responsive tab-bar overflow (`initResponsiveTabs()` / `collapseTabsIfNeeded()`
/ `☰ More`) already existed in AquaPOS, but was only ever initialized on the main
`launchApp()` path. The three other ways into the app — a staff invite link, a
staff PIN link when already signed in this tab, and a staff PIN link on a fresh
device — never called it, so a till opened straight into one of those paths (very
common: staff mostly open their own personal PIN link, not the admin login) could
show an overflowing, unclipped tab bar on a narrow phone/tablet with no "More"
escape hatch. Fixed by calling `initResponsiveTabs()` on all four entry points,
and made the function's resize-listener registration idempotent (guarded by
`responsiveTabsListenerAttached`) so calling it more than once per page load —
which now happens whenever a session moves between login screens — never stacks
duplicate listeners.

Also added the `❓ HELP` button to the header (the `.help-btn` CSS already existed
in Aqua POS's stylesheet, copied from the shared template, but the actual button
was never added — this closed that gap), matching the same pattern already live
in the Services module: a one-tap `triggerHelp()` alert with the support numbers
**0113607529** and **0791598506**, no ticket form, since a cashier mid-sale needs
a phone number, not another screen.

## Rollout to the rest of the suite (MinimartPOS, Hotel, Production, Services)

Both features, plus the two follow-up fixes, were ported from Aqua POS to the
other four apps in this suite: the root app (`index.html`, "MinimartPOS"),
`hotel/index.html`, `production/index.html`, and `services/index.html`.

**Status as of this note:**
- **Header logo** — done and verified in all four (root, hotel, production, services).
- **Help button, both numbers** — done and verified in all four.
- **"☰ More" tab overflow** — checked in all four; none had the bug Aqua POS had
  (their login screens are overlays rather than an `app-container` toggle, so
  `initResponsiveTabs()` firing once at load already covers every login path).
  No fix was needed.
- **Promotional Offers Engine** — done and verified in **root, hotel, and
  production**. **Not yet ported to `services/index.html`** — the Services app
  has its own structure (job/service billing) that needs the same scoping pass
  the other three got before it's safe to touch its checkout math. Nothing in
  `services/index.html` was changed; it works exactly as it did before, just
  without the new Offers feature yet.

### Why these four needed a different approach than Aqua POS

Aqua POS's cart total had one call site (`cartTotal()`) plus a handful of direct
users. Root/Hotel/Production are forked from a larger, shared "Shop" template
with a materially bigger surface:

- **Six independent places recompute the cart total** in each app: the M-Pesa
  STK-push amount, the on-screen cart render, the split-payment default fill,
  `cartTotal()` itself, the customer-facing pole/second-screen display, and the
  actual checkout. All six were found and routed through one function so the
  amount shown, the amount validated, and the amount actually charged can never
  drift apart — the same discipline as Aqua POS, just with six sites instead of one
  instead of one.
- **Cross-branch sales**: a cart can contain items that actually belong to
  another branch, sold under this branch's receipt but settled back to the
  owning branch via a revenue-split ratio (`crossBranchRatio`). Offers **never**
  apply to a cross-branch line, in every app — confirmed mathematically (not just
  assumed) that using the discounted total in that ratio is still correct, since
  cross-branch items are never themselves discounted.
- **Production's Hire Counter**: a second, entirely separate cart
  (`currentHireCart`) for equipment rental, with its own day/set-based pricing
  and its own checkout (`performHireCheckout()`). Never touched — rental pricing
  doesn't map onto a retail promo, and a shared row-rendering helper
  (`buildCartRowsHtml`) was extended with an optional parameter so offer badges
  only ever render for the Sales Counter, never the Hire Counter, from the same
  function.
- **No stored sale total**: unlike Aqua POS, these apps never persist a
  top-level `total` on a sale record — every other screen (receipts, Bills,
  Daily Sales, reports, exports) independently recomputes it from each item's
  stored `price × qty`. Threading a separate "discount" field through every one
  of those (unknown, numerous) call sites would have been fragile. Instead, each
  offer's discount is baked directly into the item's persisted `price` at the
  moment of checkout (`checkoutItemLine()`) — a promotional price becomes *the*
  price for that completed sale, the same way a real till's price list works.
  `originalPrice` and `offerApplied` are kept alongside purely so the receipt can
  still show what was discounted and by how much. This makes every other screen
  automatically correct with no changes needed there, at the cost of the receipt
  and reports no longer being able to "undo" a discount after the fact — an
  acceptable trade since none of those apps could do that for any other kind of
  price adjustment (e.g. a manual price override) either.

### A naming collision worth knowing about

All four apps already ship an unrelated, pre-existing feature: a time-limited
discount on a *single* inventory item (`🏷️ Set Offer / Promotion`, its own
`#offer-modal`, `saveOffer()`, `closeOfferModal()`, stored as `product.offer`).
The new engine is a completely different concept — standing, cart-wide rules the
checkout evaluates automatically — but the natural names for it collided
directly with that existing feature in root (caught during implementation:
`saveOffer()`/`closeOfferModal()` were being silently overridden, which would
have broken the existing single-item discount button). Every new function, DOM
id, and CSS class introduced for the new engine uses a `promo-offer-` /
`*PromoOffer*` prefix throughout all four apps specifically to avoid this —
verified with an automated duplicate-function and duplicate-id scan on each file
after every change, not just assumed safe by inspection.

### Still to do

- Port the Promotional Offers Engine to `services/index.html`, after scoping its
  job/service billing structure the same way Production's Hire Counter and the
  cross-branch logic were scoped here first.

## Feature 2 — Promotional Offers Engine

**Data model** — a new `offers` array, synced exactly like `products`/`staff`/etc.
(added to `saveAllLocal()`, both sync-push bodies, and `pullFromServer()`):

```js
{
  id, name, active: true|false,
  type: 'bogo' | 'percent' | 'flat' | 'bundle',
  scope: 'all' | 'items',                 // 'all' = every cart line is a candidate
  targets: [{ kind:'category', category } | { kind:'code', code }],  // scope==='items' only
  // bogo:    buyQty, freeQty, freeDiscountPercent (100 = fully free, 50 = half off)
  // percent: percentOff
  // flat:    flatAmount, minQty
  // bundle:  bundleQty, bundlePrice
}
```

**Engine (modular, framework-free):**
- `lineMatchesOffer(line, offer)` — scope/target matching, category-aware
  (`refill`, `bottled`, `accessory`, `bale`).
- `computeLineOfferDiscount(line, offer)` — pure function, one offer × one cart
  line → `{amount, label}` or `null`. Handles bogo/percent/bundle.
- `computeFlatOfferResults(entries)` — flat KES-off offers, evaluated once across
  their matched lines (a flat amount doesn't naturally split per line), capped so
  it never exceeds the matched subtotal.
- `applyOffersToCart(entries)` — the single entry point. Per line, only the
  best-value per-line offer applies (no stacking of e.g. two BOGO deals on one
  item); flat cart-wide offers apply on top of that. Returns
  `{lineResults, flatResults, totalDiscount}`.

This is the one function `cartTotal()`, `renderCart()`, and `checkoutCart()` all
call — there is exactly one place discount math happens, so the on-screen total,
the change-due/split-balance validation, and the amount actually charged can never
drift apart.

**Cart UI:** each discounted line gets a green `🏷️ Offer Applied: …` badge with the
line's own item name, plus a struck-through→discounted total shown under the
original line total; the cart footer shows any flat cart-wide offers as their own
badges, and the grand total gets a "(saved KES X)" suffix.

**Settings UI:** new `🎁 Offers` sub-tab — a list of existing offers (name, type
pill, human-readable summary, active/paused state, edit/delete) plus an add/edit
modal. The modal's fields swap based on offer type, and the scope toggle
(`All Items` vs `Specific`) reveals a category checklist + a searchable product
checklist for targeting.

**Receipt:** each discounted line prints its offer label and discount inline
(`🏷️ Buy 5 Get 1 Free (−KES 200)`), any flat cart-wide offers print as their own
lines, and a `Total Savings: KES X` line prints once a discount applied — all
purely additive, so a sale with no offers prints exactly as before.

**Known limitation to flag:** the existing VAT breakdown (`computeVatBreakdown`)
computes tax on each line's pre-discount `price × qty`, same as it already did
before this feature (it also never accounted for the delivery fee). Discounted
sales will therefore show a VAT breakdown that's slightly higher than a strict
post-discount VAT calculation would give. Fixing that is a pre-existing tax-engine
question bigger than this feature's scope — flagging it here rather than silently
changing tax math no one asked to change.

**Porting to the rest of the suite:** the engine section (`lineMatchesOffer`
through `applyOffersToCart`, plus the Offers management UI functions) is
self-contained and only depends on each app's own `products` array and
`ITEM_CATEGORY_LABELS` map — both of which already exist, in slightly different
shapes, in every module. The port per app is: (1) copy the `offers` state +
sync wiring, (2) copy the engine + management-UI functions, (3) copy the Settings
sub-tab markup + modal, (4) wire `cartTotal()`/`renderCart()`/`checkoutCart()`/
`renderReceipt()` the same way this note describes for AquaPOS. Since every app's
cart/checkout/receipt functions follow the same shape (they were built from the
same original template), each port is mechanical, not a redesign.

# Gas Refill & Sales Module — Architecture Note

**Implemented in root (Shop/MinimartPOS) and `services/index.html` only**, per
the request. Not yet ported to hotel, hospital, school, production, pharmacy,
or water.

## The core decision: no new data store

The request describes this as if it needed its own DB models, API endpoints,
and stock system. It doesn't get any of that — instead, gas cylinders and
accessories are created as ordinary `inventory` items with a handful of extra
tagging fields:

- **Cylinder variant** ("Pro Gas 6kg") creates **two linked items** in one go:
  `{ isGasCylinder: true, gasRole: 'full', gasBrand, gasWeight, gasPairCode:
  <empty item's code>, gasRefillPrice, gasRefillWholesalePrice }` and the
  mirror `gasRole: 'empty'` item pointing back via its own `gasPairCode`. The
  Full item's own `price`/`wholesaleSellingPrice` double as its Outright
  price; `gasRefillPrice`/`gasRefillWholesalePrice` are the separate
  Refill/Exchange price.
- **Accessories** (burners/holders) are plain items with `isGasAccessory:
  true, gasAccessoryType: 'burner'|'holder'` — nothing else special.

Because these ARE inventory items, stock tracking, restock, low-stock alerts,
the Stock Report, Barcode, sync, and daily backups all already work on them —
none of that was rebuilt. Editing an existing variant's price or correcting
its stock is just editing it from 📋 Inventory or 📥 Restock like any other
item; the Gas Refill tab's own "Manage" panels are create-only.

## Reusing the cart instead of building a second checkout

A "Refill/Exchange", "Complete Set", or "Outright Purchase" line built in the
Gas Refill tab is written directly into the SAME `currentCart` object the
Sales Counter's own search/add flow uses (with a `::gasrefill` / `::gasset` /
`::gasoutright` cart-key suffix so it can never collide with a normal line
for that same item code). That one decision means the entire existing
pipeline is inherited for free, with zero duplicated logic:

- the per-line price-tier menu (Retail / Wholesale / Custom, Manager-PIN
  gated) and the whole-cart "quote a custom price" editor — both already
  built, already wired to `currentCart[key].price`;
- Walk-In/Delivery, delivery zones, delivery agents, Pay-on-Delivery;
- Cash / M-Pesa / Card / Split / Bill (Pay Later);
- receipts, Daily Sales, Bills, SMS thank-yous, loyalty tokens, eTIMS.

A Complete Set's Burner/Holder picks are added via the ordinary `addToCart()`
call (no gas-specific code at all) — they're just items. There is
deliberately no second cart, no second checkout button, and no gas-specific
delivery/payment code anywhere: the Gas Refill tab's "Add to Sale" button
populates the cart and then hands off to 🛒 Sales Counter to finish the sale
("🛒 Go to Checkout" jumps there directly). **Delivery works with no extra
code for the same reason** — `checkoutCart()` reads `orderType`, the delivery
address/fee/agent, and Pay-on-Delivery generically off whatever's sitting in
`currentCart`, with no per-item-type branching, so a Complete Set or Outright
cylinder can be sent out for delivery exactly like any other product. Stock
(and the Empty-cylinder credit, below) is applied at checkout time, same as
every other item; the Deliveries tab then tracks physical fulfillment
separately, exactly as it already does for anything else marked for
delivery.

## The one genuinely new piece of logic

Everything above only deducts the SOLD item's own stock — it has no notion of
"and the customer handed back an empty." That's the one hook actually added
inside `checkoutCart()`, right next to the existing stock-deduction loop:

```js
entries.forEach(line => {
    if (!line.gasReturnEmptyCode) return;
    const emptyItem = inventory.find(p => p.code === line.gasReturnEmptyCode);
    if (emptyItem) emptyItem.qty = (emptyItem.qty || 0) + line.qty;
});
```

Only a Refill/Exchange line sets `gasReturnEmptyCode` (to the Full item's
paired Empty code) when it's added to the cart; Complete Set and Outright
lines never do, so they never trigger this. Applied to `entries` (not
`localEntries`), matching where the main deduction loop already runs.

## Supplier Exchange / Refill Return

The one transaction type that is NOT a sale — no cart, no payment. A small,
separate action on the Gas Refill tab directly adjusts the Full/Empty item
pair's `qty` (`send`: −Empty only; `return`: −Empty, +Full) and appends to a
capped 30-entry `gasSupplierHistory` log (synced like any other setting).

## Settings toggle

`doGasRefills` (off by default) shows/hides the 🔥 Gas Refill tab button —
inserted right after 🛒 Sales Counter in the Shop app, and right after 🔧
Services Counter in the Services app, per the request. Added to
`LOCKABLE_TABS` in both apps so it can be locked and handed out via Staff
roles like any other tab, and to `collectSyncPayload()`/its pull-side
counterpart so the setting (and the supplier-exchange history) sync across
devices.

## Verified

Both files' inline `<script>` blocks extracted and run through `node
--check` (clean); scanned for duplicate function names and duplicate
`gas-*` element ids across each file (none found).

### Still to do
- Port to hotel, hospital, school, pharmacy, and water. (Now also done in **production** — see below.)

## Port to production

Ported mechanically from root, with two production-specific adjustments:

- Production has no Loyalty Tokens feature, so the settings-toggle logic
  (`setDoGasRefills`/`initGasSettingsUI`/`updateGasTabVisibility`) and the
  whole gas-logic block were anchored next to `let currentCart = {}` and the
  `collectSyncPayload()`/pull-side fields instead, rather than next to a
  `loyaltyEnabled` pattern that doesn't exist here.
- Production's own checkout (`checkoutCart()` is a thin wrapper around
  `async function performCheckoutCart()`) uses a 4-arg
  `deductStockForSaleUnit(product, qty, saleMode, overrideRecipe)` and has a
  SECOND, entirely separate cart (`currentHireCart`, the 🔄 Hiring Counter,
  for equipment rental). Gas Refill only ever touches `currentCart` (the
  Sales Counter's cart) — `currentHireCart` and the Hiring Counter's own
  checkout are untouched, so a hired-out item's stock/return logic can never
  interact with a gas line. The empty-cylinder credit hook was placed at the
  END of `performCheckoutCart()`'s stock-deduction `entries.forEach` (after
  the hire/service/variant early-returns, at the same catch-all line every
  other plain item falls through to), matching exactly where the equivalent
  hook sits in root/services.

Verified the same way: extracted `<script>` blocks run clean through `node
--check`; no duplicate function names or duplicate `gas-*` element ids in the
file; all six new-in-root gas functions confirmed defined exactly once.

# Production Tab Upgrade: Bottle/Bale Math, Factory Stock & Wizard — Architecture Note

**Implemented in `water/index.html` (Aqua POS) only**, per the request. Additive
throughout — every existing bale-category product keeps behaving exactly as
before (plain decimal `qty`) unless its owner explicitly turns on the new
"Track by bottle count" toggle; nothing here changes default behaviour for
existing shops.

## Bottle/Bale/Loose math

`getBaleBreakdown(totalBottles, bottlesPerBale)` is the single source of
truth — full bales and half bales only ever come from COMPLETE multiples
(24 and 12 by default), a remainder under half a bale never rounds up, it's
just `looseBottles`. Verified against all four worked examples in the spec
(2400/2410/2412/2423 bottles). `baleBreakdownToBottles()` is its inverse;
`baleBreakdownToDecimal()` collapses a breakdown to the existing
`fullBales + halfBales*0.5` convention the rest of the app (cart, price
tiers, receipts) already uses, so bottle-tracked items slot into all of that
unchanged.

## Bottle-level tracking is opt-in, per bale product

New product fields (all bale-category only, defaulted by
`ensureBaleTrackingDefaults()` on every load — see the recurring
`backfillRegalAquaCatalogItems()` hook): `trackBottles`, `bottleStock`,
`bottlesPerBale`, `factoryBottleStock`, `factoryQty`, `halfBalePriceMode`
(`'auto'|'manual'`), `halfBalePrice`. When `trackBottles` is on,
`bottleStock` becomes the true source of truth and `syncBaleTrackingFields()`
recomputes `qty`/`fullBales`/`halfBales`/`looseBottles` (and the Factory-side
mirror) from it — called after every edit that touches bottle counts, so
nothing can drift. The Inventory tab's Products table gets a new nested
sub-row under every bale product (`baleNestedRowHtml()`) with the tracking
toggle, a Bottle Stock quick-edit, Bottles/Bale override, the live
breakdown, and the Half-Bale pricing toggle + manual price field.

## Half-bale pricing

`getHalfBalePrice()` returns either a straight 50% split of the current
(possibly tiered) full-bale rate, or an independently set manual price —
never forced. The existing "½ Bale" grid button and `addBottledToCart()`
now store a *synthetic* per-full-bale rate (2× the actual half-bale price)
as the cart line's `price`, so the pre-existing `price × qty` total math
everywhere else (cart total, receipt) comes out to exactly the intended
charge whether or not it's a plain 50% split — no other total-calculation
code needed to change.

## Multi-Step Production Wizard

`productionStepsTemplate` (synced/localStorage-persisted) is a fully
user-editable list of `{ name, materials: [{materialId, qtyPerUnit}] }`
steps, seeded with the five steps from the spec but freely renamable/
addable/removable — nothing about step *identity* is hardcoded into the run
logic. Running it (`submitProductionWizard()`) aggregates every step's
material need across the whole batch (same material in two steps sums
once), validates every material has enough stock BEFORE deducting anything,
then deducts and lands the batch in **Factory Stock only** — never Shop
Floor `qty`/`bottleStock` directly. This coexists with the pre-existing
single-item "Produce Item" form (unchanged, still writes straight to Shop
Floor) — the Wizard is the new, Factory-Stock-routed path; the classic form
remains for raw materials and quick non-bale/bottle production where a
Factory-Stock detour doesn't apply.

## Factory Floor Stock, Dispatch & Direct Sale

Every bale/bottled product gets a `factoryQty` (or, if bottle-tracked,
`factoryBottleStock`) pool, shown in a new Factory Floor Stock card on the
Production tab (`renderFactoryStockTable()`). "🚚 Dispatch" opens a modal
(Full/Half Bales + Loose Bottles inputs for a tracked item, one decimal
quantity otherwise) that validates against current Factory availability
before moving stock across. "🛒 Direct Sale" (`addFactorySaleToCart()`)
adds a cart line flagged `fromFactory: true`, under its own `::factory`
cart-key suffix so it can never collide with a normal Shop-Floor line for
the same item. `availableStockForLine()` and `deductProductStockForSale()`
are the two chokepoints every stock check/deduction (cart add, +/-, direct
decimal entry, and the checkout deduction loop) now goes through, so a
Factory-Direct line is always validated and deducted against Factory Stock
and a normal line against Shop Floor stock — never the wrong pool, and
never past either one's limit.

## Verified

Inline `<script>` extracted and run through `node --check` (clean); scanned
for duplicate function names and duplicate element ids across the file
(none found); `getBaleBreakdown()` re-implemented standalone in Node and
checked against all four spec examples (exact match).
