// Review fixes on the gateway side: router-level rejections are ledgered, client retries of one Arcade
// call cost one work start, the CLI refuses to serve an open POST /tokens, and `npm run demo` shares a
// generated admin key with the web while keeping ARCADE_API_KEY out of the web (agent) process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { ArcadeError } from "../src/arcade.mjs";
import { verifyChain } from "../gateway/ledger.mjs";
import { createGatewayServer } from "../gateway/server.mjs";
import { MIN_ADMIN_KEY_LENGTH, requireAdminKey, resolveGatewayOptions } from "../gateway/leash-gateway.mjs";
import { childEnvs } from "../scripts/dev.mjs";

const SECRET = "leash-hardening-test-secret-0123456789";
const ADMIN_KEY = "leash-admin-key-for-hardening-tests";
const ADMIN = Object.freeze({ Authorization: `Bearer ${ADMIN_KEY}` });
const SILENT = Object.freeze({ info() {}, warn() {}, error() {} });
const TOKEN_REQUEST = Object.freeze({ agentId: "hardening-test", payer: "demo-user", maxSpend: "200.00", categories: ["Silk scarf"] });
const RATE_LIMITED = Object.freeze({ code: "RATE_LIMITED", status: 429, message: "slow down" });

// A fake Arcade that answers 429 to the first `failures` patterns/create calls, then a job.
function fakeArcade({ failures = 0 } = {}) {
  let remaining = failures;
  const calls = [];
  const call = async (path, body) => {
    calls.push({ path, requestId: body?.requestId });
    if (path === "/patterns/create" && remaining > 0) {
      remaining -= 1;
      throw new ArcadeError(429, RATE_LIMITED, path);
    }
    return { jobId: `job-${calls.length}`, status: "queued" };
  };
  const unused = async () => { throw new Error("not used by this test"); };
  return { client: { baseUrl: "http://localhost:1/v1", call, getProduct: unused, createCheckout: unused, listCategories: unused }, calls };
}

async function withGateway(options, fn) {
  const { arcade = fakeArcade().client, ...rest } = options;
  const gateway = await createGatewayServer({ port: 0, arcade, secret: SECRET, logger: SILENT, ...rest });
  try {
    await fn(gateway);
  } finally {
    await gateway.close();
  }
}

async function read(response) {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) };
}

