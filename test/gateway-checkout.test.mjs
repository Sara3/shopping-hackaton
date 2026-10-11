// Leash gateway HTTP server, /mandates + /checkout side: the real mock replica behind createGatewayServer
// (port 0, injected clock) with a tamperable Arcade client and image fetch. Every 403 from the checkout
// gate freezes the token and Arcade's checkouts/create is never reached on a denied attempt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockServer } from "../mock/arcade-mock.mjs";
import { ArcadeError, createClient } from "../src/arcade.mjs";
import { LIVE_BASE_URL } from "../src/endpoint.mjs";
import { sha256Hex } from "../gateway/signing.mjs";
import { verifyChain } from "../gateway/ledger.mjs";
import { verifyMandateSignature } from "../gateway/mandates.mjs";
import { runCheckout } from "../gateway/checkout.mjs";
import { verifyToken } from "../gateway/tokens.mjs";
import { GATEWAY_PORT, HOST, MAX_BODY_BYTES, createGatewayServer } from "../gateway/server.mjs";
import { resolveGatewayOptions, startLine } from "../gateway/leash-gateway.mjs";

const SECRET = "leash-checkout-test-secret-0123456789";
const ARCADE_KEY = "arcade_sk_test_checkoutsecretvalue";
const T0 = Date.parse("2026-10-11T18:00:00.000Z");
const MANDATE_TTL_MS = 600_000;
const ADMIN_KEY = "leash-admin-key-for-tests";
const SILENT = Object.freeze({ info() {}, warn() {}, error() {} });
const TOKEN_REQUEST = Object.freeze({ agentId: "checkout-test", payer: "demo-user", maxSpend: "200.00", categories: ["Silk scarf"] });

let mock, base, scarf, pillow;

async function makeProduct(categoryName, prompt) {
  const pattern = await base.generatePattern({ prompt }, { intervalMs: 1 });
  const { items } = await base.listCategories();
  const { categoryId } = items.find((item) => item.name === categoryName);
  const { selections } = await base.getCategory(categoryId);
  const product = await base.buildProduct({ patternId: pattern.patternId, categoryId, selections, fit: { mode: "fill" } }, { intervalMs: 1 });
  return { ...product, patternId: pattern.patternId };
}

before(async () => {
  mock = await createMockServer({ port: 0, latencyMs: 0, stateFile: null, logger: null });
  base = createClient({ apiKey: ARCADE_KEY, baseUrl: mock.apiUrl });
  scarf = await makeProduct("Silk scarf", "blue florals on linen");
  pillow = await makeProduct("Linen pillow", "green stripes");
});
after(() => mock.close());

// An Arcade client whose re-read price and checkout creation the test can tamper with; undefined = untouched.
function tamperableArcade() {
  let price;
  let failCreates = false;
  let createCalls = 0;
  const reprice = (product) => (price === undefined ? product : { ...product, unitPrice: price === null ? null : { ...product.unitPrice, amount: price } });
  const client = {
    ...base,
    getProduct: async (productId, quantity) => reprice(await base.getProduct(productId, quantity)),
    createCheckout: async (args) => {
      createCalls += 1;
      if (failCreates) throw new ArcadeError(500, { message: "checkout service down" }, "/checkouts/create");
      return base.createCheckout(args);
    },
  };
  return { client, setPrice: (value) => { price = value; }, failCreates: (value) => { failCreates = value; }, createCalls: () => createCalls };
}

// Image fetch that can be switched to serve another design's bytes behind the same URL.
function tamperableImages() {
  let swapped = false;
  const fetchImpl = (url, init) => (swapped ? Promise.resolve(new Response("<svg>large red roses on black</svg>")) : fetch(url, init));
  return { fetchImpl, swap: () => { swapped = true; } };
}

const manualClock = (start = T0) => {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
};

async function withGateway(overrides, fn) {
  const kit = { arcade: tamperableArcade(), images: tamperableImages(), clock: manualClock() };
  const gateway = await createGatewayServer({
    port: 0, arcade: kit.arcade.client, fetchImpl: kit.images.fetchImpl, secret: SECRET, now: kit.clock.now, logger: SILENT, secrets: [ARCADE_KEY], ...overrides,
  });
  try {
    await fn(gateway, kit);
  } finally {
    await gateway.close();
  }
}

