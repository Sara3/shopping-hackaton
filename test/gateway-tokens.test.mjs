import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_PREFIX,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MAX_SPEND_CENTS,
  MAX_CATEGORIES,
  validateTokenRequest,
  issueToken,
  verifyToken,
  maxSpendCents,
} from "../gateway/tokens.mjs";
import { GatewayError } from "../gateway/errors.mjs";
import { toCents, formatCents, isDecimalAmount } from "../gateway/money.mjs";
import { canonicalJson, sha256Hex, hmacHex, safeEqualHex, encodeSigned, decodeSigned } from "../gateway/signing.mjs";
import {
  AGENT_SCOPES,
  FORBIDDEN_SCOPES,
  WORK_STARTING_PROCEDURES,
  isValidProcedure,
  scopeForProcedure,
  isForbiddenScope,
  isAgentScope,
  isWorkStarting,
  procedureCategoryId,
} from "../gateway/scopes.mjs";

const SECRET = "leash-test-secret-0123456789abcdef";
const T0 = Date.parse("2026-10-11T17:00:00.000Z");
const clock = (ms) => () => ms;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const goodBody = (overrides = {}) => ({
  agentId: "web-agent",
  payer: "demo-user",
  maxSpend: "200.00",
  categories: ["Silk scarf", "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a002"],
  ...overrides,
});

const issueAt = (ms = T0, overrides = {}) => issueToken(validateTokenRequest(goodBody(overrides)), { secret: SECRET, now: clock(ms) });

const expectGatewayError = (fn, { status, code, message }) => {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GatewayError, `expected GatewayError ${code}, got ${caught}`);
  assert.equal(caught.status, status);
  assert.equal(caught.code, code);
  if (message) assert.match(caught.message, message);
  return caught;
};

const flipChar = (text, index) => {
  const current = text[index];
  const replacement = BASE64URL[(BASE64URL.indexOf(current) + 1) % BASE64URL.length];
  return `${text.slice(0, index)}${replacement === current ? "A" : replacement}${text.slice(index + 1)}`;
};

// ---------------------------------------------------------------------------------- constants

test("token constants match the contract", () => {
  assert.equal(TOKEN_PREFIX, "leash_");
  assert.equal(DEFAULT_TTL_SECONDS, 600);
  assert.equal(MAX_TTL_SECONDS, 30 * 24 * 60 * 60);
  assert.equal(MAX_SPEND_CENTS, 10_000_000);
  assert.equal(MAX_CATEGORIES, 20);
});

// ------------------------------------------------------------------------- validateTokenRequest

test("validateTokenRequest normalises a good body with defaults", () => {
  const validated = validateTokenRequest(goodBody({ categories: ["  Silk scarf  ", "Lampshade"] }));
  assert.deepEqual(validated, {
    agentId: "web-agent",
    payer: "demo-user",
    maxSpendCents: 20000,
    categories: ["Silk scarf", "Lampshade"],
    ttlSeconds: DEFAULT_TTL_SECONDS,
    scopes: [...AGENT_SCOPES],
  });
});

test("validateTokenRequest accepts maxSpend as a decimal string or a finite number", () => {
  const cases = [["200.00", 20000], ["200", 20000], ["128.5", 12850], [" 0.01 ", 1], [200, 20000], [128.5, 12850], ["100000.00", MAX_SPEND_CENTS]];
  for (const [maxSpend, cents] of cases) {
    assert.equal(validateTokenRequest(goodBody({ maxSpend })).maxSpendCents, cents, JSON.stringify(maxSpend));
  }
});

test("validateTokenRequest takes ttlSeconds 1..MAX_TTL_SECONDS (30 days) and treats null as the default", () => {
  assert.equal(validateTokenRequest(goodBody({ ttlSeconds: 1 })).ttlSeconds, 1);
  assert.equal(validateTokenRequest(goodBody({ ttlSeconds: MAX_TTL_SECONDS })).ttlSeconds, MAX_TTL_SECONDS);
  assert.equal(validateTokenRequest(goodBody({ ttlSeconds: null })).ttlSeconds, DEFAULT_TTL_SECONDS);
});

test("validateTokenRequest returns requested scopes deduplicated in canonical order", () => {
  const { scopes } = validateTokenRequest(goodBody({ scopes: ["products:get", "patterns:create", "products:get"] }));
  assert.deepEqual(scopes, ["patterns:create", "products:get"]);
});

