import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMockServer } from "../mock/arcade-mock.mjs";
import { ArcadeError, USER_AGENT, createClient } from "../src/arcade.mjs";
import { CODES, GatewayError } from "../gateway/errors.mjs";
import { AGENT_SCOPES } from "../gateway/scopes.mjs";
import { sha256Hex } from "../gateway/signing.mjs";
import { createDetector } from "../gateway/detector.mjs";
import { createMandateStore } from "../gateway/mandate-store.mjs";
import { IMAGE_TIMEOUT_MS, MAX_IMAGE_BYTES, hashImage } from "../gateway/image-hash.mjs";
import {
  DEFAULT_MANDATE_TTL_SECONDS, MAX_QUANTITY, createCategoryResolver, createMandate, validateMandateRequest, verifyMandateSignature,
} from "../gateway/mandates.mjs";
import { runCheckout, validateCheckoutRequest } from "../gateway/checkout.mjs";
import { authorizeProcedure, forwardProcedure } from "../gateway/proxy.mjs";

const SECRET = "leash-test-secret";
const TEN_MINUTES_MS = 600_000;
const MANDATE_KEYS = ["agentId", "categoryId", "currency", "expiresAt", "imageSha256", "issuedAt", "mandateId", "maxTotal",
  "payer", "productId", "quantity", "selections", "tokenId", "unitPrice", "v"];
let mock, arcade, scarf, pillow;

async function makeProduct(categoryName, prompt) {
  const pattern = await arcade.generatePattern({ prompt }, { intervalMs: 1 });
  const { items } = await arcade.listCategories();
  const { categoryId } = items.find((item) => item.name === categoryName);
  const { selections } = await arcade.getCategory(categoryId);
  const product = await arcade.buildProduct({ patternId: pattern.patternId, categoryId, selections, fit: { mode: "fill" } }, { intervalMs: 1 });
  return { ...product, patternId: pattern.patternId };
}

before(async () => {
  mock = await createMockServer({ port: 0, latencyMs: 0, stateFile: null, logger: null });
  arcade = createClient({ apiKey: "mock_key", baseUrl: mock.apiUrl });
  scarf = await makeProduct("Silk scarf", "blue florals on linen");
  pillow = await makeProduct("Linen pillow", "green stripes");
});
after(() => mock.close());

const claimsFor = (overrides = {}) => ({
  v: 1,
  tokenId: `tok_${randomBytes(8).toString("hex")}`,
  agentId: "test-agent",
  payer: "demo-user",
  maxSpend: "200.00",
  categories: ["Silk scarf"],
  scopes: [...AGENT_SCOPES],
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + TEN_MINUTES_MS).toISOString(),
  ...overrides,
});

const gate = (overrides = {}) => ({
  arcade,
  fetchImpl: fetch,
  secret: SECRET,
  now: () => Date.now(),
  categoryResolver: createCategoryResolver({ arcade }),
  mandateStore: createMandateStore(),
  detector: createDetector({ now: () => Date.now() }),
  ...overrides,
});

async function approve(claims, deps, { productId = scarf.productId, quantity = 1 } = {}) {
  const issued = await createMandate({ claims, productId, quantity }, deps);
  deps.mandateStore.put({ mandate: issued.mandate, signature: issued.signature });
  return issued;
}

const line = (productId = scarf.productId, quantity = 1) => ({ productId, quantity });
const checkoutCount = () => Object.keys(mock.getState().checkouts).length;
const imageUrl = (patternId) => `${mock.url}/img/${patternId}.svg`;
const svgBytes = async (patternId) => Buffer.from(await (await fetch(imageUrl(patternId))).arrayBuffer());
const patchProduct = (patch) => ({ ...arcade, getProduct: async (id, quantity) => patch(await arcade.getProduct(id, quantity)) });
const pricedAt = (amount, currency = "USD") => patchProduct((p) => ({ ...p, unitPrice: amount === null ? null : { amount, currency } }));

