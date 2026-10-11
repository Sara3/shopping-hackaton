// Unit tests for the agent side of Leash: gateway/client.mjs, web/leash.mjs and the recorder's
// gateway path. Fake fetch only (no gateway, no Arcade); the end-to-end lives in leash-e2e.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArcadeError, USER_AGENT } from "../src/arcade.mjs";
import { issueToken, validateTokenRequest } from "../gateway/tokens.mjs";
import { LeashError, createLeashClient, issueAgentToken, normalizeLeashUrl } from "../gateway/client.mjs";
import {
  APPROVAL_PATTERN, DEFAULT_CATEGORIES, MAX_REMEMBERED_TOKENS, createLeashSession, humanQuantity, resolveLeashConfig, wrapAgentWithMandates,
} from "../web/leash.mjs";
import { createCheckoutRecorder } from "../web/recorder.mjs";
import { APPROVE_PATTERN } from "../agent/scripted.mjs";

const LEASH = "http://127.0.0.1:8080";
const MOCK_CHECKOUT_URL = "http://localhost:8788/checkout/1000000001";
const silent = { info() {}, warn() {}, error() {} };
const START_MS = Date.parse("2026-10-11T10:00:00.000Z");

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const request = {
      url: String(url),
      path: new URL(String(url)).pathname,
      method: init.method ?? "GET",
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    requests.push(request);
    return handler(request);
  };
  return { requests, fetchImpl };
}

