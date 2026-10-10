# Repo rules (hackathon entry, built on Arcade's API)

- Read `.claude/skills/arcade-api/SKILL.md` before touching the API. Full OpenAPI: https://docs.arcade.ai/openapi.json
- Use `src/arcade.mjs` for every call: it sets the mandatory `User-Agent`, retries 429/5xx, and polls jobs every 3 s.
- Never automate payment or open `checkoutUrl` programmatically; never load-test; never commit `.env`.
- Every call hits the real Studio account (no sandbox). Pattern + product creation is fine; checkout only when a human asks.
- Pattern generation takes ~1–2 min: pre-generate demo assets and cache `patternId`/`productId` for the 90-second demo.
- Node 26, ESM (`.mjs`), zero runtime dependencies unless the entry needs them. Tests: `npm test` (node --test, fake fetch).
