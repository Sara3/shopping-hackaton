# Running Doraemon Locally

Stack: [Strands Agents SDK](https://strandsagents.com) + Claude, Python 3.12. Model host
is **Amazon Bedrock only** -- no other provider is supported. Deliberately minimal: a
single agent and tool set, no policy-sidecar. OTel tracing is available for local
debugging (opt-in, see "Tracing" below) via a local Jaeger container -- no other infra.

**Arcade's live API isn't reachable yet** (endpoint reference is the official
`.claude/skills/arcade-api/SKILL.md`), so every tool call is served by
`agent/arcade_client.py`'s `MockArcadeClient` -- data shaped exactly like Arcade's real
schemas, clearly labeled `"mocked": True`. `ARCADE_MODE=mock` is the only implemented value
right now; see that file's docstring for how a `LiveArcadeClient` drops in later without
touching `agent/tools.py`.

## What's in this project

```
doraemon/
├── .claude/skills/        # official Arcade-maintained skills (arcade-api, arcade-api-test-drive)
├── agent/
│   ├── cli.py            # interactive chat loop / entrypoint
│   ├── agent.py           # builds the Strands Agent (system prompt, tools, model)
│   ├── tools.py            # the 9 @tool functions (see agent.md's "Agent architecture")
│   ├── arcade_client.py     # ArcadeClient interface + MockArcadeClient
│   ├── confirmation.py       # the out-of-band confirmation gate (see its docstring)
│   ├── telemetry.py           # opt-in OTel tracing -> local Jaeger, for debugging
│   └── config.py                # env-based configuration
├── webui/app.py           # Streamlit browser chat (the decided storefront surface)
├── scripts/verify_tools.py # no-LLM sanity check of the mock client + confirmation gate
├── docker-compose.yml      # local Jaeger, only needed if OTEL_ENABLED=true
└── requirements.txt
```

## 1. Install

```bash
python3.12 -m venv .venv   # needs Python 3.10+; 3.12 confirmed working
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Configure

```bash
cp .env.example .env
```

No key goes in `.env` -- the agent uses your normal AWS credential chain (env vars,
`aws configure`, or an IAM role). Just make sure:
- You have credentials boto3 can find, and `AWS_REGION` in `.env` matches a region where
  you have Claude model access enabled.
- The `STRANDS_MODEL_ID` default (a cross-region inference profile, see
  `agent/config.py`) is actually enabled in your account/region -- check with
  `aws bedrock list-inference-profiles --region <region>` yourself, and override
  `STRANDS_MODEL_ID` in `.env` if yours differs.
- Your IAM identity has `bedrock:InvokeModel`/`bedrock:InvokeModelWithResponseStream` on
  that model/profile.

Leave `ARCADE_MODE=mock`, `DRY_RUN_CHECKOUT=true` as-is unless you're deliberately testing
the live-checkout stretch goal.

## 3. Sanity-check the mock backend + confirmation gate (no API key needed)

```bash
python scripts/verify_tools.py
```

Should print 18 `[PASS]` lines, including the confirmation-gate checks: checkout is
blocked before an out-of-band confirmation, an unknown nonce is rejected, the same nonce
can't fund a second checkout, and an over-spend-ceiling order needs an explicit override.

## 4. Run the agent

CLI:

```bash
python -m agent.cli
```

Example conversation:

```
You: I want a mug with a cartoon cat on it, 15oz
Agent: [calls list_categories, get_category, create_pattern, get_job, create_product, get_job, get_product]
       ... shows a render + price ...
You: ship it to 123 Demo St, San Francisco CA
Agent: [calls present_confirmation] Here's your order: ... Type exactly: confirm a1b2c3d4
You: confirm a1b2c3d4
[confirmation driver] Confirmation 'a1b2c3d4' marked confirmed.
Agent: [calls create_checkout] Your (demo) order is placed! ...
You: what's the status?
Agent: [calls get_order] Still in production...
```

Browser chat (the actual decided storefront surface):

```bash
streamlit run webui/app.py
```

Same flow, but the confirmation step is a real **Confirm & Checkout** button instead of a
typed command -- clicking it calls `agent.confirmation.mark_confirmed()` directly, the same
out-of-band gate as the CLI, just with a button instead of parsed text.

## The confirmation gate, in one sentence

`create_checkout` only succeeds if `agent.confirmation.mark_confirmed(nonce)` was called by
the driver (CLI command parser or webui button) -- a function the LLM has no tool access to.
A product description, image, or chat message that tries to talk the agent into believing
the user already confirmed cannot make checkout fire; see
[redteam-cases.md](redteam-cases.md) case 2.4 for the attack this defends against.

## Tracing (local debugging, opt-in)

Strands emits OTel spans for every model call and tool call automatically. To see them:

```bash
docker compose up -d        # starts a local Jaeger, http://localhost:16686
```

Set `OTEL_ENABLED=true` in `.env` (leave `OTEL_EXPORTER_OTLP_ENDPOINT` as the default
`http://localhost:4318` unless Jaeger is running elsewhere), then run the CLI or webui as
normal. Every `agent(user_message)` call becomes one `agent.turn` trace in Jaeger, with
Strands' own `invoke_agent`/`execute_event_loop_cycle`/`chat`/tool-call spans nested
underneath it -- including the model id, tool inputs, and (if something fails) the actual
exception, which is the main reason to turn this on: it's much faster to find *why* a
turn failed in Jaeger's trace view than from CLI stack traces alone.

This is strictly a local debugging aid -- turning it off (the default) doesn't change
behavior, and it's not a substitute for `agent/confirmation.py`'s audit log, which is what
agent_constitution.md's "log every state transition" rule actually depends on.

Turn it off / tear down: `docker compose down` (or just leave `OTEL_ENABLED=false`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bedrock call fails with an access/validation error on the model id | Run `aws bedrock list-inference-profiles --region <region>` yourself and set `STRANDS_MODEL_ID` in `.env` to one that's actually enabled for your account |
| Bedrock call fails with a credentials error | Run `aws configure list` yourself to confirm boto3 can find credentials; `AWS_REGION` in `.env` must match a region with model access |
| Bedrock call fails with `ResourceNotFoundException: Model use case details have not been submitted for this account` | AWS-account-level entitlement issue, unrelated to this repo's code -- fill out the Anthropic model use-case form in the Bedrock console for your account, then retry after a few minutes |
| `ModuleNotFoundError: strands` | `pip install -r requirements.txt` inside the activated venv |
| `pip install` fails resolving `strands-agents` | Needs Python 3.10+; this repo's system `python3` may be older (3.9) -- use `python3.12` (or newer) to create the venv |
| Agent calls `create_checkout` and it refuses | Expected unless you typed/clicked the exact confirmation step first -- that's the gate working |
| No traces in Jaeger | Confirm `docker compose ps` shows `doraemon-jaeger` healthy and `OTEL_ENABLED=true` is actually set before the process started (it's read once at startup) |

## Next step: red-teaming

`scripts/verify_tools.py` exercises the gate directly; the next step is driving the actual
*agent* (LLM in the loop) through the cases in [redteam-cases.md](redteam-cases.md) --
starting with 2.1/2.2/2.4 (prompt injection, image-borne injection, confirmation-gate
erosion), since those are the ones a mocked backend can already fully exercise without
needing live Arcade credentials.
