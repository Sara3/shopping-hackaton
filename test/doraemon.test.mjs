import test from "node:test";
import assert from "node:assert/strict";
import { DoraemonError, TOKEN_MIN_REMAINING_MS, createDoraemonAgent } from "../agent/doraemon-agent.mjs";
import { createLeashClient } from "../gateway/client.mjs";
import { createLeashSession, wrapAgentWithMandates } from "../web/leash.mjs";
import { doraemonEnvs } from "../scripts/dev.mjs";
import { resolveWebConfig } from "../web/config.mjs";

const LEASH_URL = "http://127.0.0.1:8080";
const DORAEMON_URL = "http://127.0.0.1:8790";
const SERVICE_KEY = "service-key-0123456789";
const TOKEN = "leash_session-token";
const PINNED = "leash_pinned-token";
const PRODUCT_CARD = { type: "product", productId: "prod_1", title: "Silk scarf", unitPrice: "128.00", quantity: 1, total: "128.00" };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Serves the Doraemon service (/turn) and the gateway's /mandates, recording every request body.
function fakeNetwork(turnReplies, { mandateDenial = null } = {}) {
  const requests = [];
  const queue = [...turnReplies];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    if (url === `${DORAEMON_URL}/turn`) return json(200, queue.shift());
    if (url === `${LEASH_URL}/mandates`) {
      if (mandateDenial) return json(403, mandateDenial);
      return json(200, { mandateId: "mnd_1", mandate: { quantity: body.quantity, productId: body.productId, unitPrice: "128.00", maxTotal: "128.00" } });
    }
    return json(404, { error: "not_found" });
  };
  return { fetchImpl, requests };
}

const turnReply = (overrides = {}) => ({
  reply: "ok", cards: [], calls: [], notes: [], proposal: null, traceId: "a".repeat(32),
  session: { id: "s1", turns: [{ role: "user", text: "x" }], patterns: [], products: [], checkouts: [], pages: [] },
  ...overrides,
});

function setup(turnReplies, options) {
  const network = fakeNetwork(turnReplies, options);
  const leash = createLeashClient({ leashUrl: LEASH_URL, getToken: async () => TOKEN, fetchImpl: network.fetchImpl });
  const agent = createDoraemonAgent({ leash, url: DORAEMON_URL, serviceKey: SERVICE_KEY, model: "claude-opus-5-5", fetchImpl: network.fetchImpl });
  return { ...network, leash, agent };
}

test("doraemon agent: a turn sends the session's token, no mandate, the service key, and fresh on a new session", async () => {
  const { agent, requests } = setup([turnReply({ proposal: "Silk scarf at $128.00 × 1 = $128.00" })]);
  const result = await agent.handleMessage({ session: { id: "s1", turns: [] }, text: "  a blue scarf  ", inspiration: "" });
  const [request] = requests;
  assert.equal(request.url, `${DORAEMON_URL}/turn`);
  assert.equal(request.headers.Authorization, `Bearer ${SERVICE_KEY}`);
  assert.deepEqual(request.body.leash, { url: LEASH_URL, token: TOKEN });
  assert.equal(request.body.mandateId, null);
  assert.equal(request.body.fresh, true);
  assert.equal(request.body.text, "a blue scarf");
  assert.equal(result.trace.mode, "doraemon");
  assert.equal(result.trace.proposal, "Silk scarf at $128.00 × 1 = $128.00");
  assert.equal(result.session.id, "s1");
});

test("doraemon agent: inside withMandate it hands Doraemon the mandate and the token pinned with it", async () => {
  const { agent, leash, requests } = setup([turnReply()]);
  await leash.withMandate("mnd_9", () => agent.handleMessage({ session: { id: "s1", turns: [{}] }, text: "approve" }), PINNED);
  assert.equal(requests[0].body.mandateId, "mnd_9");
  assert.equal(requests[0].body.leash.token, PINNED);
  assert.equal(requests[0].body.fresh, false);
});

test("doraemon agent behind the mandate wrapper: Approve on the carded product mints a mandate, then confirms through Doraemon", async () => {
  const shown = turnReply({ cards: [PRODUCT_CARD], session: { id: "s1", turns: [{}, {}], patterns: [], products: [PRODUCT_CARD], checkouts: [], pages: [] } });
  const { agent, leash, requests } = setup([shown, turnReply()]);
  const session = { getToken: async () => TOKEN, client: leash, tokenInfo: () => null };
  const wrapped = wrapAgentWithMandates(agent, session, { logger: { warn() {} } });
  const first = await wrapped.handleMessage({ session: { id: "s1", turns: [] }, text: "a blue scarf, ship to SF" });
  await wrapped.handleMessage({ session: first.session, text: "approve" });
  const mandate = requests.find((request) => request.url === `${LEASH_URL}/mandates`);
  assert.deepEqual({ productId: mandate.body.productId, quantity: mandate.body.quantity }, { productId: "prod_1", quantity: 1 });
  const approval = requests.filter((request) => request.url === `${DORAEMON_URL}/turn`)[1];
  assert.equal(approval.body.mandateId, "mnd_1");
  assert.equal(approval.body.leash.token, TOKEN);
});

