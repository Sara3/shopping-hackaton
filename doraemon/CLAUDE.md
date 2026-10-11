# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Doraemon is a commerce agent for Arcade AI's "Shopping 3.0" hackathon: a user describes
a product in natural language or uploads a reference photo, and the agent turns that
into a real, priced, orderable product routed to fulfillment through Arcade's
manufacturer network. Full product shape, pipeline, and current architecture — the
source of truth, keep this up to date rather than this file: [agent.md](agent.md).

## Status & commands

Stack chosen: Python 3.12 + Strands Agents SDK + Claude via the Claude API
(`MODEL_PROVIDER=anthropic`, the default, keyed by `CLAUDE_API_KEY`) or Amazon Bedrock
(`MODEL_PROVIDER=bedrock`) — no other providers. In the shopping-hackaton monorepo Doraemon is
the chat's agent: `agent/service.py` serves the web UI (`../web/`) and every Arcade call goes
through the Leash gateway with the web session's token. For install/run/test commands and
troubleshooting, see [RUNNING.md](RUNNING.md) — don't duplicate them here. Never run `aws`
CLI commands without the user's explicit go-ahead first, even read-only ones.

## Hard rules before writing code here

[agent_constitution.md](agent_constitution.md) governs this repo and is not optional
context — it defines what you (the coding agent) can do autonomously vs. must ask the
user about first, and the non-negotiable rules for the commerce agent itself (real
money/fulfillment only on explicit confirmation, sandbox-by-default, untrusted-input
handling, no secrets in commits). Read it before implementing anything in the
order/payment/fulfillment path. The confirmation gate (agent.md, `agent/confirmation.py`)
is the hard boundary between "exploring ideas" and "spending real money" — evaluate any
change touching ordering/payment against where it sits relative to that boundary, and
treat real Arcade credentials, real checkout, or flipping `DRY_RUN_CHECKOUT=false` as
"must ask first" per the constitution.