const isError = (code, rule) => (error) => {
  assert.ok(error instanceof GatewayError, `expected GatewayError ${code}, got ${error?.stack ?? error}`);
  assert.equal(error.code, code);
  assert.equal(error.status, CODES[code]);
  if (rule !== undefined) assert.equal(error.extra.rule, rule);
  return true;
};
const denied = (promise, code, rule) => assert.rejects(promise, isError(code, rule));

// ------------------------------------------------------------------------------ image hash

test("hashImage: sha256 of the exact image bytes, sent with our User-Agent and no Authorization header", async () => {
  const seen = [];
  const recording = (url, init) => seen.push(init) && fetch(url, init);
  assert.equal(await hashImage(imageUrl(scarf.patternId), recording), sha256Hex(await svgBytes(scarf.patternId)));
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].headers["User-Agent"], USER_AGENT);
  assert.ok(!Object.keys(seen[0].headers).some((name) => name.toLowerCase() === "authorization"));
  assert.equal(IMAGE_TIMEOUT_MS, 10_000);
});

test("hashImage: non-http(s) URL, non-2xx, over-size (declared or actual), timeout and network failure are image_unreadable", async () => {
  let calls = 0;
  const counting = async () => (calls += 1) && new Response("x");
  for (const url of [undefined, "", "not a url", "file:///etc/passwd", "data:image/svg+xml,<svg/>", "javascript:alert(1)"]) {
    await denied(hashImage(url, counting), "image_unreadable");
  }
  assert.equal(calls, 0);
  await denied(hashImage(`${mock.url}/img/missing.svg`, fetch), "image_unreadable");
  const declared = async () => new Response("small", { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } });
  await denied(hashImage("http://img.test/a.svg", declared), "image_unreadable");
  const oneTooMany = new Uint8Array(MAX_IMAGE_BYTES + 1);
  const undeclared = async () => new Response(new ReadableStream({ start: (c) => { c.enqueue(oneTooMany); c.close(); } }));
  await denied(hashImage("http://img.test/b.svg", undeclared), "image_unreadable");
  const hanging = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  await denied(hashImage("http://img.test/c.svg", hanging, { timeoutMs: 20 }), "image_unreadable");
  await denied(hashImage("http://img.test/d.svg", async () => { throw new TypeError("fetch failed"); }), "image_unreadable");
});

// ------------------------------------------------------------------------------ mandates

