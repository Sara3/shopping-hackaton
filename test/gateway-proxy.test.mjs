// Leash gateway HTTP server, /arcade/* side: the real mock replica behind createGatewayServer, port 0,
// injected clock. Proves scope and category checks, freezes, the ledger, hardening and the CLI options.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createMockServer } from "../mock/arcade-mock.mjs";
import { createClient } from "../src/arcade.mjs";
import { AGENT_SCOPES } from "../gateway/scopes.mjs";
import { GENESIS_HASH, verifyChain } from "../gateway/ledger.mjs";
import { MAX_BODY_BYTES, createGatewayServer } from "../gateway/server.mjs";

const SECRET = "leash-proxy-test-secret-0123456789";
const ARCADE_KEY = "arcade_sk_test_proxysecretvalue";
const ADMIN_KEY = "leash-admin-key-for-tests";
const T0 = Date.parse("2026-10-11T18:00:00.000Z");
const MINUTE_MS = 60_000;
const SILENT = Object.freeze({ info() {}, warn() {}, error() {} });
const TOKEN_REQUEST = Object.freeze({ agentId: "proxy-test", payer: "demo-user", maxSpend: "200.00", categories: ["Silk scarf"] });
const ENVELOPE_KEYS = new Set(["error", "message", "rule", "tokenFrozen"]);
const STATUS_KEYS = ["agentId", "categories", "denials", "expiresAt", "frozen", "frozenAt", "frozenReason", "maxSpend", "payer", "scopes", "tokenId"];

let mock, arcade, scarfId, pillowId;
const upstream = [];
let seq = 0;
const rid = (prefix) => `${prefix}-${process.pid}-${(seq += 1)}`;

before(async () => {
  mock = await createMockServer({ port: 0, latencyMs: 0, stateFile: null, logger: null });
  const recording = (url, init) => {
    upstream.push({ path: new URL(url).pathname.replace(/^\/v1/, ""), authorization: init?.headers?.Authorization, body: String(init?.body ?? "") });
    return fetch(url, init);
  };
  arcade = createClient({ apiKey: ARCADE_KEY, baseUrl: mock.apiUrl, fetchImpl: recording });
  const { items } = await arcade.listCategories();
  scarfId = items.find((item) => item.name === "Silk scarf").categoryId;
  pillowId = items.find((item) => item.name === "Linen pillow").categoryId;
});
after(() => mock.close());

const manualClock = (start = T0) => {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
};

async function withGateway(overrides, fn) {
  const { clock = manualClock(), ...options } = overrides;
  const gateway = await createGatewayServer({ port: 0, arcade, secret: SECRET, now: clock.now, logger: SILENT, secrets: [ARCADE_KEY], ...options });
  try {
    await fn(gateway, clock);
  } finally {
    await gateway.close();
  }
}

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

async function read(response) {
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: parse(text) };
}

