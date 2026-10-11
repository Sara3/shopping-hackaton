---
name: arcade-api
description: Use when building integrations to generate AI patterns from text prompts, refine patterns with edits/recoloring/cropping, create custom products from patterns, and manage orders. Use for pattern generation workflows, product creation pipelines, and e-commerce integrations.
metadata:
    mintlify-proj: arcade
    version: "1.0"
---

# Arcade API Skill

## Product summary

Arcade API is a REST service for generating AI-powered patterns from text prompts, refining them with edits and transformations, creating custom products from patterns, and managing orders. All requests are POST calls to `https://platform.arcade.ai/v1` with JSON bodies and bearer token authentication. Long-running operations (pattern generation, refines, product builds) return jobs that you poll until completion. Primary documentation: https://docs.arcade.ai

## When to use

Reach for this skill when:
- Building a pattern generation workflow from user text prompts
- Refining existing patterns (editing, recoloring, cropping, making seamless, extending)
- Creating products from patterns with category-specific options
- Managing checkouts and orders for custom products
- Polling async jobs to track pattern generation or product build progress
- Uploading reference images to guide pattern generation
- Listing and retrieving patterns, products, references, or orders

## Quick reference

### Base URL and authentication
| Base URL | API keys |
|---|---|
| `https://platform.arcade.ai/v1` | `https://studio.arcade.ai/settings/api-keys` |

Send API key as: `Authorization: Bearer $ARCADE_API_KEY`

### Core workflow endpoints
| Task | Endpoint | Returns |
|---|---|---|
| Generate pattern | `POST /patterns/create` | `jobId` (poll to get `patternId`, plus `productId` with a `categoryId`) |
| Poll job status | `POST /jobs/get` | `status`, `result`, `error` |
| Create product | `POST /products/create` | `jobId` (poll to get `productId`) |
| Create checkout | `POST /checkouts/create` | `checkoutUrl` to pay |
| Get order | `POST /orders/get` | Order details, status, tracking |
| Report an API issue | `POST /feedback/create` | `requestId` of the report |

### Refine operations (all return jobs except `recolorClusters`)
| Operation | Endpoint | Key parameters |
|---|---|---|
| Edit pattern | `POST /patterns/refine/edit` | `patternId`, `instruction`, optional `referenceId` |
| Edit region | `POST /patterns/refine/editRegion` | `patternId`, `instruction`, `mask` (PNG data URL) |
| Recolor | `POST /patterns/refine/recolor` | `patternId`, `colors` array with `clusterId` and `color` |
| Get color clusters | `POST /patterns/refine/recolorClusters` | `patternId`; returns `clusters` (`clusterId`, `color`) synchronously, no job |
| Crop | `POST /patterns/refine/crop` | `patternId`, `rectangle` (left, top, width, height) |
| Make seamless | `POST /patterns/refine/makeSeamless` | `patternId`, `tile` (left, top, size) |
| Extend pattern | `POST /patterns/refine/extendPattern` | `patternId`, `targetWidth`, `targetHeight` |
| Extend scene | `POST /patterns/refine/extendScene` | `patternId`, `targetWidth`, `targetHeight` |

Refines work only on print patterns; a jewelry design returns 400.

### Required fields for common requests
**Pattern creation:**
- `requestId` (string, ≤128 chars, unique per request)
- `prompt` (string)
- Optional: `referenceIds`, `modelId`, `colors`, `categoryId` (also makes a product; see Generate a pattern and its product)