test("mandate: re-read unitPrice 128.00, maxTotal 128.00 for qty 1, imageSha256 of the SVG bytes, signature verifies", async () => {
  const claims = claimsFor();
  const { mandateId, mandate, signature } = await createMandate({ claims, productId: scarf.productId, quantity: 1 }, gate());
  assert.match(mandateId, /^mnd_[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(mandate).sort(), MANDATE_KEYS);
  assert.deepEqual(
    [mandate.mandateId, mandate.unitPrice, mandate.maxTotal, mandate.quantity, mandate.currency, mandate.v],
    [mandateId, "128.00", "128.00", 1, "USD", 1],
  );
  assert.deepEqual(
    [mandate.tokenId, mandate.agentId, mandate.payer, mandate.productId, mandate.categoryId],
    [claims.tokenId, claims.agentId, claims.payer, scarf.productId, scarf.categoryId],
  );
  assert.deepEqual(mandate.selections, scarf.selections);
  assert.equal(mandate.imageSha256, sha256Hex(await svgBytes(scarf.patternId)));
  assert.equal(verifyMandateSignature(mandate, signature, SECRET), true);
  assert.equal(verifyMandateSignature({ ...mandate, quantity: 50 }, signature, SECRET), false);
  assert.equal(verifyMandateSignature(mandate, signature, "another-secret"), false);
  assert.equal(verifyMandateSignature(mandate, "", SECRET), false);
  assert.ok(Object.isFrozen(mandate));
});

test("mandate: quantity 50 re-prices to 102.40 (maxTotal 5120.00), over maxSpend 200.00 -> 403 price_exceeded price_delta", async () => {
  const request = { productId: scarf.productId, quantity: 50 };
  await denied(createMandate({ claims: claimsFor(), ...request }, gate()), "price_exceeded", "price_delta");
  const { mandate } = await createMandate({ claims: claimsFor({ maxSpend: "6000.00" }), ...request }, gate());
  assert.deepEqual([mandate.unitPrice, mandate.maxTotal, mandate.quantity], ["102.40", "5120.00", 50]);
});

test("mandate: categories by name (any case) or id; a pillow on a scarf-only token -> 403 scope_denied off_scope_category", async () => {
  const deps = gate();
  for (const categories of [["Silk scarf"], ["silk SCARF"], [scarf.categoryId]]) {
    const { mandate } = await createMandate({ claims: claimsFor({ categories }), productId: scarf.productId, quantity: 1 }, deps);
    assert.equal(mandate.categoryId, scarf.categoryId);
  }
  await denied(createMandate({ claims: claimsFor(), productId: pillow.productId, quantity: 1 }, deps), "scope_denied", "off_scope_category");
  const partial = claimsFor({ categories: ["Silk"] });
  await denied(createMandate({ claims: partial, productId: scarf.productId, quantity: 1 }, deps), "scope_denied", "off_scope_category");
});

test("mandate: expiresAt is min(now + ttl, token expiresAt) and never outlives the token", async () => {
  const t0 = Date.parse("2026-10-11T18:00:00.000Z");
  const deps = gate({ now: () => t0 });
  const long = claimsFor({ expiresAt: new Date(t0 + 3_600_000).toISOString() });
  const { mandate } = await createMandate({ claims: long, productId: scarf.productId, quantity: 1 }, deps);
  assert.equal(mandate.issuedAt, new Date(t0).toISOString());
  assert.equal(Date.parse(mandate.expiresAt), t0 + DEFAULT_MANDATE_TTL_SECONDS * 1000);
  const short = claimsFor({ expiresAt: new Date(t0 + 60_000).toISOString() });
  const shortLived = await createMandate({ claims: short, productId: scarf.productId, quantity: 1 }, deps);
  assert.equal(shortLived.mandate.expiresAt, short.expiresAt);
  const custom = await createMandate({ claims: long, productId: scarf.productId, quantity: 1 }, { ...deps, ttlSeconds: 30 });
  assert.equal(Date.parse(custom.mandate.expiresAt), t0 + 30_000);
  const lapsed = claimsFor({ expiresAt: new Date(t0).toISOString() });
  await denied(createMandate({ claims: lapsed, productId: scarf.productId, quantity: 1 }, deps), "expired", "expired");
});

test("mandate: unitPrice null -> 409 price_pending; Arcade 404 -> not_found; other Arcade failures -> 502 arcade_error", async () => {
  const request = { claims: claimsFor(), productId: scarf.productId, quantity: 1 };
  await denied(createMandate(request, gate({ arcade: pricedAt(null) })), "price_pending");
  await denied(createMandate({ ...request, productId: "prod_missing" }, gate()), "not_found");
  const failing = { ...arcade, getProduct: async () => { throw new ArcadeError(500, { message: "boom" }, "/products/get"); } };
  await denied(createMandate(request, gate({ arcade: failing })), "arcade_error");
  await denied(createMandate(request, gate({ arcade: pricedAt("12x.00") })), "arcade_error");
  const noImage = patchProduct(({ images, imageUrl: _url, ...rest }) => rest);
  await denied(createMandate(request, gate({ arcade: noImage })), "image_unreadable");
});

test("validateMandateRequest: productId 1-200 chars, quantity an integer 1-1000, else 400 bad_request", () => {
  assert.deepEqual(validateMandateRequest({ token: "t", productId: "prod_1", quantity: 2 }), { productId: "prod_1", quantity: 2 });
  const bad = [
    null, [], {}, { productId: "", quantity: 1 }, { productId: "  ", quantity: 1 }, { productId: "p".repeat(201), quantity: 1 },
    { productId: 7, quantity: 1 }, { productId: "p", quantity: 0 }, { productId: "p", quantity: MAX_QUANTITY + 1 },
    { productId: "p", quantity: 1.5 }, { productId: "p", quantity: "1" }, { productId: "p" },
  ];
  for (const body of bad) assert.throws(() => validateMandateRequest(body), isError("bad_request"), JSON.stringify(body));
});

test("category resolver: direct id needs no call, names matched exactly (case-insensitive) and cached for ttlMs", async () => {
  let clock = 0;
  let calls = 0;
  const counting = { listCategories: async () => { calls += 1; return arcade.listCategories(); } };
  const resolver = createCategoryResolver({ arcade: counting, now: () => clock, ttlMs: 1000 });
  assert.equal(await resolver.isAllowed([scarf.categoryId], scarf.categoryId), true);
  assert.equal(calls, 0);
  assert.equal(await resolver.isAllowed(["Silk scarf"], scarf.categoryId), true);
  assert.equal(await resolver.isAllowed(["Silk scarf"], pillow.categoryId), false);
  assert.equal(await resolver.isAllowed(["Silk scarf"], "cat_unknown"), false);
  assert.equal(await resolver.isAllowed(["Silk scarf"], undefined), false);
  assert.equal(calls, 1);
  clock = 1000;
  assert.equal(await resolver.isAllowed(["LINEN PILLOW"], pillow.categoryId), true);
  assert.equal(calls, 2);
  const down = { listCategories: async () => { throw new ArcadeError(503, "down", "/categories/list"); } };
  await denied(createCategoryResolver({ arcade: down }).isAllowed(["Silk scarf"], scarf.categoryId), "arcade_error");
});

// ------------------------------------------------------------------------------ checkout gate

test("checkout: normal path calls checkouts/create once with dropShip true and returns exactly { checkoutUrl }", async () => {
  const sent = [];
  const spying = { ...arcade, createCheckout: async (args) => { sent.push(args); return arcade.createCheckout(args); } };
  const deps = gate({ arcade: spying });
  const claims = claimsFor();
  const { mandateId } = await approve(claims, deps);
  const before = checkoutCount();
  const result = await runCheckout({ claims, mandateId, lines: [line()] }, deps);
  assert.deepEqual(Object.keys(result), ["checkoutUrl"]);
  assert.ok(result.checkoutUrl.startsWith(`${mock.url}/checkout/`));
  assert.match(result.checkoutUrl, /\/checkout\/\d+$/);
  assert.deepEqual(sent, [{ lines: [{ productId: scarf.productId, quantity: 1 }], dropShip: true }]);
  assert.equal(checkoutCount(), before + 1);
  const checkout = mock.getState().checkouts[result.checkoutUrl.split("/").at(-1)];
  assert.equal(checkout.dropShip, true);
  assert.deepEqual(checkout.lines.map((l) => [l.productId, l.quantity]), [[scarf.productId, 1]]);
});

test("checkout: quantity 50 against a mandate for 1 -> mandate_mismatch quantity_above_mandate, Arcade untouched, mandate not burned", async () => {
  const deps = gate();
  const claims = claimsFor();
  const { mandateId } = await approve(claims, deps);
  const before = checkoutCount();
  await denied(runCheckout({ claims, mandateId, lines: [line(scarf.productId, 50)] }, deps), "mandate_mismatch", "quantity_above_mandate");
  assert.equal(checkoutCount(), before);
  assert.match((await runCheckout({ claims, mandateId, lines: [line()] }, deps)).checkoutUrl, /\/checkout\/\d+$/);
});

test("checkout: unknown mandate, another token's mandate, forged mandate, other product, wrong line count, lower quantity", async () => {
  const deps = gate();
  const claims = claimsFor({ maxSpend: "1000.00" });
  const { mandateId, mandate, signature } = await approve(claims, deps);
  const before = checkoutCount();
  const attempt = (overrides, d = deps) => runCheckout({ claims, mandateId, lines: [line()], ...overrides }, d);
  await denied(attempt({ mandateId: "mnd_0000000000000000" }), "mandate_mismatch", "mandate_unknown");
  await denied(attempt({ claims: claimsFor() }), "mandate_mismatch", "line_mismatch");
  await denied(attempt({ lines: [line(pillow.productId)] }), "mandate_mismatch", "line_mismatch");
  await denied(attempt({ lines: [line(), line()] }), "mandate_mismatch", "line_mismatch");
  await denied(attempt({ lines: [] }), "mandate_mismatch", "line_mismatch");
  const two = await approve(claims, deps, { quantity: 2 });
  await denied(attempt({ mandateId: two.mandateId }), "mandate_mismatch", "line_mismatch");
  const forgedStore = createMandateStore();
  forgedStore.put({ mandate: { ...mandate, quantity: 50, maxTotal: "6400.00" }, signature });
  await denied(attempt({ lines: [line(scarf.productId, 50)] }, { ...deps, mandateStore: forgedStore }), "mandate_mismatch", "line_mismatch");
  await denied(attempt({}, { ...deps, secret: "another-secret" }), "mandate_mismatch", "line_mismatch");
  assert.equal(checkoutCount(), before);
});

test("checkout: clock at the mandate's expiresAt -> expired (checked before the lines)", async () => {
  const deps = gate();
  const claims = claimsFor();
  const { mandateId, mandate } = await approve(claims, deps);
  const later = { ...deps, now: () => Date.parse(mandate.expiresAt) };
  await denied(runCheckout({ claims, mandateId, lines: [line(scarf.productId, 50)] }, later), "expired", "expired");
});

test("checkout: re-read price above the mandate, other currency or over the token cap -> price_exceeded price_delta; null -> price_pending", async () => {
  const deps = gate();
  const claims = claimsFor();
  const { mandateId } = await approve(claims, deps);
  const before = checkoutCount();
  const attempt = (overrides) => runCheckout({ claims, mandateId, lines: [line()] }, { ...deps, ...overrides });
  await denied(attempt({ arcade: pricedAt("128.01") }), "price_exceeded", "price_delta");
  await denied(attempt({ arcade: pricedAt("128.00", "EUR") }), "price_exceeded", "price_delta");
  const swapped = async () => new Response("<svg>large red roses on black</svg>");
  await denied(attempt({ arcade: pricedAt("130.00"), fetchImpl: swapped }), "price_exceeded", "price_delta");
  await denied(attempt({ arcade: pricedAt(null) }), "price_pending");
  const capped = { ...claims, maxSpend: "100.00" };
  await denied(runCheckout({ claims: capped, mandateId, lines: [line()] }, deps), "price_exceeded", "price_delta");
  assert.equal(checkoutCount(), before);
  assert.ok((await attempt({ arcade: pricedAt("127.00") })).checkoutUrl, "a lower price is not a delta against the human");
});

test("checkout: different image bytes or another design's image URL -> design_swapped", async () => {
  const deps = gate();
  const claims = claimsFor();
  const { mandateId } = await approve(claims, deps);
  const before = checkoutCount();
  const attempt = (overrides) => runCheckout({ claims, mandateId, lines: [line()] }, { ...deps, ...overrides });
  const swappedBytes = async () => new Response("<svg>large red roses on black</svg>");
  await denied(attempt({ fetchImpl: swappedBytes }), "design_swapped", "design_swapped");
  const otherDesign = patchProduct((p) => ({ ...p, images: [{ url: imageUrl(pillow.patternId) }] }));
  await denied(attempt({ arcade: otherDesign }), "design_swapped", "design_swapped");
  assert.equal(checkoutCount(), before);
});

test("checkout: a mandate is single use; an Arcade failure after consume is 502 arcade_error and still burns it", async () => {
  const deps = gate();
  const claims = claimsFor();
  const first = await approve(claims, deps);
  const attempt = (mandateId, d = deps) => runCheckout({ claims, mandateId, lines: [line()] }, d);
  await attempt(first.mandateId);
  await denied(attempt(first.mandateId), "mandate_used", "mandate_used");
  const failing = { ...arcade, createCheckout: async () => { throw new ArcadeError(500, { message: "down" }, "/checkouts/create"); } };
  const second = await approve(claims, deps);
  await denied(attempt(second.mandateId, { ...deps, arcade: failing }), "arcade_error");
  await denied(attempt(second.mandateId), "mandate_used", "mandate_used");
  const lookalike = { ...arcade, createCheckout: async () => ({ checkoutId: "1", checkoutUrl: "javascript:alert(1)" }) };
  const third = await approve(claims, deps);
  await denied(attempt(third.mandateId, { ...deps, arcade: lookalike }), "arcade_error");
});

test("validateCheckoutRequest: a malformed checkout from a verified token is a 403 mismatch that freezes, never a 400; no quantity cap", () => {
  const body = { token: "t", mandateId: "mnd_1", lines: [{ productId: "p", quantity: 1, unitPrice: "0.01" }] };
  assert.deepEqual(validateCheckoutRequest(body), { mandateId: "mnd_1", lines: [{ productId: "p", quantity: 1 }] });
  const ok = { productId: "p", quantity: 1 };
  assert.deepEqual(validateCheckoutRequest({ mandateId: "m", lines: [{ productId: "p", quantity: 5000 }] }).lines, [{ productId: "p", quantity: 5000 }]);
  for (const candidate of [null, {}, { mandateId: "", lines: [ok] }, { mandateId: 5, lines: [ok] }, { mandateId: null, lines: [ok] }, { lines: [ok] }]) {
    assert.throws(() => validateCheckoutRequest(candidate), isError("mandate_mismatch", "mandate_unknown"), JSON.stringify(candidate));
  }
  const badLines = [
    { mandateId: "m", lines: [] }, { mandateId: "m", lines: "x" }, { mandateId: "m", lines: Array(51).fill(ok) }, { mandateId: "m", lines: [null] },
    { mandateId: "m", lines: [{ productId: "", quantity: 1 }] }, { mandateId: "m", lines: [{ productId: "p", quantity: 0 }] },
    { mandateId: "m", lines: [{ productId: "p", quantity: -1 }] }, { mandateId: "m", lines: [{ productId: "p", quantity: 2.5 }] },
    { mandateId: "m", lines: [{ productId: "p", quantity: "50" }] }, { mandateId: "m", lines: [{ productId: "p", quantity: 2 ** 53 }] },
  ];
  for (const candidate of badLines) assert.throws(() => validateCheckoutRequest(candidate), isError("mandate_mismatch", "line_mismatch"), JSON.stringify(candidate));
});

// ------------------------------------------------------------------------------ proxy

const proxyDeps = (detector = createDetector({ now: () => Date.now() })) => ({ detector, categoryResolver: createCategoryResolver({ arcade }) });

test("proxy: a procedure outside the token's scopes, any forbidden scope and malformed paths -> scope_denied rule scope", async () => {
  const deps = proxyDeps();
  const narrow = claimsFor({ scopes: ["categories:list"] });
  assert.deepEqual(await authorizeProcedure({ claims: narrow, procedure: "/categories/list", body: {} }, deps), { scope: "categories:list", workStarting: false });
  await denied(authorizeProcedure({ claims: narrow, procedure: "/patterns/create", body: {} }, deps), "scope_denied", "scope");
  const forged = claimsFor({ scopes: [...AGENT_SCOPES, "checkouts:create", "orders:list", "orders:get", "products:list"] });
  const refused = ["/checkouts/create", "/orders/list", "/orders/get", "/products/list", "/patterns/../checkouts/create", "/checkouts/create/", "/v1/checkouts/create", "", undefined];
  for (const procedure of refused) {
    await denied(authorizeProcedure({ claims: forged, procedure, body: {} }, deps), "scope_denied", "scope");
  }
  await denied(authorizeProcedure({ claims: claimsFor(), procedure: "/patterns/get", body: [] }, deps), "bad_request");
});

test("proxy: a category outside the token -> scope_denied off_scope_category; a category procedure without a string categoryId -> bad_request", async () => {
  const deps = proxyDeps();
  const claims = claimsFor();
  const call = (procedure, body) => authorizeProcedure({ claims, procedure, body }, deps);
  assert.equal((await call("/categories/get", { categoryId: scarf.categoryId })).scope, "categories:get");
  await denied(call("/categories/get", { categoryId: pillow.categoryId }), "scope_denied", "off_scope_category");
  await denied(call("/products/create", { categoryId: pillow.categoryId, patternId: "cm1" }), "scope_denied", "off_scope_category");
  await denied(call("/products/create", { categoryId: [pillow.categoryId], patternId: "cm1" }), "bad_request");
  await denied(call("/categories/get", {}), "bad_request");
  assert.equal(deps.detector.status(claims.tokenId).workStartsLastMinute, 0);
});

test("proxy: velocity limit 2 -> third work-starting call is velocity_exceeded and freezes; reads do not count; frozen -> token_frozen", async () => {
  const detector = createDetector({ now: () => Date.now(), velocityLimit: 2 });
  const deps = proxyDeps(detector);
  const claims = claimsFor();
  const call = (procedure) => authorizeProcedure({ claims, procedure, body: {} }, deps);
  assert.equal((await call("/patterns/create")).workStarting, true);
  assert.equal((await call("/patterns/get")).workStarting, false);
  assert.equal((await call("/patterns/refine/recolorClusters")).workStarting, false);
  assert.equal((await call("/patterns/refine/edit")).workStarting, true);
  await denied(call("/patterns/create"), "velocity_exceeded", "velocity");
  assert.deepEqual([detector.isFrozen(claims.tokenId).frozen, detector.isFrozen(claims.tokenId).reason], [true, "velocity"]);
  await denied(call("/categories/list"), "token_frozen", "velocity");
  const other = claimsFor();
  assert.equal((await authorizeProcedure({ claims: other, procedure: "/patterns/create", body: {} }, deps)).workStarting, true);
});

test("forwardProcedure: 200 body, Arcade 404/422 passed through with Arcade's body, transport failure -> 502, forbidden never sent", async () => {
  const listed = await forwardProcedure({ procedure: "/categories/list", body: {} }, { arcade });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((item) => item.name), ["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"]);
  const missing = await forwardProcedure({ procedure: "/patterns/get", body: { patternId: "cm_missing" } }, { arcade });
  assert.deepEqual([missing.status, missing.body.code, missing.body.message], [404, "NOT_FOUND", "Pattern not found."]);
  const invalid = await forwardProcedure({ procedure: "/patterns/create", body: {} }, { arcade });
  assert.deepEqual([invalid.status, invalid.body.code], [422, "INPUT_VALIDATION_FAILED"]);
  const broken = { call: async () => { throw new TypeError("fetch failed"); } };
  await denied(forwardProcedure({ procedure: "/categories/list", body: {} }, { arcade: broken }), "arcade_error");
  let sent = 0;
  const counting = { call: async () => { sent += 1; return {}; } };
  for (const procedure of ["/checkouts/create", "/orders/list", "/a/b/c/d"]) {
    await denied(forwardProcedure({ procedure, body: {} }, { arcade: counting }), "scope_denied", "scope");
  }
  assert.equal(sent, 0);
});