function post(gw, path, { body = {}, token = null, headers = {} } = {}) {
  const auth = token === null ? {} : { Authorization: `Bearer ${token}` };
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(`${gw.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth, ...headers }, body: payload }).then(read);
}

const get = (gw, path, headers = {}) => fetch(`${gw.url}${path}`, { headers }).then(read);

async function issue(gw, overrides = {}, headers = {}) {
  const response = await post(gw, "/tokens", { body: { ...TOKEN_REQUEST, ...overrides }, headers });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

const tokenStatus = async (gw, tokenId) => (await get(gw, `/tokens/${tokenId}`)).json;
const ledgerRows = async (gw, tokenId) => (await get(gw, `/ledger?tokenId=${tokenId}`)).json.entries;
const checkoutCount = () => Object.keys(mock.getState().checkouts).length;
const summary = (response) => [response.status, response.json?.error, response.json?.rule, response.json?.tokenFrozen];

function assertEnvelope(response, { status, code, tokenFrozen = false }) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.error, code);
  assert.equal(typeof response.json.message, "string");
  assert.equal(response.json.tokenFrozen, tokenFrozen);
  assert.ok(Object.keys(response.json).every((key) => ENVELOPE_KEYS.has(key)), response.text);
}

function rawRequest(port, { path, host, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host } }, async (res) => {
      const chunks = await res.toArray();
      resolve({ status: res.statusCode, json: parse(Buffer.concat(chunks).toString("utf8")) });
    });
    req.on("error", reject).end();
  });
}

// ------------------------------------------------------------------------------ tokens

test("POST /tokens issues a leash token with every agent scope and never checkouts:create; asking for it is 400 scope_forbidden", async () => {
  await withGateway({}, async (gw) => {
    const issued = await issue(gw);
    assert.deepEqual(Object.keys(issued).sort(), ["agentId", "categories", "expiresAt", "maxSpend", "payer", "scopes", "token", "tokenId"]);
    assert.ok(issued.token.startsWith("leash_"));
    assert.match(issued.tokenId, /^tok_[0-9a-f]{16}$/);
    assert.deepEqual([issued.agentId, issued.payer, issued.maxSpend, issued.categories], ["proxy-test", "demo-user", "200.00", ["Silk scarf"]]);
    assert.deepEqual(issued.scopes, [...AGENT_SCOPES]);
    assert.ok(!issued.scopes.includes("checkouts:create"));
    assert.equal(issued.expiresAt, new Date(T0 + 600_000).toISOString());

    const forbidden = await post(gw, "/tokens", { body: { ...TOKEN_REQUEST, scopes: ["categories:list", "checkouts:create"] } });
    assertEnvelope(forbidden, { status: 400, code: "scope_forbidden" });
    assert.match(forbidden.json.message, /checkouts:create/);
    const missing = await post(gw, "/tokens", { body: { ...TOKEN_REQUEST, agentId: undefined } });
    assertEnvelope(missing, { status: 400, code: "bad_request" });
    assert.match(missing.json.message, /agentId/);

    const rows = (await get(gw, "/ledger")).json.entries;
    assert.deepEqual(rows.map((row) => [row.endpoint, row.decision, row.code, row.tokenId]), [["/tokens", "approved", null, issued.tokenId],
      ["/tokens", "denied", "scope_forbidden", null], ["/tokens", "denied", "bad_request", null]]);
    assert.deepEqual(rows[1].detail.forbidden, ["checkouts:create"]);
    assert.ok(!JSON.stringify(rows).includes(issued.token));
  });
});

// ------------------------------------------------------------------------------ proxy

test("/arcade/categories/list is proxied with the gateway's key; the caller never sees the key and its token never goes upstream", async () => {
  await withGateway({}, async (gw) => {
    const { token } = await issue(gw);
    const from = upstream.length;
    const listed = await post(gw, "/arcade/categories/list", { token });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.json.items.map((item) => item.name), ["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"]);
    assert.ok(!listed.text.includes(ARCADE_KEY));
    const sent = upstream.slice(from);
    assert.deepEqual(sent.map((call) => [call.path, call.authorization]), [["/categories/list", `Bearer ${ARCADE_KEY}`]]);
    assert.ok(sent.every((call) => !call.body.includes(token)));
  });
  const echoing = { ...arcade, call: async (path) => ({ path, leaked: `key=${ARCADE_KEY}`, quoted: JSON.stringify(ARCADE_KEY) }) };
  await withGateway({ arcade: echoing }, async (gw) => {
    const { token } = await issue(gw);
    const echoed = await post(gw, "/arcade/categories/list", { token });
    assert.equal(echoed.status, 200);
    assert.ok(!echoed.text.includes(ARCADE_KEY), echoed.text);
    assert.equal(echoed.json.leaked, "key=arcade…");
  });
});

test("/arcade/checkouts/create, /arcade/orders/list and every forbidden or malformed procedure -> 403 scope_denied rule scope, never sent upstream", async () => {
  await withGateway({}, async (gw) => {
    const from = upstream.length;
    const checkoutsBefore = checkoutCount();
    const procedures = ["/arcade/checkouts/create", "/arcade/orders/list", "/arcade/orders/get", "/arcade/products/list", "/arcade/patterns/list",
      "/arcade/references/list", "/arcade/feedback/create", "/arcade/checkouts%2Fcreate", "/arcade/checkouts/create/", "/arcade/v1/checkouts/create", "/arcade/"];
    const body = { lines: [{ productId: "prod_x", quantity: 50 }], dropShip: true, orderId: "ord_x" };
    for (const path of procedures) {
      const { token } = await issue(gw);
      const denied = await post(gw, path, { token, body });
      assertEnvelope(denied, { status: 403, code: "scope_denied" });
      assert.equal(denied.json.rule, "scope", path);
    }
    const narrow = await issue(gw, { scopes: ["categories:list"] });
    const outside = await post(gw, "/arcade/patterns/get", { token: narrow.token, body: { patternId: "cm_x" } });
    assert.deepEqual(summary(outside), [403, "scope_denied", "scope", false]);
    assert.equal(upstream.length, from);
    assert.equal(checkoutCount(), checkoutsBefore);
  });
});

test("/arcade/categories/get outside the token's categories -> 403 scope_denied off_scope_category and the token is frozen", async () => {
  await withGateway({}, async (gw) => {
    const { token, tokenId } = await issue(gw);
    const inside = await post(gw, "/arcade/categories/get", { token, body: { categoryId: scarfId, selections: {} } });
    assert.equal(inside.status, 200, inside.text);
    const outside = await post(gw, "/arcade/categories/get", { token, body: { categoryId: pillowId, selections: {} } });
    assertEnvelope(outside, { status: 403, code: "scope_denied", tokenFrozen: true });
    assert.equal(outside.json.rule, "off_scope_category");
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
    assert.deepEqual([status.frozen, status.frozenReason, status.frozenAt, status.denials], [true, "off_scope_category", new Date(T0).toISOString(), 1]);

    const second = await issue(gw);
    const body = { requestId: rid("prod"), patternId: "cm_x", categoryId: pillowId, selections: {} };
    assert.deepEqual(summary(await post(gw, "/arcade/products/create", { token: second.token, body })), [403, "scope_denied", "off_scope_category", true]);
    const row = (await ledgerRows(gw, tokenId)).at(-1);
    assert.deepEqual([row.decision, row.code, row.rule, row.procedure, row.detail.categoryId], ["denied", "scope_denied", "off_scope_category", "/categories/get", pillowId]);
    assert.deepEqual([row.detail.tokenFrozen, row.detail.frozenReason], [true, "off_scope_category"]);
  });
});

test("a frozen token gets 403 token_frozen on /arcade, /mandates and /checkout; other tokens are unaffected", async () => {
  await withGateway({}, async (gw) => {
    const { token, tokenId } = await issue(gw);
    await post(gw, "/arcade/categories/get", { token, body: { categoryId: pillowId } });
    const from = upstream.length;
    const line = { productId: "prod_x", quantity: 1 };
    const attempts = [
      () => post(gw, "/arcade/categories/list", { token }),
      () => post(gw, "/arcade/patterns/get", { token, body: { patternId: "cm_x" } }),
      () => post(gw, "/mandates", { body: { token, productId: "prod_x", quantity: 1 } }),
      () => post(gw, "/mandates", { token, body: { productId: "prod_x", quantity: 1 } }),
      () => post(gw, "/checkout", { body: { token, mandateId: "mnd_x", lines: [line] } }),
      () => post(gw, "/checkout", { token, body: { mandateId: "mnd_x", lines: [line] } }),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      assertEnvelope(response, { status: 403, code: "token_frozen", tokenFrozen: true });
      assert.equal(response.json.rule, "off_scope_category");
    }
    assert.equal(upstream.length, from);
    assert.equal((await tokenStatus(gw, tokenId)).denials, 1 + attempts.length);
    const other = await issue(gw);
    assert.equal((await post(gw, "/arcade/categories/list", { token: other.token })).status, 200);
  });
});

test("absent, malformed, tampered or foreign tokens -> 401 token_invalid; an expired token -> 403 expired; none is pinned on a token", async () => {
  let foreign;
  await withGateway({ secret: "another-gateway-secret-abcdef" }, async (other) => {
    foreign = (await issue(other)).token;
  });
  await withGateway({}, async (gw, clock) => {
    const { token, tokenId } = await issue(gw);
    const at = 12;
    const tampered = `${token.slice(0, at)}${token[at] === "A" ? "B" : "A"}${token.slice(at + 1)}`;
    const headers = [{}, { Authorization: "Bearer" }, { Authorization: "Bearer nope" }, { Authorization: `Basic ${token}` },
      { Authorization: `Bearer ${tampered}` }, { Authorization: `Bearer ${foreign}` }, { Authorization: `Bearer ${token} extra` }];
    for (const header of headers) {
      assertEnvelope(await post(gw, "/arcade/categories/list", { headers: header }), { status: 401, code: "token_invalid" });
    }
    const line = { productId: "prod_x", quantity: 1 };
    const bodies = [["/mandates", { productId: "prod_x", quantity: 1 }, {}], ["/mandates", { token: 5, productId: "prod_x", quantity: 1 }, {}],
      ["/mandates", { token, productId: "prod_x", quantity: 1 }, { Authorization: `Bearer ${foreign}` }],
      ["/checkout", { token: tampered, mandateId: "mnd_x", lines: [line] }, {}], ["/checkout", { mandateId: "mnd_x", lines: [line] }, {}]];
    for (const [path, body, header] of bodies) {
      assertEnvelope(await post(gw, path, { body, headers: header }), { status: 401, code: "token_invalid" });
    }
    clock.advance(600_000);
    const expired = await post(gw, "/arcade/categories/list", { token });
    assertEnvelope(expired, { status: 403, code: "expired" });
    assert.equal(expired.json.rule, "expired");
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.denials], [false, 0]);
    const denied = (await get(gw, "/ledger")).json.entries.filter((row) => row.decision === "denied");
    assert.equal(denied.length, headers.length + bodies.length + 1);
    assert.ok(denied.every((row) => row.tokenId === null));
  });
});

test("Arcade 404 and 422 pass through with Arcade's status and body, ledgered as approved and never counted as denials", async () => {
  await withGateway({}, async (gw) => {
    const { token, tokenId } = await issue(gw);
    const missing = await post(gw, "/arcade/patterns/get", { token, body: { patternId: "cm_missing" } });
    assert.deepEqual([missing.status, missing.json.code, missing.json.message], [404, "NOT_FOUND", "Pattern not found."]);
    const invalid = await post(gw, "/arcade/patterns/create", { token, body: {} });
    assert.deepEqual([invalid.status, invalid.json.code], [422, "INPUT_VALIDATION_FAILED"]);
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.denials], [false, 0]);
    const rows = (await ledgerRows(gw, tokenId)).slice(1);
    assert.deepEqual(rows.map((row) => [row.procedure, row.decision, row.detail.status]), [["/patterns/get", "approved", 404], ["/patterns/create", "approved", 422]]);
  });
});

test("velocityLimit 2: the third work-starting call inside a minute -> 403 velocity_exceeded and frozen; reads never count; the window slides", async () => {
  await withGateway({ velocityLimit: 2 }, async (gw, clock) => {
    const { token, tokenId } = await issue(gw);
    const create = (t) => post(gw, "/arcade/patterns/create", { token: t, body: { requestId: rid("pat"), prompt: "blue florals on linen" } });
    assert.equal((await create(token)).status, 200);
    assert.equal((await post(gw, "/arcade/categories/list", { token })).status, 200);
    assert.equal((await create(token)).status, 200);
    const from = upstream.length;
    const third = await create(token);
    assertEnvelope(third, { status: 403, code: "velocity_exceeded", tokenFrozen: true });
    assert.equal(third.json.rule, "velocity");
    assert.equal(upstream.length, from);
    assert.deepEqual([(await tokenStatus(gw, tokenId)).frozenReason], ["velocity"]);
    assert.deepEqual(summary(await post(gw, "/arcade/categories/list", { token })), [403, "token_frozen", "velocity", true]);

    const sliding = await issue(gw);
    assert.equal((await create(sliding.token)).status, 200);
    assert.equal((await create(sliding.token)).status, 200);
    clock.advance(MINUTE_MS);
    assert.equal((await create(sliding.token)).status, 200);
  });
});

test("three denials freeze the token: a second token_frozen/denial_count ledger row, then token_frozen everywhere", async () => {
  await withGateway({}, async (gw) => {
    const { token, tokenId } = await issue(gw);
    const flags = [];
    for (let i = 0; i < 3; i += 1) flags.push((await post(gw, "/arcade/orders/list", { token })).json.tokenFrozen);
    assert.deepEqual(flags, [false, false, true]);
    assert.deepEqual(summary(await post(gw, "/arcade/categories/list", { token })), [403, "token_frozen", "denial_count", true]);
    const rows = await ledgerRows(gw, tokenId);
    const scope = ["/arcade", "denied", "scope_denied", "scope"];
    const frozen = ["/arcade", "denied", "token_frozen", "denial_count"];
    assert.deepEqual(rows.map((row) => [row.endpoint, row.decision, row.code, row.rule]), [["/tokens", "approved", null, null], scope, scope, scope, frozen, frozen]);
    assert.deepEqual([rows[3].detail.tokenFrozen, rows[3].detail.frozenReason, rows[4].detail.denials], [true, "denial_count", 3]);
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.frozenReason, status.denials], [true, "denial_count", 4]);
  });
});

// ------------------------------------------------------------------------------ hardening

test("hardening: health, security headers, 421 foreign Host, 415, 413, 400 bad JSON, 404 and 405 all in the error envelope", async () => {
  await withGateway({ mode: "mock" }, async (gw) => {
    const health = await get(gw, "/health");
    assert.deepEqual(health.json, { ok: true, arcadeBaseUrl: mock.apiUrl, mode: "mock" });
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.match(health.headers.get("content-type"), /^application\/json/);
    assert.ok(!health.text.includes(ARCADE_KEY));

    const rebound = await rawRequest(gw.port, { path: "/health", host: `evil.example:${gw.port}` });
    assert.deepEqual([rebound.status, rebound.json.error, rebound.json.tokenFrozen], [421, "bad_host", false]);
    assert.equal((await rawRequest(gw.port, { path: "/health", host: `localhost:${gw.port}` })).status, 200);
    assert.equal((await rawRequest(gw.port, { path: "/health", host: "127.0.0.1:1" })).status, 421);

    const { token, tokenId } = await issue(gw);
    for (const type of ["text/plain", "application/jsonx", "application/x-www-form-urlencoded"]) {
      assertEnvelope(await post(gw, "/arcade/categories/list", { token, headers: { "Content-Type": type } }), { status: 415, code: "unsupported_media_type" });
    }
    const big = JSON.stringify({ prompt: "x".repeat(MAX_BODY_BYTES) });
    assertEnvelope(await post(gw, "/arcade/patterns/create", { token, body: big }), { status: 413, code: "payload_too_large" });
    assertEnvelope(await post(gw, "/tokens", { body: "{not json" }), { status: 400, code: "bad_request" });
    assertEnvelope(await post(gw, "/arcade/patterns/get", { token, body: "[1,2]" }), { status: 400, code: "bad_request" });
    assertEnvelope(await get(gw, "/nope"), { status: 404, code: "not_found" });
    assertEnvelope(await post(gw, "/arcade", { token }), { status: 404, code: "not_found" });
    assertEnvelope(await get(gw, "/tokens/tok_0000000000000000"), { status: 404, code: "not_found" });
    for (const [method, path] of [["GET", "/tokens"], ["POST", "/health"], ["GET", "/arcade/categories/list"], ["POST", "/ledger"], ["DELETE", "/checkout"]]) {
      const response = await fetch(`${gw.url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" }).then(read);
      assertEnvelope(response, { status: 405, code: "method_not_allowed" });
    }
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.denials], [false, 0]);
  });
});