async function read(response) {
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

function post(gw, path, { body = {}, token = null } = {}) {
  const auth = token === null ? {} : { Authorization: `Bearer ${token}` };
  return fetch(`${gw.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) }).then(read);
}

const get = (gw, path) => fetch(`${gw.url}${path}`).then(read);

async function issue(gw, overrides = {}) {
  const response = await post(gw, "/tokens", { body: { ...TOKEN_REQUEST, ...overrides } });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function mandateFor(gw, token, { productId = scarf.productId, quantity = 1 } = {}) {
  const response = await post(gw, "/mandates", { body: { token, productId, quantity } });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

const line = (productId = scarf.productId, quantity = 1) => ({ productId, quantity });
const checkout = (gw, token, mandateId, lines = [line()]) => post(gw, "/checkout", { body: { token, mandateId, lines } });
const tokenStatus = async (gw, tokenId) => (await get(gw, `/tokens/${tokenId}`)).json;
const ledgerRows = async (gw, tokenId) => (await get(gw, `/ledger?tokenId=${tokenId}`)).json.entries;
const checkoutCount = () => Object.keys(mock.getState().checkouts).length;
const svgBytes = async (patternId) => Buffer.from(await (await fetch(`${mock.url}/img/${patternId}.svg`)).arrayBuffer());

// A denial from the checkout gate: 403 envelope with the rule, tokenFrozen true, the token frozen for that
// rule, and the next /arcade/* call refused with token_frozen.
async function assertFrozenDenial(gw, response, { code, rule, token, tokenId }) {
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(response.json, { error: code, message: response.json.message, rule, tokenFrozen: true });
  const status = await tokenStatus(gw, tokenId);
  assert.deepEqual([status.frozen, status.frozenReason], [true, rule]);
  const next = await post(gw, "/arcade/categories/list", { token });
  assert.deepEqual([next.status, next.json.error, next.json.rule, next.json.tokenFrozen], [403, "token_frozen", rule, true]);
}

// ------------------------------------------------------------------------------ normal path

test("normal: approve 1 scarf -> signed mandate at 128.00, checkout returns exactly { checkoutUrl } on the mock origin, ledgered approved", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const issued = await mandateFor(gw, token);
    assert.deepEqual(Object.keys(issued).sort(), ["mandate", "mandateId", "signature"]);
    const { mandate } = issued;
    assert.deepEqual([mandate.mandateId, mandate.unitPrice, mandate.maxTotal, mandate.quantity, mandate.productId, mandate.tokenId],
      [issued.mandateId, "128.00", "128.00", 1, scarf.productId, tokenId]);
    assert.equal(mandate.imageSha256, sha256Hex(await svgBytes(scarf.patternId)));
    assert.equal(verifyMandateSignature(mandate, issued.signature, SECRET), true);
    assert.equal(gw.mandateStore.get(issued.mandateId).signature, issued.signature);

    const before = checkoutCount();
    const done = await checkout(gw, token, issued.mandateId);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(Object.keys(done.json), ["checkoutUrl"]);
    assert.ok(done.json.checkoutUrl.startsWith(`${mock.url}/checkout/`));
    assert.match(done.json.checkoutUrl, /\/checkout\/\d+$/);
    assert.equal(checkoutCount(), before + 1);
    assert.equal(kit.arcade.createCalls(), 1);
    const created = mock.getState().checkouts[done.json.checkoutUrl.split("/").at(-1)];
    assert.equal(created.dropShip, true);
    assert.deepEqual(created.lines.map((l) => [l.productId, l.quantity]), [[scarf.productId, 1]]);

    const rows = await ledgerRows(gw, tokenId);
    assert.deepEqual(rows.map((row) => [row.endpoint, row.decision, row.code]), [["/tokens", "approved", null], ["/mandates", "approved", null], ["/checkout", "approved", null]]);
    assert.deepEqual([rows[1].detail.mandateId, rows[1].detail.unitPrice, rows[1].detail.maxTotal], [issued.mandateId, "128.00", "128.00"]);
    assert.deepEqual(rows[2].detail.lines, [line()]);
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.denials], [false, 0]);
  });
});

test("normal with the token as Bearer: /mandates and /checkout accept Authorization instead of a body token", async () => {
  await withGateway({}, async (gw) => {
    const { token } = await issue(gw);
    const issued = await post(gw, "/mandates", { token, body: { productId: scarf.productId, quantity: 1 } });
    assert.equal(issued.status, 200, issued.text);
    const done = await post(gw, "/checkout", { token, body: { mandateId: issued.json.mandateId, lines: [line()] } });
    assert.deepEqual([done.status, Object.keys(done.json)], [200, ["checkoutUrl"]]);
  });
});

// ------------------------------------------------------------------------------ checkout gate denials

test("lines quantity 50 against a mandate for 1 -> 403 mandate_mismatch quantity_above_mandate, frozen, checkouts/create never called", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    const before = checkoutCount();
    const denied = await checkout(gw, token, mandateId, [line(scarf.productId, 50)]);
    await assertFrozenDenial(gw, denied, { code: "mandate_mismatch", rule: "quantity_above_mandate", token, tokenId });
    const retry = await checkout(gw, token, mandateId);
    assert.deepEqual([retry.status, retry.json.error, retry.json.tokenFrozen], [403, "token_frozen", true]);
    assert.equal(kit.arcade.createCalls(), 0);
    assert.equal(checkoutCount(), before);
    const row = (await ledgerRows(gw, tokenId)).find((entry) => entry.endpoint === "/checkout");
    assert.deepEqual([row.decision, row.code, row.rule, row.detail.mandateId], ["denied", "mandate_mismatch", "quantity_above_mandate", mandateId]);
    assert.deepEqual([row.detail.lines, row.detail.tokenFrozen, row.detail.frozenReason], [[line(scarf.productId, 50)], true, "quantity_above_mandate"]);
  });
});

test("another productId, two lines, an unknown mandateId or another token's mandate -> 403 mandate_mismatch and frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const cases = [
      { lines: [line(pillow.productId)], rule: "line_mismatch" },
      { lines: [line(), line()], rule: "line_mismatch" },
      { mandateId: "mnd_0000000000000000", rule: "mandate_unknown" },
      { foreign: true, rule: "line_mismatch" },
    ];
    for (const { lines, mandateId, foreign, rule } of cases) {
      const { token, tokenId } = await issue(gw, { maxSpend: "1000.00", categories: ["Silk scarf", "Linen pillow"] });
      const own = await mandateFor(gw, token);
      const other = foreign ? await mandateFor(gw, (await issue(gw)).token) : null;
      const response = await checkout(gw, token, mandateId ?? other?.mandateId ?? own.mandateId, lines);
      await assertFrozenDenial(gw, response, { code: "mandate_mismatch", rule, token, tokenId });
    }
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

test("Arcade re-reads a higher price at checkout -> 403 price_exceeded rule price_delta and frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    kit.arcade.setPrice("128.01");
    await assertFrozenDenial(gw, await checkout(gw, token, mandateId), { code: "price_exceeded", rule: "price_delta", token, tokenId });
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

test("product image bytes changed after approval -> 403 design_swapped and frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    kit.images.swap();
    await assertFrozenDenial(gw, await checkout(gw, token, mandateId), { code: "design_swapped", rule: "design_swapped", token, tokenId });
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

test("clock past the mandate's expiresAt (token still valid) -> 403 expired and frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw, { ttlSeconds: 3600 });
    const { mandateId, mandate } = await mandateFor(gw, token);
    assert.equal(Date.parse(mandate.expiresAt), T0 + MANDATE_TTL_MS);
    kit.clock.advance(MANDATE_TTL_MS);
    await assertFrozenDenial(gw, await checkout(gw, token, mandateId), { code: "expired", rule: "expired", token, tokenId });
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

test("a consumed mandate used a second time -> 403 mandate_used and frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw, { maxSpend: "1000.00" });
    const { mandateId } = await mandateFor(gw, token);
    assert.equal((await checkout(gw, token, mandateId)).status, 200);
    await assertFrozenDenial(gw, await checkout(gw, token, mandateId), { code: "mandate_used", rule: "mandate_used", token, tokenId });
    assert.equal(kit.arcade.createCalls(), 1);
  });
});

test("Arcade failing on checkouts/create -> 502 arcade_error, the mandate is consumed, the token is NOT frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    kit.arcade.failCreates(true);
    const failed = await checkout(gw, token, mandateId);
    assert.equal(failed.status, 502, failed.text);
    assert.deepEqual(failed.json, { error: "arcade_error", message: failed.json.message, tokenFrozen: false });
    assert.ok(!failed.text.includes(ARCADE_KEY));
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.denials], [false, 0]);
    assert.equal((await post(gw, "/arcade/categories/list", { token })).status, 200);
    const row = (await ledgerRows(gw, tokenId)).find((entry) => entry.endpoint === "/checkout");
    assert.deepEqual([row.decision, row.code, row.rule, row.detail.tokenFrozen], ["denied", "arcade_error", null, false]);

    kit.arcade.failCreates(false);
    const reused = await checkout(gw, token, mandateId);
    assert.deepEqual([reused.status, reused.json.error, reused.json.rule], [403, "mandate_used", "mandate_used"]);
    assert.equal(kit.arcade.createCalls(), 1);
  });
});

test("a verified token's malformed checkout freezes it: qty 5000 -> quantity_above_mandate, bad lines -> line_mismatch, no mandateId -> mandate_unknown", async () => {
  await withGateway({}, async (gw, kit) => {
    const cases = [
      [(mandateId) => ({ mandateId, lines: [line(scarf.productId, 5000)] }), "quantity_above_mandate"],
      ...[0, -1, 1.5, "50"].map((quantity) => [(mandateId) => ({ mandateId, lines: [line(scarf.productId, quantity)] }), "line_mismatch"]),
      [(mandateId) => ({ mandateId, lines: [] }), "line_mismatch"], [(mandateId) => ({ mandateId }), "line_mismatch"],
      [() => ({ lines: [line()] }), "mandate_unknown"], [() => ({ mandateId: null, lines: [line()] }), "mandate_unknown"],
    ];
    for (const [makeBody, rule] of cases) {
      const { token, tokenId } = await issue(gw);
      const { mandateId } = await mandateFor(gw, token);
      await assertFrozenDenial(gw, await post(gw, "/checkout", { body: { token, ...makeBody(mandateId) } }), { code: "mandate_mismatch", rule, token, tokenId });
      assert.deepEqual([(await checkout(gw, token, mandateId)).json.error, (await tokenStatus(gw, tokenId)).denials], ["token_frozen", 3]);
    }
    const anonymous = await post(gw, "/checkout", { body: { lines: [line(scarf.productId, 5000)] } });
    assert.deepEqual([anonymous.status, anonymous.json.error, anonymous.json.tokenFrozen], [401, "token_invalid", false]);
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

// ------------------------------------------------------------------------------ running total

test("the allowance is a running total: with maxSpend 200.00 a 128.00 checkout passes at spent 0 and is refused at spent 12800", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const claims = verifyToken(token, { secret: SECRET, now: kit.clock.now });
    const deps = { arcade: kit.arcade.client, fetchImpl: kit.images.fetchImpl, mandateStore: gw.mandateStore, detector: gw.detector, secret: SECRET, now: kit.clock.now };
    const run = (mandateId, extra = {}) => runCheckout({ claims, mandateId, lines: [line()] }, { ...deps, ...extra });

    const passed = await run((await mandateFor(gw, token)).mandateId);
    assert.deepEqual([Object.keys(passed), passed.totalCents], [["checkoutUrl", "totalCents"], 12800]);

    const { mandateId } = await mandateFor(gw, token);
    const asked = [];
    const spent = (id) => { asked.push(id); return 12800; };
    await assert.rejects(run(mandateId, { spentCents: spent }), (error) => {
      assert.deepEqual([error.status, error.code, error.extra.rule], [403, "allowance_exceeded", "allowance_exceeded"]);
      assert.equal(error.message, "running total 256.00 would exceed this token's allowance 200.00 (already spent 128.00)");
      return true;
    });
    assert.deepEqual(asked, [tokenId]);
    assert.equal(kit.arcade.createCalls(), 1);

    await assert.rejects(run(mandateId, { spentCents: () => 7201 }), (error) => error.code === "allowance_exceeded");
    assert.equal(kit.arcade.createCalls(), 1);
    const exact = await run(mandateId, { spentCents: () => 7200 });
    assert.equal(exact.totalCents, 12800);
    assert.equal(kit.arcade.createCalls(), 2);
  });
});

test("a second 128.00 checkout on a 200.00 token -> 403 allowance_exceeded, frozen, never sent to Arcade; the first row carries totalCents", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const first = await checkout(gw, token, (await mandateFor(gw, token)).mandateId);
    assert.equal(first.status, 200, first.text);
    const { mandateId } = await mandateFor(gw, token);
    const second = await checkout(gw, token, mandateId);
    await assertFrozenDenial(gw, second, { code: "allowance_exceeded", rule: "allowance_exceeded", token, tokenId });
    assert.match(second.json.message, /running total 256\.00 would exceed this token's allowance 200\.00 \(already spent 128\.00\)/);
    assert.equal(kit.arcade.createCalls(), 1);

    const rows = (await ledgerRows(gw, tokenId)).filter((entry) => entry.endpoint === "/checkout");
    assert.deepEqual(rows.map((entry) => [entry.decision, entry.code, entry.rule]), [["approved", null, null], ["denied", "allowance_exceeded", "allowance_exceeded"]]);
    assert.equal(rows[0].detail.totalCents, 12800);
    assert.equal(Object.hasOwn(rows[1].detail, "totalCents"), false);
    assert.deepEqual(verifyChain((await get(gw, "/ledger")).json.entries), { ok: true });
  });
});

test("salami: 300.00 allows two 128.00 checkouts and refuses the third (384.00); other tokens keep their own total", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw, { maxSpend: "300.00" });
    for (const attempt of [1, 2]) {
      const done = await checkout(gw, token, (await mandateFor(gw, token)).mandateId);
      assert.equal(done.status, 200, `checkout ${attempt}: ${done.text}`);
    }
    const third = await checkout(gw, token, (await mandateFor(gw, token)).mandateId);
    await assertFrozenDenial(gw, third, { code: "allowance_exceeded", rule: "allowance_exceeded", token, tokenId });
    assert.match(third.json.message, /running total 384\.00 .* allowance 300\.00 \(already spent 256\.00\)/);
    assert.equal(kit.arcade.createCalls(), 2);

    const fresh = await issue(gw);
    assert.equal((await checkout(gw, fresh.token, (await mandateFor(gw, fresh.token)).mandateId)).status, 200);
    assert.equal(kit.arcade.createCalls(), 3);
  });
});

test("three parallel checkouts cannot read the same running total: one passes, the rest are refused or find the token frozen", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const mandateIds = [];
    for (let index = 0; index < 3; index += 1) mandateIds.push((await mandateFor(gw, token)).mandateId);
    const results = await Promise.all(mandateIds.map((mandateId) => checkout(gw, token, mandateId)));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 403, 403]);
    assert.deepEqual(results.filter((result) => result.status === 403).map((result) => result.json.error).sort(), ["allowance_exceeded", "token_frozen"]);
    assert.equal(kit.arcade.createCalls(), 1);
    const approved = (await ledgerRows(gw, tokenId)).filter((entry) => entry.endpoint === "/checkout" && entry.decision === "approved");
    assert.equal(approved.length, 1);
  });
});

// ------------------------------------------------------------------------------ mandate route

test("/mandates: qty 50 over maxSpend -> 403 price_exceeded counted but not frozen; a pillow on a scarf token -> off_scope_category frozen", async () => {
  await withGateway({}, async (gw) => {
    const { token, tokenId } = await issue(gw);
    const tooMuch = await post(gw, "/mandates", { body: { token, productId: scarf.productId, quantity: 50 } });
    assert.deepEqual([tooMuch.status, tooMuch.json.error, tooMuch.json.rule, tooMuch.json.tokenFrozen], [403, "price_exceeded", "price_delta", false]);
    const counted = await tokenStatus(gw, tokenId);
    assert.deepEqual([counted.frozen, counted.frozenReason, counted.frozenAt, counted.denials], [false, null, null, 1]);
    assert.equal(gw.mandateStore.size(), 0);

    const offScope = await post(gw, "/mandates", { body: { token, productId: pillow.productId, quantity: 1 } });
    await assertFrozenDenial(gw, offScope, { code: "scope_denied", rule: "off_scope_category", token, tokenId });
    assert.equal(gw.mandateStore.size(), 0);
  });
});

test("/mandates: price pending 409, unknown product 404 and a bad body 400 are not denials; the ledger stays chained", async () => {
  await withGateway({}, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    kit.arcade.setPrice(null);
    const pending = await post(gw, "/mandates", { body: { token, productId: scarf.productId, quantity: 1 } });
    assert.deepEqual([pending.status, pending.json.error, pending.json.tokenFrozen], [409, "price_pending", false]);
    kit.arcade.setPrice(undefined);
    const missing = await post(gw, "/mandates", { body: { token, productId: "prod_missing", quantity: 1 } });
    assert.deepEqual([missing.status, missing.json.error], [404, "not_found"]);
    const bad = await post(gw, "/mandates", { body: { token, productId: scarf.productId, quantity: 0 } });
    assert.deepEqual([bad.status, bad.json.error], [400, "bad_request"]);
    const status = await tokenStatus(gw, tokenId);
    assert.deepEqual([status.frozen, status.denials], [false, 0]);
    const { entries } = (await get(gw, "/ledger")).json;
    assert.deepEqual(verifyChain(entries), { ok: true });
    assert.deepEqual(entries.map((row) => row.code), [null, "price_pending", "not_found", "bad_request"]);
    assert.ok(!JSON.stringify(entries).includes(token));
  });
});

// ------------------------------------------------------------------------------ live-checkout guard

test("mode mock: checkout succeeds whether or not LIVE_CHECKOUT_ENABLED is set -- the guard only applies to live mode", async () => {
  for (const liveCheckoutEnabled of [false, true]) {
    await withGateway({ mode: "mock", liveCheckoutEnabled }, async (gw, kit) => {
      const { token } = await issue(gw);
      const { mandateId } = await mandateFor(gw, token);
      const done = await checkout(gw, token, mandateId);
      assert.equal(done.status, 200, done.text);
      assert.equal(kit.arcade.createCalls(), 1);
    });
  }
});

test("mode live, LIVE_CHECKOUT_ENABLED unset: every check runs and the mandate is spent, but Arcade is never called; the gateway answers a simulated checkout", async () => {
  await withGateway({ mode: "live" }, async (gw, kit) => {
    const { token, tokenId } = await issue(gw, { maxSpend: "1000.00" });
    const { mandateId } = await mandateFor(gw, token);
    const done = await checkout(gw, token, mandateId);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.json, { checkoutUrl: `${gw.url}/simulated-checkout/${mandateId}`, simulated: true });
    assert.equal(kit.arcade.createCalls(), 0);
    const row = (await ledgerRows(gw, tokenId)).find((entry) => entry.endpoint === "/checkout");
    assert.deepEqual([row.decision, row.detail.simulated, row.detail.totalCents], ["approved", true, 12800]);

    const receipt = await get(gw, `/simulated-checkout/${mandateId}`);
    assert.equal(receipt.status, 200, receipt.text);
    assert.deepEqual(
      [receipt.json.simulated, receipt.json.mandateId, receipt.json.productId, receipt.json.quantity, receipt.json.total, receipt.json.currency],
      [true, mandateId, scarf.productId, 1, "128.00", "USD"],
    );
    assert.match(receipt.json.message, /no Arcade order was created and nothing was charged/);

    const replay = await checkout(gw, token, mandateId);
    assert.deepEqual([replay.status, replay.json.error], [403, "mandate_used"]);
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

const fetchPage = (url, init = {}) => fetch(url, { redirect: "manual", ...init, headers: { Accept: "text/html", ...init.headers } });

test("the simulated checkout link opens a checkout page for a browser; Pay marks it paid (no money, no Arcade call) and shows the order", async () => {
  await withGateway({ mode: "live" }, async (gw, kit) => {
    const { token } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    const { checkoutUrl } = (await checkout(gw, token, mandateId)).json;

    const page = await fetchPage(checkoutUrl);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src/);
    assert.ok(html.includes(scarf.title) && html.includes("$128.00") && html.includes("Pay $128.00"), html);
    assert.ok(html.includes(`action="/simulated-checkout/${mandateId}/pay"`));
    assert.ok(html.includes("no card is charged and no Arcade order is created"));
    assert.ok(!html.includes("<script"));

    const paid = await fetchPage(`${checkoutUrl}/pay`, { method: "POST" });
    assert.deepEqual([paid.status, paid.headers.get("location")], [303, `/simulated-checkout/${mandateId}`]);
    const after = await (await fetchPage(checkoutUrl)).text();
    assert.match(after, /Payment complete\. Order SIM-000001 placed\./);
    assert.ok(!after.includes("<form"));
    const again = await fetchPage(`${checkoutUrl}/pay`, { method: "POST" });
    assert.equal(again.status, 303);
    assert.match((await get(gw, `/simulated-checkout/${mandateId}`)).json.paid.orderNumber, /^SIM-000001$/);
    assert.equal(kit.arcade.createCalls(), 0);

    const unknown = await fetchPage(`${gw.url}/simulated-checkout/mnd_0000000000000000/pay`, { method: "POST" });
    assert.equal(unknown.status, 404);
  });
});

test("a simulated checkout counts toward the allowance like a real one: the running total still stops the second", async () => {
  await withGateway({ mode: "live" }, async (gw) => {
    const { token } = await issue(gw, { maxSpend: "200.00" });
    const first = await checkout(gw, token, (await mandateFor(gw, token)).mandateId);
    assert.deepEqual([first.status, first.json.simulated], [200, true]);
    const second = await checkout(gw, token, (await mandateFor(gw, token)).mandateId);
    assert.deepEqual([second.status, second.json.error], [403, "allowance_exceeded"]);
  });
});

test("GET /simulated-checkout answers 404 for a mandate that was never checked out in simulation, and 404 in mock mode", async () => {
  for (const mode of ["live", "mock"]) {
    await withGateway({ mode }, async (gw) => {
      const { token } = await issue(gw);
      const { mandateId } = await mandateFor(gw, token);
      const missing = await get(gw, `/simulated-checkout/${mandateId}`);
      assert.deepEqual([missing.status, missing.json.error], [404, "not_found"]);
    });
  }
});

test("mode live, LIVE_CHECKOUT_ENABLED=true: checkout proceeds to Arcade normally", async () => {
  await withGateway({ mode: "live", liveCheckoutEnabled: true }, async (gw, kit) => {
    const { token } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    const done = await checkout(gw, token, mandateId);
    assert.equal(done.status, 200, done.text);
    assert.equal(kit.arcade.createCalls(), 1);
  });
});

test("simulation never shadows a real mandate check: quantity above mandate still freezes in live mode too", async () => {
  await withGateway({ mode: "live" }, async (gw, kit) => {
    const { token, tokenId } = await issue(gw);
    const { mandateId } = await mandateFor(gw, token);
    await assertFrozenDenial(gw, await checkout(gw, token, mandateId, [line(scarf.productId, 50)]), { code: "mandate_mismatch", rule: "quantity_above_mandate", token, tokenId });
    assert.equal(kit.arcade.createCalls(), 0);
  });
});

// ------------------------------------------------------------------------------ restart, factory, CLI

const ledgerLines = (path) => readFileSync(path, "utf8").trim().split("\n").map((row) => JSON.parse(row));

test("a token frozen at checkout stays frozen after a restart that reloads the chained on-disk ledger (same secret)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leash-gateway-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    let token;
    await withGateway({ ledgerPath }, async (gw) => {
      ({ token } = await issue(gw));
      const { mandateId } = await mandateFor(gw, token);
      assert.equal((await checkout(gw, token, mandateId, [line(scarf.productId, 50)])).json.tokenFrozen, true);
    });
    const records = ledgerLines(ledgerPath);
    assert.deepEqual(verifyChain(records), { ok: true });
    for (const secret of [token, ARCADE_KEY, SECRET]) assert.ok(!readFileSync(ledgerPath, "utf8").includes(secret));
    await withGateway({ ledgerPath }, async (gw) => {
      assert.equal(gw.ledger.size(), records.length);
      const again = await post(gw, "/arcade/categories/list", { token });
      assert.deepEqual([again.status, again.json.error, again.json.rule, again.json.tokenFrozen], [403, "token_frozen", "quantity_above_mandate", true]);
      assert.equal((await post(gw, "/arcade/categories/list", { token: (await issue(gw)).token })).status, 200);
    });
    const reloaded = ledgerLines(ledgerPath);
    assert.deepEqual([verifyChain(reloaded), reloaded.length], [{ ok: true }, records.length + 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createGatewayServer: binds loopback only, needs a secret and a complete Arcade client; contract constants", async () => {
  assert.deepEqual([GATEWAY_PORT, HOST, MAX_BODY_BYTES], [8080, "127.0.0.1", 64 * 1024]);
  const options = { port: 0, arcade: base, secret: SECRET, logger: SILENT };
  await assert.rejects(createGatewayServer({ ...options, host: "0.0.0.0" }), /loopback/);
  await assert.rejects(createGatewayServer({ ...options, secret: "" }), /secret/);
  await assert.rejects(createGatewayServer({ ...options, arcade: { call() {} } }), /getProduct/);
  await assert.rejects(createGatewayServer({ ...options, adminKey: "" }), /adminKey/);
  await withGateway({}, async (gw) => {
    assert.deepEqual([gw.server.address().address, gw.url], ["127.0.0.1", `http://127.0.0.1:${gw.port}`]);
    assert.deepEqual([typeof gw.ledger.append, typeof gw.detector.freeze, typeof gw.mandateStore.get], ["function", "function", "function"]);
  });
});

