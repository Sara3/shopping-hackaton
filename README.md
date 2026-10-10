# Shopping 3.0 Hackathon — Arcade build

Sunday 2026-10-11 · TIAT, 151 Powell St SF · doors 10:00, seated 10:15, build 10:30–15:00, demos 15:15 (90 s/team).
Rule: every entry must create physical products through Arcade's API, built on-site.

## Setup (do this before Sunday)

| Step | Command / link | Expected |
|---|---|---|
| 1. API key | https://studio.arcade.ai/settings/api-keys → Settings → API keys | a bearer key (same access as your account, never commit it) |
| 2. Env | `cp .env.example .env` then paste the key into `ARCADE_API_KEY` | `.env` is git-ignored |
| 3. Verify | `npm run doctor` | `PASS` on node, key, `models/list`, `categories/list` |
| 4. Explore | `npm run categories` | every category, its option keys and default selection |
| 5. End-to-end | `npm run smoke -- "your prompt"` | pattern → product → price + mockup URL, **no checkout, nothing charged** |
| 6. Tests | `npm test` | client unit tests (fake fetch, no network) |

`npm run smoke` creates a real pattern and product in the Studio account (generation takes ~1–2 min). Only `checkouts/create` + paying the hosted `checkoutUrl` costs money; the scripts never do that.

## API in one table

| Step | Endpoint (all `POST https://platform.arcade.ai/v1`) | Returns |
|---|---|---|
| Generate | `/patterns/create` `{requestId, prompt, referenceIds?, colors?, modelId?}` | `jobId` → poll `/jobs/get` → `result.patternId` |
| Refine | `/patterns/refine/{edit,editRegion,recolor,crop,makeSeamless,extendPattern,extendScene,fixDeformity,upscale}` | new `patternId` via job |
| Your own image | `/references/createUpload` → `PUT` bytes → `/references/create` | `referenceId` (guides generation, max 3 per prompt) |
| Products | `/categories/list` → `/categories/get {categoryId, selections}` → `/products/create` → job → `/products/get` | `unitPrice`, `maker`, `images`, `volumeDiscounts` |
| Buy | `/checkouts/create {lines:[{productId, quantity}], dropShip:true}` | hosted `checkoutUrl`; `/orders/get` is 404 until paid |

Gotchas: `User-Agent` header is mandatory (edge 403 without it) · poll jobs every 2–5 s · `requestId` is an idempotency key (reuse only to retry the same body) · image URLs expire, re-read to renew · `dropShip:true` is required for quantity-1 lines without a subscription (else 412) · there is no sandbox, every call hits the real account.

## Layout

| Path | What |
|---|---|
| `src/arcade.mjs` | zero-dependency client: auth, User-Agent, retries on 429/5xx, job polling, `generatePattern`, `buildProduct` |
| `scripts/doctor.mjs` | setup check (read-only calls) |
| `scripts/categories.mjs` | lists categories + default selections |
| `scripts/smoke.mjs` | pattern → product → price, no checkout |
| `.claude/skills/arcade-api*` | Arcade's official Claude Code skills (`npx skills add https://docs.arcade.ai`; add `-a cursor` or `-a codex` for other agents) |
| `test/` | `node --test` unit tests with a fake `fetch` |
