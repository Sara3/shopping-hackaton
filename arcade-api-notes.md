# Arcade API — Reference Notes

Condensed from https://docs.arcade.ai (quickstart, auth, idempotency, jobs, errors, and the
patterns/categories/products/checkouts/orders API reference) on 2026-10-10. This is the
factual basis for the architecture described in [agent.md](agent.md) — update both
together if Arcade's docs change.

## Base URL & auth
- `https://platform.arcade.ai/v1/`
- All calls are `POST` with JSON bodies (except the two `GET`-style category/model list
  reads, which are also POST per the OpenAPI spec).
- `Authorization: Bearer $ARCADE_API_KEY` — one key, full account access. **No separate
  sandbox/live key or test-mode flag exists in the docs.** Treat every call as hitting the
  real account.
- `User-Agent: your-app/1.0 (contact@example.com)` is **required** — missing/default
  user agents get a 403 before reaching the API.
- Max payload size 1 MB (413 if exceeded).

## Idempotency
- Every work-creating call takes a caller-chosen `requestId` (string, 1–128 chars).
- Replay with the same `requestId` + body → original result, no duplicate work.
- Validation failures (4xx before work starts) don't consume the `requestId`.
- Mismatched replay (same `requestId`, different body, original still in flight) → `409`;
  retry shortly or mint a new `requestId`.
- **Known exception:** `checkouts/create` can leave a duplicate *unpaid* checkout if a
  request is abandoned mid-flight and retried. Must be handled explicitly (see spec).

## Jobs (async work)
- Pattern/product generation runs as a job: initial call returns `jobId`, `kind`
  (`pattern`|`product`|`download`), `status` (`running`|`succeeded`|`failed`).
- Poll `POST /jobs/get` with `jobId`. **Poll every 2–5s** — faster polling burns rate limit
  without finishing jobs sooner. No documented hard timeout; budget your own.
- `succeeded` can still return `result: null` (e.g. a refine found nothing to fix). Handle
  as a valid no-op, not an error.
- Pattern generation takes ~1–2 minutes end to end.

## Errors
| Code | Meaning | Action |
|---|---|---|
| 400 | request malformed | fix before retry |
| 401 | key missing/invalid/revoked | check credentials |
| 403 | rejected (often missing/default User-Agent) | fix header |
| 404 | resource doesn't exist | verify id |
| 409 | requestId conflict, in flight | brief delay + retry unchanged, or new requestId |
| 422 | body invalid | read `fieldErrors`/`formErrors` |
| 429 | rate limited | wait `Retry-After` seconds |
| 503 | transient | exponential backoff, same `requestId` |

Standard error body: `{code, status, message}`; 429 uses `{error, message}` instead.

## Endpoints used in the Doraemon pipeline

### Reference images (photo intake)
- `POST /references/createUpload` → upload slot for a photo.
- `POST /references/create` → turns the uploaded file into a `referenceId`. Idempotent on
  `uploadId` (repeat call returns the same `referenceId`, 200). Deleted refs → 404.
- Up to 3 `referenceIds` can be passed into `patterns/create` to steer generation from a
  photo.

### Pattern generation (spec → render)
`POST /patterns/create`
- Required: `requestId`, `prompt` (1–1000 chars).
- Optional: `referenceIds` (≤3), `modelId` (omit to let Arcade choose), `colors` (≤10,
  hex/palette/Pantone tokens), `categoryId` (**pass this to also create a product in the
  same job** — otherwise you get a pattern only, with no price).
- Returns a job; on success, `result.patternId` (+ `result.productId` if `categoryId` was
  passed).
- Refine ops exist for iteration without a full regenerate: `edit`, `editRegion`,
  `recolor`/`recolorClusters`, `crop`, `makeSeamless`, `extendPattern`, `extendScene`,
  `fixDeformity`, `upscale` (`upscale` exposes `expectedCreditCost` — these ops spend
  Arcade **credits** on *our* account, separate from the price shown to the end customer).

### Categories (what can be manufactured)
- `POST /categories/list` → `{categoryId, name, imageUrl, world: "print"|"jewelry",
  category: {parent}}[]`. `world` is the manufacturing method; it's a hard split, not a
  cosmetic tag.
