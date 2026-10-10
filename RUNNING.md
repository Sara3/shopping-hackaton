# Running Doraemon Locally

Stack: [Strands Agents SDK](https://strandsagents.com) + Claude, Python 3.12. Model host
is **Amazon Bedrock only** -- no other provider is supported. Deliberately minimal: a
single agent and tool set, no OTel/policy-sidecar/Docker.

**Arcade's live API isn't reachable yet** (see [arcade-api-notes.md](arcade-api-notes.md)),
so every tool call is served by `agent/arcade_client.py`'s `MockArcadeClient` -- data shaped
exactly like Arcade's real schemas, clearly labeled `"mocked": True`. `ARCADE_MODE=mock` is
the only implemented value right now; see that file's docstring for how a `LiveArcadeClient`
drops in later without touching `agent/tools.py`.

## What's in this project

```
doraemon/
├── agent/
│   ├── cli.py            # interactive chat loop / entrypoint
│   ├── agent.py           # builds the Strands Agent (system prompt, tools, model)
│   ├── tools.py            # the 9 @tool functions (see agent.md's "Agent architecture")
│   ├── arcade_client.py     # ArcadeClient interface + MockArcadeClient
│   ├── confirmation.py       # the out-of-band confirmation gate (see its docstring)
│   └── config.py              # env-based configuration
├── webui/app.py           # Streamlit browser chat (the decided storefront surface)
├── scripts/verify_tools.py # no-LLM sanity check of the mock client + confirmation gate
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bedrock call fails with an access/validation error on the model id | Run `aws bedrock list-inference-profiles --region <region>` yourself and set `STRANDS_MODEL_ID` in `.env` to one that's actually enabled for your account |
| Bedrock call fails with a credentials error | Run `aws configure list` yourself to confirm boto3 can find credentials; `AWS_REGION` in `.env` must match a region with model access |
| `ModuleNotFoundError: strands` | `pip install -r requirements.txt` inside the activated venv |
| `pip install` fails resolving `strands-agents` | Needs Python 3.10+; this repo's system `python3` may be older (3.9) -- use `python3.12` (or newer) to create the venv |
| Agent calls `create_checkout` and it refuses | Expected unless you typed/clicked the exact confirmation step first -- that's the gate working |

## Next step: red-teaming

`scripts/verify_tools.py` exercises the gate directly; the next step is driving the actual
*agent* (LLM in the loop) through the cases in [redteam-cases.md](redteam-cases.md) --
starting with 2.1/2.2/2.4 (prompt injection, image-borne injection, confirmation-gate
erosion), since those are the ones a mocked backend can already fully exercise without
needing live Arcade credentials.