test("adminKey set: POST /tokens, GET /tokens/<id> and GET /ledger need Bearer <adminKey>; an agent token is not an admin key", async () => {
  await withGateway({ adminKey: ADMIN_KEY }, async (gw) => {
    const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
    assertEnvelope(await post(gw, "/tokens", { body: TOKEN_REQUEST }), { status: 401, code: "token_invalid" });
    assertEnvelope(await post(gw, "/tokens", { body: TOKEN_REQUEST, headers: { Authorization: `Bearer ${ADMIN_KEY}x` } }), { status: 401, code: "token_invalid" });
    const { token, tokenId } = await issue(gw, {}, admin);
    for (const path of [`/tokens/${tokenId}`, "/ledger"]) {
      assertEnvelope(await get(gw, path), { status: 401, code: "token_invalid" });
      assertEnvelope(await get(gw, path, { Authorization: `Bearer ${token}` }), { status: 401, code: "token_invalid" });
      assert.equal((await get(gw, path, admin)).status, 200);
    }
    assert.equal((await post(gw, "/arcade/categories/list", { token })).status, 200);
    const ledger = await get(gw, "/ledger", admin);
    assert.deepEqual(ledger.json.entries.map((row) => [row.endpoint, row.decision, row.code]).slice(0, 3), [
      ["/tokens", "denied", "token_invalid"], ["/tokens", "denied", "token_invalid"], ["/tokens", "approved", null],
    ]);
    assert.ok(!ledger.text.includes(ADMIN_KEY));
  });
});

