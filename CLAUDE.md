# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repo is pre-implementation — no source code, build tooling, or tests exist yet.
There are no build/lint/test commands to run. Once a stack is chosen and code lands,
replace this section with the real commands (build, lint, test, run a single test).

## What this project is

Doraemon is a commerce agent for Arcade AI's "Shopping 3.0" hackathon: a user describes
a product in natural language or uploads a reference photo, and the agent turns that
into a real, priced, orderable product routed to fulfillment through Arcade's
manufacturer network. Full product shape and pipeline: [agent.md](agent.md).

## Hard rules before writing code here

[agent_constitution.md](agent_constitution.md) governs this repo and is not optional
context — it defines what you (the coding agent) can do autonomously vs. must ask the
user about first, and the non-negotiable rules for the commerce agent itself (real
money/fulfillment only on explicit confirmation, sandbox-by-default, untrusted-input
handling, no secrets in commits). Read it before implementing anything in the
order/payment/fulfillment path.

## Architecture (planned)

The intended pipeline, detailed in agent.md, is: natural-language/image intake → spec
generation → Arcade product generation (imaging) → Arcade instant pricing → listing →
explicit user confirmation → fulfillment via Arcade's manufacturer network. The
confirmation step is the hard boundary between "exploring ideas" and "spending real
money" — any code change that touches ordering/payment should be evaluated against
where it sits relative to that boundary.

Tech stack, API auth model, and storefront surface (standalone web app vs. chat agent vs.
Shopify app) are not yet decided — see the Open/TBD section of agent.md.