test("leash-gateway options: mock replica on 8788 unless ARCADE_MODE=live, random secret with a warning, port and ledger defaults", () => {
  const local = resolveGatewayOptions({ ARCADE_API_KEY: "arcade_sk_live_shouldnotleak" }, { randomSecret: () => "r".repeat(64) });
  assert.deepEqual([local.mode, local.baseUrl, local.apiKey, local.port, local.adminKey, local.secret], ["mock", "http://localhost:8788/v1", "mock_key", 8080, null, "r".repeat(64)]);
  assert.ok(local.ledgerPath.endsWith(join("gateway", "ledger.jsonl")));
  assert.ok(local.warnings.some((warning) => /LEASH_SECRET/.test(warning)));
  assert.match(resolveGatewayOptions({}).secret, /^[0-9a-f]{64}$/);
  assert.equal(local.liveCheckoutEnabled, false);

  const env = { ARCADE_MODE: "live", ARCADE_API_KEY: "arcade_sk_live_abcdef123456", LEASH_SECRET: "s".repeat(32), LEASH_PORT: "9090", LEASH_ADMIN_KEY: ADMIN_KEY, LEASH_VELOCITY_LIMIT: "3", LEASH_LEDGER: "out/ledger.jsonl" };
  const live = resolveGatewayOptions(env);
  assert.deepEqual([live.mode, live.baseUrl, live.port, live.adminKey, live.velocityLimit, live.secret], ["live", LIVE_BASE_URL, 9090, ADMIN_KEY, "3", "s".repeat(32)]);
  assert.ok(live.ledgerPath.endsWith(join("out", "ledger.jsonl")));
  assert.deepEqual(live.warnings, []);
  assert.equal(live.liveCheckoutEnabled, false);
  const banner = startLine(live, "http://127.0.0.1:9090");
  assert.ok(banner.includes("arcade…") && banner.includes("live") && banner.includes(LIVE_BASE_URL));
  assert.ok(banner.includes("live checkout simulated"));
  for (const secret of [env.ARCADE_API_KEY, env.LEASH_SECRET, ADMIN_KEY]) assert.ok(!banner.includes(secret));
  for (const port of ["80a", "70000", "-1"]) assert.throws(() => resolveGatewayOptions({ LEASH_PORT: port }), /LEASH_PORT/);

  const liveEnabled = resolveGatewayOptions({ ...env, LIVE_CHECKOUT_ENABLED: "true" });
  assert.equal(liveEnabled.liveCheckoutEnabled, true);
  assert.ok(startLine(liveEnabled, "http://127.0.0.1:9090").includes("LIVE CHECKOUT ENABLED"));
  assert.ok(!startLine(local, "http://127.0.0.1:8080").includes("checkout")); // mock mode: no live-checkout banner segment at all
});