test("ledger: every attempt is one hash-chained row without tokens or keys; logs: one line per request with tokenId, no bodies, no tokens", async () => {
  const lines = [];
  const capture = { info: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  await withGateway({ logger: capture }, async (gw) => {
    const { token, tokenId } = await issue(gw);
    await post(gw, "/arcade/categories/list", { token });
    await post(gw, "/arcade/orders/list", { token });
    const missing = await post(gw, "/mandates", { body: { token, productId: "prod_missing_secretish", quantity: 1 } });
    assertEnvelope(missing, { status: 404, code: "not_found" });
    const ledger = await get(gw, "/ledger");
    const { head, entries } = ledger.json;
    assert.deepEqual(verifyChain(entries), { ok: true });
    assert.equal(entries[0].prevHash, GENESIS_HASH);
    assert.equal(head, entries.at(-1).hash);
    assert.deepEqual(entries, JSON.parse(JSON.stringify(gw.ledger.entries())));
    assert.deepEqual(entries.map((row) => [row.endpoint, row.procedure, row.decision, row.code, row.tokenId]), [["/tokens", null, "approved", null, tokenId],
      ["/arcade", "/categories/list", "approved", null, tokenId], ["/arcade", "/orders/list", "denied", "scope_denied", tokenId], ["/mandates", null, "denied", "not_found", tokenId]]);
    const keys = ["agentId", "at", "code", "decision", "detail", "endpoint", "hash", "prevHash", "procedure", "rule", "seq", "tokenId"];
    assert.ok(entries.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(keys)));
    for (const secret of [token, ARCADE_KEY, SECRET]) assert.ok(!ledger.text.includes(secret));

    assert.equal(lines.length, 5);
    assert.match(lines[0], /^POST \/tokens 200 \d+ms tok_[0-9a-f]{16}$/);
    assert.match(lines[2], /^POST \/arcade\/orders\/list 403 \d+ms tok_[0-9a-f]{16}$/);
    assert.match(lines[4], /^GET \/ledger 200 \d+ms$/);
    assert.ok(lines.slice(0, 4).every((line) => line.endsWith(tokenId)));
    for (const leaked of [token, ARCADE_KEY, "demo-user", "prod_missing_secretish", "Silk scarf"]) {
      assert.ok(lines.every((line) => !line.includes(leaked)), leaked);
    }
  });
});