const deepFreeze = (value) => {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const realToken = (nowMs = START_MS) =>
  issueToken(validateTokenRequest({ agentId: "web-agent", payer: "demo-user", maxSpend: "200.00", categories: [...DEFAULT_CATEGORIES] }), {
    secret: "unit-secret",
    now: () => nowMs,
  });

const tokenResponse = ({ token, claims }) => ({ token, ...claims });
const FROZEN = { error: "token_frozen", message: "token is frozen (quantity_above_mandate)", rule: "quantity_above_mandate", tokenFrozen: true };

// ---------------------------------------------------------------------------- gateway/client.mjs

test("normalizeLeashUrl: loopback http or any https, no credentials, no trailing slash", () => {
  assert.equal(normalizeLeashUrl("http://127.0.0.1:8080/"), LEASH);
  assert.equal(normalizeLeashUrl("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeLeashUrl("https://leash.example.com/gw/"), "https://leash.example.com/gw");
  for (const bad of ["http://leash.example.com", "ftp://127.0.0.1", "not a url", "", "http://user:pw@127.0.0.1:8080", "http://127.0.0.1:8080/?q=1"]) {
    assert.throws(() => normalizeLeashUrl(bad), /LEASH_URL/, bad);
  }
});

test("LeashError carries status, gateway code and body; message names path, status and code", () => {
  const error = new LeashError(403, FROZEN, "/checkout");
  assert.equal(error.status, 403);
  assert.equal(error.code, "token_frozen");
  assert.equal(error.body.rule, "quantity_above_mandate");
  assert.equal(error.message, "Leash /checkout → HTTP 403: token_frozen token is frozen (quantity_above_mandate)");
  assert.equal(new LeashError(500, "oops", "/tokens").code, "http_500");
});

test("proxied Arcade calls go to <leash>/arcade with the CURRENT token, the client's User-Agent, never the placeholder", async () => {
  let token = "leash_first";
  const { requests, fetchImpl } = fakeFetch(() => jsonResponse(200, { items: [] }));
  const client = createLeashClient({ leashUrl: LEASH, getToken: async () => token, fetchImpl });
  await client.listCategories();
  token = "leash_second";
  await client.getProduct("p1", 2);
  assert.equal(client.baseUrl, `${LEASH}/arcade`);
  assert.equal(requests[0].url, `${LEASH}/arcade/categories/list`);
  assert.equal(requests[0].headers.Authorization, "Bearer leash_first");
  assert.equal(requests[0].headers["User-Agent"], USER_AGENT);
  assert.equal(requests[1].headers.Authorization, "Bearer leash_second");
  assert.deepEqual(requests[1].body, { productId: "p1", quantity: 2 });
  assert.equal(client.getOrder, undefined);
  assert.equal(client.listOrders, undefined);
});

test("generatePattern keeps the arcade client's job polling through the gateway", async () => {
  const replies = {
    "/arcade/patterns/create": { jobId: "j1" },
    "/arcade/jobs/get": { jobId: "j1", status: "succeeded", result: { patternId: "pat1" } },
    "/arcade/patterns/get": { patternId: "pat1", prompt: "blue florals" },
  };
  const { requests, fetchImpl } = fakeFetch((request) => jsonResponse(200, replies[request.path]));
  const client = createLeashClient({ leashUrl: LEASH, getToken: async () => "leash_t", fetchImpl });
  const pattern = await client.generatePattern({ prompt: "blue florals" }, { intervalMs: 1 });
  assert.equal(pattern.patternId, "pat1");
  assert.deepEqual(requests.map((request) => request.path), Object.keys(replies));
});

test("a gateway denial on a proxied call becomes a LeashError with the gateway code; Arcade errors pass through", async () => {
  const { fetchImpl } = fakeFetch((request) =>
    request.path === "/arcade/patterns/create" ? jsonResponse(403, FROZEN) : jsonResponse(404, { code: "NOT_FOUND", status: 404, message: "No product p9." }));
  const client = createLeashClient({ leashUrl: LEASH, getToken: async () => "leash_t", fetchImpl });
  await assert.rejects(client.generatePattern({ prompt: "x" }), (error) => {
    assert.ok(error instanceof LeashError);
    assert.equal(error.code, "token_frozen");
    assert.match(error.message, /^Leash \/arcade\/patterns\/create → HTTP 403: token_frozen /);
    return true;
  });
  await assert.rejects(client.getProduct("p9"), (error) => error instanceof ArcadeError && !(error instanceof LeashError) && error.status === 404);
});

test("createCheckout posts token, the scoped mandateId and the lines to /checkout, once, and returns only the gateway's JSON", async () => {
  const { requests, fetchImpl } = fakeFetch(() => jsonResponse(200, { checkoutUrl: MOCK_CHECKOUT_URL }));
  const client = createLeashClient({ leashUrl: LEASH, getToken: async () => "leash_t", fetchImpl });
  const lines = [{ productId: "p1", quantity: 1 }];
  const out = await client.withMandate("mnd_1", () => client.createCheckout({ lines, dropShip: true }));
  assert.deepEqual(out, { checkoutUrl: MOCK_CHECKOUT_URL });
  assert.equal(requests[0].url, `${LEASH}/checkout`);
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, { token: "leash_t", mandateId: "mnd_1", lines });
  assert.equal(client.currentMandateId(), null);
  await client.createCheckout({ lines });
  assert.equal(requests[1].body.mandateId, null);
});

test("withMandate pins the token the mandate was minted with: createCheckout sends it even after getToken() renewed", async () => {
  let token = "leash_renewed";
  const { requests, fetchImpl } = fakeFetch(() => jsonResponse(200, { checkoutUrl: MOCK_CHECKOUT_URL, mandateId: "mnd_1" }));
  const client = createLeashClient({ leashUrl: LEASH, getToken: async () => token, fetchImpl });
  await client.createMandate({ productId: "p1", quantity: 1, token: "leash_pinned" });
  await client.withMandate("mnd_1", () => client.createCheckout({ lines: [{ productId: "p1", quantity: 1 }] }), "leash_pinned");
  token = "leash_later";
  await client.createCheckout({ lines: [{ productId: "p1", quantity: 1 }] });
  assert.deepEqual(requests.map((request) => [request.path, request.body.token, request.body.mandateId ?? null]), [
    ["/mandates", "leash_pinned", null], ["/checkout", "leash_pinned", "mnd_1"], ["/checkout", "leash_later", null],
  ]);
});

test("createCheckout never retries: a 403 or 502 from /checkout throws a LeashError after one request", async () => {
  for (const [status, body] of [[403, { error: "mandate_mismatch", message: "line quantity 50 is above the mandated 1", rule: "quantity_above_mandate", tokenFrozen: true }], [502, { error: "arcade_error", message: "down" }]]) {
    const { requests, fetchImpl } = fakeFetch(() => jsonResponse(status, body));
    const client = createLeashClient({ leashUrl: LEASH, getToken: async () => "leash_t", fetchImpl });
    await assert.rejects(client.createCheckout({ lines: [{ productId: "p1", quantity: 50 }] }), (error) => error instanceof LeashError && error.code === body.error);
    assert.equal(requests.length, 1);
  }
});

test("createMandate posts token, productId and quantity to /mandates; tokenStatus reads GET /tokens/<tokenId>", async () => {
  const issued = realToken();
  const { requests, fetchImpl } = fakeFetch((request) => jsonResponse(200, request.path === "/mandates" ? { mandateId: "mnd_1" } : { frozen: false }));
  const client = createLeashClient({ leashUrl: LEASH, getToken: async () => issued.token, fetchImpl });
  assert.deepEqual(await client.createMandate({ productId: "p1", quantity: 1 }), { mandateId: "mnd_1" });
  assert.deepEqual(requests[0].body, { token: issued.token, productId: "p1", quantity: 1 });
  assert.deepEqual(await client.tokenStatus(), { frozen: false });
  assert.equal(requests[1].method, "GET");
  assert.equal(requests[1].url, `${LEASH}/tokens/${issued.claims.tokenId}`);
});

test("issueAgentToken posts the request to /tokens (admin bearer only when set) and refuses a reply without a token", async () => {
  const issued = realToken();
  const { requests, fetchImpl } = fakeFetch(() => jsonResponse(200, tokenResponse(issued)));
  const request = { leashUrl: LEASH, agentId: "web-agent", payer: "demo-user", maxSpend: "200.00", categories: ["Silk scarf"], ttlSeconds: 600, fetchImpl };
  const out = await issueAgentToken(request);
  assert.equal(out.tokenId, issued.claims.tokenId);
  assert.deepEqual(requests[0].body, { agentId: "web-agent", payer: "demo-user", maxSpend: "200.00", categories: ["Silk scarf"], ttlSeconds: 600 });
  assert.equal(requests[0].headers.Authorization, undefined);
  await issueAgentToken({ ...request, adminKey: "admin-key-123" });
  assert.equal(requests[1].headers.Authorization, "Bearer admin-key-123");
  const empty = fakeFetch(() => jsonResponse(200, { tokenId: "tok_x" }));
  await assert.rejects(issueAgentToken({ ...request, fetchImpl: empty.fetchImpl }), /no token/);
  const refused = fakeFetch(() => jsonResponse(400, { error: "scope_forbidden", message: "refused: checkouts:create" }));
  await assert.rejects(issueAgentToken({ ...request, fetchImpl: refused.fetchImpl }), (error) => error instanceof LeashError && error.code === "scope_forbidden");
});

// ---------------------------------------------------------------------------- web/leash.mjs

test("APPROVAL_PATTERN is the scripted agent's APPROVE_PATTERN; humanQuantity reads what the human typed", () => {
  assert.deepEqual([APPROVAL_PATTERN.source, APPROVAL_PATTERN.flags], [APPROVE_PATTERN.source, APPROVE_PATTERN.flags]);
  for (const text of ["approve", "Yes please", "ok", "OK 2", "approve 50", "okay", "Approved!", "yesss", "silk scarf", "not ok", "nope"]) {
    assert.equal(APPROVAL_PATTERN.test(text), APPROVE_PATTERN.test(text), text);
  }
  for (const text of ["okay", "approved"]) assert.match(text, APPROVAL_PATTERN, text);
  assert.equal(humanQuantity("approve"), 1);
  assert.equal(humanQuantity("approve 2"), 2);
  assert.equal(humanQuantity("yes, 3 of them"), 3);
  assert.equal(humanQuantity("ok 1000"), 1);
  assert.equal(humanQuantity("approve 50 scarves, not 7"), 50);
});

test("resolveLeashConfig: null without LEASH_URL, defaults, csv categories, bad URL throws", () => {
  assert.equal(resolveLeashConfig({}), null);
  assert.equal(resolveLeashConfig({ LEASH_URL: "" }), null);
  const config = resolveLeashConfig({ LEASH_URL: `${LEASH}/` });
  assert.deepEqual(config, {
    leashUrl: LEASH, agentId: "web-agent", payer: "demo-user", maxSpend: "200.00", categories: DEFAULT_CATEGORIES, ttlSeconds: 600, adminKey: null,
  });
  const custom = resolveLeashConfig({ LEASH_URL: LEASH, LEASH_PAYER: "mom", LEASH_MAX_SPEND: "50.00", LEASH_CATEGORIES: " Silk scarf , Lampshade ,", LEASH_ADMIN_KEY: "adm" });
  assert.deepEqual([custom.payer, custom.maxSpend, custom.categories, custom.adminKey], ["mom", "50.00", ["Silk scarf", "Lampshade"], "adm"]);
  assert.throws(() => resolveLeashConfig({ LEASH_URL: "http://leash.example.com" }), /LEASH_URL/);
});

function gatewayStub({ mandate = "ok", status = { frozen: false }, afterMandateMs = 0, beforeIssue = async () => {}, logger = silent } = {}) {
  let clock = START_MS;
  const issuedTokens = [];
  const { requests, fetchImpl } = fakeFetch(async (request) => {
    if (request.path === "/tokens") {
      await beforeIssue(issuedTokens.length);
      const issued = realToken(clock);
      issuedTokens.push(issued);
      return jsonResponse(200, tokenResponse(issued));
    }
    if (request.path.startsWith("/tokens/")) return jsonResponse(200, status);
    if (request.path === "/checkout") return jsonResponse(200, { checkoutUrl: MOCK_CHECKOUT_URL });
    if (mandate !== "ok") return jsonResponse(403, mandate);
    clock += afterMandateMs;
    const { productId, quantity } = request.body;
    return jsonResponse(200, { mandateId: "mnd_1", mandate: { mandateId: "mnd_1", productId, quantity, unitPrice: "128.00", maxTotal: "128.00" }, signature: "ab" });
  });
  const config = resolveLeashConfig({ LEASH_URL: LEASH });
  const session = createLeashSession(config, { fetchImpl, now: () => clock, logger });
  return { session, requests, issuedTokens, tick: (ms) => { clock += ms; } };
}

test("createLeashSession issues one token for concurrent callers and exposes public info without the token", async () => {
  const { session, requests, issuedTokens } = gatewayStub();
  const [a, b] = await Promise.all([session.getToken(), session.getToken()]);
  assert.equal(a, b);
  assert.equal(requests.filter((request) => request.path === "/tokens").length, 1);
  assert.equal(session.tokenInfo().tokenId, issuedTokens[0].claims.tokenId);
  const info = session.publicInfo();
  assert.deepEqual(Object.keys(info).sort(), ["agentId", "categories", "expiresAt", "maxSpend", "scopes", "tokenId", "url"]);
  assert.doesNotMatch(JSON.stringify(info), new RegExp(a.slice(10, 40)));
});

test("createLeashSession renews within 30 s of expiry, but never renews a frozen token", async () => {
  const fresh = gatewayStub();
  const first = await fresh.session.getToken();
  fresh.tick(600_000 - 20_000);
  const second = await fresh.session.getToken();
  assert.notEqual(second, first);
  assert.equal(fresh.issuedTokens.length, 2);

  const frozen = gatewayStub({ status: { frozen: true, frozenReason: "quantity_above_mandate" } });
  const kept = await frozen.session.getToken();
  frozen.tick(600_000 - 20_000);
  assert.equal(await frozen.session.getToken(), kept);
  assert.equal(await frozen.session.getToken(), kept);
  assert.equal(frozen.issuedTokens.length, 1);
  assert.equal(frozen.requests.filter((request) => request.path.startsWith("/tokens/")).length, 1);
});

const tokenIssues = (requests) => requests.filter((request) => request.path === "/tokens").length;
const statusChecks = (requests) => requests.filter((request) => request.path.startsWith("/tokens/")).length;

test("createLeashSession.reset() mints a new token even while the current one is fresh, logs the rotation, returns public info", async () => {
  const lines = [];
  const { session, issuedTokens } = gatewayStub({ logger: { ...silent, info: (line) => lines.push(line) } });
  const first = await session.getToken();
  const info = await session.reset();
  const [old, rotated] = issuedTokens.map((issued) => issued.claims.tokenId);
  assert.notEqual(rotated, old);
  assert.equal(info.tokenId, rotated);
  assert.deepEqual(info, session.publicInfo());
  assert.equal(session.tokenInfo().tokenId, rotated);
  assert.equal(await session.getToken(), issuedTokens[1].token);
  assert.notEqual(await session.getToken(), first);
  assert.doesNotMatch(JSON.stringify(info), new RegExp(issuedTokens[1].token.slice(10, 40)));
  assert.equal(lines.at(-1), `leash: token rotated ${old} → ${rotated}`);

  const cold = gatewayStub({ logger: { ...silent, info: (line) => lines.push(line) } });
  const coldInfo = await cold.session.reset();
  assert.equal(coldInfo.tokenId, cold.issuedTokens[0].claims.tokenId);
  assert.equal(lines.at(-1), `leash: token rotated none → ${coldInfo.tokenId}`);
});

test("createLeashSession.reset() replaces a frozen, renew-blocked token without asking its status", async () => {
  const { session, requests, issuedTokens, tick } = gatewayStub({ status: { frozen: true, frozenReason: "quantity_above_mandate" } });
  const kept = await session.getToken();
  tick(600_000 - 20_000);
  assert.equal(await session.getToken(), kept);
  const checks = statusChecks(requests);
  const info = await session.reset();
  assert.equal(statusChecks(requests), checks, "reset() asked for the frozen token's status");
  assert.equal(info.tokenId, issuedTokens[1].claims.tokenId);
  const fresh = await session.getToken();
  assert.equal(fresh, issuedTokens[1].token);
  assert.notEqual(fresh, kept);
  assert.equal(await session.getToken(), fresh, "the rotated token is not renew-blocked or re-issued while fresh");
  assert.equal(tokenIssues(requests), 2);
});

test("createLeashSession.reset() waits for a pending renew, then issues its own token after it", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { session, requests, issuedTokens } = gatewayStub({ beforeIssue: (count) => (count === 0 ? held : undefined) });
  const renewing = session.getToken();
  const resetting = session.reset();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokenIssues(requests), 1, "reset() asked for a token while a renew was still pending");
  release();
  const [renewed, info] = await Promise.all([renewing, resetting]);
  assert.equal(tokenIssues(requests), 2);
  assert.equal(renewed, issuedTokens[0].token);
  assert.equal(info.tokenId, issuedTokens[1].claims.tokenId);
  assert.equal(await session.getToken(), issuedTokens[1].token);
});