test("doraemon agent behind the mandate wrapper: a mandate the gateway refuses reaches Doraemon as the refusal", async () => {
  const shown = turnReply({ cards: [PRODUCT_CARD], session: { id: "s1", turns: [{}, {}], patterns: [], products: [PRODUCT_CARD], checkouts: [], pages: [] } });
  const denial = { error: "price_exceeded", message: "2 × 128.00 = 256.00 is over this token's maxSpend 200.00", rule: "price_delta", tokenFrozen: false };
  const { agent, leash, requests } = setup([shown, turnReply()], { mandateDenial: denial });
  const wrapped = wrapAgentWithMandates(agent, { getToken: async () => TOKEN, client: leash, tokenInfo: () => null }, { logger: { warn() {} } });
  const first = await wrapped.handleMessage({ session: { id: "s1", turns: [] }, text: "two scarves" });
  await wrapped.handleMessage({ session: first.session, text: "approve 2" });
  const approval = requests.filter((request) => request.url === `${DORAEMON_URL}/turn`)[1];
  assert.equal(approval.body.mandateId, null);
  assert.deepEqual(approval.body.mandateRefusal, { code: "price_exceeded", message: denial.message, rule: "price_delta" });
});

test("doraemon agent: a service error surfaces with its code; it refuses to run without a Leash client", async () => {
  const fetchImpl = async () => json(409, { error: "session_busy", message: "still handling a message" });
  const leash = createLeashClient({ leashUrl: LEASH_URL, getToken: async () => TOKEN, fetchImpl });
  const agent = createDoraemonAgent({ leash, url: DORAEMON_URL, serviceKey: SERVICE_KEY, fetchImpl });
  await assert.rejects(agent.handleMessage({ session: { id: "s1" }, text: "hi" }), (error) => error instanceof DoraemonError && error.code === "session_busy");
  assert.throws(() => createDoraemonAgent({ leash: { call() {} }, serviceKey: SERVICE_KEY }), /only behind Leash/);
});

test("dev: Doraemon never gets the Arcade key or the admin key; dry-run is off only on the replica", () => {
  const env = { AGENT_BACKEND: "doraemon", LEASH_URL, ARCADE_API_KEY: "arcade_sk_live_x", LEASH_ADMIN_KEY: "admin-key-0123456789" };
  const mock = doraemonEnvs(env, { isMock: true, makeServiceKey: () => SERVICE_KEY });
  assert.equal(mock.serviceEnv.ARCADE_API_KEY, "");
  assert.equal(mock.serviceEnv.LEASH_ADMIN_KEY, "");
  assert.equal(mock.serviceEnv.DRY_RUN_CHECKOUT, "false");
  assert.deepEqual(mock.webShared, { DORAEMON_URL, DORAEMON_SERVICE_KEY: SERVICE_KEY });
  assert.equal(doraemonEnvs(env, { isMock: false, makeServiceKey: () => SERVICE_KEY }).serviceEnv.DRY_RUN_CHECKOUT, undefined);
  assert.equal(doraemonEnvs({ ...env, AGENT_BACKEND: "naive" }, { isMock: true }), null);
  assert.throws(() => doraemonEnvs({ AGENT_BACKEND: "doraemon" }, { isMock: true }), /behind Leash only/);
});

test("config: AGENT_BACKEND=doraemon reports the doraemon agent; unset keeps the naive one", () => {
  assert.equal(resolveWebConfig({ AGENT_BACKEND: "doraemon" }).publicConfig.agentMode, "doraemon");
  assert.equal(resolveWebConfig({ AGENT_MODE: "scripted" }).publicConfig.agentBackend, "naive");
});

test("leash session: a token that cannot outlive a Doraemon turn is renewed before the turn, a fresh one is kept", async () => {
  const TTL_MS = 600_000;
  let clock = Date.parse("2026-10-11T20:00:00Z");
  let minted = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/tokens")) {
      minted += 1;
      const tokenId = `tok_${String(minted).padStart(16, "0")}`;
      return json(200, { token: `leash_t${minted}`, tokenId, agentId: "web-agent", payer: "p", maxSpend: "200.00", categories: ["Silk scarf"], scopes: [], expiresAt: new Date(clock + TTL_MS).toISOString() });
    }
    return json(200, { frozen: false });
  };
  const config = { leashUrl: LEASH_URL, agentId: "web-agent", payer: "p", maxSpend: "200.00", categories: ["Silk scarf"], ttlSeconds: 600, adminKey: "admin-key-0123456789" };
  const session = createLeashSession(config, { fetchImpl, now: () => clock, logger: { info() {}, warn() {} } });
  const first = await session.getToken();
  clock += TTL_MS - TOKEN_MIN_REMAINING_MS + 1_000; // the token has less than a turn's worth of life left
  assert.equal(await session.getToken(), first, "plain callers keep it until its last 30 s");
  const forTurn = await session.client.currentToken(TOKEN_MIN_REMAINING_MS);
  assert.notEqual(forTurn, first, "a Doraemon turn gets a renewed token");
  assert.equal(await session.client.currentToken(TOKEN_MIN_REMAINING_MS), forTurn, "a fresh token is not renewed again");
});