test("validateTokenRequest rejects every bad field with a 400 naming that field", () => {
  const cases = [
    [null, /body/], [[], /body/], ["text", /body/],
    [goodBody({ agentId: undefined }), /agentId/], [goodBody({ agentId: "" }), /agentId/],
    [goodBody({ agentId: "a b" }), /agentId/], [goodBody({ agentId: "a/b" }), /agentId/],
    [goodBody({ agentId: "x".repeat(81) }), /agentId/], [goodBody({ agentId: 5 }), /agentId/],
    [goodBody({ payer: undefined }), /payer/], [goodBody({ payer: "" }), /payer/], [goodBody({ payer: "   " }), /payer/],
    [goodBody({ payer: 5 }), /payer/], [goodBody({ payer: "x".repeat(121) }), /payer/], [goodBody({ payer: "a\nb" }), /payer/],
    [goodBody({ maxSpend: undefined }), /maxSpend/], [goodBody({ maxSpend: null }), /maxSpend/],
    [goodBody({ maxSpend: "0" }), /maxSpend/], [goodBody({ maxSpend: "0.00" }), /maxSpend/], [goodBody({ maxSpend: 0 }), /maxSpend/],
    [goodBody({ maxSpend: -1 }), /maxSpend/], [goodBody({ maxSpend: "-5.00" }), /maxSpend/], [goodBody({ maxSpend: "abc" }), /maxSpend/],
    [goodBody({ maxSpend: "1.234" }), /maxSpend/], [goodBody({ maxSpend: 12.345 }), /maxSpend/], [goodBody({ maxSpend: "1e3" }), /maxSpend/],
    [goodBody({ maxSpend: Number.NaN }), /maxSpend/], [goodBody({ maxSpend: Number.POSITIVE_INFINITY }), /maxSpend/],
    [goodBody({ maxSpend: "100000.01" }), /maxSpend/], [goodBody({ maxSpend: 100001 }), /maxSpend/], [goodBody({ maxSpend: true }), /maxSpend/],
    [goodBody({ categories: undefined }), /categories/], [goodBody({ categories: [] }), /categories/],
    [goodBody({ categories: "Silk scarf" }), /categories/], [goodBody({ categories: [""] }), /categories/],
    [goodBody({ categories: ["  "] }), /categories/], [goodBody({ categories: [5] }), /categories/],
    [goodBody({ categories: Array.from({ length: MAX_CATEGORIES + 1 }, (_, index) => `c${index}`) }), /categories/],
    [goodBody({ categories: ["x".repeat(121)] }), /categories/], [goodBody({ categories: ["a\u0000b"] }), /categories/],
    [goodBody({ ttlSeconds: 0 }), /ttlSeconds/], [goodBody({ ttlSeconds: -1 }), /ttlSeconds/], [goodBody({ ttlSeconds: MAX_TTL_SECONDS + 1 }), /ttlSeconds/],
    [goodBody({ ttlSeconds: 1.5 }), /ttlSeconds/], [goodBody({ ttlSeconds: "600" }), /ttlSeconds/], [goodBody({ ttlSeconds: Number.NaN }), /ttlSeconds/],
    [goodBody({ scopes: "patterns:create" }), /scopes/], [goodBody({ scopes: {} }), /scopes/], [goodBody({ scopes: [] }), /scopes/],
  ];
  for (const [body, pattern] of cases) {
    const error = expectGatewayError(() => validateTokenRequest(body), { status: 400, code: "bad_request" });
    assert.match(error.message, pattern, `${JSON.stringify(body)} -> ${error.message}`);
  }
});

test("validateTokenRequest answers 400 scope_forbidden for checkouts:create and any non-agent scope", () => {
  const error = expectGatewayError(
    () => validateTokenRequest(goodBody({ scopes: ["patterns:create", "checkouts:create"] })),
    { status: 400, code: "scope_forbidden", message: /scopes/ },
  );
  assert.deepEqual(error.extra.forbidden, ["checkouts:create"]);
  for (const scope of [...FORBIDDEN_SCOPES, "admin:all", "patterns", "checkouts:create "]) {
    const denied = expectGatewayError(() => validateTokenRequest(goodBody({ scopes: [scope] })), { status: 400, code: "scope_forbidden" });
    assert.deepEqual(denied.extra.forbidden, [scope]);
  }
  expectGatewayError(() => validateTokenRequest(goodBody({ scopes: [5] })), { status: 400, code: "scope_forbidden" });
});

// ------------------------------------------------------------------------------- issue / verify