test("createLeashSession.reset() rejects when the gateway refuses, keeping the current token", async () => {
  const { session, issuedTokens } = gatewayStub({ beforeIssue: (count) => { if (count === 1) throw new Error("gateway down"); } });
  const kept = await session.getToken();
  await assert.rejects(session.reset(), /gateway down/);
  assert.equal(await session.getToken(), kept);
  assert.equal(session.tokenInfo().tokenId, issuedTokens[0].claims.tokenId);
});

test("createLeashSession.secrets() lists every token it issued, old and new, frozen and bounded to the last 20", async () => {
  const { session, issuedTokens } = gatewayStub();
  assert.deepEqual(session.secrets(), []);
  await session.getToken();
  await session.reset();
  const listed = session.secrets();
  assert.deepEqual(listed, issuedTokens.map((issued) => issued.token));
  assert.equal(Object.isFrozen(listed), true);
  for (let round = 0; round < MAX_REMEMBERED_TOKENS + 5; round += 1) await session.reset();
  assert.equal(MAX_REMEMBERED_TOKENS, 20);
  assert.equal(session.secrets().length, MAX_REMEMBERED_TOKENS);
  assert.deepEqual(session.secrets(), issuedTokens.slice(-MAX_REMEMBERED_TOKENS).map((issued) => issued.token));
  assert.equal(session.secrets().at(-1), await session.getToken());
  assert.deepEqual(listed, issuedTokens.slice(0, 2).map((issued) => issued.token), "an earlier secrets() array changed");
});

