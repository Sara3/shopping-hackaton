# agent.md — Doraemon Commerce Agent

## What this is
An agent that takes a natural-language description or a reference photo of a product a
user wants, turns it into a real, priced, orderable product, and pushes it to
fulfillment. Built for Arcade AI's "Shopping 3.0" hackathon.

- **Host:** Arcade AI
- **Event:** Shopping 3.0: The AI Commerce Hackathon, Sun Oct 11, 2026, 10:00 AM–6:00 PM,
  Union Square, San Francisco
- **Prizes:** 1st $10,000 / 2nd $5,000
- **Judges:** Kirsten Green (Forerunner Ventures), Mariam Naficy (Arcade CEO / Minted
  founder), Ash Herr (TIAT), surprise guests
- **Platform access:** Arcade provides product generation (imaging), instant pricing
  (surfaced via the product record, not a separate call — see below), and fulfillment
  through its manufacturer network — the same infra powering Arcade's own products.

## Pipeline (idea → merchant)
1. **Intake** — user describes a product in natural language, or uploads a reference
   image, in a simple web chat interface (browser-based, no app/SMS dependency).
2. **Spec generation** — the agent turns that input into a structured product spec
   (category, color, style prompt, optional reference images), with a confidence score
   gating whether it asks a clarifying question instead of proceeding.
3. **Render + price** — one underlying Arcade pipeline (pattern → product job, polled to
   completion) returns both the render and the real sell price together; there is no
   separate "pricing step."
4. **Listing** — the priced, rendered product is shown as a confirmation card: image,
   price, and the destination the user states.
5. **Confirmation** — the user takes one explicit action (a button tied to that specific
   card, not a free-text "yes") before anything that spends money happens. No step past
   here fires without it.
6. **Checkout handoff** — the agent hands off to Arcade's own hosted checkout page, where
   the user actually pays and enters their shipping address. Doraemon never collects,
   stores, or transmits payment details itself.
7. **Fulfillment** — order status and tracking are pulled by polling Arcade (no webhooks
   exist to push this), and surfaced back to the user.

See [agent_constitution.md](agent_constitution.md) for the hard rules governing steps 5–7
and everything security/financial.

## Agent architecture
Doraemon is **one LLM agent running a single tool-calling loop** — no separate
"pricing agent," "confirmation agent," or orchestration service. The conversation itself
drives intake → spec → render/price → confirm → checkout handoff → status; the agent calls
tools in sequence as the conversation progresses. (Language/framework still open — any
standard tool-calling runtime works here.)

Tool set, each a thin wrapper over one Arcade call (see the `arcade-api` skill in
[.claude/skills/arcade-api/SKILL.md](.claude/skills/arcade-api/SKILL.md) for the endpoints
behind them):
- `list_categories`, `get_category` — resolve category + build a valid option `selections`
  object.
- `upload_reference_image`, `create_reference` — photo intake, only when an image is
  supplied.
- `create_pattern`, `get_job` — render generation, wrapped as one call that blocks until
  the job succeeds or fails.
- `create_product`, `get_product` — the priced product; this is where the render and the
  real sell price both come from.
- `present_confirmation` — shows the bound product+price+destination card and opens a
  pending-confirmation record. Does not call Arcade.
- `create_checkout` — the one tool that spends real money. Hard-gated on a prior
  `present_confirmation` record being explicitly confirmed by an actual UI action; refuses
  otherwise, regardless of what the agent's own read of the conversation suggests. This is
  the defense against a product description or image trying to talk the agent into
  skipping confirmation (constitution §2).
- `get_order` — polled fulfillment status and tracking.

## Structured product spec
```ts
type ProductSpec = {
  categoryId: string | null;   // null until resolved against the category list
  world: "print" | "jewelry" | null;
  prompt: string;               // natural-language description fed to generation
  colors?: string[];            // hex / palette tokens, max 10
  referenceImageIds?: string[]; // max 3
  confidence: number;           // 0–1, model self-score on spec completeness
  clarifyingQuestion?: string;  // set when confidence is below threshold
};
```
If `confidence` is below threshold (start at 0.6, tune against real inputs), the agent asks
`clarifyingQuestion` instead of generating — never guess past low confidence and proceed to
spend credits or show a price (constitution §2 "fail closed"). Category resolution is a
small loop: start with empty selections, add values, re-check what's still available,
repeat until the category confirms it can actually be manufactured.