**Product creation:**
- `requestId`
- `patternId`
- `categoryId` (from `categories/list`)
- `selections` (the complete object returned by `categories/get` when `canManufacture` is `true`)
- Optional: `fit` (crop/zoom when aspect ratio doesn't match)

**Checkout:**
- `requestId`
- `lines` (array of `{productId, quantity}`)
- Optional: `dropShip` (boolean)

**Feedback:**
- `requestId` (identifies the report; a retry may deliver it twice)
- `text` (what you expected, what happened, what you tried)
- Optional: `procedure`, `request` (`body`, `userAgent`), `response` (`status`, `body`, `durationMs`), `agent`, `reportedAt`

## Decision guidance

| Scenario | Use | Why |
|---|---|---|
| User wants to guide pattern generation | Upload reference via `references/createUpload` + `references/create`, then pass `referenceIds` to `patterns/create` | References steer AI toward desired style |
| Product in a `jewelry` category | `patterns/create` with its `categoryId` | The only way; `products/create` refuses jewelry |
| Pattern and product in one job | `patterns/create` with a `print` `categoryId` | Arcade picks the options; use `products/create` to choose them |
| Pattern needs color changes | Call `recolorClusters` first to see dominant colors, then `recolor` with new colors | Must match cluster IDs returned by `recolorClusters` |
| Pattern aspect ratio doesn't match product size | Include `fit` object in `products/create` with crop coordinates | Required to avoid distortion; omit if aspect ratios already match |
| Need to edit only part of pattern | Use `editRegion` with PNG mask instead of `edit` | Mask controls which pixels are editable; must be ≥16×16 at scaled size |
| Pattern is repeating tile vs. scene | Use `extendPattern` for repeating patterns, `extendScene` for non-repeating images | Different algorithms for seamless vs. non-seamless content |
| Retrying a failed request | Reuse same `requestId` and body | Ensures idempotent behavior; API returns original result if work already ran |
| Handling 409 CONFLICT on retry | Check if original request is still starting; if so, retry after short delay; otherwise use new `requestId` | Indicates a body mismatch, work still starting, or a `references/createUpload` retry after its upload was saved |

## Workflow

### Generate and refine a pattern
1. Create API key in Arcade Studio (Settings → API keys) and export as `ARCADE_API_KEY`
2. Call `POST /patterns/create` with `requestId`, `prompt`, optional `referenceIds` and `colors`
3. Receive `jobId` immediately; poll `POST /jobs/get` with `jobId` until `status` is `succeeded` or `failed`
4. On success, extract `result.patternId` from job response
5. (Optional) Refine the pattern: call any refine endpoint (edit, recolor, crop, etc.) with the `patternId`
6. Poll the refine job until completion to get new `patternId`

### Generate a pattern and its product
Each category from `categories/list` has a `world`, and may have a `category` naming its group (such as Rings for Dainty Diamond Ring).
1. Call `POST /patterns/create` with `requestId`, `prompt` and a `categoryId`
2. Poll the job; it runs until the product is built. On success, `result` has `patternId` and `productId`
3. Call `POST /products/get` with `productId` to see its `selections` and `unitPrice`, then continue at `checkouts/create`, as in Create and order a product

- `print`: Arcade picks the product's options. To choose them, use `products/create` instead.
- `jewelry`: the only way to make a jewelry product. The request waits for a prompt/category compatibility check before creating a job. A clear category mismatch returns HTTP 400 with a category-specific message and no job; revise the prompt or category and retry. The pattern is a design made for that category, with options picked from your prompt; send no `modelId`, `referenceIds` or `colors`. `categories/get` shows the options; name the ones you want in the prompt. `products/create` returns 400 for a jewelry category, and refines, edit references and `products/create` return 400 for a jewelry design.

### Create and order a product
1. Call `POST /categories/list` to see available product categories, and pick a `print` one
2. Call `POST /categories/get` with `categoryId` and `selections: {}`. The response fills in a complete selection. `canManufacture` describes that returned selection and can be `true` immediately. To customize, send only your explicit choices, adding one `available: true` value at a time until the returned selection suits you
3. When `canManufacture` is `true`, call `POST /products/create` with `patternId`, `categoryId`, the complete `selections` object from the latest response (not your empty or partial request), and optional `fit`
4. Poll the product job until `status` is `succeeded`; extract `result.productId`
5. Call `POST /checkouts/create` with `lines` array containing `productId` and `quantity`
6. Receive `checkoutUrl`; user opens it to pay
7. After payment, call `POST /orders/get` with `checkoutId` to retrieve order details

### Upload a reference image
1. Call `POST /references/createUpload` with a new `requestId`, `mediaType` (image/jpeg, image/png, etc.) and `byteLength`
2. Receive `uploadUrl` and `uploadId`; PUT the file bytes to `uploadUrl` with required headers
3. Call `POST /references/create` with a new `requestId` and `uploadId` to save the reference
4. Receive `referenceId`; use in `patterns/create` or refine operations

Calling `references/create` again with the same `uploadId` returns the existing reference (200, same `referenceId`), even with a new `requestId`, as long as the reference has not been deleted. It does not create a duplicate. Retrying `references/createUpload` with its original `requestId` after the upload was saved returns 409 CONFLICT; use a new `requestId` there to upload another file.

## Common gotchas

- **Forgetting to poll jobs**: Pattern generation and product builds are async. Once admission checks pass, `patterns/create` returns a job; you must poll `jobs/get` until completion. Generation typically takes 1–2 minutes.
- **Null result on succeeded job**: A succeeded job can have `result: null` if the pattern was deleted or a `fixDeformity` job found nothing to repair. Always check for null before extracting IDs.
- **Hardcoded category IDs**: Don't hardcode category IDs; call `categories/list` to discover them.
- **Missing fit object for aspect ratio mismatch**: If pattern aspect ratio doesn't match product size, `products/create` fails unless you provide `fit` with crop coordinates. Check pattern dimensions before creating products.
- **Recolor requires cluster IDs**: You cannot pass arbitrary colors to `recolor`; you must first call `recolorClusters` to get the cluster IDs, then pass those IDs with new colors.
- **Mask size constraints for editRegion**: The mask PNG must have the same aspect ratio as the source pattern (short side may differ by 1 pixel), long edge ≤1536 pixels, and editable area ≥16×16 pixels at scaled size.
- **Idempotency key conflicts**: Reusing a `requestId` with a different body returns 409 CONFLICT. A retry while the original request is still starting can also return 409; follow the error message and retry unchanged after a delay. For reference uploads, the consumed-upload conflict applies to `references/createUpload`, not to replaying `references/create` for an existing reference.
- **Short-lived URLs**: Image URLs in responses (imageUrl, thumbnailUrl, downloadUrl) expire. Call the endpoint again to renew them.
- **Pagination cursor is opaque**: Pass `nextCursor` unchanged; don't try to parse or modify it.

## Verification checklist

Before submitting work with Arcade API:
- [ ] API key is set in `ARCADE_API_KEY` and sent as a bearer token
- [ ] All required fields are present: `requestId`, `prompt`/`patternId`, `categoryId`, `selections`, etc.
- [ ] `requestId` is unique per distinct request (reuse only for retries with identical body)
- [ ] Job polling loop checks for both `succeeded` and `failed` status, and handles `error.message`
- [ ] Pattern/product IDs are extracted from `result` after job succeeds, not from initial response
- [ ] Category options are fetched via `categories/get` before calling `products/create`, and the category's `world` is `print`
- [ ] If pattern aspect ratio doesn't match product size, `fit` object with crop is included
- [ ] For recolor operations, `recolorClusters` was called first to get cluster IDs
- [ ] For editRegion, mask PNG is valid (correct aspect ratio, ≤1536 long edge, ≥16×16 editable area)
- [ ] Pagination uses `cursor` from previous `nextCursor` (not hardcoded or guessed)
- [ ] Error responses are checked for `code` and `message` to distinguish retryable (5xx, 409) from non-retryable (4xx) errors
- [ ] Image URLs are refreshed by calling the endpoint again if they may have expired

## Resources

Comprehensive page-by-page navigation: https://docs.arcade.ai/llms.txt

Critical documentation:
- [Quickstart](https://docs.arcade.ai/quickstart) — End-to-end example with code samples
- [Jewelry quickstart](https://docs.arcade.ai/jewelry-quickstart) — Design a piece of jewelry and order it
- [Jobs](https://docs.arcade.ai/jobs) — How to poll async operations
- [Authentication](https://docs.arcade.ai/authentication) — API key setup and environment handling

---

> For additional documentation and navigation, see: https://docs.arcade.ai/llms.txt