// Design turns show a product card for `carded(session)` (default: the newest product); approvals check out.
const innerAgent = (client, { carded = (session) => session.products.at(-1)?.productId } = {}) => ({
  mode: "scripted",
  handleMessage: async ({ session, text }) => {
    const approval = APPROVE_PATTERN.test(text);
    const checkout = approval ? await client.createCheckout({ lines: [{ productId: "p1", quantity: 1 }] }).catch(() => null) : null;
    const productId = approval ? null : carded(session);
    return deepFreeze({
      session,
      reply: `mandate=${client.currentMandateId()}${checkout ? " checkout" : ""}`,
      cards: productId ? [{ type: "pattern", patternId: "pat1" }, { type: "product", productId, title: "Silk scarf" }] : [],
      trace: { mode: "scripted", calls: [], notes: ["inner note"] },
    });
  },
});

const productSession = (quantity, products = [{ productId: "p1", title: "Silk scarf", quantity }]) =>
  deepFreeze({ id: "s", turns: [], patterns: [], checkouts: [], products });
const mandateBodies = (requests) => requests.filter((request) => request.path === "/mandates").map((request) => request.body);

test("wrapAgentWithMandates: approval binds the HUMAN's quantity, runs the agent inside the mandate, appends a note", async () => {
  const { session, requests } = gatewayStub();
  const agent = wrapAgentWithMandates(innerAgent(session.client), session, { logger: silent });
  await agent.handleMessage({ session: productSession(50), text: "silk scarf, blue florals" });
  const result = await agent.handleMessage({ session: productSession(50), text: "approve", inspiration: "" });
  assert.equal(agent.mode, "scripted");
  assert.deepEqual(mandateBodies(requests)[0].quantity, 1);
  assert.equal(result.reply, "mandate=mnd_1 checkout");
  assert.deepEqual(result.trace.notes, ["inner note", "leash: mandate mnd_1 binds 1 × p1 at $128.00, max $128.00"]);
  assert.deepEqual(result.trace.leash, { tokenId: session.tokenInfo().tokenId, mandateId: "mnd_1" });
  await agent.handleMessage({ session: productSession(1), text: "approve 2" });
  assert.equal(mandateBodies(requests)[1].quantity, 2);
});