// ------------------------------------------------------------------------------ Leash off: POST /simulated-checkout

// This gateway serves POST /tokens to the admin only, like `npm run demo` does.
const issueAsAdmin = async (gw, overrides = {}) => {
  const response = await post(gw, "/tokens", { body: { ...TOKEN_REQUEST, ...overrides }, token: ADMIN_KEY });
  assert.equal(response.status, 200, response.text);
  return response.json;
};

const KEY_HELD_REQUEST = () => ({
  productId: scarf.productId, quantity: 50, unitPrice: "102.40", currency: "USD", title: scarf.title, imageUrl: scarf.imageUrl ?? scarf.images?.[0]?.url ?? null,
  selectionLabel: "90 × 90 cm", maker: "Odette",
});

test("POST /simulated-checkout (admin only) stores a key-holding agent's receipt under a sim_ id and answers the checkout URL; Arcade is never called", async () => {
  await withGateway({ mode: "live", adminKey: ADMIN_KEY }, async (gw, kit) => {
    const denied = await post(gw, "/simulated-checkout", { body: KEY_HELD_REQUEST() });
    assert.deepEqual([denied.status, denied.json.error], [401, "token_invalid"]);
    const { token } = await issueAsAdmin(gw);
    const withAgentToken = await post(gw, "/simulated-checkout", { body: KEY_HELD_REQUEST(), token });
    assert.equal(withAgentToken.status, 401, "an agent token is not the admin key");

    const before = checkoutCount();
    const created = await post(gw, "/simulated-checkout", { body: KEY_HELD_REQUEST(), token: ADMIN_KEY });
    assert.equal(created.status, 200, created.text);
    assert.match(created.json.checkoutId, /^sim_[0-9a-f]{16}$/);
    assert.deepEqual(created.json, { checkoutId: created.json.checkoutId, checkoutUrl: `${gw.url}/simulated-checkout/${created.json.checkoutId}`, simulated: true });
    assert.deepEqual([kit.arcade.createCalls(), checkoutCount()], [0, before]);

    const receipt = await get(gw, `/simulated-checkout/${created.json.checkoutId}`);
    assert.equal(receipt.status, 200, receipt.text);
    assert.deepEqual(
      [receipt.json.simulated, receipt.json.checkoutId, receipt.json.mandateId, receipt.json.productId, receipt.json.quantity, receipt.json.unitPrice, receipt.json.total, receipt.json.currency, receipt.json.paid],
      [true, created.json.checkoutId, null, scarf.productId, 50, "102.40", "5120.00", "USD", null],
    );
    assert.deepEqual([receipt.json.title, receipt.json.selectionLabel, receipt.json.maker], [scarf.title, "90 × 90 cm", "Odette"]);
    assert.match(receipt.json.message, /Leash was off and the agent held the account key.*nothing was charged/);

    const rows = gw.ledger.entries().filter((entry) => entry.endpoint === "/simulated-checkout");
    assert.deepEqual(rows.map((entry) => [entry.decision, entry.code]), [["denied", "token_invalid"], ["denied", "token_invalid"], ["approved", null]], "the two 401s are ledgered too");
    const row = rows.at(-1);
    assert.deepEqual(
      [row.decision, row.tokenId, row.agentId, row.detail.checkoutId, row.detail.quantity, row.detail.totalCents, row.detail.simulated, row.detail.keyHeld],
      ["approved", null, null, created.json.checkoutId, 50, 512000, true, true],
    );
    assert.deepEqual(verifyChain(gw.ledger.entries()), { ok: true });
    assert.ok(!JSON.stringify(gw.ledger.entries()).includes(ADMIN_KEY));

    // Counts toward no allowance: the same token can still spend its whole cap afterwards.
    const { mandateId } = await mandateFor(gw, token);
    const leashed = await checkout(gw, token, mandateId);
    assert.deepEqual([leashed.status, leashed.json.simulated], [200, true]);
  });
});