## Sandbox / dry-run strategy
Arcade's API has no built-in sandbox mode — one key is full real-account access. Generation
calls run for real in dev and in the demo (they spend Arcade credits on our account, not
customer money, and there's no way to fake a convincing render). `create_checkout` is the
only tool gated by a `DRY_RUN_CHECKOUT` flag (env var, default **on**): when on, it logs the
would-be call and returns a fabricated receipt instead of touching Arcade. Flipping it off
is an explicit, human action — never a default or an inferred state. Every dry-run response
is labeled as mocked in logs and in the UI (constitution §1).

## Confirmation gate — two things to get right
1. **The agent cannot confirm on the user's behalf.** `present_confirmation` creates a
   server-held record (product, price, stated destination, a nonce) when the card is shown.
   `create_checkout` only proceeds if that exact nonce has been separately marked confirmed
   by a literal button click — not by the model deciding the user's chat message counts as
   a yes.
2. **Destination isn't a field we control.** Arcade's hosted checkout page is where the
   customer actually enters the ship-to address and pays; we have no API field to set it.
   We collect a stated destination at confirmation purely for the audit record, then after
   checkout poll order status and compare the real shipping address against what was
   confirmed — surfacing a mismatch rather than silently trusting either side. This is a
   disclosed compromise, not a fully clean fix.

## Idempotency & order tracking
- Every Arcade-call tool uses a caller-chosen idempotency key derived from the order
  attempt + step name, so a retried call is a true replay, not a duplicate.
- Before calling checkout, check whether this order attempt already has one; if so, reuse
  it instead of calling again (Arcade's checkout call can otherwise leave a duplicate
  unpaid checkout on a retried/abandoned request — also covers a double-tap on confirm).
- Each order attempt is one row with a status field, updated by whichever tool just ran —
  no separate state-machine service.
- No webhooks exist for fulfillment updates; a polling loop checks order status for any
  order that isn't yet in a terminal state.

## Spend ceiling
A configurable per-order spend ceiling is compared against the product's price × quantity.
Above the ceiling, `present_confirmation` requires a second, separate explicit confirmation
before checkout is reachable at all (constitution §2).

## Local debugging
OTel tracing is available opt-in (`OTEL_ENABLED=true` + a local Jaeger via
`docker compose up -d`) so a turn's full model/tool-call chain, including failures, is
inspectable in a trace viewer instead of just stack traces. Every span — including
Strands' own auto-instrumented ones — carries `session.id` (one per CLI run/browser
session) and `user.id` (self-reported, no auth system exists yet); every `tool.*` span
additionally carries `tool.status` (`success`/`error`/`refused`, inferred from the tool's
return value) so a confirmation-gate refusal is distinguishable from an actual bug at a
glance. Debugging aid only — not part of the audit trail the constitution requires; that's
still `agent/confirmation.py`'s log. See [RUNNING.md](RUNNING.md) for setup.

## Design principles
- **Secure** — real money and real fulfillment only move on explicit human confirmation.
- **Fun** — fast feedback loop: describe or show a product, see it rendered and priced in
  seconds.
- **Idea → merchant** — the output of this agent isn't a mockup, it's a listing a
  stranger could actually buy.
- **Simple** — one agent, one tool-calling loop. No bespoke multi-service orchestration.

## Open questions
1. **Destination binding** is a disclosed compromise (see Confirmation gate above) — flag
   if asked, rather than claiming full compliance.
2. **Credit budget** — Arcade exposes no credits/balance endpoint; check remaining credits
   in Arcade Studio manually before the event and go easy on credit-costed refine
   operations during the live demo.
3. **Confidence threshold (0.6)** is a placeholder; needs tuning against real walk-up input
   before the event, not just synthetic test prompts.
4. **`world` split (print vs. jewelry)** — pick one for the demo script to keep category
   resolution simple; don't try to support both live.

## MVP cut line for the build day
**In scope for v0 (must work live):** the agent and tool set above, text intake → spec →
render/price → confirmation card with an explicit button → dry-run checkout → fabricated
receipt + audit record shown on screen.

**Stretch, in priority order:** (a) one real checkout against Arcade with dry-run flipped
off for a single live, human-approved purchase; (b) photo intake via reference images;
(c) one remix/refine call (recolor or crop) on an already-rendered pattern; (d) order-status
polling + tracking UI.

**Cut if short on time:** budget-constrained generation, batch/social ordering.

## Open / TBD
- Photo/reference-image intake (stretch item — text intake is built, images aren't yet).
- Swapping `MockArcadeClient` for a live Arcade client once credentials/API access work.
- `USE_LEASH_PROXY=true` (see `.env.example`) routes every tool call through the Leash
  gateway (`agent/arcade_client.py`'s `ProxiedArcadeClient`) instead of resolving
  `ArcadeClient` in-process — for demoing the gateway from the shopping-hackaton repo
  against this agent's traffic. `ProxiedArcadeClient` self-mints its own short-lived
  token via `POST /tokens` (re-minting on its own TTL or a 401/403) rather than holding a
  long-lived secret the way `ARCADE_API_KEY` is held — matches the gateway's documented
  10-minute token expiry. The gateway's actual relay/`/tokens` server isn't built yet
  (see shopping-hackaton/LEASH_GATEWAY_BUILD_PLAN.md — every check in `gate.mjs`/`gate.py`
  is still a `TODO` stub), so this is wired but non-functional until that lands. Not yet
  wired: `create_checkout`'s relay carries no signed mandate (`agent/confirmation.py`'s
  `PendingConfirmation` doesn't carry `imageSha256`/`maxTotal`/a signature), so once the
  gateway's `checkMandate` is implemented, a proxied checkout will be denied until that
  mandate flow is built on top of this — deliberately deferred until the mandate's exact
  field shapes are settled with the gateway side, rather than guessed at here.
- ~~Language/framework~~ — decided: Python 3.12 + Strands Agents SDK + Claude, hosted on
  Amazon Bedrock only (no other model provider). Running instructions:
  [RUNNING.md](RUNNING.md).
- ~~Storefront surface~~ — decided: simple web chat interface (browser, not WhatsApp/
  Twilio, not Shopify). Built as a Streamlit app (`webui/app.py`) for now.
- ~~Arcade API surface and auth model~~ — confirmed from docs.arcade.ai on 2026-10-10.
  Full endpoint-level reference is now the official Arcade-maintained skills in
  [.claude/skills/arcade-api/SKILL.md](.claude/skills/arcade-api/SKILL.md) (endpoint
  reference, workflows, gotchas) and
  [.claude/skills/arcade-api-test-drive/SKILL.md](.claude/skills/arcade-api-test-drive/SKILL.md)
  (how to safely exercise the real API and file feedback) — not a hand-written notes file,
  so it stays in sync with Arcade's own docs rather than drifting.

Update this file as these decisions land — it's the source of truth for the product
shape, not just the initial pitch.