test("wrapAgentWithMandates: the mandate binds the product on the last product CARD, not session.products.at(-1)", async () => {
  const { session, requests } = gatewayStub();
  const agent = wrapAgentWithMandates(innerAgent(session.client, { carded: () => "pA" }), session, { logger: silent });
  const shown = productSession(1, [{ productId: "pA", title: "Blue scarf", quantity: 1 }, { productId: "pB", title: "Red roses scarf", quantity: 1 }]);
  await agent.handleMessage({ session: shown, text: "silk scarf, blue florals" });
  const result = await agent.handleMessage({ session: shown, text: "approve" });
  assert.deepEqual(mandateBodies(requests).map((body) => body.productId), ["pA"]);
  assert.match(result.trace.notes.at(-1), / × pA at /);
});

test("wrapAgentWithMandates: no mandate without a product card in this session, or once that product left the session (reset)", async () => {
  const { session, requests } = gatewayStub();
  const agent = wrapAgentWithMandates(innerAgent(session.client), session, { logger: silent });
  const uncarded = await agent.handleMessage({ session: productSession(1), text: "approve" });
  await agent.handleMessage({ session: productSession(1), text: "silk scarf, blue florals" });
  const reset = await agent.handleMessage({ session: productSession(1, []), text: "approve" });
  const other = await agent.handleMessage({ session: { ...productSession(1), id: "other" }, text: "approve" });
  assert.deepEqual(mandateBodies(requests), []);
  assert.deepEqual([uncarded.trace.leash.mandateId, reset.trace.leash.mandateId, other.trace.leash.mandateId], [null, null, null]);
});