test("the sim_ checkout page reads like the mnd_ one, says the agent held the key, and Pay confirms an order without money or Arcade", async () => {
  await withGateway({ mode: "live", adminKey: ADMIN_KEY }, async (gw, kit) => {
    const { checkoutUrl, checkoutId } = (await post(gw, "/simulated-checkout", { body: KEY_HELD_REQUEST(), token: ADMIN_KEY })).json;
    const page = await fetchPage(checkoutUrl);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.ok(html.includes(scarf.title) && html.includes("Pay $5120.00") && html.includes("Qty 50"), html);
    assert.ok(html.includes(`action="/simulated-checkout/${checkoutId}/pay"`));
    assert.ok(html.includes("The agent held the account key; nothing was charged."));
    assert.ok(!html.includes("mandate") && !html.includes("<script"));

    const paid = await fetchPage(`${checkoutUrl}/pay`, { method: "POST" });
    assert.deepEqual([paid.status, paid.headers.get("location")], [303, `/simulated-checkout/${checkoutId}`]);
    const after = await (await fetchPage(checkoutUrl)).text();
    assert.ok(after.includes("Order confirmed") && /Payment complete\. Order SIM-000001 placed\./.test(after) && !after.includes("<form"), after);
    assert.equal((await get(gw, `/simulated-checkout/${checkoutId}`)).json.paid.orderNumber, "SIM-000001");
    assert.equal(kit.arcade.createCalls(), 0);

    // Order numbers are shared with Leash checkouts: the next paid receipt, mandate or not, is SIM-000002.
    const { token } = await issueAsAdmin(gw);
    const { mandateId } = await mandateFor(gw, token);
    const leashed = (await checkout(gw, token, mandateId)).json;
    assert.match(leashed.checkoutUrl, /\/simulated-checkout\/mnd_[0-9a-f]{16}$/);
    await fetchPage(`${leashed.checkoutUrl}/pay`, { method: "POST" });
    assert.equal((await get(gw, `/simulated-checkout/${mandateId}`)).json.paid.orderNumber, "SIM-000002");
  });
});

