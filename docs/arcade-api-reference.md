# Arcade API developer reference (arcade.ai)

Scope: the physical-product-generation API of **arcade.ai** (Mariam Naficy's company: prompt -> pattern -> product -> checkout -> made on demand and shipped), documented at https://docs.arcade.ai. This is NOT arcade.dev / arcade-ai.com (an unrelated tool-calling platform); nothing from arcade.dev was used.

Compiled 2026-10-10 from the live docs. Field names are copied from `openapi.json` (identical at https://docs.arcade.ai/openapi.json and https://platform.arcade.ai/v1/spec.json: 28 operations, every path item byte-for-byte equal after JSON canonicalisation) and from the raw `.md` of all 35 indexed pages. A live verification pass on 2026-10-11 (section 14.3) ran 26 of the 27 real endpoints against the Studio account with a real key; findings are tagged `[LIVE]` inline where they confirm or correct a claim below.

Evidence tags used throughout:

| Tag | Meaning |
|---|---|
| `[DOC]` | Stated on a docs.arcade.ai prose page (quickstart, authentication, jobs, errors, idempotency, pagination, agents) |
| `[SPEC]` | From `openapi.json` (request/response schemas and field descriptions) |
| `[SKILL]` | From the two official agent-skill files the docs publish (`arcade-api`, `arcade-api-test-drive`) |
| `[NON-API]` | From Arcade's marketing site, legal terms or consumer help center. Not API documentation; may not apply to API checkout |
| `[OBSERVED]` | Something I saw in HTTP responses (headers, redirects), not in any doc |
| `[LIVE]` | Observed by actually calling `platform.arcade.ai` with a real `ARCADE_API_KEY` (2026-10-11, section 14.3). Supersedes `UNVERIFIED` for the same claim |
| `UNVERIFIED` | Not stated anywhere I could read, and not yet confirmed with a real key; do not rely on it |

When first compiled (2026-10-10), nothing in this file had been tested against the live API: no key was available and creating objects on Sara's account was out of scope. The Node script in section 13 was run only against a local mock that validates every request and response against the verified OpenAPI schemas. A real key became available on 2026-10-11 (an onboarding teammate's); section 14.3 records exactly what was run and what remains genuinely untested (notably: no checkout was created, so payment/shipping/order-lifecycle claims in sections 9 and parts of 10 are still `UNVERIFIED`).

---

## 0. Shape in 15 lines

1. Base `https://platform.arcade.ai/v1`. EVERY call is `POST` with a JSON body (reads too; no-parameter reads send `{}`). `[DOC]`
2. Auth: `Authorization: Bearer $ARCADE_API_KEY`. Key (`arcade_sk_live_...`) comes from https://studio.arcade.ai/settings/api-keys. No test/sandbox keys are documented. `[DOC][SKILL]`
3. Always send a real `User-Agent` such as `your-app/1.0 (you@example.com)`; missing or library-default UAs can get a non-JSON `403` from the edge. `[DOC]`
4. Work that takes time (`patterns/create`, every `patterns/refine/*` except `recolorClusters`, `products/create`) returns a Job `{jobId, kind, status, result, error, createdAt, completedAt}`; poll `jobs/get` every 2-5 s until `status` is `succeeded` or `failed`. `[DOC][SPEC]`
5. Pattern generation takes about 1-2 minutes. Refine and product-build times are not documented. `[DOC]`
6. Every work-starting call needs a caller-chosen `requestId` (1-128 chars); replaying it with the same body is safe. `[DOC]`
7. Bring-your-own image: `references/createUpload` -> `PUT` bytes -> `references/create` -> pass `referenceId` to `patterns/create.referenceIds` (max 3) or `patterns/refine/edit.referenceId`. gif/jpeg/png/webp, max 10 MiB. It GUIDES generation; exact logo placement is not a documented feature. `[SPEC]`
8. Product: `categories/list` -> `categories/get` (walk `selections` until `canManufacture` is true) -> `products/create {requestId, patternId, categoryId, selections, fit?}` -> job -> `products/get` for `images[]` (mockups) and `unitPrice {amount, currency}`. `[SPEC]`
9. Category names, options and prices are NOT published; they come back at runtime. The only documented example is cotton dinner napkins: `{"fabric":"cotton","size":"20x20"}`. `[DOC]` Confirmed live 2026-10-11 (section 14.3): that category is real (`categoryId` `c314010b-e15a-4014-a376-9b8f4e973461`, named "Napkins"), `fabric` also has a `refined_linen` value, `size` also has `5x5`, and the cotton/20x20 `unitPrice` was `33.96 USD`. `[LIVE]`
10. `unitPrice` can be `null` ("read again later") and is quoted "before the volume discount"; shipping and tax are not mentioned (presumably excluded, UNVERIFIED). `[SPEC]`
11. Checkout: `checkouts/create {requestId, lines:[{productId, quantity}], dropShip?}` returns `{checkoutId, checkoutUrl}`. No address/email/payment fields: a human opens `checkoutUrl` and pays there (real money, no test mode documented). `[SPEC][SKILL]`
12. Any line with `quantity: 1` needs `"dropShip": true` unless the account has an active subscription, else `412 PRECONDITION_FAILED`. `[SPEC]`
13. Order tracking: `orders/get` by `orderId` or `checkoutId` (404 until paid); `status` enum `ordered, cadReview, sampleReview, inProduction, inReview, inCorrection, approved, updatedInfo, shipped, delivered, fulfilled, refunded`; `tracking[]`. No webhooks documented: poll. `[SPEC]`
14. Rate limit: per source IP at the Cloudflare edge, `429` with `Retry-After`; no numbers published. No SDKs, CLI or API-actions MCP server are documented. Agent skills: `npx skills add https://docs.arcade.ai`. `[DOC]`
15. Image URLs (patterns, references, products, orders, downloads, uploads) are short-lived and their host is not guaranteed: re-fetch via the get endpoint, never store them. `[SPEC]`

---

## 1. API key

| Item | Value | Source |
|---|---|---|
| Where to create | https://studio.arcade.ai/settings/api-keys (Arcade Studio, Settings -> API keys). You must be signed in to Studio. No API endpoint creates keys; it is a Studio UI action | `[DOC]` |
| Header | `Authorization: Bearer $ARCADE_API_KEY` (HTTP bearer scheme; OpenAPI `securitySchemes.apiKey = {type: http, scheme: bearer}`) | `[DOC][SPEC]` |
| Key format | Starts with `arcade_sk_live_`. "Any other key gets `401` here" | `[SKILL]` |
| Shown | Studio shows the key only once; copy it immediately | `[SKILL]` |
| Lifetime | Expire after 90 days by default; each user can have at most 10 active keys | `[SKILL]` |
| Power | "A key has the same access as your account"; never commit it or put it in client-side code | `[DOC]` |
| Failure | Missing, invalid, expired or revoked key -> `401`; a revoked key stops working immediately | `[DOC]` |
| Sandbox / test keys | None documented. The skill says every call "runs against the human's real Arcade account. Generations, products and checkouts it creates are real and appear in their Studio". The `live` in the prefix hints at a test prefix existing, but nothing documents one | `[SKILL]` UNVERIFIED |
| Cost / plan needed to get a key | Not documented. Studio's landing page says "Try now for free" `[NON-API]`; whether a free account can create API keys is UNVERIFIED | |

Read-only smoke test (creates nothing; the skill's own "verify the setup" step): `curl -sS https://platform.arcade.ai/v1/models/list -H "Authorization: Bearer $ARCADE_API_KEY" -H "Content-Type: application/json" -H "User-Agent: your-app/1.0 (you@example.com)" -d '{}'` should return `200` with `{"items":[{"modelId":"...","name":"..."}]}`. `401` = key problem; non-JSON `403` = `User-Agent` rejected at the edge; `429` = slow down (wait `Retry-After`); `503` = retry.

Scripts should read the key from the environment (`ARCADE_API_KEY`), send it only to `platform.arcade.ai`, and never print it. Signed URLs the API returns (`imageUrl`, `uploadUrl`, ...) may be on other hosts: use them as returned, WITHOUT the key. `[SKILL]`

---

## 2. Base URL, content type, versioning

| Item | Value | Source |
|---|---|---|
| Base URL | `https://platform.arcade.ai/v1` (OpenAPI `servers[0]`, "Production"; there is no other server listed) | `[DOC][SPEC]` |
| Method | `POST` for every operation, including reads | `[DOC]` |
| Request body | JSON object; `Content-Type: application/json`. A read with no parameters sends `{}` | `[DOC][SKILL]` |
| Response | JSON on success (`200`) | `[SPEC]` |
| Body size | Over 1 MB -> `413` (plain text). Malformed JSON -> `400` (plain text) | `[DOC]` |
| Versioning | In the URL path (`/v1`); OpenAPI `info.version` is `"1"`; no version header; no changelog or deprecation policy page exists | `[SPEC]` |
| Machine-readable spec | OpenAPI 3.1.1 at https://docs.arcade.ai/openapi.json and https://platform.arcade.ai/v1/spec.json | `[SPEC][SKILL]` |
| Required header | `User-Agent: your-app/1.0 (you@example.com)`. "Requests with no `User-Agent`, or with an HTTP library's default such as `Python-urllib`, may be rejected at the edge with `403`" before reaching the API. Node's built-in `fetch` sends a library-default UA, so set one | `[DOC]` |
| Hosting | Edge is Cloudflare (`server: cloudflare`), origin on Railway (`x-railway-*` headers) | `[OBSERVED]` |
| Image storage | All short-lived image/upload URLs observed 2026-10-11 are V4-signed Google Cloud Storage links (`storage.googleapis.com`, service account `b2b-marketplace@arcade-ai-prod.iam.gserviceaccount.com`): pattern and reference images in bucket `b2b-designs`, product mockup overlays in bucket `public-user-designs-arcade-ai-prod`, category thumbnails in `public-storefront-assets-prod`. Consistent with "host not guaranteed" in the spec — do not hardcode these bucket names | `[LIVE]` |

Docs gap: the Quickstart prose says to name your integration in `User-Agent`, but only its Python sample sets one; the JavaScript, TypeScript, Go, Rust and cURL samples rely on the library default, which the docs say may draw a `403`. Set it yourself.

---

## 3. Conventions shared by all endpoints

### 3.1 `requestId` and idempotency `[DOC]`

- Requests that start work take `requestId`: a unique string, 1 to 128 characters, chosen by you. Use a new one per distinct request. (Report-only `feedback/create` also has one, but it is NOT an idempotency key there.)
- If a request fails or times out, retry it with the SAME `requestId` AND the same body: the work runs once and the retry returns the original result (for jobs: the same `jobId`).
- `409 CONFLICT` on a retry means one of: the original is still starting (retry shortly, unchanged), the body differs from the original (use a new `requestId`), or the original `references/createUpload` upload was already used (use a new `requestId`).
- A request that failed validation does not consume its `requestId`: fix the body and resend.
- Exception: if a `checkouts/create` request is abandoned while starting, a retry can leave one extra unpaid checkout.
- Read endpoints (`*/get`, `*/list`) have no `requestId`, except `patterns/refine/recolorClusters` which requires one.

### 3.2 Pagination `[DOC][SPEC]`

`patterns/list`, `references/list`, `products/list`, `orders/list` return newest first:

```json
{
  "items": [...],
  "nextCursor": "eyJjcmVhdGVkQXQiOi..."
}
```

Omit `cursor` for the first page; pass the previous `nextCursor` back unchanged as `cursor`; a `null` `nextCursor` is the last page. The cursor is opaque. `limit`: patterns 1-60 (default 24), references 1-60 (default 24), products 1-100 (default 24), orders 1-50 (default 20). `orders/list` can return fewer than `limit` items when filtered by `status`, so loop until `nextCursor` is null.

### 3.3 The Job object `[DOC][SPEC]`

Returned by every operation that starts work, and by `jobs/get`. All seven fields are always present.

| Field | Type | Meaning |
|---|---|---|
| `jobId` | string | "Opaque job ID; read the job with jobs.get" |
| `kind` | enum `pattern` \| `product` \| `download` | What the job makes: a pattern (`patterns.create` or a refine), a product (`products.create`) or a download (an upscale started in Arcade Studio; cannot be started through the API) |
| `status` | enum `running` \| `succeeded` \| `failed` | "Jobs are created running; there is no queued state" |
| `result` | `{patternId}` \| `{productId}` \| `{downloadUrl, expiresAt}` \| `null` | What a succeeded job made. `null` while running, when it failed, when a deformity fix found nothing to repair, and once the pattern it made is deleted. So a SUCCEEDED job can have `result: null` |
| `error` | `{message}` \| `null` | Why the job failed; set once it failed |
| `createdAt` | date-time | When the job started (for a product with no recorded build: when the product was created) |
| `completedAt` | date-time \| `null` | When it finished; `null` while running and for a failed product job (not recorded) |

Examples. The first two are the docs' own (Jobs page and Quickstart); they leave out fields the spec marks required (`createdAt`, `completedAt`, and in the second also `error`):

```json
{ "jobId": "3583f242-50ed-4250-94c2-c00ea25249dd", "kind": "pattern", "status": "running", "result": null, "error": null }
```

```json
{ "jobId": "3583f242-50ed-4250-94c2-c00ea25249dd", "kind": "pattern", "status": "succeeded", "result": { "patternId": "cmujgkfnk0004pc10nt3kghxd" } }
```

A complete succeeded job per the spec:

```json
{
  "jobId": "3583f242-50ed-4250-94c2-c00ea25249dd",
  "kind": "pattern",
  "status": "succeeded",
  "result": { "patternId": "cmujgkfnk0004pc10nt3kghxd" },
  "error": null,
  "createdAt": "<date-time>",
  "completedAt": "<date-time>"
}
```

Other shapes from the spec (placeholders): product success `{"kind":"product","status":"succeeded","result":{"productId":"<id>"},"error":null,...}`; failure `{"status":"failed","result":null,"error":{"message":"<why>"},...}`; download `{"kind":"download","result":{"downloadUrl":"https://...","expiresAt":"<date-time>"},...}`.

Polling details: section 6.

### 3.4 Short-lived URLs `[SPEC][SKILL]`

`imageUrl`, `thumbnailUrl`, `images[].url`, `downloadUrl`, `uploadUrl`, order and category `imageUrl` are signed/short-lived and "Host not guaranteed" (category images: "Host and lifetime not guaranteed"). Do not persist or hotlink them; call the matching get endpoint again to renew, and copy bytes to your own storage if you need permanence. Do not send your API key to them.

### 3.5 Errors `[DOC]`

JSON error body (except where noted):

```json
{
  "code": "NOT_FOUND",
  "status": 404,
  "message": "Order not found."
}
```

| Status / code | Meaning |
|---|---|
| `400 BAD_REQUEST` | The request can't be processed. Malformed JSON body -> `400` as plain text |
| `401 UNAUTHORIZED` | API key missing, invalid, expired or revoked |
| `403 FORBIDDEN` | API rejected the request (JSON body). A non-JSON `403` comes from the edge before the API, usually a missing or library-default `User-Agent`. The hidden `patterns/refine/upscale` also fails with `403` |
| `404 NOT_FOUND` | Resource doesn't exist (`orders/get` by `checkoutId` is 404 until paid) |
| `409 CONFLICT` | `requestId` conflicts with an earlier request (section 3.1) |
| `412 PRECONDITION_FAILED` | `checkouts/create` with a `quantity: 1` line and no `dropShip: true` on an account without an active subscription. Documented only in the checkout operation text, not in the errors table `[SPEC]` |
| `413` | Body over 1 MB, plain text |
| `422 INPUT_VALIDATION_FAILED` | Invalid body. `data.fieldErrors` lists problems with fields, `data.formErrors` problems with the body as a whole. (The inner shape of each list, for example field -> messages, is not documented: UNVERIFIED) |
| `429 rate_limit_exceeded` | Too many requests from one source. The JSON body has `error` and `message` rather than `code` and `status`. Wait `Retry-After` seconds, then retry |
| `503 SERVICE_UNAVAILABLE` | Temporary outage; retry with backoff. `feedback/create` returns it while feedback is unavailable |

Retry policy (docs): retry `5xx` with backoff and the same `requestId`; after `429` wait `Retry-After` seconds, retry with the same `requestId`; retry a `409` for a request still starting, unchanged, after a short delay; fix the request before retrying any other `4xx`. Per-operation error bodies are NOT declared in openapi.json (only `200` is).

---

## 4. Endpoint index (28 operations: 27 documented, 1 hidden)

| # | `POST` path | Purpose | Starts a job? |
|---|---|---|---|
| 5.1 | `/patterns/create` | Generate a pattern from a prompt (+ optional references, model, colors) | yes (`kind: pattern`) |
| 5.2 | `/patterns/get` | Retrieve a pattern (image URLs, size, prompt, source) | no |
| 5.3 | `/patterns/list` | List your patterns, newest first | no |
| 5.4 | `/patterns/refine/edit` | Edit a pattern from a text instruction | yes |
| 5.5 | `/patterns/refine/editRegion` | Edit only a masked region | yes |
| 5.6 | `/patterns/refine/recolorClusters` | List dominant colors (cluster IDs) for `recolor` | no (synchronous) |
| 5.7 | `/patterns/refine/recolor` | Replace dominant colors | yes |
| 5.8 | `/patterns/refine/crop` | Crop to a rectangle | yes |
| 5.9 | `/patterns/refine/makeSeamless` | Turn a square region into a seamless repeat tile | yes |
| 5.10 | `/patterns/refine/extendPattern` | Extend a REPEATING pattern to a larger size | yes |
| 5.11 | `/patterns/refine/extendScene` | Extend a NON-repeating image beyond its edges | yes |
| 5.12 | `/patterns/refine/fixDeformity` | Detect and repair malformed details | yes |
| 5.13 | `/patterns/refine/upscale` | HIDDEN. Not available via the API (403) | n/a |
| 5.14 | `/jobs/get` | Retrieve a job; poll until `succeeded`/`failed` | no |
| 5.15 | `/references/createUpload` | Get a signed URL to `PUT` an image to | no |
| 5.16 | `/references/create` | Save the uploaded image as a reference | no |
| 5.17 | `/references/get` | Retrieve a reference | no |
| 5.18 | `/references/list` | List references, newest first | no |
| 5.19 | `/models/list` | List generation models | no |
| 5.20 | `/categories/list` | List product categories | no |
| 5.21 | `/categories/get` | Category + options + availability + a complete `selections` | no |
| 5.22 | `/products/create` | Build a product from pattern + category + selections | yes (`kind: product`) |
| 5.23 | `/products/get` | Retrieve a product (images, maker, price) | no |
| 5.24 | `/products/list` | List products, newest first | no |
| 5.25 | `/checkouts/create` | Create a hosted checkout for products | no |
| 5.26 | `/orders/get` | Retrieve an order by `orderId` or `checkoutId` | no |
| 5.27 | `/orders/list` | List orders, newest first (optional `status` filter) | no |
| 5.28 | `/feedback/create` | Send a report about the API to Arcade | no |

There are NO delete, update, cancel-order, webhook-registration, shipping-estimate, or usage/credits endpoints in the spec. Anything you create (patterns, references, products, unpaid checkouts) stays in the account and cannot be removed through the API (the job text mentions a pattern being "deleted", so deletion exists somewhere, presumably Studio: UNVERIFIED). `[SPEC]`

---

## 5. Endpoints

Generated mechanically from the verified `openapi.json` so field names, enums and limits are exact. "Request body shape" blocks use placeholders like `<requestId>` and are NOT real values. The tables show requiredness (`Req`), constraints and the spec's own descriptions. Realistic examples taken from the docs are in the Notes and in sections 6 to 9.

### 5.1 `POST /patterns/create`  Create a pattern  (`patterns.create`)

Docs page: https://docs.arcade.ai/api-reference/patterns/create-a-pattern

> Starts a job that generates a pattern from a prompt. On success, `result.patternId` is the new pattern.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `prompt` | string | yes | length 1-1000 |  |
| `referenceIds` | array<string> | no | items 0-3; default `[]` | References to guide the generation |
| `modelId` | string | no | length >= 1 | A modelId from models.list; omit to let Arcade choose |
| `colors` | array<string> | no | items 0-10; default `[]` | #RRGGBB hex, or Arcade palette or Pantone color tokens |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "prompt": "<prompt>",
  "referenceIds": [
    "<referenceIds>"
  ],
  "modelId": "<modelId>",
  "colors": [
    "<colors>"
  ]
}
```

**Response 200**: a Job object (shape in section 3.3). Schema note: "A pattern job that makes one pattern".

**Notes**

- [DOC] Starts a job; on success `result.patternId` is the new pattern. Typical generation time: 1 to 2 minutes (quickstart, `arcade-api` skill).
- [SPEC] `prompt` is 1 to 1000 characters. `referenceIds` takes at most 3 IDs from the References flow (section 7.2). `colors` takes at most 10 strings: `#RRGGBB` hex, or "Arcade palette" or "Pantone" color tokens. The token syntax for palette/Pantone is not documented: UNVERIFIED. `modelId` must come from `models/list`; omit it to let Arcade choose.
- [SPEC] There is NO parameter for output size, aspect ratio, tiling/seamlessness, or number of variants. Read the resulting `width` and `height` from `patterns/get`. What size you get by default is not documented: UNVERIFIED.
- [DOC] Replaying the same `requestId` with the same body returns the original job (same `jobId`); a different body with the same `requestId` returns `409`.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.2 `POST /patterns/get`  Retrieve a pattern  (`patterns.get`)

Docs page: https://docs.arcade.ai/api-reference/patterns/retrieve-a-pattern

> Retrieves a pattern. Image URLs are short-lived; retrieve the pattern again to renew them.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `patternId` | string | yes | length >= 1 | Opaque ID of one pattern: an immutable image. A refine makes a new pattern. |

Request body shape (placeholders, not real values):

```json
{
  "patternId": "<patternId>"
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `imageUrl` | string (uri) | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `thumbnailUrl` | string (uri) | yes |  |  |
| `width` | integer | yes | > 0 |  |
| `height` | integer | yes | > 0 |  |
| `patternId` | string | yes | length >= 1 | Opaque ID of one pattern: an immutable image. A refine makes a new pattern. |
| `prompt` | string or null | yes |  | The prompt of the generation this pattern comes from, through any refines; null when none made it |
| `sourcePatternId` | string or null | yes | length >= 1 | The pattern a refine was made from; null for a generation |
| `createdAt` | string (date-time) | yes |  |  |

Response shape:

```json
{
  "imageUrl": "https://...",
  "thumbnailUrl": "https://...",
  "width": 1,
  "height": 1,
  "patternId": "<patternId>",
  "prompt": "<prompt>",
  "sourcePatternId": "<sourcePatternId>",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

**Notes**

- [DOC] `imageUrl` and `thumbnailUrl` are short-lived and their host is not guaranteed: do not store them, re-call `patterns/get` to renew, and copy the bytes to your own storage if you need them to last.
- [SPEC] Patterns are immutable images. A refine makes a NEW pattern whose `sourcePatternId` is the one it was made from.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.3 `POST /patterns/list`  List patterns  (`patterns.list`)

Docs page: https://docs.arcade.ai/api-reference/patterns/list-patterns

> Lists your patterns, newest first.

**Request**, JSON object (body is required, but every field is optional):

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `cursor` | string or null | no | length >= 1 | nextCursor of the previous page; omit for the first page |
| `limit` | integer | no | 1-60; default `24` |  |

Request body shape (placeholders, not real values):

```json
{
  "cursor": "<cursor>",
  "limit": 24
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `items` | array<object> | yes |  | The caller's patterns, generated and refined, most recently made first |
| `items[].imageUrl` | string (uri) | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `items[].thumbnailUrl` | string (uri) | yes |  |  |
| `items[].width` | integer | yes | > 0 |  |
| `items[].height` | integer | yes | > 0 |  |
| `items[].patternId` | string | yes | length >= 1 | Opaque ID of one pattern: an immutable image. A refine makes a new pattern. |
| `items[].prompt` | string or null | yes |  | The prompt of the generation this pattern comes from, through any refines; null when none made it |
| `items[].sourcePatternId` | string or null | yes | length >= 1 | The pattern a refine was made from; null for a generation |
| `items[].createdAt` | string (date-time) | yes |  |  |
| `nextCursor` | string or null | yes |  | Opaque; pass back unchanged. Null on the last page. |

Response shape:

```json
{
  "items": [
    {
      "imageUrl": "https://...",
      "thumbnailUrl": "https://...",
      "width": 1,
      "height": 1,
      "patternId": "<patternId>",
      "prompt": "<prompt>",
      "sourcePatternId": "<sourcePatternId>",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "nextCursor": "<nextCursor>"
}
```

**Notes**

- [DOC] Newest first. `limit` 1 to 60 (default 24). Paginate with `nextCursor` (section 3.4). `references/list` says a reference that was refined or made into a product is "also listed by patterns.list".

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.4 `POST /patterns/refine/edit`  Edit a pattern  (`patterns.refine.edit`)

Docs page: https://docs.arcade.ai/api-reference/refine/edit-a-pattern

> Starts a job that edits a pattern from a text instruction.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `instruction` | string | yes | length 1-1000 |  |
| `referenceId` | string | no | length >= 1 | A reference or another pattern to guide the edit |
| `colors` | array<string> | no | items 0-10 | #RRGGBB hex, or Arcade palette or Pantone color tokens |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "instruction": "<instruction>",
  "referenceId": "<referenceId>",
  "colors": [
    "<colors>"
  ]
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [DOC] Starts a job that makes a new pattern; the source pattern is never changed. `referenceId` is "A reference or another pattern to guide the edit", so it accepts a reference ID (section 7.2) or a pattern ID. `colors` has the same format as in `patterns/create`.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.5 `POST /patterns/refine/editRegion`  Edit a region  (`patterns.refine.editRegion`)

Docs page: https://docs.arcade.ai/api-reference/refine/edit-a-region

> Starts a job that edits only the masked area of a pattern.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `instruction` | string | yes | length 1-1000 |  |
| `mask` | string | yes | length >= 1 | PNG data URL with the source revision's aspect ratio (the short side may differ by 1 pixel) and a long edge of at most 1536 pixels; it is scaled to the image the edit runs on. Pixels with alpha above 0 are editable, and the selection must cover at least 16 x 16 pixels at that size. |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "instruction": "<instruction>",
  "mask": "<mask>"
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [SPEC] `mask` is a PNG data URL (`data:image/png;base64,...`). Same aspect ratio as the source pattern (short side may differ by 1 pixel), long edge at most 1536 pixels, scaled to the image the edit runs on. Pixels with alpha above 0 are editable; the editable selection must cover at least 16 x 16 pixels at that size.
- [DOC] Request body limit is 1 MB (larger returns `413` as plain text), so keep the data URL small.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.6 `POST /patterns/refine/recolorClusters`  Retrieve color clusters  (`patterns.refine.recolorClusters`)

Docs page: https://docs.arcade.ai/api-reference/refine/retrieve-color-clusters

> Lists a pattern's dominant colors, to choose replacements for `recolor`.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to recolor |
| `clusterCount` | integer | no | 2-20 | Omit to let the service choose; recolor must repeat the value |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "clusterCount": 2
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `clusters` | array<object> | yes |  |  |
| `clusters[].clusterId` | string | yes |  | Pass back to recolor with a new color |
| `clusters[].color` | string | yes | regex `^#[0-9a-fA-F]{6}$` | The cluster’s current color |

Response shape:

```json
{
  "clusters": [
    {
      "clusterId": "<clusterId>",
      "color": "#RRGGBB"
    }
  ]
}
```

**Notes**

- [DOC] Synchronous: returns `clusters` directly, no job, no new pattern.
- [SPEC] If you send `clusterCount` here, `recolor` must repeat the same value. Omit it to let the service choose.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.7 `POST /patterns/refine/recolor`  Recolor a pattern  (`patterns.refine.recolor`)

Docs page: https://docs.arcade.ai/api-reference/refine/recolor-a-pattern

> Starts a job that replaces a pattern's dominant colors.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `colors` | array<object> | yes | items >= 2 | One color for every cluster recolorClusters returned; at least one must change |
| `colors[].clusterId` | string | yes | length >= 1 |  |
| `colors[].color` | string | yes | regex `^#[0-9a-fA-F]{6}$` | #RRGGBB |
| `clusterCount` | integer | no | 2-20 | Omit to let the service choose; recolor must repeat the value |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "colors": [
    {
      "clusterId": "<clusterId>",
      "color": "#RRGGBB"
    }
  ],
  "clusterCount": 2
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [SPEC] `colors` needs one entry for EVERY cluster that `recolorClusters` returned (at least 2 entries) and at least one color must differ from the current one. You cannot recolor with arbitrary colors without cluster IDs. Colors are strict `#RRGGBB` (regex `^#[0-9a-fA-F]{6}$`).

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.8 `POST /patterns/refine/crop`  Crop a pattern  (`patterns.refine.crop`)

Docs page: https://docs.arcade.ai/api-reference/refine/crop-a-pattern

> Starts a job that crops a pattern to a rectangle.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `rectangle` | object | yes |  | In the source revision's pixels |
| `rectangle.left` | integer | yes | >= 0 |  |
| `rectangle.top` | integer | yes | >= 0 |  |
| `rectangle.width` | integer | yes | >= 16 |  |
| `rectangle.height` | integer | yes | >= 16 |  |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "rectangle": {
    "left": 0,
    "top": 0,
    "width": 16,
    "height": 16
  }
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [SPEC] `rectangle` is in the pixels of the source pattern (get `width`/`height` from `patterns/get`). `width` and `height` are at least 16. Makes a new pattern.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.9 `POST /patterns/refine/makeSeamless`  Make a pattern seamless  (`patterns.refine.makeSeamless`)

Docs page: https://docs.arcade.ai/api-reference/refine/make-a-pattern-seamless

> Starts a job that turns a square region into a seamless repeat.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `tile` | object | yes |  | Square region, in the source revision's pixels, to turn into a seamless repeat tile |
| `tile.left` | integer | yes | >= 0 |  |
| `tile.top` | integer | yes | >= 0 |  |
| `tile.size` | integer | yes | >= 16 |  |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "tile": {
    "left": 0,
    "top": 0,
    "size": 16
  }
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [SPEC] `tile` is a square region (`left`, `top`, `size`, all pixels of the source pattern; `size` at least 16) that is turned into a seamless repeat tile.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.10 `POST /patterns/refine/extendPattern`  Extend a pattern  (`patterns.refine.extendPattern`)

Docs page: https://docs.arcade.ai/api-reference/refine/extend-a-pattern

> Starts a job that extends a repeating pattern to a larger size.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `targetHeight` | integer | yes | 16-1536 |  |
| `targetWidth` | integer | yes | 16-1536 |  |
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |

Request body shape (placeholders, not real values):

```json
{
  "targetHeight": 16,
  "targetWidth": 16,
  "requestId": "<requestId>",
  "patternId": "<patternId>"
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [DOC] For REPEATING patterns. `targetWidth` and `targetHeight` are each 16 to 1536 pixels. Use `extendScene` for non-repeating images.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.11 `POST /patterns/refine/extendScene`  Extend a scene  (`patterns.refine.extendScene`)

Docs page: https://docs.arcade.ai/api-reference/refine/extend-a-scene

> Starts a job that extends a non-repeating image beyond its edges.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `targetHeight` | integer | yes | 16-1536 |  |
| `targetWidth` | integer | yes | 16-1536 |  |
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |

Request body shape (placeholders, not real values):

```json
{
  "targetHeight": 16,
  "targetWidth": 16,
  "requestId": "<requestId>",
  "patternId": "<patternId>"
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [DOC] For NON-repeating images (extends beyond the edges). Same request fields and 16 to 1536 limits as `extendPattern`.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.12 `POST /patterns/refine/fixDeformity`  Fix deformities  (`patterns.refine.fixDeformity`)

Docs page: https://docs.arcade.ai/api-reference/refine/fix-deformities

> Starts a job that detects and repairs malformed details in a pattern.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `maxPasses` | integer | yes | 1-3 |  |
| `force` | boolean | no | default `false` | Attempt a repair even when the scan finds no deformity |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "maxPasses": 1,
  "force": false
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [SPEC] `maxPasses` is REQUIRED (integer 1 to 3); the `arcade-api` skill's refine table omits it. `force: true` attempts a repair even when the scan finds nothing.
- [DOC] A succeeded job can have `result: null` when nothing needed repair. Treat that as success.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.13 `POST /patterns/refine/upscale`  Upscale a pattern  (`patterns.refine.upscale`)  [HIDDEN / NOT AVAILABLE]

Docs page: NOT in llms.txt index (page exists at https://docs.arcade.ai/api-reference/refine/upscale-a-pattern.md; openapi.json marks the operation `x-hidden`)

> Not available through the API. Upscaling is a paid feature of Arcade Studio; requests fail with `403`.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to refine |
| `expectedCreditCost` | integer | no | >= 0 | Highest credit cost you accept; rejected if the current cost is higher. Omit to accept the current cost. |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "expectedCreditCost": 0
}
```

**Response 200**: a Job object (shape in section 3.3). Schema note: "A download job; succeeded at once when this pattern was already upscaled".

**Notes**

- [SPEC] Marked `x-hidden` in openapi.json and absent from llms.txt, but the page https://docs.arcade.ai/api-reference/refine/upscale-a-pattern.md returns 200. Do not build on it: "Not available through the API ... requests fail with `403`". The `expectedCreditCost` field is the only place the docs mention Studio credits.
- [LIVE] Confirmed 2026-10-11: `{"requestId":"...","patternId":"...","expectedCreditCost":1}` against a real pattern returned `403 FORBIDDEN` with `{"code":"FORBIDDEN","status":403,"message":"Upscaling is a paid feature of Arcade Studio and is not available through the API."}`. The low `expectedCreditCost` cap did not change the outcome; the block is unconditional, not a cost-cap rejection.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.14 `POST /jobs/get`  Retrieve a job  (`jobs.get`)

Docs page: https://docs.arcade.ai/api-reference/jobs/retrieve-a-job

> Retrieves a job. Poll until `status` is `succeeded` or `failed`.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `jobId` | string | yes | length >= 1 | Opaque job ID; read the job with jobs.get |

Request body shape (placeholders, not real values):

```json
{
  "jobId": "<jobId>"
}
```

**Response 200**: a Job object (shape in section 3.3).

**Notes**

- [DOC] Poll until `status` is `succeeded` or `failed` (section 6). Works for any job from `patterns/create`, any `patterns/refine/*` job, and `products/create`.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.15 `POST /references/createUpload`  Create an upload URL  (`references.createUpload`)

Docs page: https://docs.arcade.ai/api-reference/references/create-an-upload-url

> Returns a signed URL to upload a reference image to. `PUT` the file, then call `references/create`.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `mediaType` | enum | yes | values: `image/gif`, `image/jpeg`, `image/png`, `image/webp` | Content-Type of the file; references.create checks the bytes |
| `byteLength` | integer | yes | <= 10485760; > 0 | Declared file size, at most 10 MiB. The URL does not bind the size; references.create checks the stored bytes. |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "mediaType": "image/gif",
  "byteLength": 1
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `uploadId` | string | yes | regex `^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(gif\|jpg\|png\|webp)$` | From createUpload; valid only for the caller that created it |
| `uploadUrl` | string (uri) | yes |  | Signed URL to PUT the file bytes to. Host not guaranteed. |
| `method` | const "PUT" | yes |  |  |
| `requiredHeaders` | object | yes |  | Headers the PUT must send exactly; the signature binds them |
| `requiredHeaders.Content-Type` | string | yes |  |  |
| `expiresAt` | string (date-time) | yes |  | The URL is rejected after this time |

Response shape:

```json
{
  "uploadId": "<uploadId>",
  "uploadUrl": "https://...",
  "method": "PUT",
  "requiredHeaders": {
    "Content-Type": "<Content-Type>"
  },
  "expiresAt": "2026-01-01T00:00:00Z"
}
```

**Notes**

- [SPEC] `mediaType` is one of `image/gif`, `image/jpeg`, `image/png`, `image/webp`. `byteLength` is 1 to 10485760 (10 MiB) and is only declared: "The URL does not bind the size; references.create checks the stored bytes."
- [SPEC] Then `PUT` the raw file bytes to `uploadUrl` with EXACTLY the headers in `requiredHeaders` (the signature binds them). The `uploadUrl` host is not guaranteed and it is not the Arcade API: do not send your API key to it. The URL stops working after `expiresAt`.
- [DOC] Retrying `references/createUpload` with its original `requestId` after the upload was already saved returns `409 CONFLICT`; use a new `requestId` to upload another file. `uploadId` is "valid only for the caller that created it". Format: `<uuid>.<gif|jpg|png|webp>`.
- [LIVE] 2026-10-11: for a 209-byte PNG, `uploadUrl` and `uploadId` came back on `storage.googleapis.com/b2b-designs/uploads/<account>/<uploadId>` (V4-signed, `X-Goog-Expires=600`, i.e. the upload URL itself expires in 10 minutes — shorter than most other short-lived URLs in this API). `requiredHeaders` was exactly `{"Content-Type":"image/png"}`; the plain `PUT` with that one header and no API key returned `200` with an empty body.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.16 `POST /references/create`  Create a reference  (`references.create`)

Docs page: https://docs.arcade.ai/api-reference/references/create-a-reference

> Saves an uploaded image as a reference for `patterns/create`.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `uploadId` | string | yes | regex `^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(gif\|jpg\|png\|webp)$` | From references.createUpload, once the file was PUT |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "uploadId": "<uploadId>"
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `imageUrl` | string (uri) | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `thumbnailUrl` | string (uri) | yes |  |  |
| `width` | integer | yes | > 0 |  |
| `height` | integer | yes | > 0 |  |
| `mediaType` | enum | yes | values: `image/gif`, `image/jpeg`, `image/png`, `image/webp` |  |
| `referenceId` | string | yes | length >= 1 | Opaque ID of one uploaded reference image |
| `createdAt` | string (date-time) | yes |  |  |

Response shape:

```json
{
  "imageUrl": "https://...",
  "thumbnailUrl": "https://...",
  "width": 1,
  "height": 1,
  "mediaType": "image/gif",
  "referenceId": "<referenceId>",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

**Notes**

- [SKILL] Calling `references/create` again with the same `uploadId` returns the existing reference (200, same `referenceId`) even with a new `requestId`; it does not create a duplicate.
- [SPEC] Checks the stored bytes (type, size). Returns the reference with `width`, `height`, `mediaType`, short-lived `imageUrl`/`thumbnailUrl`.
- [LIVE] 2026-10-11: a 64x64 PNG upload came back as `{"width":64,"height":64,"mediaType":"image/png",...}` — `width`/`height` are the real decoded pixel dimensions of the uploaded file, not a fixed/rounded value. `imageUrl` was `.../b2b-designs/uploads/<account>/<uploadId>-stored.png` (same bucket as the upload, suffixed `-stored`), signed for 1 hour (`X-Goog-Expires=3600`) — longer-lived than the `createUpload` URL itself.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.17 `POST /references/get`  Retrieve a reference  (`references.get`)

Docs page: https://docs.arcade.ai/api-reference/references/retrieve-a-reference

> Retrieves a reference image.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `referenceId` | string | yes | length >= 1 | Opaque ID of one uploaded reference image |

Request body shape (placeholders, not real values):

```json
{
  "referenceId": "<referenceId>"
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `imageUrl` | string (uri) | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `thumbnailUrl` | string (uri) | yes |  |  |
| `width` | integer | yes | > 0 |  |
| `height` | integer | yes | > 0 |  |
| `mediaType` | enum | yes | values: `image/gif`, `image/jpeg`, `image/png`, `image/webp` |  |
| `referenceId` | string | yes | length >= 1 | Opaque ID of one uploaded reference image |
| `createdAt` | string (date-time) | yes |  |  |

Response shape:

```json
{
  "imageUrl": "https://...",
  "thumbnailUrl": "https://...",
  "width": 1,
  "height": 1,
  "mediaType": "image/gif",
  "referenceId": "<referenceId>",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.18 `POST /references/list`  List references  (`references.list`)

Docs page: https://docs.arcade.ai/api-reference/references/list-references

> Lists your references, newest first.

**Request**, JSON object (body is required, but every field is optional):

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `cursor` | string or null | no | length >= 1 | nextCursor of the previous page; omit for the first page |
| `limit` | integer | no | 1-60; default `24` |  |

Request body shape (placeholders, not real values):

```json
{
  "cursor": "<cursor>",
  "limit": 24
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `items` | array<object> | yes |  | Newest first. A reference that was refined or made into a product stays listed here and is also listed by patterns.list. |
| `items[].imageUrl` | string (uri) | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `items[].thumbnailUrl` | string (uri) | yes |  |  |
| `items[].width` | integer | yes | > 0 |  |
| `items[].height` | integer | yes | > 0 |  |
| `items[].mediaType` | enum | yes | values: `image/gif`, `image/jpeg`, `image/png`, `image/webp` |  |
| `items[].referenceId` | string | yes | length >= 1 | Opaque ID of one uploaded reference image |
| `items[].createdAt` | string (date-time) | yes |  |  |
| `nextCursor` | string or null | yes |  | Opaque; pass back unchanged. Null on the last page. |

Response shape:

```json
{
  "items": [
    {
      "imageUrl": "https://...",
      "thumbnailUrl": "https://...",
      "width": 1,
      "height": 1,
      "mediaType": "image/gif",
      "referenceId": "<referenceId>",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "nextCursor": "<nextCursor>"
}
```

**Notes**

- [SPEC] `limit` 1 to 60 (default 24).

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.19 `POST /models/list`  List models  (`models.list`)

Docs page: https://docs.arcade.ai/api-reference/models/list-models

> Lists the models you can generate patterns with.

**Request**, JSON object:

Send an empty object: `{}`. No fields are defined.

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `items` | array<object> | yes |  | The generation models patterns.create accepts |
| `items[].modelId` | string | yes |  |  |
| `items[].name` | string | yes |  |  |

Response shape:

```json
{
  "items": [
    {
      "modelId": "<modelId>",
      "name": "<name>"
    }
  ]
}
```

**Notes**

- [SPEC] Send `{}`. Returns only `modelId` and `name` per model. Which models exist, and their cost or style, is runtime data: UNVERIFIED. (Studio's marketing page mentions "Arcade Canon" curated models and custom brand models; not confirmed as API model names.)
- [LIVE] 2026-10-11, 26 models came back, none named "Arcade Canon": `batik`/"Indonesian Batik", `chinoiserie`/"East Asian", `arts-and-crafts-floral`/"Arts and Crafts Floral", `victorian-floral`/"Archival British Floral", `parisian-garden`/"Archival French Floral", `marbled-paper`/"Archival Hand Marbled", `stamped-floral`/"Ukrainian Folk Art", `french-floral-wallpaper`/"French Floral Wallpaper", `art-nouveau`/"Art Nouveau", `japanese-botanical`/"Japanese Botanical", `japanese-woodblock`/"Japanese Woodblock", `french-neoclassical`/"French Neoclassical", `indian-textiles`/"Indian Textiles", `american-aesthetic-movement`/"American Aesthetic Movement", `gilded-age-frieze`/"Gilded Age Frieze", `gilded-age`/"Gilded Age", `austrian-biedermeier`/"Austrian Biedermeier", `estonian-watercolor`/"Estonian Watercolor", `toile`/"Toile", `impressionism`/"Impressionism", `nonpareil-hand-marbled`/"Nonpareil Hand Marbled", `french-rococo`/"French Rococo", `european-tapestry`/"European Tapestry", `italian-silk`/"Italian Silk", `meiji-period`/"Meiji Period", `mughal-watercolor`/"Mughal Watercolor". All are named art/textile styles; no pricing or cost tier came back with them. Treat as a snapshot, not a contract: the list is runtime data and can change.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.20 `POST /categories/list`  List categories  (`categories.list`)

Docs page: https://docs.arcade.ai/api-reference/categories/list-categories

> Lists the product categories available to order.

**Request**, JSON object:

Send an empty object: `{}`. No fields are defined.

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `items` | array<object> | yes |  | The categories products can be made in |
| `items[].categoryId` | string | yes | length >= 1 | Category ID, from categories.list |
| `items[].name` | string | yes |  |  |
| `items[].imageUrl` | string (uri) or null | yes |  | Category image; null when there is none. Host and lifetime not guaranteed. |
| `items[].world` | enum `print` \| `jewelry` | yes |  | How products in this category are made. `print`: from a pattern, by `products/create` or by `patterns/create` with this `categoryId`. `jewelry`: from a design made for this category, only by `patterns/create` with this `categoryId` |
| `items[].category` | object | no |  | The group this category is in, e.g. `Rings` for `Dainty Diamond Ring`; absent when it has none |
| `items[].category.categoryId` | string | yes (if present) | length >= 1 | Group ID; the `categoryId` of the group when it is also a category |
| `items[].category.name` | string | yes (if present) |  |  |

**[SPEC] correction (2026-10-11):** `world` and `category` are both in `openapi.json`'s `categories/list` response schema; the table above initially omitted them when this doc was first generated. Fixed here.

Response shape:

```json
{
  "items": [
    {
      "categoryId": "<categoryId>",
      "name": "<name>",
      "imageUrl": "https://...",
      "world": "print",
      "category": {
        "categoryId": "<groupCategoryId>",
        "name": "<groupName>"
      }
    }
  ]
}
```

**Notes**

- [DOC] Do not hardcode category IDs; discover them here. No category names, options or prices are published in the docs: they come back at runtime and need an API key.
- [LIVE] 2026-10-11, 29 categories came back, every `imageUrl` non-null for `print` and `null` for `jewelry`: 21 `world: "print"` categories (Decorative Pillows, Outdoor Decorative Pillows, Scarves, Ribbon Scarf, Napkins, Placemats, Outdoor Placemats, Tablecloths, Table Runners, Duvets, Shams, Quilts, Quilted Shams, Drum Lampshades, Tall Drum Lampshades, Rectangular Lampshades, Pocket Squares, Curtains, Fabric By The Yard, Floor Pillows, Tea Towels) and 8 `world: "jewelry"` categories (Dainty Diamond Ring, Dainty Gemstone Earrings, Rings, Stud Earrings, Dainty Gemstone Ring, Pendant Necklace, Initial Earrings, Dangle Earrings), the last 4 of which group under `Rings`/`Earrings`/`Necklaces` via `category`.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.21 `POST /categories/get`  Retrieve a category  (`categories.get`)

Docs page: https://docs.arcade.ai/api-reference/categories/retrieve-a-category

> Retrieves a category and its options. Not every combination of option values can be made: send the values you have decided, in any number, and each value comes back with `available`, whether some product that can be made has that value together with every value you sent for the other options.
>
> Walk to any product without guessing, one call for each value you add:
>
> 1. Call with `selections: {}`. If the returned `selections` suits you, pass it to `products.create`.
> 2. Otherwise pick a value with `available: true` for an option you have not sent, add it to `selections`, and call again.
> 3. Repeat until `selections` suits you.
>
> Choosing only available values never dead-ends, and every product that can be made is reachable in any order. If the values you send cannot be made together, `canManufacture` is `false`: the values you sent that are marked unavailable are the conflict, and the available values of those options are the ways out.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `categoryId` | string | yes | length >= 1 | Category ID, from categories.list |
| `selections` | map<string,string> | no | default `{}` | The values you have decided, option key to option value, in any number including none; options you leave out are open |

Request body shape (placeholders, not real values):

```json
{
  "categoryId": "<categoryId>",
  "selections": {
    "<optionKey>": "<optionValue>"
  }
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `categoryId` | string | yes | length >= 1 | Category ID, from categories.list |
| `name` | string | yes |  |  |
| `options` | array<object> | yes |  |  |
| `options[].key` | string | yes |  | Option key, as used in selections |
| `options[].label` | string | yes |  |  |
| `options[].values` | array<object> | yes |  |  |
| `options[].values[].value` | string | yes |  |  |
| `options[].values[].label` | string | yes |  |  |
| `options[].values[].isDefault` | boolean | yes |  |  |
| `options[].values[].available` | boolean | yes |  | Whether some product that can be made has this value together with every value you sent for the other options |
| `selections` | map<string,string> | yes |  | A complete selection that keeps every value you sent: each open option takes its default where that can still be made, else another available value. Pass it to products.create when canManufacture is true |
| `canManufacture` | boolean | yes |  | Whether selections can be made; products.create uses the lowest-priced maker that can make it. False when the values you sent cannot be made together, and selections then fills the open options with their defaults |

Response shape:

```json
{
  "categoryId": "<categoryId>",
  "name": "<name>",
  "options": [
    {
      "key": "<key>",
      "label": "<label>",
      "values": [
        {
          "value": "<value>",
          "label": "<label>",
          "isDefault": false,
          "available": false
        }
      ]
    }
  ],
  "selections": {
    "<optionKey>": "<optionValue>"
  },
  "canManufacture": false
}
```

**Notes**

- [DOC] Walk algorithm: (1) call with `selections: {}`; if the returned `selections` suits you, pass it to `products/create`. (2) Otherwise pick a value with `available: true` for an option you have not sent, add it to `selections`, call again. (3) Repeat. Only choosing available values never dead-ends. If the values you sent cannot be made together, `canManufacture` is `false`.
- [SKILL] Pass `products/create` the complete `selections` object from the latest RESPONSE, not the empty or partial object you sent. `canManufacture` describes the returned selection and can already be `true` on the first call.
- [SPEC] `products/create` uses "the lowest-priced maker that can make it".
- [LIVE] 2026-10-11, `{"categoryId":"c314010b-e15a-4014-a376-9b8f4e973461","selections":{}}` (Napkins) returned `canManufacture: true` on the first call, with:
  ```json
  {
    "categoryId": "c314010b-e15a-4014-a376-9b8f4e973461",
    "name": "Napkins",
    "options": [
      { "key": "fabric", "label": "Fabric", "values": [
        { "value": "cotton", "label": "Everyday Cotton", "isDefault": true, "available": true },
        { "value": "linen", "label": "Crisp Linen", "isDefault": false, "available": true },
        { "value": "refined_linen", "label": "Refined Linen", "isDefault": false, "available": true }
      ] },
      { "key": "size", "label": "Size", "values": [
        { "value": "20x20", "label": "20\" x 20\"", "isDefault": true, "available": true },
        { "value": "5x5", "label": "5\" x 5\"", "isDefault": false, "available": true }
      ] }
    ],
    "selections": { "fabric": "cotton", "size": "20x20" },
    "canManufacture": true,
    "world": "print"
  }
  ```
  Note `world` also comes back here, same as `categories/list` (not in the generated table above either — same spec-correction as section 5.20).

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.22 `POST /products/create`  Create a product  (`products.create`)

Docs page: https://docs.arcade.ai/api-reference/products/create-a-product

> Starts a job that builds a product from a pattern, a category and its options. On success, `result.productId` is the new product.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `patternId` | string | yes | length >= 1 | The pattern to make it from |
| `categoryId` | string | yes | length >= 1 | Category ID, from categories.list |
| `selections` | map<string,string> | yes |  | The complete selection, as categories.get returns it |
| `fit` | union of 2 objects (see Notes) | no |  | How the pattern fits the product; required when the pattern's aspect ratio does not match the selected size. A crop is in the pattern's pixels. |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "patternId": "<patternId>",
  "categoryId": "<categoryId>",
  "selections": {
    "<optionKey>": "<optionValue>"
  },
  "fit": {
    "crop": {
      "height": 16,
      "left": 0,
      "top": 0,
      "width": 16
    },
    "mode": "crop",
    "zoomLevel": 1
  }
}
```

**Response 200**: a Job object (shape in section 3.3). Schema note: "A product job; its result names the product once built".

**Notes**

- [SPEC] `fit` is a union of two shapes. Required "when the pattern's aspect ratio does not match the selected size"; omit it when the ratios match.
  - Crop: `{ "mode": "crop", "crop": { "left": 0, "top": 0, "width": 16, "height": 16 }, "zoomLevel": 1 }` where `crop` is in the pattern's pixels (`left`/`top` at least 0, `width`/`height` at least 16) and `zoomLevel` is exactly one of 1, 2, 3, 4, 8, 12.
  - Fill: `{ "mode": "fill" }` (no other keys allowed).
  - What `fill` and `zoomLevel` do visually, how a missing `fit` fails (422 vs failed job), and whether sending `fit` when ratios already match is accepted: UNVERIFIED. [LIVE] 2026-10-11: a 1024x1024 pattern (`patterns/create`'s default output size, no size parameter exists on that request) built into Napkins `size: "20x20"` (also square) WITH `"fit": {"mode": "fill"}` sent anyway, and the job still succeeded — so `fill` is accepted even when the ratios already match; it is not rejected as redundant. Whether `fit` can be omitted entirely in that case is still UNVERIFIED (not tried).
- [DOC] Quickstart request (docs example, IDs are examples):
  `{ "requestId": "linen-florals-napkins-1", "patternId": "cmujgkfnk0004pc10nt3kghxd", "categoryId": "c314010b-e15a-4014-a376-9b8f4e973461", "selections": { "fabric": "cotton", "size": "20x20" } }`
- [DOC] A new product appears in `products/list` once its job succeeded; `products/get` then adds images, copy and pricing.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.23 `POST /products/get`  Retrieve a product  (`products.get`)

Docs page: https://docs.arcade.ai/api-reference/products/retrieve-a-product

> Retrieves a product with its images, maker and price. Pass `quantity` to price that quantity.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `productId` | string | yes | length >= 1 | Opaque product ID |
| `quantity` | integer | no | >= 1; default `1` | The quantity pricing is quoted for |

Request body shape (placeholders, not real values):

```json
{
  "productId": "<productId>",
  "quantity": 1
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `productId` | string | yes | length >= 1 | Opaque product ID |
| `title` | string | yes |  |  |
| `categoryId` | string | yes | length >= 1 | Category ID, from categories.list |
| `maker` | object | yes |  |  |
| `maker.makerId` | string | yes |  |  |
| `maker.name` | string | yes |  |  |
| `selections` | map<string,string> | yes |  | The selection the product was made with, option value per option key |
| `selectionLabel` | string | yes |  | Human-readable summary of the selection |
| `imageUrl` | string (uri) | yes |  | Thumbnail of the primary product image. Short-lived; read again to renew. Host not guaranteed. |
| `createdAt` | string (date-time) | yes |  |  |
| `images` | array<object> | yes |  | Product images, primary first |
| `images[].url` | string (uri) | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `description` | string or null | yes |  | Product details; null when they cannot be loaded |
| `careInstructions` | string | yes |  | Empty when there are none or they cannot be loaded right now |
| `volumeDiscounts` | object or null | yes |  | Spend tiers of the maker's volume discount; empty when it has none, and null when they are unavailable right now |
| `volumeDiscounts.currency` | string | yes |  | ISO 4217 code |
| `volumeDiscounts.tiers` | array<object> | yes |  |  |
| `volumeDiscounts.tiers[].minimumSpend` | string | yes |  | Decimal amount |
| `volumeDiscounts.tiers[].maximumSpend` | string or null | yes |  | Decimal amount; null for the open-ended last tier |
| `volumeDiscounts.tiers[].discountPercent` | number | yes |  |  |
| `patternId` | string | yes | length >= 1 | The pattern the product was made from |
| `unitPrice` | object or null | yes |  | The price of one unit when ordering quantity, before the volume discount; null while pricing is unavailable, so read again later |
| `unitPrice.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `unitPrice.currency` | string | yes |  | ISO 4217 code |

Response shape:

```json
{
  "productId": "<productId>",
  "title": "<title>",
  "categoryId": "<categoryId>",
  "maker": {
    "makerId": "<makerId>",
    "name": "<name>"
  },
  "selections": {
    "<optionKey>": "<optionValue>"
  },
  "selectionLabel": "<selectionLabel>",
  "imageUrl": "https://...",
  "createdAt": "2026-01-01T00:00:00Z",
  "images": [
    {
      "url": "https://..."
    }
  ],
  "description": "<description>",
  "careInstructions": "<careInstructions>",
  "volumeDiscounts": {
    "currency": "<ISO 4217 code>",
    "tiers": [
      {
        "minimumSpend": "<minimumSpend>",
        "maximumSpend": "<maximumSpend>",
        "discountPercent": 0
      }
    ]
  },
  "patternId": "<patternId>",
  "unitPrice": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  }
}
```

**Notes**

- [SPEC] `unitPrice` = `{ "amount": "48.00", "currency": <ISO 4217> }`: price of ONE unit when ordering `quantity`, before the volume discount; `null` while pricing is unavailable ("read again later"). So the price is not guaranteed to be instant. Shipping and tax are not mentioned (presumably excluded: UNVERIFIED).
- [SPEC] `images` (primary first) are the product mockups/photos; `imageUrl` is a thumbnail of the primary one. Both short-lived, host not guaranteed.
- [SPEC] `volumeDiscounts.tiers[]` = spend tiers of the maker's volume discount (`minimumSpend`, `maximumSpend` null on the open-ended last tier, `discountPercent`); `[]` when none, `null` when unavailable.
- [LIVE] 2026-10-11, a Napkins product (cotton, 20x20) built from the pattern above, `quantity: 1`:
  - `title`: `"Everyday Cotton Dinner Napkins (Set of 4)"` — built from the option VALUE labels + a display name for the category ("Dinner Napkins", not the bare `categories/list` name "Napkins") + a pack-size suffix. NOT derived from the pattern's prompt text.
  - `maker`: `{"makerId":"294facb5-9ff1-4ae6-b1c6-e6e94cf64849","name":"Esme"}`.
  - `selectionLabel`: `"Everyday Cotton • 20\" x 20\""` — value labels joined by `" • "`, not `"<option label>: <value>"`.
  - `unitPrice`: `{"amount":"33.96","currency":"USD"}` for quantity 1.
  - `volumeDiscounts.tiers`: 5 tiers by spend, not the round numbers you might guess: `$1.00-200.00` 0%, `$201.00-450.00` 9.5%, `$451.00-1200.00` 14.6%, `$1201.00-2450.00` 19.8%, `$2451.00+` 24.9%.
  - `description` and `careInstructions` were both non-empty, multi-line, maker-authored marketing copy (varies per fabric choice within one product's `careInstructions`), not a template string.
  - `images`: 5 URLs for one product (`baseform_overlay_image`, `single_corner_overlay_image`, `single_folded_overlay_image`, `multi_folded_overlay_image`, `insitu_overlay_image` — overlay renders of the pattern on product mockups), all on `storage.googleapis.com/public-user-designs-arcade-ai-prod/...` (signed GCS URLs, not the `b2b-designs` bucket that patterns/references use).

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.24 `POST /products/list`  List products  (`products.list`)

Docs page: https://docs.arcade.ai/api-reference/products/list-products

> Lists your products, newest first.

**Request**, JSON object (body is required, but every field is optional):

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `cursor` | string or null | no | length >= 1 | nextCursor of the previous page; omit for the first page |
| `limit` | integer | no | 1-100; default `24` |  |

Request body shape (placeholders, not real values):

```json
{
  "cursor": "<cursor>",
  "limit": 24
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `items` | array<object> | yes |  | Newest first. A new product appears once jobs.get reports its job succeeded; products.get adds images, copy and pricing. |
| `items[].productId` | string | yes | length >= 1 | Opaque product ID |
| `items[].title` | string | yes |  |  |
| `items[].categoryId` | string | yes | length >= 1 | Category ID, from categories.list |
| `items[].maker` | object | yes |  |  |
| `items[].maker.makerId` | string | yes |  |  |
| `items[].maker.name` | string | yes |  |  |
| `items[].selections` | map<string,string> | yes |  | The selection the product was made with, option value per option key |
| `items[].selectionLabel` | string | yes |  | Human-readable summary of the selection |
| `items[].imageUrl` | string (uri) | yes |  | Thumbnail of the primary product image. Short-lived; read again to renew. Host not guaranteed. |
| `items[].createdAt` | string (date-time) | yes |  |  |
| `items[].patternId` | string | yes | length >= 1 | The pattern the product was made from |
| `nextCursor` | string or null | yes |  | Opaque; pass back unchanged. Null on the last page. |

Response shape:

```json
{
  "items": [
    {
      "productId": "<productId>",
      "title": "<title>",
      "categoryId": "<categoryId>",
      "maker": {
        "makerId": "<makerId>",
        "name": "<name>"
      },
      "selections": {
        "<optionKey>": "<optionValue>"
      },
      "selectionLabel": "<selectionLabel>",
      "imageUrl": "https://...",
      "createdAt": "2026-01-01T00:00:00Z",
      "patternId": "<patternId>"
    }
  ],
  "nextCursor": "<nextCursor>"
}
```

**Notes**

- [SPEC] `limit` 1 to 100 (default 24). Only summary fields; call `products/get` for `images`, `description`, `careInstructions`, `volumeDiscounts`, `unitPrice`.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.25 `POST /checkouts/create`  Create a checkout  (`checkouts.create`)

Docs page: https://docs.arcade.ai/api-reference/checkouts/create-a-checkout

> Creates a checkout for your products. Open `checkoutUrl` to pay; the order is placed once payment completes. If any line has `quantity: 1`, set `"dropShip": true` in the request body unless you have an active subscription. Omitting `dropShip` or setting it to `false` without an active subscription returns `412 PRECONDITION_FAILED` for these lines.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen idempotency key; a replay returns the original result |
| `lines` | array<object> | yes | items 1-50 | The caller's products to order, one line each |
| `lines[].productId` | string | yes | length >= 1 | Opaque product ID |
| `lines[].quantity` | integer | yes | 1-1000 |  |
| `dropShip` | boolean | no | default `false` | Adds the drop-ship service to the order. Defaults to false. Set to true if any line has quantity 1, unless you have an active subscription; otherwise the request returns 412 PRECONDITION_FAILED. |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "lines": [
    {
      "productId": "<productId>",
      "quantity": 1
    }
  ],
  "dropShip": false
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `checkoutId` | string | yes | regex `^\d+$` | The checkout's draft order ID; orders.get finds the order once it is placed |
| `checkoutUrl` | string (uri) | yes |  | Hosted checkout page; host not guaranteed |

Response shape:

```json
{
  "checkoutId": "1234567890",
  "checkoutUrl": "https://..."
}
```

**Notes**

- [SPEC] The ONLY inputs are `lines` (1 to 50 lines, `quantity` 1 to 1000 each) and `dropShip`. There is NO field for shipping address, email, name, payment method, currency, coupon, or webhook URL: the buyer enters those on the hosted `checkoutUrl` page.
- [SPEC] If any line has `quantity: 1` you must send `"dropShip": true` unless the account has an active subscription; otherwise `412 PRECONDITION_FAILED` (this status is not in errors.md). `dropShip` "Adds the drop-ship service to the order"; its fee is not documented: UNVERIFIED.
- [DOC] `checkoutId` is "The checkout's draft order ID" (numeric string; docs example `1129729917083`). `checkoutUrl` example: `https://checkout.arcade.ai/checkouts/...`.
- [DOC] Payment happens when a human opens `checkoutUrl`. Real money, no test mode documented. The order is placed only after payment completes. If a `checkouts/create` request is abandoned while starting, a retry can leave one extra unpaid checkout.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.26 `POST /orders/get`  Retrieve an order  (`orders.get`)

Docs page: https://docs.arcade.ai/api-reference/orders/retrieve-an-order

> Retrieves an order by `orderId`, or by `checkoutId` once the checkout is paid. Returns `404` until then.

**Request**, JSON object (body is required, but every field is optional):

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `orderId` | string | no | regex `^\d+$` | Order ID |
| `checkoutId` | string | no | regex `^\d+$` | The checkout's draft order ID; orders.get finds the order once it is placed |

Request body shape (placeholders, not real values):

```json
{
  "orderId": "1234567890",
  "checkoutId": "1234567890"
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `orderId` | string | yes | regex `^\d+$` | Order ID |
| `orderCode` | string or null | yes |  | The Arcade order code; null when there is none |
| `orderNumber` | string | yes |  | Display name, e.g. "#1042" |
| `status` | enum | yes | values: `ordered`, `cadReview`, `sampleReview`, `inProduction`, `inReview`, `inCorrection`, `approved`, `updatedInfo`, `shipped`, `delivered`, `fulfilled`, `refunded` | Derived from the makers' fulfillment and any refunds |
| `placedAt` | string (date-time) | yes |  |  |
| `total` | object | yes |  |  |
| `total.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `total.currency` | string | yes |  | ISO 4217 code |
| `itemCount` | integer | yes |  |  |
| `imageUrl` | string (uri) or null | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `lines` | array<object> | yes |  |  |
| `lines[].productId` | string or null | yes | length >= 1 | Set when the line is one of the caller's products |
| `lines[].title` | string | yes |  |  |
| `lines[].selectionLabel` | string | yes |  | Human-readable summary of the line's selection; the store's line title when the product is not the caller's |
| `lines[].quantity` | integer | yes |  |  |
| `lines[].total` | object or null | yes |  | After line discounts |
| `lines[].total.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `lines[].total.currency` | string | yes |  | ISO 4217 code |
| `lines[].imageUrl` | string (uri) or null | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `lines[].makerName` | string or null | yes |  |  |
| `subtotal` | object or null | yes |  |  |
| `subtotal.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `subtotal.currency` | string | yes |  | ISO 4217 code |
| `shipping` | object or null | yes |  |  |
| `shipping.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `shipping.currency` | string | yes |  | ISO 4217 code |
| `tax` | object or null | yes |  |  |
| `tax.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `tax.currency` | string | yes |  | ISO 4217 code |
| `volumeDiscount` | object or null | yes |  | The makers' volume discount |
| `volumeDiscount.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `volumeDiscount.currency` | string | yes |  | ISO 4217 code |
| `discounts` | object or null | yes |  | Other discounts, excluding the volume discount |
| `discounts.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `discounts.currency` | string | yes |  | ISO 4217 code |
| `shippingAddress` | object or null | yes |  |  |
| `shippingAddress.name` | string or null | yes |  |  |
| `shippingAddress.city` | string or null | yes |  |  |
| `shippingAddress.provinceCode` | string or null | yes |  |  |
| `shippingAddress.countryCode` | string or null | yes |  |  |
| `tracking` | array<object> | yes |  | Tracking of the shipments made so far |
| `tracking[].company` | string or null | yes |  |  |
| `tracking[].number` | string or null | yes |  |  |
| `tracking[].url` | string (uri) or null | yes |  |  |
| `refunds` | array<object> | yes |  |  |
| `refunds[].createdAt` | string (date-time) or null | yes |  |  |
| `refunds[].amount` | object or null | yes |  |  |
| `refunds[].amount.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `refunds[].amount.currency` | string | yes |  | ISO 4217 code |

Response shape:

```json
{
  "orderId": "1234567890",
  "orderCode": "<orderCode>",
  "orderNumber": "#1042",
  "status": "ordered",
  "placedAt": "2026-01-01T00:00:00Z",
  "total": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  },
  "itemCount": 1,
  "imageUrl": "https://...",
  "lines": [
    {
      "productId": "<productId>",
      "title": "<title>",
      "selectionLabel": "<selectionLabel>",
      "quantity": 1,
      "total": {
        "amount": "48.00",
        "currency": "<ISO 4217 code>"
      },
      "imageUrl": "https://...",
      "makerName": "<makerName>"
    }
  ],
  "subtotal": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  },
  "shipping": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  },
  "tax": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  },
  "volumeDiscount": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  },
  "discounts": {
    "amount": "48.00",
    "currency": "<ISO 4217 code>"
  },
  "shippingAddress": {
    "name": "<name>",
    "city": "<city>",
    "provinceCode": "<provinceCode>",
    "countryCode": "<countryCode>"
  },
  "tracking": [
    {
      "company": "<company>",
      "number": "<number>",
      "url": "https://..."
    }
  ],
  "refunds": [
    {
      "createdAt": "2026-01-01T00:00:00Z",
      "amount": {
        "amount": "48.00",
        "currency": "<ISO 4217 code>"
      }
    }
  ]
}
```

**Notes**

- [SPEC] Send `orderId` OR `checkoutId` (both are optional in the schema; behavior when both or neither are sent: UNVERIFIED). With `checkoutId` the order exists only after payment: `404` until then. That is normal, not an error to report.
- [SPEC] `status` is "Derived from the makers' fulfillment and any refunds". Values in order of the enum: `ordered`, `cadReview`, `sampleReview`, `inProduction`, `inReview`, `inCorrection`, `approved`, `updatedInfo`, `shipped`, `delivered`, `fulfilled`, `refunded`. The meaning of each value is not documented: UNVERIFIED.
- [SPEC] `shippingAddress` exposes only `name`, `city`, `provinceCode`, `countryCode`. `tracking[]` = `{ company, number, url }` for shipments made so far. `total`, `subtotal`, `shipping`, `tax`, `volumeDiscount`, `discounts` are money objects `{ amount: "48.00", currency }` or null.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.27 `POST /orders/list`  List orders  (`orders.list`)

Docs page: https://docs.arcade.ai/api-reference/orders/list-orders

> Lists your orders, newest first.

**Request**, JSON object (body is required, but every field is optional):

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `cursor` | string or null | no | length >= 1 | nextCursor of the previous page; omit for the first page |
| `limit` | integer | no | 1-50; default `20` |  |
| `status` | enum | no | values: `ordered`, `cadReview`, `sampleReview`, `inProduction`, `inReview`, `inCorrection`, `approved`, `updatedInfo`, `shipped`, `delivered`, `fulfilled`, `refunded` | Only orders in this status |

Request body shape (placeholders, not real values):

```json
{
  "cursor": "<cursor>",
  "limit": 20,
  "status": "ordered"
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `items` | array<object> | yes |  | Newest first |
| `items[].orderId` | string | yes | regex `^\d+$` | Order ID |
| `items[].orderCode` | string or null | yes |  | The Arcade order code; null when there is none |
| `items[].orderNumber` | string | yes |  | Display name, e.g. "#1042" |
| `items[].status` | enum | yes | values: `ordered`, `cadReview`, `sampleReview`, `inProduction`, `inReview`, `inCorrection`, `approved`, `updatedInfo`, `shipped`, `delivered`, `fulfilled`, `refunded` | Derived from the makers' fulfillment and any refunds |
| `items[].placedAt` | string (date-time) | yes |  |  |
| `items[].total` | object | yes |  |  |
| `items[].total.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `items[].total.currency` | string | yes |  | ISO 4217 code |
| `items[].itemCount` | integer | yes |  |  |
| `items[].imageUrl` | string (uri) or null | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `items[].lines` | array<object> | yes |  |  |
| `items[].lines[].productId` | string or null | yes | length >= 1 | Set when the line is one of the caller's products |
| `items[].lines[].title` | string | yes |  |  |
| `items[].lines[].selectionLabel` | string | yes |  | Human-readable summary of the line's selection; the store's line title when the product is not the caller's |
| `items[].lines[].quantity` | integer | yes |  |  |
| `items[].lines[].total` | object or null | yes |  | After line discounts |
| `items[].lines[].total.amount` | string | yes |  | Decimal amount, e.g. "48.00" |
| `items[].lines[].total.currency` | string | yes |  | ISO 4217 code |
| `items[].lines[].imageUrl` | string (uri) or null | yes |  | Short-lived; read again to renew. Host not guaranteed. |
| `items[].lines[].makerName` | string or null | yes |  |  |
| `nextCursor` | string or null | yes |  | Opaque; pass back unchanged. Null on the last page. With a status, a page can hold fewer than limit orders. |

Response shape:

```json
{
  "items": [
    {
      "orderId": "1234567890",
      "orderCode": "<orderCode>",
      "orderNumber": "#1042",
      "status": "ordered",
      "placedAt": "2026-01-01T00:00:00Z",
      "total": {
        "amount": "48.00",
        "currency": "<ISO 4217 code>"
      },
      "itemCount": 1,
      "imageUrl": "https://...",
      "lines": [
        {
          "productId": "<productId>",
          "title": "<title>",
          "selectionLabel": "<selectionLabel>",
          "quantity": 1,
          "total": {
            "amount": "48.00",
            "currency": "<ISO 4217 code>"
          },
          "imageUrl": "https://...",
          "makerName": "<makerName>"
        }
      ]
    }
  ],
  "nextCursor": "<nextCursor>"
}
```

**Notes**

- [SPEC] `limit` 1 to 50 (default 20). Optional `status` filter (same enum as `orders/get`). "With a status, a page can hold fewer than limit orders", so keep following `nextCursor` until it is null.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---

### 5.28 `POST /feedback/create`  Send feedback  (`feedback.create`)

Docs page: https://docs.arcade.ai/api-reference/feedback/send-feedback

> Sends a report about the API to the Arcade team: what you expected, what happened, and the request and response involved. Leave out credentials and personal data; the server also drops URL query strings, API keys and credential fields before the team sees the report.
>
> `requestId` identifies the report. It is not an idempotency key: a retry after an error may deliver the report twice. Returns `503` while feedback is unavailable.

**Request**, JSON object:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen ID of the report; quote it to Arcade. Not an idempotency key: a retry may deliver the report twice. |
| `text` | string | yes | length 1-4000 | What you expected, what happened and what you tried |
| `procedure` | string | no | length 1-200 | The procedure the report is about, e.g. "patterns/create" |
| `request` | object | no |  | The request the report is about |
| `request.body` | any | no |  | The JSON body you sent |
| `request.userAgent` | string | no | length 0-500 | The User-Agent you sent |
| `response` | object | no |  | The response the report is about |
| `response.status` | integer | no | 0-599 | HTTP status; 0 when no response arrived |
| `response.body` | any | no |  | The body you received |
| `response.durationMs` | number | no | >= 0 |  |
| `agent` | string | no | length 1-100 | The agent or client that filed the report, e.g. "claude-code" |
| `reportedAt` | string (date-time) | no |  | When the issue was seen |

Request body shape (placeholders, not real values):

```json
{
  "requestId": "<requestId>",
  "text": "<text>",
  "procedure": "patterns/create",
  "request": {
    "body": "<body>",
    "userAgent": "<userAgent>"
  },
  "response": {
    "status": 0,
    "body": "<body>",
    "durationMs": 0
  },
  "agent": "claude-code",
  "reportedAt": "2026-01-01T00:00:00Z"
}
```

**Response 200**:

| Field | Type | Req | Constraints / default | Description |
|---|---|---|---|---|
| `requestId` | string | yes | length 1-128 | Caller-chosen ID of the report; quote it to Arcade. Not an idempotency key: a retry may deliver the report twice. |

Response shape:

```json
{
  "requestId": "<requestId>"
}
```

**Notes**

- [DOC] Reports an API problem to the Arcade team. Leave out credentials and personal data (the server also strips query strings, API keys and credential fields). `requestId` identifies the report but is NOT an idempotency key: a retry may deliver it twice. Returns `503` while feedback is unavailable. Not needed for normal integration.

Only the 200 response is declared in openapi.json; error bodies follow section 3.5.

---


## 6. Job polling

| Item | Value | Source |
|---|---|---|
| Endpoint | `POST /jobs/get` with `{ "jobId": "<jobId>" }` (only field) | `[SPEC]` |
| Which calls make jobs | `patterns/create`, every `patterns/refine/*` except `recolorClusters`, `products/create` (and the unavailable `upscale`) | `[DOC]` |
| State machine | `running` -> `succeeded` or `failed`. "Jobs are created running; there is no queued state." Terminal states: `succeeded`, `failed`. No `cancelled`/`expired` state exists in the enum | `[SPEC]` |
| Reading the outcome | `succeeded`: read `result` (`patternId` or `productId`), which may be `null` (section 3.3). `failed`: read `error.message` | `[DOC]` |
| Recommended interval | Every 2 to 5 seconds. "Faster polling counts against the rate limit and doesn't make jobs finish sooner" | `[DOC]` |
| Typical latency | Pattern generation "takes a minute or two" (1 to 2 minutes). Refine latency and product-build latency are NOT documented | `[DOC]` UNVERIFIED for refine/product |
| Observed latency (one run, 2026-10-11, section 14.3) | `patterns/create` 95.7 s; `refine/edit` 51.4 s; `refine/editRegion` 69.9 s; `refine/recolorClusters` instant (sync); `refine/recolor` 5.9 s; `refine/crop` 3.2 s; `refine/makeSeamless` 13.1 s; `refine/extendPattern` 77.2 s; `refine/extendScene` 66.5 s; `refine/fixDeformity` 6.9 s (`force:false`, no deformity found, `result: null`); `products/create` 22.6 s. One run, one account tier: do not treat as a guarantee | `[LIVE]` |
| Timeout | No server-side timeout is documented. The test-drive skill treats "a job still `running` after 10 minutes" as a reportable issue and its helper defaults to a 600 s client timeout, 3 s interval, minimum 2 s | `[SKILL]` |
| Job retention | How long a `jobId` stays readable: UNVERIFIED | |
| Source pattern | "Refines never change the source pattern"; each refine makes a NEW `patternId` | `[DOC]` |
| Concurrency | The skill says not to run more than one generation at a time unless the human asks. Whether the API enforces a limit: UNVERIFIED | `[SKILL]` |
| After a product job | A new product appears in `products/list` once `jobs/get` reports its job succeeded; `products/get` then adds images, copy and pricing | `[SPEC]` |

Handling `429`/`5xx` while polling: wait `Retry-After` (at least the polling interval) on `429`, back off on `5xx`, keep polling (inference: a failed poll request does not affect the job).

---

## 7. Refining patterns, and supplying your own image

### 7.1 Refine operations

All refines take the source `patternId`, return a Job whose success `result.patternId` is a NEW pattern, and never modify the source. Only `recolorClusters` is synchronous.

| Operation | Path (`/patterns/refine/...`) | Inputs beyond `requestId`, `patternId` | Limits |
|---|---|---|---|
| Edit (text instruction) | `edit` | `instruction`; optional `referenceId` (a reference or another pattern), `colors[]` | `instruction` 1-1000 chars; `colors` max 10 |
| Edit region | `editRegion` | `instruction`, `mask` (PNG data URL) | mask aspect ratio = source (short side may differ by 1 px), long edge <= 1536 px, alpha > 0 = editable, selection >= 16 x 16 px |
| Color clusters | `recolorClusters` (sync) | optional `clusterCount` | 2-20; returns `clusters[{clusterId, color}]` |
| Recolor | `recolor` | `colors[{clusterId, color}]` (one per cluster, at least 2, at least one changed), optional `clusterCount` (repeat the same value) | `color` strict `#RRGGBB` |
| Crop | `crop` | `rectangle {left, top, width, height}` in source pixels | width/height >= 16 |
| Seamless tile | `makeSeamless` | `tile {left, top, size}` square region in source pixels | size >= 16 |
| Extend repeating pattern | `extendPattern` | `targetWidth`, `targetHeight` | each 16-1536 |
| Extend scene | `extendScene` | `targetWidth`, `targetHeight` | each 16-1536 |
| Fix deformities | `fixDeformity` | `maxPasses` (REQUIRED, 1-3), optional `force` | result may be `null` on success |
| Upscale | `upscale` | HIDDEN | "Not available through the API ... requests fail with `403`" |

Typical recolor sequence: `recolorClusters` -> read `clusters` -> `recolor` with a new color for each `clusterId` -> poll -> new `patternId`.

There is no "resize/dpi", "background removal", "variation", "tile preview" or "style transfer" operation in the spec. Text-instruction `edit` is the generic escape hatch. `[SPEC]`

### 7.2 Bring your own image (upload) `[SPEC][SKILL]`

Yes, a caller can supply its own image. Four steps; `requestId` is required on the two POSTs and must be new for each upload.

```bash
# 1. ask for a signed upload URL
curl -sS https://platform.arcade.ai/v1/references/createUpload \
  -H "Authorization: Bearer $ARCADE_API_KEY" -H "Content-Type: application/json" \
  -H "User-Agent: your-app/1.0 (you@example.com)" \
  -d '{"requestId":"logo-upload-1","mediaType":"image/png","byteLength":123456}'
# -> {"uploadId":"<uuid>.png","uploadUrl":"https://...","method":"PUT",
#     "requiredHeaders":{"Content-Type":"image/png"},"expiresAt":"<date-time>"}

# 2. PUT the raw bytes with EXACTLY the required headers. Plain curl, NO API key.
curl -sS -X PUT -H "Content-Type: image/png" --data-binary @logo.png "$UPLOAD_URL"

# 3. save it as a reference
curl -sS https://platform.arcade.ai/v1/references/create \
  -H "Authorization: Bearer $ARCADE_API_KEY" -H "Content-Type: application/json" \
  -H "User-Agent: your-app/1.0 (you@example.com)" \
  -d '{"requestId":"logo-ref-1","uploadId":"<uploadId from step 1>"}'
# -> {"referenceId":"...","imageUrl":"https://...","thumbnailUrl":"https://...",
#     "width":0,"height":0,"mediaType":"image/png","createdAt":"<date-time>"}
```

4. Use the `referenceId`:
   - `patterns/create.referenceIds` (array, max 3) "to guide the generation".
   - `patterns/refine/edit.referenceId` ("A reference or another pattern to guide the edit").

Limits: `mediaType` in `image/gif`, `image/jpeg`, `image/png`, `image/webp`; `byteLength` 1 to 10,485,760 (10 MiB); `references/create` verifies the stored bytes; `uploadId` matches `^<uuid>\.(gif|jpg|png|webp)$` and is valid only for the caller that created it; `uploadUrl` has an `expiresAt`.

What a reference does and does not do:

| Question | Answer |
|---|---|
| Can I send an image URL instead of uploading? | No. The spec has no URL-ingest field; upload bytes via the signed `PUT` |
| Is a reference printed as-is on the product? | Documented as guidance only: tag "Images that guide generation"; `referenceIds` "References to guide the generation". A logo/photo is NOT documented to be reproduced pixel-exact. UNVERIFIED |
| Can a reference be used directly as a `patternId` (to refine or to build a product)? | Probably: `references/list` says "A reference that was refined or made into a product stays listed here and is also listed by `patterns.list`", and `edit.referenceId` accepts "a reference or another pattern". But no page says to pass a `referenceId` as `patternId`. INFERRED, UNVERIFIED: test `references/create` -> `products/create` with `patternId = referenceId` using a real key |
| Can I control logo position / scale on the product? | Not in the spec. Products take a whole pattern plus `fit` (`crop` with `zoomLevel`, or `fill`). Placement of a logo on a specific area of a product is not a documented feature |
| Studio-side claims `[NON-API]` | Studio says "Bring your own artwork" and "Upload your own art, refine it with our AI, and make it production-ready", and "Prompt with text or images". Not confirmed as API behavior |

### 7.3 Per-item unique artwork

Possible, with no bulk shortcut `[SPEC]`:

- One `patterns/create` per unique design (each is a job, ~1-2 min), optionally steered by up to 3 references; then one `products/create` per (pattern, category, selections) -> one `productId`.
- `checkouts/create` accepts up to 50 distinct `productId` lines in one checkout, each `quantity` 1-1000. So 50 different designs can be bought in one checkout; N copies of ONE design = one product with `quantity: N`.
- There is no batch endpoint, no variable-data/personalisation template, and no per-unit artwork inside one product (a product is bound to one pattern).
- Latency budget for a unique item: pattern job (1-2 min) + product job (unknown) + price read. Sequential generation is the documented etiquette.

---

## 8. Products: categories, options, mockups, price

### 8.1 Discovering what you can make `[SPEC]`

1. `POST /categories/list` with `{}` -> `items[{categoryId, name, imageUrl}]` (`imageUrl` may be `null`).
2. `POST /categories/get` with `{ "categoryId": "...", "selections": {} }` -> `options[{key, label, values[{value, label, isDefault, available}]}]`, a complete `selections`, and `canManufacture`.
3. To change an option: add ONE `available: true` value for an option you have not sent to `selections` and call again; repeat until the returned `selections` suits you. Choosing only available values never dead-ends and every makeable product is reachable in any order. If the combination you sent is impossible, `canManufacture` is `false` and the values you sent that are marked `available: false` are the conflict.
4. `POST /products/create` with the complete `selections` from the LATEST response. `products/create` uses "the lowest-priced maker that can make it".

Do not hardcode category IDs or option keys: both come from the API. `[DOC]`

### 8.2 The category list: NOT documented, now partly confirmed live

No *page* lists the categories, their options, sizes, materials, colors or prices — they are runtime data and need an API key to read (`categories/list`, `categories/get`). A real key was used 2026-10-11 (section 14.3) to read the live list; treat the Studio-landing-page table further below as still unconfirmed against the API, but the table immediately below is a direct API response.

**[LIVE] Real `categories/list` response, 2026-10-11** (29 categories; `imageUrl` omitted here for brevity, see section 5.20 for the full shape including `world`/`category`):

| categoryId | name | world | groups under |
|---|---|---|---|
| `0ef267de-f8c2-4a93-89a3-63be809f68e2` | Decorative Pillows | print | — |
| `e31ea74b-f8a6-42f1-b005-c67ea65faecf` | Outdoor Decorative Pillows | print | — |
| `687b34ae-209d-461d-b681-4b0426400be8` | Scarves | print | — |
| `27b5f126-6464-4629-927e-be965be6ad5b` | Ribbon Scarf | print | — |
| `c314010b-e15a-4014-a376-9b8f4e973461` | Napkins | print | — |
| `4504ea0b-93d6-4280-9368-894a6ef4c783` | Placemats | print | — |
| `a8864e59-2dac-41c6-8a5c-559722e5d3e1` | Outdoor Placemats | print | — |
| `00215014-e6a4-4494-a66d-ada4854deadb` | Tablecloths | print | — |
| `9aeeb74f-f11a-40c6-afd7-4001f0178d3b` | Table Runners | print | — |
| `0a17cc22-3030-497e-8d53-d6c593b992ce` | Duvets | print | — |
| `f08a20ab-cd71-4065-bd2b-fe9a10ac37f6` | Shams | print | — |
| `f2f91b52-4c78-4b10-8185-d34e6611a638` | Quilts | print | — |
| `2b810c22-306f-40fd-82ca-b114a15224b0` | Quilted Shams | print | — |
| `feab7433-7db7-4b7b-94aa-8a28e5b7f57b` | Drum Lampshades | print | — |
| `538c3174-cdb6-40c9-9e7d-283eeeb00937` | Tall Drum Lampshades | print | — |
| `ae5b9a9b-4a55-4e70-a2d9-9382a0f9751c` | Rectangular Lampshades | print | — |
| `60b9b5bd-89ed-4e20-b871-4af5e838b385` | Pocket Squares | print | — |
| `1c97deee-33c9-4738-89f5-1eeade41d3d1` | Curtains | print | — |
| `576f2db2-dc4d-4d18-94a3-3f9fd39cd459` | Fabric By The Yard | print | — |
| `246045bd-53c9-434f-ac92-9459aa3a07d4` | Floor Pillows | print | — |
| `d6f27ba1-a68e-41be-909e-c93b24a479d7` | Tea Towels | print | — |
| `23f9c1bf-2fb5-4412-85ba-91cfcf4cba50` | Dainty Diamond Ring | jewelry | Rings |
| `80624394-d719-4749-99d5-6f8c3d8a15e5` | Rings | jewelry | Rings (itself) |
| `c8882c6d-cf08-4b88-b01e-678ff6828382` | Dainty Gemstone Ring | jewelry | Rings |
| `5ff5601a-78a5-4383-8535-4f05a656f491` | Dainty Gemstone Earrings | jewelry | Earrings |
| `a1167c6c-1bd9-45ea-b70e-883393a02bfa` | Stud Earrings | jewelry | Earrings |
| `dcfb2279-aef5-4ab9-b980-9b96626f145f` | Initial Earrings | jewelry | Earrings |
| `fd810c00-c58c-4147-a946-f3e4fb5d6939` | Dangle Earrings | jewelry | Earrings |
| `cb985ad9-3fe0-4163-8aea-3555dbdfaac9` | Pendant Necklace | jewelry | Necklaces |

Only Napkins' options/pricing were actually walked with `categories/get`/`products/get` (section 5.21/5.23); the other 28 categories' option keys/values/prices are still UNVERIFIED — only their names and IDs are confirmed. No jewelry product was built (the skill says jewelry designs take no `modelId`/`referenceIds`/`colors` and are "only for its own product").

Before this live pass, the only documented example was from the Quickstart ("Create a product"; IDs are examples), which the live `categoryId` above confirms is real:

```json
{
  "requestId": "linen-florals-napkins-1",
  "patternId": "cmujgkfnk0004pc10nt3kghxd",
  "categoryId": "c314010b-e15a-4014-a376-9b8f4e973461",
  "selections": { "fabric": "cotton", "size": "20x20" }
}
```

i.e. a "cotton dinner napkins" category with option keys `fabric` and `size` (values `cotton`, `20x20`). Nothing else is shown: other option keys (for example color, material, finish) are UNVERIFIED.

`[NON-API]` What Arcade Studio's public landing page (https://studio.arcade.ai/, 2026-10-10) shows as product types, not confirmed to match `categories/list`:

| Studio label | Description on the page | Status |
|---|---|---|
| Scarves | "Silk twill, hand-rolled hems" | live |
| Indoor pillows | "100% linen, made to order" | live |
| Table linens | "Any pattern, made to order" | live |
| Lampshades | "Any pattern, made to order" | live |
| Jewelry | "Gold, custom size and texture" | "Coming soon" |
| Bedding | "Any pattern, made to order" | "Coming soon" |

Makers named there: Odette (Hong Kong, silk scarves), Lattice & Loom (Gurgaon, India, printed textiles), Esme (Ghaziabad, India, printed textiles), Jack of All Shades (Alabama, US, custom lampshades), Lago e Seta (Soiano del Lago, Italy, silk scarves). The API exposes the chosen maker as `maker {makerId, name}` on `products/get`. [LIVE] 2026-10-11: Esme is real and matches exactly — a Napkins product built via the API came back with `"maker":{"name":"Esme",...}`.

**Correction, 2026-10-11:** the landing-page table above marks Jewelry "Coming soon" (checked 2026-10-10), but `categories/list` already returns 8 live, orderable `world: "jewelry"` categories (Rings, Earrings, Pendant Necklace, etc., see table above). The API is ahead of the marketing copy here — do not rely on the landing page to decide whether jewelry is available. `[LIVE]` overrides `[NON-API]`.

### 8.3 Create the product `[SPEC]`

`POST /products/create` -> Job (`kind: product`) -> on success `result.productId`.

- Required: `requestId`, `patternId`, `categoryId`, `selections` (complete, option key -> option value).
- Optional `fit`: needed only when "the pattern's aspect ratio does not match the selected size". Crop variant `{mode:"crop", crop:{left,top,width,height}, zoomLevel}` with `zoomLevel` in 1, 2, 3, 4, 8, 12; fill variant `{mode:"fill"}`. How a missing `fit` fails is UNVERIFIED (check `patterns/get` `width`/`height` against the product size first).

### 8.4 Mockup / preview image `[SPEC]`

`POST /products/get` returns `images: [{url}]` ("Product images, primary first") and `imageUrl` ("Thumbnail of the primary product image"). `products/list` returns only the thumbnail `imageUrl`. All are short-lived URLs on a host that is not guaranteed. The docs do not describe what the image looks like (rendering of your pattern on the product vs maker photo), its size or format: UNVERIFIED. Studio's landing page says "Every product generated comes back with an instantly guaranteed price" `[NON-API]`; the API contract below is more cautious.

### 8.5 Price fields, currency, guarantees `[SPEC]`

| Field (`products/get`) | Meaning |
|---|---|
| `unitPrice.amount` | Decimal string, e.g. `"48.00"` |
| `unitPrice.currency` | ISO 4217 code (which currency you get, and whether you can choose: not documented. UNVERIFIED) |
| `unitPrice` = `null` | "null while pricing is unavailable, so read again later" |
| Quantity | Request field `quantity` (integer >= 1, default 1): "The quantity pricing is quoted for". `unitPrice` is the price of one unit when ordering that quantity, BEFORE the volume discount |
| `volumeDiscounts` | `{currency, tiers[{minimumSpend, maximumSpend or null, discountPercent}]}` for the maker's volume discount; tiers are by total spend, not unit count. `[]`/empty when none, `null` when unavailable |
| Shipping, tax, discounts | Not mentioned for `unitPrice` (presumably excluded: UNVERIFIED). Their amounts appear on the order after payment (`subtotal`, `shipping`, `tax`, `volumeDiscount`, `discounts`, `total`) |

Is the price instant and guaranteed? Not by contract: no price-lock, expiry, or "price at checkout equals `unitPrice` x quantity" statement exists in the API docs, and `unitPrice` can be `null`. Marketing says "instantly priced / instantly guaranteed price" `[NON-API]`. Treat it as a quote and confirm at the hosted checkout. UNVERIFIED.

### 8.6 Variants, quantities, minimums

- A variant is a `selections` map. Each distinct (pattern, category, selections) is its own product/`productId`; there are no SKUs or variant IDs.
- Checkout quantities: 1 to 1000 per line, 1 to 50 lines `[SPEC]`. Quantity 1 requires `dropShip: true` (or an active subscription). The docs state no other minimum order quantity; Studio says "No minimums" `[NON-API]`.
- Product `title`, `description` (nullable), `careInstructions` (may be empty) come back from `products/get` and can fail to load temporarily.

---

## 9. Checkout and orders

### 9.1 Create the checkout `[SPEC][DOC]`

```json
{
  "requestId": "linen-florals-checkout-1",
  "lines": [{ "productId": "1cda0369-36f4-44ca-aae2-9d60e788a291", "quantity": 10 }]
}
```

Response (docs example; real `checkoutUrl` is longer):

```json
{
  "checkoutId": "1129729917083",
  "checkoutUrl": "https://checkout.arcade.ai/checkouts/..."
}
```

`dropShip` (boolean, default false): "Adds the drop-ship service to the order." Set `true` when any line has `quantity: 1`, unless the account has an active subscription, or the call returns `412 PRECONDITION_FAILED`.

### 9.2 What the API does NOT take

No shipping address, email, name, phone, payment method, card, currency, coupon, shipping method, webhook URL, or metadata. All of that is entered by the buyer on the hosted page. The API only lets you read the order afterwards (`orders/get`), where `shippingAddress` is limited to `name`, `city`, `provinceCode`, `countryCode`. Consequence: a human must open `checkoutUrl`; there is no API way to pay or to pre-fill. The skill explicitly says "Do not pay, and do not automate payment."

### 9.3 Who takes the payment, and is it real money

| Question | Answer |
|---|---|
| Who hosts checkout? | Arcade, at `checkout.arcade.ai` `[DOC]` (Quickstart example URL). Response headers show it is a Shopify-powered storefront (`powered-by: Shopify`, Shopify cookies; the root redirects to `/password`) `[OBSERVED]`. `checkoutId` is documented as a "draft order ID" and `orderNumber` looks like `#1042`, consistent with Shopify draft orders (inference) |
| Which processor charges the card (Stripe? Shopify Payments?) | Not stated. UNVERIFIED |
| Real money? | Yes: "paying places a real, charged order that gets made and shipped" `[SKILL]`. No test mode, test cards or sandbox are documented |
| Taxes / duties | Collected at checkout/by Arcade per its terms (VAT/sales tax calculated, collected, remitted) `[NON-API]`; amounts appear on the order |
| Shipping estimate API? | None. Shipping shows up on the hosted checkout/order only |
| Order only after payment | "the order is placed once payment completes"; `orders/get` by `checkoutId` is `404` until then, so an unpaid or abandoned checkout is indistinguishable from a not-yet-paid one |
| Checkout expiry | Not documented. UNVERIFIED |

### 9.4 Order status and tracking `[SPEC]`

`POST /orders/get` `{ "orderId": "<digits>" }` or `{ "checkoutId": "<digits>" }`:

- `status` enum: `ordered`, `cadReview`, `sampleReview`, `inProduction`, `inReview`, `inCorrection`, `approved`, `updatedInfo`, `shipped`, `delivered`, `fulfilled`, `refunded` ("Derived from the makers' fulfillment and any refunds"). Meaning of each value is not documented (names suggest a maker review/approval pipeline before `shipped`).
- `tracking: [{ company, number, url }]` (each nullable) for shipments made so far; `refunds: [{ createdAt, amount }]`; `orderId`, `orderCode` (Arcade order code, nullable), `orderNumber` (display name, e.g. `"#1042"`), `placedAt`, `total`, `itemCount`, `imageUrl`, `lines[{productId|null, title, selectionLabel, quantity, total|null, imageUrl|null, makerName|null}]`, `subtotal`, `shipping`, `tax`, `volumeDiscount`, `discounts`, `shippingAddress`.
- `orders/list`: newest first; filter with `status`; `limit` 1-50.
- Webhooks / callbacks: none documented. Poll `orders/get` (mind the rate limit, e.g. every few minutes, not seconds). UNVERIFIED whether undocumented webhooks exist.

### 9.5 Fulfillment context from the consumer help center `[NON-API]`

From arcadestudio.zendesk.com articles (dated 2025-04, consumer marketplace flows; may not match API checkout, UNVERIFIED for API orders):

- "Arcade only accepts shipping and billing addresses within the USA territory."
- After an order, the maker approves or rejects it within 2 business days (rejection -> cancellation email and refund); the buyer must approve a photo and video of the finished product before the maker ships.
- Returns only if damaged or defective (custom goods); orders over USD 800 shipped to the U.S. may incur duties.
- Studio landing page: "No minimums, No inventory risk, Cancel anytime"; "If your product isn't as described or is delayed, you'll get a full refund".

---

## 10. Rate limits, credits, pricing, free tier

| Topic | What is documented | Source |
|---|---|---|
| Rate limit | "The edge rate-limits each source IP and answers `429` when you exceed it." JSON body has `error` and `message` (not `code`/`status`; the errors table labels the row `429 rate_limit_exceeded`); header `Retry-After` (seconds). NO numbers (requests per minute/day) are published. Shared IPs (office, hackathon wifi, CI) would share the budget (inference from "each source IP") | `[DOC][SKILL]` |
| What counts | Polling faster than every 2 s "counts against the rate limit"; do not load-test or probe the limit | `[DOC][SKILL]` |
| Concurrency | Skill advises one generation at a time; enforcement unknown | `[SKILL]` UNVERIFIED |
| Credits | No credit balance, cost, or "credits remaining" field exists in any response. The only credit mention is `expectedCreditCost` on the hidden/unavailable `upscale` ("Upscaling is a paid feature of Arcade Studio") | `[SPEC]` |
| Price per generation / refine / product build | Not documented. UNVERIFIED (could be free until checkout, or metered against a Studio plan; no `402`/quota error is documented) | |
| Free tier | Not documented for the API. Studio landing: "Try now for free" | `[NON-API]` UNVERIFIED for API |
| Subscription | Exists: an "active subscription" waives the `dropShip` requirement for quantity-1 lines. Plans/prices not documented | `[SPEC]` |
| Key limits | 90-day default expiry, max 10 active keys per user | `[SKILL]` |
| Body size | 1 MB | `[DOC]` |

---

## 11. SDKs, CLI, MCP, agent integration

| Item | Finding | Source |
|---|---|---|
| Official SDKs | None. The docs show raw HTTP in cURL, Python (`urllib`), JavaScript (`fetch`), TypeScript, Go (`net/http`), Rust (`reqwest`). Generate a client from the OpenAPI 3.1.1 spec if you want one (`https://docs.arcade.ai/openapi.json`) | `[DOC][SPEC]` |
| CLI | None documented for Arcade itself (the `skills` CLI used by `npx skills add` is a generic skills installer) | `[DOC]` |
| Agent skills | `npx skills add https://docs.arcade.ai` installs two skills into your project (Agent Skills spec, agentskills.io; works with Claude Code, Codex, Cursor): `arcade-api` (endpoint reference, workflows, gotchas) and `arcade-api-test-drive` (get a key, exercise the API safely, file reports) | `[DOC]` |
| Skill URLs | Discovery index `https://docs.arcade.ai/.well-known/agent-skills/index.json` (lists name, description, url, sha256 digest; I checked both digests match the files); files `https://docs.arcade.ai/.well-known/agent-skills/arcade-api/skill.md` and `.../arcade-api-test-drive/skill.md`; the same files are also served as `https://docs.arcade.ai/.well-known/skills/<name>/SKILL.md` with index `/.well-known/skills/index.json`, which `https://docs.arcade.ai/skill.md` 307-redirects to | `[DOC][OBSERVED]` |
| Manual install (no `npx`) | Copy each skill file to `.claude/skills/<name>/SKILL.md` (Claude Code project skills) or the Codex/Cursor equivalent. This layout is the generic Agent Skills convention, not an Arcade instruction | INFERRED |
| AGENTS.md | Arcade publishes no AGENTS.md / CLAUDE.md snippet. `https://docs.arcade.ai/AGENTS.md` just 307-redirects to the docs page `agents.md` ("Use with an AI agent") | `[OBSERVED]` |
| Docs for LLMs | `https://docs.arcade.ai/llms.txt` (index), `llms-full.txt` (prose + endpoint blurbs), every page also as `.md` by appending `.md` | `[DOC]` |
| MCP server for the API | None documented: no MCP server exposes patterns/products/checkout as tools | UNVERIFIED |
| MCP for the docs | `https://docs.arcade.ai/.well-known/mcp.json` declares `{"version":"1.0.0","transport":"http","url":"https://arcade-api.main-kill-isr.mintlify.me/mcp","servers":[{"name":"public","url":"https://arcade-api.main-kill-isr.mintlify.me/mcp","transport":"http","authentication":"none"}]}`; `https://docs.arcade.ai/mcp` exists (GET -> 405, so it speaks MCP over POST). Both are Mintlify's documentation-search MCP route (`x-matched-path: /_mintlify/mcp/...`); I did not connect or list its tools | `[OBSERVED]` |

Config snippets (mine, not Arcade's; the Claude Code syntax is standard, the Arcade URL is the one above):

```bash
# agent skills, from Arcade's docs
npx skills add https://docs.arcade.ai

# optional: docs-search MCP in Claude Code (not an API-actions server; tool list not inspected)
claude mcp add --transport http arcade-docs https://docs.arcade.ai/mcp
```

Do not paste your API key into a skill, MCP config, or a report; the skill's own rules say to send it only to `platform.arcade.ai`.

---

## 12. Gotchas

1. EVERYTHING is `POST` + JSON, including reads. `GET` is not supported. `[DOC]`
2. Set a real `User-Agent`; a missing or library-default UA (the docs name `Python-urllib`; Node's `fetch` default is untested) can draw a non-JSON edge `403` that never reaches the API. Only the Quickstart's Python sample sets one. `[DOC]`
3. The key is live-only and has full account power. Every pattern, product and checkout you create is real, shows up in the owner's Studio, and cannot be deleted through the API. `[SKILL][SPEC]`
4. The job response is the SAME shape for patterns, refines and products; read `kind`. IDs come from `result` AFTER the job succeeds, never from the first response. `result` can be `null` even on success. `[DOC]`
5. `fixDeformity` requires `maxPasses` (1-3); `recolor` needs cluster IDs from `recolorClusters` (and a color for EVERY cluster); `editRegion` needs a correctly sized PNG mask; `extend*` targets are 16-1536 px. `[SPEC]`
6. `products/create` needs the COMPLETE `selections` from a `categories/get` RESPONSE. Sending your partial request object, or a hardcoded ID or option, is the easiest way to fail. `[SKILL]`
7. `fit` is required when the pattern aspect ratio differs from the product size; the exact failure mode is undocumented, so compare `patterns/get` `width x height` with the product size first. UNVERIFIED
8. `unitPrice` can be `null` and is per unit for the quoted `quantity`, "before the volume discount"; shipping and tax are not mentioned (presumably excluded). No price lock is documented. `[SPEC]`
9. `checkouts/create` collects no address/email/payment: the buyer pays on `checkoutUrl`. Quantity-1 lines need `dropShip: true` or the call fails `412`. Checkout is real money. `[SPEC]`
10. `orders/get` by `checkoutId` is `404` until the checkout is PAID. There is no checkout-status endpoint and no webhook. `[SPEC]`
11. Image URLs expire and may change host. Never cache them; copy the bytes. Never send your API key to them. `[SPEC][SKILL]`
12. A reused `requestId` with a different body is `409`; a retry of `references/createUpload` after its upload was saved is `409`; a retried abandoned `checkouts/create` can leave an extra unpaid checkout. `[DOC]`
13. `references/createUpload` does not bind `byteLength`; `references/create` checks the stored bytes. The signed `PUT` must send exactly `requiredHeaders`. `[SPEC]`
14. Unknown rate-limit numbers + per-IP limits: do not parallelise generations or poll faster than 2 s. `[DOC][SKILL]`
15. Docs inconsistencies: (a) `llms.txt` omits the hidden `upscale` page (it exists at `/api-reference/refine/upscale-a-pattern.md`); (b) `errors.md` omits `412`; (c) the `arcade-api` skill's refine table omits `fixDeformity` and its `maxPasses`, and lists `dropShip` as plain optional without the `412` rule; (d) job examples in the Quickstart omit `error`, `createdAt`, `completedAt` that the spec marks required. `[SPEC]`
16. Studio consumer help says shipping is US-only (2025 article); verify before promising international delivery. `[NON-API]` UNVERIFIED for API
17. IP/copyright: Arcade's terms let it cancel orders and ban accounts for copying third-party IP, which matters if users upload logos or photos they do not own. `[NON-API]`


## 13. Minimal runnable Node 26 script (no checkout)

File: `arcade-demo.mjs` (also saved next to this reference as `/private/tmp/claude-501/-Users-sara-Projects/cf5ff167-fb76-416e-bc3f-a7c350d2410e/scratchpad/arcade-demo.mjs`). Native `fetch`, zero dependencies, reads `ARCADE_API_KEY` from the environment. It never calls `checkouts/create`.

```bash
export ARCADE_API_KEY="arcade_sk_live_..."          # from studio.arcade.ai/settings/api-keys
export ARCADE_USER_AGENT="my-hackathon-app/1.0 (me@mydomain.com)"   # put a real contact
node arcade-demo.mjs
```

Flow: `patterns/create` -> poll `jobs/get` (3 s) -> `patterns/get` (prints size + image URL) -> `categories/list` -> `categories/get {selections:{}}` -> `products/create` with the returned `selections` -> poll -> `products/get {quantity:1}` (re-read while `unitPrice` is `null`) -> prints mockup URL and price.

How "cheapest category" is handled: the docs publish NO category list and NO prices, and `categories/list` returns no price; a price exists only on `products/get` after a product is built. So:

- Default: build one product in the first category whose name matches `/napkin/i` (the one category the docs show: cotton dinner napkins), else the first category. Override the match with `ARCADE_CATEGORY="scarf"` (a regex).
- `ARCADE_CHEAPEST=1`: build ONE product per category using each category's default selections, then print them sorted by `unitPrice.amount` and report the lowest. This is the only way to find the cheapest at runtime; it creates one extra (free until checked out, as far as documented) product per category in the account, and the API cannot delete them.
- If a build fails mentioning `fit`/`aspect`, it retries once with `fit: {"mode":"fill"}` (what `fill` does is UNVERIFIED; the failure wording is also UNVERIFIED).

Verification status: `node --check` passes (Node v26.10.0). Run against a local mock that validates every request body (including "no undocumented property") and every mock response against the verified OpenAPI schemas, in three scenarios: default mode with injected `429` (Retry-After 1) and `503`; `ARCADE_CHEAPEST=1` with one category forced through the `fit` retry; missing key (exit 2) and invalid key (exit 1). Result: 0 schema violations, 0 checkout calls, `unitPrice: null` re-read worked. NOT run against the live API. Output below is from the mock, not Arcade:

```text
pattern pat-1 1024x1024
  https://img.example.test/pat-1.png?sig=abc
categories: Silk scarves [cat-scarf-0001], Dinner napkins [cat-napkin-0002], Indoor pillows [cat-pillow-0003]
  Dinner napkins: 12.50 USD  (20 x 20 in)

product prod-2: Dinner napkins (custom) [Dinner napkins] made by Mock Maker
mockup: https://img.example.test/mockup-1.jpg?sig=1
price:  12.50 USD each (quantity 1, before volume discount)
No checkout was created. Image URLs are short-lived; call products/get again to renew them.
```

```js
#!/usr/bin/env node
// arcade-demo.mjs: prompt -> pattern -> poll job -> product -> print mockup URL + price.
// Node 18+ (written for Node 26). Native fetch, zero dependencies. NEVER calls checkouts/create.
//
//   ARCADE_API_KEY=arcade_sk_live_... node arcade-demo.mjs
//
// Optional env:
//   ARCADE_PROMPT       pattern prompt (default: the Quickstart prompt)
//   ARCADE_CATEGORY     regex matched against category names (default "napkin", the one category the docs show)
//   ARCADE_CHEAPEST=1   build one product per category with default selections and keep the lowest unitPrice
//                       (the docs publish no category prices; price only exists on products/get after a build)
//   ARCADE_USER_AGENT   default "arcade-demo/1.0 (you@example.com)"; use a real contact, the edge 403s default UAs
//   ARCADE_API_BASE     default https://platform.arcade.ai/v1

const apiKey = process.env.ARCADE_API_KEY;
if (!apiKey) {
  console.error("Set ARCADE_API_KEY (Arcade Studio > Settings > API keys)");
  process.exit(2);
}
const BASE = process.env.ARCADE_API_BASE ?? "https://platform.arcade.ai/v1";
const USER_AGENT = process.env.ARCADE_USER_AGENT ?? "arcade-demo/1.0 (you@example.com)";
const PROMPT = process.env.ARCADE_PROMPT ?? "Small blue and white block-print florals on natural linen";
const CATEGORY_RE = new RegExp(process.env.ARCADE_CATEGORY ?? "napkin", "i");
const CHEAPEST = process.env.ARCADE_CHEAPEST === "1";
const POLL_MS = 3000; // docs: poll jobs every 2 to 5 seconds
const JOB_TIMEOUT_MS = 10 * 60_000; // docs: generation takes 1-2 minutes; 10 minutes means something is wrong
const MAX_ATTEMPTS = 4;
const run = crypto.randomUUID().slice(0, 8); // keeps requestIds unique per run
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every Arcade call is POST + JSON. Retries reuse the same body, so the requestId inside it stays the same.
async function call(procedure, body) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/${procedure}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep((res.status === 429 && retryAfter > 0 ? retryAfter : 2 * attempt) * 1000);
      continue;
    }
    throw new Error(`${procedure}: HTTP ${res.status}: ${text.slice(0, 600)}`);
  }
}

async function waitForJob(jobId) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const job = await call("jobs/get", { jobId });
    if (job.status === "succeeded") return job;
    if (job.status === "failed") throw new Error(`job ${jobId} failed: ${job.error?.message ?? "no message"}`);
  }
  throw new Error(`job ${jobId} still running after ${JOB_TIMEOUT_MS / 60_000} minutes`);
}

// 1. prompt -> pattern
const patternJob = await waitForJob((await call("patterns/create", { requestId: `${run}-pattern`, prompt: PROMPT })).jobId);
const patternId = patternJob.result?.patternId; // a succeeded job can still carry result: null
if (!patternId) throw new Error("pattern job succeeded but result is null");
const pattern = await call("patterns/get", { patternId });
console.log(`pattern ${patternId} ${pattern.width}x${pattern.height}\n  ${pattern.imageUrl}`);

// 2. pick categories (never hardcode category IDs)
const { items: categories } = await call("categories/list", {});
if (categories.length === 0) throw new Error("categories/list returned no categories");
console.log(`categories: ${categories.map((c) => `${c.name} [${c.categoryId}]`).join(", ")}`);
const candidates = CHEAPEST ? categories : [categories.find((c) => CATEGORY_RE.test(c.name)) ?? categories[0]];

// 3. pattern + category -> product (a job)
async function createProduct(category, selections, fit) {
  const created = await call("products/create", {
    requestId: `${run}-${category.categoryId}${fit ? "-fill" : ""}`,
    patternId,
    categoryId: category.categoryId,
    selections,
    ...(fit && { fit }),
  });
  const job = await waitForJob(created.jobId);
  if (!job.result?.productId) throw new Error("product job succeeded but result is null");
  return job.result.productId;
}

async function buildProduct(category) {
  const detail = await call("categories/get", { categoryId: category.categoryId, selections: {} });
  if (!detail.canManufacture) throw new Error(`default selection for "${category.name}" cannot be manufactured`);
  let productId;
  try {
    productId = await createProduct(category, detail.selections); // pass the selections the API returned
  } catch (err) {
    // fit is required only when the pattern's aspect ratio differs from the product size (failure text UNVERIFIED)
    if (!/fit|aspect/i.test(err.message)) throw err;
    console.log(`"${category.name}": retrying with fit {"mode":"fill"} after: ${err.message}`);
    productId = await createProduct(category, detail.selections, { mode: "fill" });
  }
  let product;
  for (let i = 0; i < 10; i++) {
    product = await call("products/get", { productId, quantity: 1 });
    if (product.unitPrice) break; // unitPrice is null while pricing is unavailable: read again
    await sleep(POLL_MS);
  }
  return { category, product };
}

const built = [];
for (const category of candidates) {
  try {
    built.push(await buildProduct(category));
  } catch (err) {
    if (!CHEAPEST) throw err;
    console.error(`skipped "${category.name}": ${err.message}`);
  }
}
if (built.length === 0) throw new Error("no product was built");

// 4. report. unitPrice is per unit for quantity 1, before volume discount; no shipping or tax.
const priceOf = ({ product }) => Number(product.unitPrice?.amount ?? Infinity);
built.sort((a, b) => priceOf(a) - priceOf(b));
for (const b of built) {
  const p = b.product.unitPrice;
  console.log(`  ${b.category.name}: ${p ? `${p.amount} ${p.currency}` : "price unavailable"}  (${b.product.selectionLabel})`);
}
const { category, product } = built[0];
console.log(`\nproduct ${product.productId}: ${product.title} [${category.name}] made by ${product.maker.name}`);
console.log(`mockup: ${product.images[0]?.url ?? product.imageUrl}`);
console.log(`price:  ${product.unitPrice ? `${product.unitPrice.amount} ${product.unitPrice.currency} each (quantity 1, before volume discount)` : "unavailable, read products/get again later"}`);
console.log("No checkout was created. Image URLs are short-lived; call products/get again to renew them.");
```

Re-run the offline test (fake key, loopback only, nothing leaves the machine):

```bash
SP=/private/tmp/claude-501/-Users-sara-Projects/cf5ff167-fb76-416e-bc3f-a7c350d2410e/scratchpad
node $SP/scripts/mock-arcade.mjs $SP/arcade-docs/openapi.json &     # listens on 127.0.0.1:48765, set PORT to change
ARCADE_API_KEY=arcade_sk_live_LOCALMOCKONLY ARCADE_API_BASE=http://127.0.0.1:48765/v1 node $SP/arcade-demo.mjs
curl -s http://127.0.0.1:48765/__log    # per-request schema violations (expect none)
```

Response fields the script reads, as the docs show them (docs examples keep their values; the rest is from the spec):

```json
POST /patterns/create  -> { "jobId": "3583f242-50ed-4250-94c2-c00ea25249dd", "kind": "pattern", "status": "running", "result": null }
POST /jobs/get         -> { "jobId": "3583f242-50ed-4250-94c2-c00ea25249dd", "kind": "pattern", "status": "succeeded", "result": { "patternId": "cmujgkfnk0004pc10nt3kghxd" } }
POST /patterns/get     -> { imageUrl, thumbnailUrl, width, height, patternId, prompt, sourcePatternId, createdAt }
POST /categories/list  -> { "items": [ { "categoryId", "name", "imageUrl" } ] }
POST /categories/get   -> { "categoryId", "name", "options": [ ... ], "selections": { ... }, "canManufacture": true }
POST /products/create  -> a Job with "kind": "product"; on success "result": { "productId": "..." }
POST /products/get     -> { productId, title, categoryId, maker: { makerId, name }, selections, selectionLabel, imageUrl, createdAt,
                            images: [ { url } ], description, careInstructions, volumeDiscounts, patternId,
                            unitPrice: { amount: "48.00", currency } | null }
```

Exact JSON the script sends (matches the docs' Quickstart shapes):

```json
POST /patterns/create     { "requestId": "<run>-pattern", "prompt": "Small blue and white block-print florals on natural linen" }
POST /jobs/get            { "jobId": "<jobId>" }
POST /patterns/get        { "patternId": "<patternId>" }
POST /categories/list     {}
POST /categories/get      { "categoryId": "<categoryId>", "selections": {} }
POST /products/create     { "requestId": "<run>-<categoryId>", "patternId": "<patternId>", "categoryId": "<categoryId>", "selections": { "<key>": "<value>" } }
POST /products/get        { "productId": "<productId>", "quantity": 1 }
```

---

## 14. Coverage, sources, open questions

### 14.1 Pages fetched

All 35 URLs in `https://docs.arcade.ai/llms.txt` returned HTTP 200 as raw markdown (`<url>.md`): index, quickstart, agents, authentication, idempotency, jobs, pagination, errors, and the 27 `api-reference/*` pages (patterns 3, refine 9, jobs 1, references 4, models 1, categories 2, products 3, checkouts 1, orders 2, feedback 1). Also read: `llms-full.txt` (34,328 bytes), `openapi.json` (160,702 bytes, sha256 `ad4cc234b85029c6a9a03900c371eca91db99ca3f19bc45e56e47c6fe1f79faf`), `https://platform.arcade.ai/v1/spec.json` (28 operations, all path items equal to the docs copy), the two skill files (sha256 digests match `/.well-known/agent-skills/index.json`), `sitemap.xml` (same 35 pages), `robots.txt`, `/.well-known/mcp.json`, the unindexed `upscale-a-pattern.md`, and the rendered HTML of three API pages (checkouts, orders, products/create; same content as the spec).

Not fetched / not available: NO indexed page failed. Probed and 404 (so they do not exist): `webhooks`, `rate-limits`, `rate-limiting`, `pricing`, `credits`, `sdks`, `sdk`, `cli`, `changelog`, `test-mode`, `sandbox`, `shipping`, `versioning`, `security`, `faq`, `support`, `terms`, `orders`, `checkout`, `products`, `patterns`, `references`, `categories`, `models` (as `.md` under docs.arcade.ai). `https://studio.arcade.ai/settings/api-keys` and the Studio app need a login and were not opened. `https://arcade.ai/pricing`, `/faq` and `https://studio.arcade.ai/pricing` 404. The WebFetch tool only returns a paraphrase from a small model (it says it cannot reproduce pages verbatim), so exact field names come from the raw `.md`/`openapi.json` fetched with curl; WebFetch was used on `llms.txt`, `llms-full.txt` and three API pages as a cross-check.

Non-API sources used (tagged `[NON-API]`): https://studio.arcade.ai/ landing page text; https://legal.arcade.ai/terms; Arcade consumer help center (arcadestudio.zendesk.com). A web search for "Arcade pricing" mostly returns arcade.software, a different company; ignore it.

### 14.2 To confirm with a real key (status after the 2026-10-11 live pass, section 14.3)

1. Does a `referenceId` work as `patternId` in `products/create` and in refines (direct use of an uploaded logo/photo)? — **still UNVERIFIED.** A reference was created and used as `patterns/refine/edit.referenceId` (its documented use), not tried as a `patternId`.
2. Default size/aspect ratio of generated patterns; how a missing `fit` fails; what `fill` and `zoomLevel` do. — **partly confirmed.** A prompt with no size/aspect field came back 1024x1024 (square). `fit: {mode: "fill"}` is accepted even when the pattern and product aspect ratios already match (section 5.22). A missing `fit` on a mismatched aspect ratio, and what `zoomLevel` visually changes, are still UNVERIFIED (not tried).
3. Real category list, option keys and per-category `unitPrice`; currency; whether the price equals the checkout price. — **partly confirmed.** Full category list (section 8.2); Napkins' options and `unitPrice` (`33.96 USD` for cotton/20x20, section 5.21/5.23). The other 28 categories' options/prices are still UNVERIFIED. Whether `unitPrice` equals the checkout/paid price is still UNVERIFIED — deliberately not tested (see item 8: no checkout was created).
4. Latency of refines and product builds. — **confirmed**, one sample run each (section 6, section 14.3). Not a guarantee across load, account tier, or time.
5. Numeric rate limits; concurrency limit on generations. — **still UNVERIFIED.** 26 calls were made across an ~8-minute run (well under any plausible limit) with no `429`; that is not evidence of what the limit actually is.
6. Whether a free account can create keys and what generations/builds cost (credits, plan). — **still UNVERIFIED** for "free account". Confirmed: `patterns/refine/upscale` is blocked with `403 FORBIDDEN` regardless of `expectedCreditCost` on this account/plan — it is a Studio-UI-only feature, not an API-gated-by-cost one (section 5.13). No credit balance or cost appeared in any other response.
7. `dropShip` fee, subscription price, any minimum order quantity above 1. — **still UNVERIFIED.** The product build deliberately sent `dropShip: false` with `quantity: 1` to avoid the `412` subscription gate (section 9.1); the fee/price itself was never charged or quoted.
8. Shipping destinations (help center says US only), shipping/tax at checkout, payment processor. — **still UNVERIFIED, on purpose.** No `checkouts/create` call was made in this pass: creating a checkout and opening `checkoutUrl` would place a real, charged order, which this reference's own rule (and the skill) says not to do without an explicit human ask. See section 14.3.
9. Webhooks (none documented), job and checkout retention/expiry. — **still UNVERIFIED.** Every job/pattern/product/reference created in this pass stayed readable for the ~8 minutes of the run; nothing about longer retention was tested.
10. `orders/get` behavior when both or neither of `orderId`/`checkoutId` is sent. — **still UNVERIFIED** (no checkout, so no `orderId`/`checkoutId` to test with). `orders/list` on an account with zero paid orders returned `{"items":[],"nextCursor":null}` — confirmed shape for the empty case.

Do NOT check whether the checkout price equals `unitPrice` (item 3) by paying: the skill says paying places a real, charged order.

### 14.3 Live verification log (2026-10-11)

A real `ARCADE_API_KEY` became available (an onboarding teammate's Studio account) and was used, read-only-intent but real, to run 26 of the 27 real endpoints (everything except `checkouts/create`, deliberately — see below) via this repo's `src/arcade.mjs` client in live mode. This is the source for every `[LIVE]` tag above. Full request/response log kept outside this repo at `/private/tmp/claude-502/-Users-yifeiliu-shopping-hackaton/8c5fa765-587f-4ac9-bf52-e5b4d2087c0d/scratchpad/{run.log,results.json}` (a session scratch directory, not guaranteed to persist).

What ran, in order: `models/list`, `categories/list`, `categories/get` (Napkins), `patterns/create` (prompt + 3 hex colors, no `modelId`) polled to success, `patterns/get`, `patterns/list`, `references/createUpload` + `PUT` + `references/create`, `references/get`, `references/list`, `patterns/refine/edit` (with the uploaded reference), `patterns/refine/editRegion` (with a programmatically generated mask PNG), `patterns/refine/recolorClusters` + `recolor`, `patterns/refine/crop`, `patterns/refine/makeSeamless`, `patterns/refine/extendPattern`, `patterns/refine/extendScene`, `patterns/refine/fixDeformity`, `patterns/refine/upscale` (expected-to-fail, cost capped at 1 credit), `products/create` (Napkins, `fit: {mode: "fill"}`), `products/get`, `products/list`, `orders/list`, `feedback/create` (a report flagged as a test, so it wouldn't be mistaken for a real issue).

**Deliberately not run: `checkouts/create` and the `orders/get` that depends on it.** Creating a checkout returns a real `checkoutUrl`; opening it or completing payment was never going to happen (per this reference and the skill), but even creating the checkout object was judged out of scope for a generic verification pass rather than an explicit "place this order" request — the sandbox this was run in independently reached the same conclusion and blocked the first attempt. Everything in sections 9, and items 6-9 of 14.2 above, that depends on an actual paid order therefore remains `UNVERIFIED`.

Every pattern (1 base + 6 refined), 1 reference image, and 1 product (`a42d6fba-272e-4bbf-9f2f-d7f5a53c1f5d`, "Everyday Cotton Dinner Napkins (Set of 4)") created during this pass are now real, permanent objects in that Studio account (section 4: nothing can be deleted through the API).