test("issueToken signs claims that verifyToken returns unchanged", () => {
  const { token, claims } = issueAt(T0, { ttlSeconds: 900 });
  assert.ok(token.startsWith(TOKEN_PREFIX));
  assert.match(claims.tokenId, /^tok_[0-9a-f]{16}$/);
  assert.deepEqual({ ...claims, tokenId: "x" }, {
    v: 1,
    tokenId: "x",
    agentId: "web-agent",
    payer: "demo-user",
    maxSpend: "200.00",
    categories: ["Silk scarf", "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a002"],
    scopes: [...AGENT_SCOPES],
    issuedAt: "2026-10-11T17:00:00.000Z",
    expiresAt: "2026-10-11T17:15:00.000Z",
  });
  assert.deepEqual(verifyToken(token, { secret: SECRET, now: clock(T0 + 1000) }), claims);
  assert.ok(Object.isFrozen(claims) && Object.isFrozen(claims.scopes) && Object.isFrozen(claims.categories));
});

test("issueToken gives every token its own tokenId", () => {
  const ids = new Set(Array.from({ length: 20 }, () => issueAt().claims.tokenId));
  assert.equal(ids.size, 20);
});

test("maxSpendCents reads integer cents from claims: 200.00 -> 20000", () => {
  assert.equal(maxSpendCents(issueAt().claims), 20000);
  assert.equal(maxSpendCents(issueAt(T0, { maxSpend: 128.5 }).claims), 12850);
});

test("verifyToken rejects a token with any single character changed", () => {
  const { token } = issueAt();
  for (let index = TOKEN_PREFIX.length; index < token.length; index += 1) {
    if (token[index] === ".") continue;
    expectGatewayError(() => verifyToken(flipChar(token, index), { secret: SECRET, now: clock(T0) }), { status: 401, code: "token_invalid" });
  }
});

test("verifyToken rejects a wrong secret, a wrong prefix and malformed input with 401 token_invalid", () => {
  const { token } = issueAt();
  const body = token.slice(TOKEN_PREFIX.length);
  const bad = [token.toUpperCase(), `Leash_${body}`, body, `${token}.x`, `${token}x`, `${token}=`, `leash_.${body.split(".")[1]}`, "", "leash_", undefined, null, 5, { token }, `leash_${"A".repeat(9000)}.${"A".repeat(43)}`];
  expectGatewayError(() => verifyToken(token, { secret: "another-secret-0123456789abcdef", now: clock(T0) }), { status: 401, code: "token_invalid" });
  for (const candidate of bad) {
    expectGatewayError(() => verifyToken(candidate, { secret: SECRET, now: clock(T0) }), { status: 401, code: "token_invalid" });
  }
});

test("verifyToken rejects correctly signed payloads with missing or wrong-shaped claims", () => {
  const { claims } = issueAt();
  const forge = (payload) => `${TOKEN_PREFIX}${encodeSigned(payload, SECRET)}`;
  const { tokenId, ...noTokenId } = claims;
  const variants = [
    noTokenId,
    { ...claims, v: 2 },
    { ...claims, tokenId: "tok_short" },
    { ...claims, agentId: "a b" },
    { ...claims, payer: "" },
    { ...claims, maxSpend: "lots" },
    { ...claims, maxSpend: "0.00" },
    { ...claims, categories: [] },
    { ...claims, categories: "Silk scarf" },
    { ...claims, scopes: "patterns:create" },
    { ...claims, issuedAt: "yesterday" },
    { ...claims, expiresAt: "soon" },
    { ...claims, expiresAt: claims.issuedAt },
    { ...claims, expiresAt: new Date(T0 + (MAX_TTL_SECONDS + 1) * 1000).toISOString() },
  ];
  assert.ok(tokenId);
  for (const payload of variants) {
    expectGatewayError(() => verifyToken(forge(payload), { secret: SECRET, now: clock(T0) }), { status: 401, code: "token_invalid" });
  }
});

test("verifyToken answers 403 expired once the clock reaches expiresAt", () => {
  const { token, claims } = issueAt(T0, { ttlSeconds: 60 });
  assert.equal(verifyToken(token, { secret: SECRET, now: clock(T0 + 59_999) }).tokenId, claims.tokenId);
  const error = expectGatewayError(() => verifyToken(token, { secret: SECRET, now: clock(T0 + 60_000) }), { status: 403, code: "expired" });
  assert.equal(error.extra.rule, "expired");
  expectGatewayError(() => verifyToken(token, { secret: SECRET, now: clock(T0 + 3_600_000) }), { status: 403, code: "expired" });
});