test("wrapAgentWithMandates: one token for /mandates and /checkout even when the session renews in between", async () => {
  const { session, requests, issuedTokens } = gatewayStub({ afterMandateMs: 600_000 - 20_000 });
  const agent = wrapAgentWithMandates(innerAgent(session.client), session, { logger: silent });
  await agent.handleMessage({ session: productSession(1), text: "silk scarf, blue florals" });
  const result = await agent.handleMessage({ session: productSession(1), text: "approve" });
  assert.equal(result.reply, "mandate=mnd_1 checkout");
  const minted = requests.find((request) => request.path === "/mandates").body.token;
  assert.equal(requests.find((request) => request.path === "/checkout").body.token, minted);
  assert.equal(minted, issuedTokens[0].token);
});

test("wrapAgentWithMandates: a denied mandate becomes a note and the agent still runs without one", async () => {
  const { session } = gatewayStub({ mandate: { error: "price_exceeded", message: "over maxSpend 200.00", rule: "price_delta", tokenFrozen: false } });
  const agent = wrapAgentWithMandates(innerAgent(session.client), session, { logger: silent });
  await agent.handleMessage({ session: productSession(1), text: "silk scarf, blue florals" });
  const result = await agent.handleMessage({ session: productSession(1), text: "yes" });
  assert.equal(result.reply, "mandate=null checkout");
  assert.deepEqual(result.trace.notes, ["inner note", "leash: mandate denied price_exceeded: over maxSpend 200.00"]);
  assert.equal(result.trace.leash.mandateId, null);
});

