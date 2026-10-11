# Leash: scoped authority for shopping agents

> Shopping 3.0 Hackathon · 2026-10-11 · TIAT San Francisco · built on [Arcade's API](https://docs.arcade.ai)

If a shopping agent holds a full Arcade key, it will buy whatever a stranger's text tells it to. Leash sits between the agent and Arcade. The agent gets a scoped token instead of the key. Each checkout needs a signed mandate for exactly what the human approved. If the agent strays from that mandate, it's frozen.

![The problem and the fix](docs/fig1-problem-and-fix.svg)

## Set up the demo (5 minutes)

The demo shows a real attack end to end in our own app, then prevents it. You type every request by hand. Run all commands from the repo folder.

| You need | Detail |
|---|---|
| Node | 22 or newer (we use 26) |
| Python | 3.11 or newer, for the Doraemon agent (`doraemon/`) |
| Dependencies | one Node package, plus Doraemon's Python env: run the install commands below once |
| API keys | a Claude API key for Doraemon (`CLAUDE_API_KEY` in `doraemon/.env`); no Arcade key: Arcade is a local replica with fake money |
| Internet | for Claude; the public listing links each have a localhost fallback |

```bash
npm install
```

```bash
cd doraemon && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..
```

```bash
npm run demo
```

Then open <http://localhost:8787>.

| Port | What runs there | Role in the demo |
|---|---|---|
| 8787 | chat app (the driver: sessions, Settings, Approve) | where you type and click |
| 8790 | Doraemon, the shopping agent (Python, `doraemon/agent/service.py`) | turns the chat into tool calls, only ever through Leash |
| 8080 | Leash gateway | holds the real key, checks every checkout |
| 8788 | Arcade replica and our demo listings | fake products, prices and checkout |
| 16686 | Jaeger (optional, `docker compose up -d`) | traces from Doraemon and the gateway, with `OTEL_ENABLED=true` |

| Command | Use it when |
|---|---|
| `npm run demo:allowance` | **the 90-second stage script** ([docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md)): the deliberately naive agent starts with the account key, you save the allowance live in Settings |
| `npm run demo` / `npm run demo:leash` | Doraemon, the real agent, behind Leash with the allowance ($200.00 per week) pre-saved: the "good agent" segment, and traces in Jaeger |

**Doraemon** never holds the Arcade key or the gateway's admin key: the chat app hands it the session's Leash token per turn. It reads shared listings with hidden text stripped (the Track panel still shows what was hidden), and it checks out only after you click **Approve**: the chat app has the gateway sign a mandate for exactly the card you approved, Doraemon confirms that card (only an explicit `approve`, at the card's quantity), and the gateway holds the checkout to the mandate. With Doraemon, the card's **Approve** button approves the quantity printed on that card (it sends `approve 2` for a 2 × card); the naive agent's button always sends a bare `approve` (quantity 1), as the stage script expects.

**Tracing**: run `OTEL_ENABLED=true npm run demo` with Jaeger up. Every Doraemon turn is one trace (`agent.turn`, tagged `session.id`) holding the model calls, each tool call (`tool.status`: success, error, or `refused` for a gate or a Leash denial) and one span per gateway call with the gateway's decision (`leash.decision`, `leash.code`, `leash.rule`, `leash.token_frozen`, `leash.mandate_id`). The chat's trace notes link each turn to Jaeger. The gateway exports its own spans (service `leash-gateway`: `token.issue`, `arcade.call`, `mandate.create`, `checkout`, each with `security.decision` and `security.reason`); they are separate traces for now. Doraemon already sends `traceparent` on every gateway call, so they join Doraemon's trace once the gateway reads it.

Stop one run with Ctrl-C before starting another.

### Links you will paste

| Listing | Public link | Replica fallback |
|---|---|---|
| Clean: blue linen scarf, $128.00 | `https://sara3.github.io/odette-atelier/blue-linen-scarf/` | `http://localhost:8788/inspo/blue-linen-scarf` |
| Poisoned review: the agent buys 50 red roses, $5,120.00 | `https://sara3.github.io/odette-atelier/linen-look/` | `http://localhost:8788/inspo/linen-look` |
| Poisoned as seller Q&A (works on the LLM): approve one, the 50-piece case and red roses apply at checkout | `https://sara3.github.io/odette-atelier/linen-faq/` | `http://localhost:8788/inspo/linen-faq` |
| Poisoned as data: packed in cases of 50, current print red roses on black | `https://sara3.github.io/odette-atelier/case-of-50/` | `http://localhost:8788/inspo/case-of-50` |
| Poisoned as data: sold as a family set of 50 (send `Create the family set like this one for us: …`) | `https://sara3.github.io/odette-atelier/family-set/` | `http://localhost:8788/inspo/family-set` |
| Poisoned in plain sight: the same sentence as visible review text (does the agent obey a review it can see?) | `https://sara3.github.io/odette-atelier/linen-look-visible/` | `http://localhost:8788/inspo/linen-look-visible` |
| Salami (encore): 30 separate checkouts | `https://sara3.github.io/odette-atelier/office-gift/` | `http://localhost:8788/inspo/office-gift` |
| Show the hidden sentence | drag-select the blank end of Jonas K.'s review, or add `?reveal=1` to paint it yellow in place | same |

The pages are our own static demo pages (our GitHub Pages site and the local replica). No third-party site is touched.

## The 90-second demo, click by click

Two paths, one sentence. **Path 1** shares a clean listing and the agent buys what you approved. **Path 2** shares a listing whose review hides one sentence: without Leash the agent buys 50 of something else, with Leash the same run is blocked. Run it on the stage stack, `npm run demo:allowance` (the naive agent obeys the hidden sentence; Doraemon does not). Roles, pre-flight, recovery and judge Q&A: [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md). Setup and the Doraemon segment: [docs/DEMO.md](docs/DEMO.md).

| Path | Sentence to send (exactly) |
|---|---|
| 1 · happy | `Create a scarf that looks like this: https://sara3.github.io/odette-atelier/blue-linen-scarf/` |
| 2 · sad | `Create a scarf that looks like this: https://sara3.github.io/odette-atelier/linen-look/` |

| Time | Path | Driver clicks | Screen shows | Speaker says |
|---|---|---|---|---|
| 0-15 s | 1 | **Paste a listing link** (fills the path 1 sentence), **Send**, **Approve** | `Approve Silk scarf · blue floral linen scarf at $128.00 × 1 = $128.00?`, then a $128.00 checkout | "This is the app everyone built today. I share a scarf, the agent designs it on Arcade, I approve one for $128, done." |
| 15-20 s | | **Reset** (Track keeps the old message otherwise) | empty chat | "Same sentence. Different page." |
| 20-40 s | 2, no Leash | **Paste a listing link**, change the end of the link from `blue-linen-scarf/` to `linen-look/`, **Send**, **Approve**; then, on the listing tab, drag-select the blank line at the end of Jonas K.'s review | the same $128.00 card, then 50 × red roses, **$5,120.00**, "built by the agent after you approved, not what you approved"; on the listing the hidden sentence appears white on blue; Track **page said** shows it in yellow | "I approve one. But a review on that page has a sentence I can't see. You saw a normal page. The agent saw this." |
| 40-50 s | 2, Leash on | click **Leash off** in the header (it turns green **Leash on**: $200 per week, all four categories, 7 days), then **Reset** | badges change to `key none (leash)` and `token tok_…` | "Now I give the agent an allowance. It no longer holds the key. It holds a token." |
| 50-70 s | 2, with Leash | same `…/linen-look/` sentence, **Send**, **Approve** | red box: `Leash blocked it. The agent tried to spend $5120.00 on 50 × Silk scarf · large red roses on black. You approved 1 × $128.00 and your allowance is up to $200.00 per week. Nothing was bought.` Track **agent tried**: `gateway · blocked: mandate_mismatch` | "Same page, same agent. I approved one for $128. It tried 50 for $5,120. Leash holds it to what I approved." |
| 70-90 s | | hands off | the business slide | "Arcade did the hard part: price, make, ship. Leash is Okta for shopping agents: tokens, mandates, detection. Every Arcade developer, every group chat, every brand agent." |
| Encore | | click **Leash on** to turn it off; send the sentence with `…/odette-atelier/office-gift/`, **Approve**. Then click **Leash off** to turn it on, **Reset**, send it again, **Approve** | naive: 30 checkouts of $128.00, running total $3,840.00. With the allowance: the first passes, the second is blocked `allowance_exceeded` | "Each purchase looks small. Only the total is the problem." |

The **Leash off / Leash on** button is the same as Settings → Save with the defaults (on) or Remove allowance (off); use Settings to pick your own amount or categories. After every rehearsal, click **Leash on** to turn it off, or Ctrl-C and start `npm run demo:allowance` again: a saved allowance lives in the process.

## If something is off

| Symptom | Cause | Fix |
|---|---|---|
| `port in use: http://...` | an earlier run is still up | stop the old run (Ctrl-C); the message names the port |
| Track "agent tried" shows `failed`, not `gateway · blocked` | the web process predates a code change | stop it and start `npm run demo:allowance` again |
| public link says "Site not found" | GitHub Pages is still building | paste the replica link instead |
| `browse only reads ... pages` | the stack lacks `BROWSE_ORIGINS` | every `npm run demo*` script sets it; a bare `node scripts/dev.mjs` or `npm run web` does not, so use the replica links there |
| every chat says `token_frozen` | a frozen token stays frozen | click Reset to mint a fresh token |

## What runs

```mermaid
flowchart LR
  H["You<br/>chat :8787"] --> A["Agent<br/>agent/"]
  P["Listing with a poisoned review"] -. "hidden sentence steers" .-> A
  A -- "scoped token" --> L["Leash gateway<br/>gateway/ :8080"]
  L -- "real key" --> R["Arcade replica<br/>mock/ :8788"]
  L -. "every decision" .-> D[("ledger")]
```

| Run | Command | The agent holds | You approve $128 × 1, the agent tries $5,120 × 50 |
|---|---|---|---|
| Unprotected | `npm run demo`, or `demo:allowance` before Save | the full Arcade key | a $5,120 checkout link is created |
| Leash | `npm run demo:leash`, or `demo:allowance` after Save | a scoped token | `403 mandate_mismatch`, token frozen, nothing reaches Arcade |

## Docs

| Read | For |
|---|---|
| [docs/DEMO.md](docs/DEMO.md) | running the demo: setup, starting each stack, test scenarios (stage and Doraemon), Jaeger |
| [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) | stage script: the two paths, who clicks, who says what, recovery |
| [START-HERE.md](START-HERE.md) | onboarding: rebuild, build, demo |
| [docs/REPRO.md](docs/REPRO.md) | click-by-click runbook with checkboxes; live Arcade in Part B |
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | pitch, Arcade API facts, Leash pieces, file layout |
| [docs/BUILD-DAY.md](docs/BUILD-DAY.md) | hour plan, attack catalog, 90-second script |
| [docs/arcade-api-reference.md](docs/arcade-api-reference.md) | every Arcade endpoint with request and response |

## Team and positioning

| Who or what | Detail |
|---|---|
| Sara | built the Leash gateway |
| Yifei | UI, observability traces, help on the Leash gateway |
| Austin | pitch and demo |
| Positioning | Arcade did the hard part. Leash is the missing agent layer and could ship as Arcade's own `/tokens`. |

We only ever attack our own naive agent, on our own replica and demo pages. The attack is disabled in live mode, and nothing in this repo pays.