test("verifyToken checks the signature before expiry, so a forged expired token is token_invalid", () => {
  const { token } = issueAt(T0, { ttlSeconds: 60 });
  expectGatewayError(() => verifyToken(token, { secret: "another-secret-0123456789abcdef", now: clock(T0 + 120_000) }), { status: 401, code: "token_invalid" });
});

test("claims never carry checkouts:create, even in a token signed with the real secret", () => {
  const { claims } = issueAt();
  assert.ok(!claims.scopes.includes("checkouts:create"));
  const forged = `${TOKEN_PREFIX}${encodeSigned({ ...claims, scopes: ["patterns:create", ...FORBIDDEN_SCOPES, "admin:all"] }, SECRET)}`;
  const verified = verifyToken(forged, { secret: SECRET, now: clock(T0) });
  assert.deepEqual(verified.scopes, ["patterns:create"]);
});

test("verifyToken returns only the known claim fields", () => {
  const { claims } = issueAt();
  const forged = `${TOKEN_PREFIX}${encodeSigned({ ...claims, admin: true, maxSpendOverride: "999999.00" }, SECRET)}`;
  const verified = verifyToken(forged, { secret: SECRET, now: clock(T0) });
  assert.deepEqual(Object.keys(verified).sort(), ["agentId", "categories", "expiresAt", "issuedAt", "maxSpend", "payer", "scopes", "tokenId", "v"]);
});

test("issueToken refuses unvalidated input and a missing secret", () => {
  const validated = validateTokenRequest(goodBody());
  expectGatewayError(() => issueToken({ ...validated, scopes: ["checkouts:create"] }, { secret: SECRET, now: clock(T0) }), { status: 400, code: "scope_forbidden" });
  expectGatewayError(() => issueToken({ ...validated, maxSpendCents: MAX_SPEND_CENTS + 1 }, { secret: SECRET, now: clock(T0) }), { status: 400, code: "bad_request" });
  expectGatewayError(() => issueToken({ ...validated, ttlSeconds: MAX_TTL_SECONDS + 1 }, { secret: SECRET, now: clock(T0) }), { status: 400, code: "bad_request" });
  assert.throws(() => issueToken(validated, { secret: "", now: clock(T0) }), /secret/);
  assert.throws(() => issueToken(validated, { now: clock(T0) }), /secret/);
  assert.throws(() => verifyToken(issueAt().token, { secret: "", now: clock(T0) }), /secret/);
});

// -------------------------------------------------------------------- foundation: signing

test("signing: canonicalJson sorts keys recursively and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("signing: sha256Hex and hmacHex match published test vectors", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"));
  assert.equal(hmacHex("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("signing: safeEqualHex is exact and false on length mismatch, non-hex or empty", () => {
  const mac = hmacHex(SECRET, "x");
  assert.equal(safeEqualHex(mac, mac), true);
  assert.equal(safeEqualHex(mac, hmacHex(SECRET, "y")), false);
  assert.equal(safeEqualHex(mac, mac.toUpperCase()), true);
  assert.equal(safeEqualHex(mac, mac.slice(0, -2)), false);
  assert.equal(safeEqualHex("zz", "zz"), false);
  assert.equal(safeEqualHex("", ""), false);
  assert.equal(safeEqualHex(mac, undefined), false);
});

test("signing: encodeSigned / decodeSigned round trip, tamper and wrong secret", () => {
  const payload = { b: [1, 2], a: "x" };
  const signed = encodeSigned(payload, SECRET);
  assert.deepEqual(decodeSigned(signed, SECRET), { ok: true, payload });
  assert.equal(encodeSigned({ a: "x", b: [1, 2] }, SECRET), signed);
  const [body, mac] = signed.split(".");
  assert.deepEqual(decodeSigned(`${flipChar(body, 0)}.${mac}`, SECRET), { ok: false, reason: "bad_signature" });
  assert.deepEqual(decodeSigned(`${body}.${flipChar(mac, 0)}`, SECRET), { ok: false, reason: "bad_signature" });
  assert.deepEqual(decodeSigned(signed, "another-secret"), { ok: false, reason: "bad_signature" });
  for (const malformed of ["", "abc", "a.b.c", ".x", "x.", 5, null]) {
    assert.deepEqual(decodeSigned(malformed, SECRET), { ok: false, reason: "malformed" }, String(malformed));
  }
  const notJson = `${Buffer.from("not json").toString("base64url")}.${Buffer.from(hmacHex(SECRET, "not json"), "hex").toString("base64url")}`;
  assert.deepEqual(decodeSigned(notJson, SECRET), { ok: false, reason: "malformed" });
});