test("wrapAgentWithMandates: no mandate for a design turn or an approval with no product", async () => {
  const { session, requests } = gatewayStub();
  const agent = wrapAgentWithMandates(innerAgent(session.client), session, { logger: silent });
  const design = await agent.handleMessage({ session: productSession(1), text: "silk scarf, blue florals" });
  const empty = await agent.handleMessage({ session: deepFreeze({ id: "e", turns: [], patterns: [], products: [], checkouts: [] }), text: "approve" });
  assert.equal(mandateBodies(requests).length, 0);
  assert.deepEqual(design.trace.notes, ["inner note"]);
  assert.equal(design.trace.leash.mandateId, null);
  assert.equal(empty.reply, "mandate=null checkout");
});

test("wrapAgentWithMandates: a gateway-refused checkout becomes the plain-words reply and a blocked card, from this turn's mandate and the allowance", async () => {
  const { session } = gatewayStub();
  const refusal = {
    tool: "create_checkout", args: { productId: "p1", quantity: 50 }, resultSummary: "error: Leash /checkout → HTTP 403: mandate_mismatch", ms: 1,
    error: true, source: "gateway", status: 403, code: "mandate_mismatch", rule: "quantity_above_mandate",
  };
  const refusingAgent = {
    mode: "scripted",
    handleMessage: async ({ session: chat, text }) => {
      const approval = APPROVE_PATTERN.test(text);
      return deepFreeze({
        session: { ...chat, products: [{ productId: "p1", title: "Silk scarf", unitPrice: "102.40", quantity: 50, total: "5120.00" }] },
        reply: approval ? "Sorry, create_checkout failed: Leash /checkout → HTTP 403: mandate_mismatch" : "Approve Silk scarf at $102.40 × 50 = $5120.00?",
        cards: approval ? [] : [{ type: "product", productId: "p1", title: "Silk scarf" }],
        trace: { mode: "scripted", calls: approval ? [refusal] : [], notes: [] },
      });
    },
  };
  const allowance = { maxSpend: "200.00", period: "week", categories: ["Silk scarf"] };
  const agent = wrapAgentWithMandates(refusingAgent, session, { logger: silent, allowance });
  const design = await agent.handleMessage({ session: productSession(50), text: "silk scarf, blue florals" });
  assert.equal(design.reply, "Approve Silk scarf at $102.40 × 50 = $5120.00?", "a turn with no refusal is untouched");
  const result = await agent.handleMessage({ session: productSession(50), text: "approve" });
  assert.equal(result.reply, "Leash blocked it. The agent tried to spend $5120.00 on 50 × Silk scarf. You approved 1 × $128.00 and your allowance is up to $200.00 per week. Nothing was bought.");
  assert.deepEqual(result.cards, [{
    type: "blocked",
    tried: { quantity: 50, total: "5120.00", title: "Silk scarf" },
    approved: { quantity: 1, total: "128.00" },
    allowance,
    code: "mandate_mismatch",
    rule: "quantity_above_mandate",
    reason: "not what you approved (different quantity or product)",
    footer: "Nothing was bought.",
  }]);
  assert.equal(result.trace.leash.mandateId, "mnd_1");
  assert.deepEqual(result.trace.calls, [refusal]);
  const bare = wrapAgentWithMandates(refusingAgent, session, { logger: silent });
  await bare.handleMessage({ session: productSession(50), text: "silk scarf, blue florals" });
  const quoted = await bare.handleMessage({ session: productSession(50), text: "approve" });
  assert.match(quoted.reply, /and your allowance is up to \$200\.00\. Nothing was bought\.$/, "without an allowance the token's own limit is quoted");
});