- `POST /categories/get` with `{categoryId, selections}` (start with `selections: {}`) →
  full option tree (`options[].values[].{value,label,isDefault,available}`) plus
  `canManufacture`. **Must iteratively re-call as selections are made** — `available`
  reflects what's still buildable given values chosen so far. Use the full returned
  `selections` object (not a hand-built partial one) on `products/create`.

### Product creation (render + price)
`POST /products/create`
- Required: `requestId`, `patternId`, `categoryId`, full `selections` object from
  `categories/get`.
- Optional: `fit` (crop w/ zoom level 1/2/3/4/8/12, or fill).
- Returns a job; on success, `result.productId`.
- `POST /products/get` with `{productId, quantity?}` → **this is where price lives**:
  `unitPrice {amount, currency}` (nullable if unavailable) and `volumeDiscounts`, plus
  `imageUrl`/`images[]` (short-lived, re-fetch to renew), `maker`, `selectionLabel`,
  `description`, `careInstructions`.

**This is the single biggest correction to agent.md's assumed pipeline: there is no
separate "instant pricing" API. Price is a field on `products.get`, returned by the same
generation pipeline that renders the product — "generation" and "pricing" are one step, not
two.**

### Checkout (handoff to Arcade, not a Doraemon-owned charge)
`POST /checkouts/create`
- Required: `requestId`, `lines` (1–50 items, each `{productId, quantity (1–1000)}`).
- Optional: `dropShip` (bool, default false).
- Returns `{checkoutId, checkoutUrl}`. **Payment and shipping address are both collected on
  Arcade's own hosted `checkoutUrl` page — not through our API.** The order is placed once
  payment completes there, not when `checkouts/create` returns.
- Known idempotency gap: an abandoned/retried call can leave a duplicate unpaid checkout.

### Orders (status after checkout)
- `POST /orders/get` with `{orderId}` or `{checkoutId}` (both `^\d+$` strings) →
  `status` enum: `ordered, cadReview, sampleReview, inProduction, inReview, inCorrection,
  approved, updatedInfo, shipped, delivered, fulfilled, refunded`; financials
  (`total/subtotal/shipping/tax/volumeDiscount/discounts`, each `{amount, currency}`);
  `lines[]`; `tracking[]` (`{company, number, url}`); `shippingAddress`
  (`name, city, provinceCode, countryCode`); `refunds[]`.
- `POST /orders/list` for listing/pagination.
- **No webhooks are documented anywhere in the API.** Fulfillment status must be **polled**
  via `orders/get` — there is nothing to verify-signature on, because nothing is pushed to
  us.

### Misc
- `POST /models/list` — available generation models (for `modelId` on `patterns/create`).
- `POST /feedback/send` — send feedback to Arcade about a job/result.
- List endpoints (`patterns/list`, `references/list`, `products/list`, `orders/list`) share
  one cursor pattern: omit `cursor` on page 1, pass the prior response's `nextCursor` to
  continue, `null` means last page; `limit` caps page size.

## Gaps vs. what agent.md/agent_constitution.md assumed
1. **No sandbox/test mode at the API level.** One key = full real account. Constitution
   §2 "default to sandbox" must be implemented as an app-level dry-run layer *in front of*
   Arcade, not an Arcade account setting.
2. **No webhooks.** Constitution §2's "verify webhook signatures" doesn't apply as written;
   replace with a polling sync job against `orders/get`.
3. **Destination is not an API field we control.** The shipping address is entered by the
   customer on Arcade's hosted checkout page, after we've already redirected them. Our own
   confirmation screen can show product + price with certainty, but cannot itself capture
   the ship-to address as part of that one bound confirmation — Arcade's page is where that
   happens. See the implementation spec's open questions for how this is handled.
4. **Two different "prices" exist:** the end-customer `unitPrice`/order total (what
   Doraemon must gate behind confirmation), and Arcade **credits** spent by *our* account on
   generation/refine calls (an operating-cost concern for us, not a customer-facing gate).