// ---------------------------------------------------------------------- foundation: money

test("money: toCents parses decimal strings and finite numbers into exact integer cents", () => {
  const cases = [["128.00", 12800], ["128", 12800], ["128.5", 12850], ["0.01", 1], [" 7.10 ", 710], [128, 12800], [0, 0], ["999999999999.99", 99999999999999]];
  for (const [value, cents] of cases) assert.equal(toCents(value), cents, JSON.stringify(value));
  assert.equal(formatCents(toCents("102.40") * 50), "5120.00");
});

test("money: toCents throws 400 bad_request on negative, NaN, non-decimal and empty input", () => {
  for (const value of ["-1", "abc", "1.234", "", "1e3", "1,000.00", null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY, {}]) {
    expectGatewayError(() => toCents(value), { status: 400, code: "bad_request" });
  }
});

test("money: formatCents and isDecimalAmount edge cases", () => {
  assert.equal(formatCents(12800), "128.00");
  assert.equal(formatCents(5), "0.05");
  assert.equal(formatCents(0), "0.00");
  assert.equal(formatCents(10_000_000), "100000.00");
  assert.throws(() => formatCents(-1));
  assert.throws(() => formatCents(1.5));
  assert.throws(() => formatCents("100"));
  assert.equal(isDecimalAmount("128.00"), true);
  assert.equal(isDecimalAmount("128"), true);
  assert.equal(isDecimalAmount(128), false);
  assert.equal(isDecimalAmount("1.234"), false);
  assert.equal(isDecimalAmount("-1.00"), false);
});

// --------------------------------------------------------------------- foundation: scopes

test("scopes: AGENT_SCOPES never contains a FORBIDDEN scope and both lists are frozen", () => {
  assert.ok(Object.isFrozen(AGENT_SCOPES) && Object.isFrozen(FORBIDDEN_SCOPES));
  assert.ok(FORBIDDEN_SCOPES.includes("checkouts:create"));
  for (const scope of AGENT_SCOPES) {
    assert.equal(isForbiddenScope(scope), false, scope);
    assert.equal(isAgentScope(scope), true, scope);
  }
  for (const scope of FORBIDDEN_SCOPES) assert.equal(isAgentScope(scope), false, scope);
  assert.equal(new Set(AGENT_SCOPES).size, AGENT_SCOPES.length);
});

test("scopes: scopeForProcedure maps paths to scopes and every agent scope is a valid procedure", () => {
  assert.equal(scopeForProcedure("/patterns/create"), "patterns:create");
  assert.equal(scopeForProcedure("/patterns/refine/edit"), "patterns:refine:edit");
  assert.equal(scopeForProcedure("/checkouts/create"), "checkouts:create");
  for (const scope of AGENT_SCOPES) {
    const path = `/${scope.replaceAll(":", "/")}`;
    assert.equal(isValidProcedure(path), true, path);
    assert.equal(scopeForProcedure(path), scope);
  }
  for (const path of WORK_STARTING_PROCEDURES) assert.ok(isAgentScope(scopeForProcedure(path)), path);
});

test("scopes: isValidProcedure rejects traversal, query strings, encoded slashes and wrong depth", () => {
  for (const path of ["/a/../b", "/products/get?x=1", "/products/get#x", "/products%2Fget/x", "/products", "/a/b/c/d", "products/get", "//products/get", "/products/get/", "/pro ducts/get", "", null, undefined, 5]) {
    assert.equal(isValidProcedure(path), false, String(path));
  }
});

test("scopes: work-starting procedures and category-bearing procedures", () => {
  assert.equal(isWorkStarting("/patterns/create"), true);
  assert.equal(isWorkStarting("/products/create"), true);
  assert.equal(isWorkStarting("/patterns/refine/edit"), true);
  assert.equal(isWorkStarting("/patterns/refine/recolorClusters"), false);
  assert.equal(isWorkStarting("/products/get"), false);
  assert.equal(procedureCategoryId("/products/create", { categoryId: "c1" }), "c1");
  assert.equal(procedureCategoryId("/categories/get", { categoryId: "c2" }), "c2");
  assert.equal(procedureCategoryId("/products/create", { categoryId: "" }), null);
  assert.equal(procedureCategoryId("/products/create", {}), null);
  assert.equal(procedureCategoryId("/patterns/create", { categoryId: "c1" }), null);
});