const send = (gw, method, path, { headers = {}, body } = {}) =>
  fetch(`${gw.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(read);

async function issue(gw, headers = {}) {
  const response = await send(gw, "POST", "/tokens", { headers, body: TOKEN_REQUEST });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json;
}

function rawRequest(port, { path, host, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject).end();
  });
}

// ------------------------------------------------------------------------------ ledger: every attempt

test("router-level rejections (404, 405, 421) and admin 401s each write one denied ledger row, naming a valid bearer's token; none is a denial", async () => {
  await withGateway({ adminKey: ADMIN_KEY }, async (gw) => {
    const { token, tokenId } = await issue(gw, ADMIN);
    const bearer = { Authorization: `Bearer ${token}` };
    const probes = [
      ["GET", "/arcade/checkouts/create", 405, bearer], ["PUT", "/arcade/patterns/create", 405, bearer], ["POST", "/arcade", 404, bearer],
      ["POST", "/checkouts/create", 404, bearer], ["GET", "/checkout", 405, bearer], ["GET", "/ledger", 401, bearer], ["GET", `/tokens/${tokenId}`, 401, {}],
    ];
    const before = gw.ledger.size();
    for (const [method, path, status, headers] of probes) {
      const response = await send(gw, method, path, { headers });
      assert.deepEqual([response.status, response.json.tokenFrozen], [status, false], `${method} ${path}`);
    }
    assert.equal((await rawRequest(gw.port, { path: "/checkout", host: `evil.example:${gw.port}`, method: "POST" })).status, 421);

    const rows = gw.ledger.entries().slice(before);
    assert.deepEqual(rows.map((row) => [row.endpoint, row.procedure, row.code, row.detail.status, row.detail.method, row.tokenId]), [
      ["/arcade", "/checkouts/create", "method_not_allowed", 405, "GET", tokenId],
      ["/arcade", "/patterns/create", "method_not_allowed", 405, "PUT", tokenId],
      ["/arcade", null, "not_found", 404, "POST", tokenId],
      ["/checkouts/create", null, "not_found", 404, "POST", tokenId],
      ["/checkout", null, "method_not_allowed", 405, "GET", tokenId],
      ["/ledger", null, "token_invalid", 401, "GET", tokenId],
      [`/tokens/${tokenId}`, null, "token_invalid", 401, "GET", null],
      ["/checkout", null, "bad_host", 421, "POST", null],
    ]);
    assert.ok(rows.every((row) => row.decision === "denied" && row.rule === null && row.agentId === (row.tokenId ? "hardening-test" : null)));
    assert.deepEqual(verifyChain(gw.ledger.entries()), { ok: true });
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.deepEqual([gw.detector.status(tokenId).frozen, gw.detector.status(tokenId).denials], [false, 0]);
  });
});

// ------------------------------------------------------------------------------ velocity vs retries

test("a 429 retried by the client (same requestId and body) is one work start; a new requestId or a changed body counts again", async () => {
  const fake = fakeArcade({ failures: 3 });
  await withGateway({ arcade: fake.client, velocityLimit: 2 }, async (gw) => {
    const { token, tokenId } = await issue(gw);
    const create = (body) => send(gw, "POST", "/arcade/patterns/create", { headers: { Authorization: `Bearer ${token}` }, body });
    const first = { requestId: "pattern-retry-1", prompt: "blue florals" };
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await create(first)).status);
    assert.deepEqual(statuses, [429, 429, 429, 200]);
    assert.equal(fake.calls.length, 4);
    assert.equal(gw.detector.status(tokenId).workStartsLastMinute, 1);

    assert.equal((await create({ requestId: "pattern-2", prompt: "green stripes" })).status, 200);
    const changed = await create({ ...first, prompt: "large red roses on black" });
    assert.deepEqual([changed.status, changed.json.error, changed.json.rule, changed.json.tokenFrozen], [403, "velocity_exceeded", "velocity", true]);
    assert.equal(fake.calls.length, 5);
  });
});

// ------------------------------------------------------------------------------ admin key

test("leash-gateway refuses to start without a LEASH_ADMIN_KEY of at least 16 characters (an open POST /tokens lets a frozen agent re-mint)", () => {
  assert.equal(MIN_ADMIN_KEY_LENGTH, 16);
  for (const env of [{}, { LEASH_ADMIN_KEY: "" }, { LEASH_ADMIN_KEY: "short-key" }]) {
    assert.throws(() => requireAdminKey(resolveGatewayOptions(env, { randomSecret: () => "r".repeat(64) })), /LEASH_ADMIN_KEY/, JSON.stringify(env));
  }
  const options = resolveGatewayOptions({ LEASH_ADMIN_KEY: ADMIN_KEY, LEASH_SECRET: SECRET });
  assert.equal(requireAdminKey(options), options);
});

test("npm run demo: a local gateway gets a generated admin key the web shares; the web child never gets ARCADE_API_KEY", () => {
  const makeAdminKey = () => "k".repeat(64);
  const env = { LEASH_URL: "http://127.0.0.1:8080", ARCADE_API_KEY: "arcade_sk_live_mustnotreachweb", ARCADE_MODE: "live" };
  const local = childEnvs(env, { makeAdminKey });
  assert.deepEqual(local.gateway, { url: "http://127.0.0.1:8080", port: "8080" });
  assert.deepEqual([local.gatewayEnv.LEASH_ADMIN_KEY, local.gatewayEnv.LEASH_PORT, local.gatewayEnv.ARCADE_API_KEY], ["k".repeat(64), "8080", env.ARCADE_API_KEY]);
  assert.deepEqual([local.webEnv.LEASH_ADMIN_KEY, local.webEnv.ARCADE_API_KEY, local.webEnv.LEASH_URL], ["k".repeat(64), "", env.LEASH_URL]);
  assert.equal(env.LEASH_ADMIN_KEY, undefined, "childEnvs must not mutate its input");

  const kept = childEnvs({ ...env, LEASH_ADMIN_KEY: ADMIN_KEY }, { makeAdminKey });
  assert.deepEqual([kept.gatewayEnv.LEASH_ADMIN_KEY, kept.webEnv.LEASH_ADMIN_KEY], [ADMIN_KEY, ADMIN_KEY]);
  const remote = childEnvs({ ...env, LEASH_URL: "https://leash.example.com" }, { makeAdminKey });
  assert.deepEqual([remote.gateway, remote.gatewayEnv, remote.webEnv.ARCADE_API_KEY, remote.webEnv.LEASH_ADMIN_KEY], [null, null, "", undefined]);
  const direct = childEnvs({ ARCADE_API_KEY: "mock_key_direct" }, { makeAdminKey });
  assert.deepEqual([direct.gateway, direct.gatewayEnv, direct.webEnv.ARCADE_API_KEY, direct.webEnv.LEASH_ADMIN_KEY], [null, null, "mock_key_direct", undefined]);
});