test("POST /simulated-checkout validates the receipt (400, nothing stored) and the page routes accept only mnd_ or sim_ ids", async () => {
  await withGateway({ mode: "live", adminKey: ADMIN_KEY }, async (gw) => {
    const good = KEY_HELD_REQUEST();
    const bad = [
      [{ ...good, productId: "" }, /productId/], [{ ...good, quantity: 0 }, /quantity/], [{ ...good, quantity: 1.5 }, /quantity/], [{ ...good, quantity: 1001 }, /quantity/],
      [{ ...good, unitPrice: 102.4 }, /unitPrice/], [{ ...good, unitPrice: "abc" }, /unitPrice/], [{ ...good, currency: "" }, /currency/], [{ ...good, title: 7 }, /title/],
      [[], /JSON object/],
    ];
    for (const [body, message] of bad) {
      const response = await post(gw, "/simulated-checkout", { body, token: ADMIN_KEY });
      assert.deepEqual([response.status, response.json.error], [400, "bad_request"], JSON.stringify(body));
      assert.match(response.json.message, message);
    }
    assert.equal(gw.ledger.entries().filter((entry) => entry.endpoint === "/simulated-checkout" && entry.decision === "approved").length, 0);

    const clipped = await post(gw, "/simulated-checkout", { body: { ...good, title: "t".repeat(300), imageUrl: "javascript:alert(1)", maker: "   " }, token: ADMIN_KEY });
    assert.equal(clipped.status, 200, clipped.text);
    const stored = (await get(gw, `/simulated-checkout/${clipped.json.checkoutId}`)).json;
    assert.deepEqual([stored.title.length, stored.imageUrl, stored.maker], [200, null, null]);

    for (const path of ["/simulated-checkout/xyz_0123456789abcdef", "/simulated-checkout/sim_0123", "/simulated-checkout/sim_0123456789abcdef/pay/extra"]) {
      assert.equal((await get(gw, path)).status, 404, path);
    }
    assert.equal((await get(gw, "/simulated-checkout/sim_0123456789abcdef")).status, 404, "well-formed but unknown");
    assert.equal((await fetchPage(`${gw.url}/simulated-checkout/sim_0123456789abcdef/pay`, { method: "POST" })).status, 404);
    assert.equal((await get(gw, "/simulated-checkout")).status, 405, "GET on the collection");
  });
});