// ---------------------------------------------------------------------------- web/recorder.mjs

test("recorder records the gateway /checkout by pathname and masks the token in the stored request", async () => {
  const denied = { error: "mandate_mismatch", message: "line quantity 50 is above the mandated 1", rule: "quantity_above_mandate", tokenFrozen: true };
  const recorder = createCheckoutRecorder(async () => jsonResponse(403, denied));
  const body = JSON.stringify({ token: "leash_eyJzZWNyZXQiOnRydWV9.c2ln", mandateId: "mnd_1", lines: [{ productId: "p1", quantity: 50 }] });
  const { rawCheckout } = await recorder.record(() => recorder.fetchImpl(`${LEASH}/checkout`, { method: "POST", body }));
  assert.equal(rawCheckout.status, 403);
  assert.equal(rawCheckout.source, "gateway");
  assert.match(rawCheckout.raw, /"quantity_above_mandate"/);
  assert.doesNotMatch(rawCheckout.request, /eyJzZWNyZXQ/);
  assert.deepEqual(JSON.parse(rawCheckout.request), { token: "leash_…", mandateId: "mnd_1", lines: [{ productId: "p1", quantity: 50 }] });
});

test("recorder keeps checkouts/create bodies byte-for-byte and ignores pages and other gateway routes", async () => {
  const recorder = createCheckoutRecorder(async () => jsonResponse(200, {}));
  const body = '{"requestId":"r1","lines":[{"productId":"p1","quantity":1}],"dropShip":true}';
  const direct = await recorder.record(() => recorder.fetchImpl("http://localhost:8788/v1/checkouts/create", { body }));
  assert.equal(direct.rawCheckout.request, body);
  assert.equal(direct.rawCheckout.source, "agent");
  const proxied = await recorder.record(() => recorder.fetchImpl(`${LEASH}/arcade/checkouts/create`, { body: "{}" }));
  assert.notEqual(proxied.rawCheckout, null);
  assert.equal(proxied.rawCheckout.source, "agent");
  for (const url of [MOCK_CHECKOUT_URL, `${LEASH}/mandates`, `${LEASH}/tokens`, "not a url"]) {
    const quiet = await recorder.record(() => recorder.fetchImpl(url, { body: "{}" }));
    assert.equal(quiet.rawCheckout, null, url);
  }
});
