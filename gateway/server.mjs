// Leash gateway HTTP server: the only process holding the Arcade key. Agents present a leash token; every
// call is checked outside the model, every attempt is one hash-chained ledger row, and the server is the
// one place that counts denials and freezes tokens. Hardening mirrors web/server.mjs: loopback Host check,
// JSON only, 64 KB cap, no-store security headers, one error envelope, secrets redacted from every body.
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { SpanStatusCode } from "@opentelemetry/api";
import { GatewayError, gatewayError, isGatewayError } from "./errors.mjs";
import {
  bearerOf, createRedactor, isAllowedHost, messageOf, parseTarget, readJsonBody, redactingLogger, requireAdmin, send, tokenFrom,
} from "./http.mjs";
import { createLedger, spentCents } from "./ledger.mjs";
import { createDetector } from "./detector.mjs";
import { createMandateStore } from "./mandate-store.mjs";
import { DEFAULT_MANDATE_TTL_SECONDS, createCategoryResolver, createMandate, validateMandateRequest } from "./mandates.mjs";
import { runCheckout, validateCheckoutRequest } from "./checkout.mjs";
import { authorizeProcedure, forwardProcedure } from "./proxy.mjs";
import { renderSimulatedCheckoutPage } from "./receipt-page.mjs";
import { procedureCategoryId } from "./scopes.mjs";
import { withSpan } from "./telemetry.mjs";
import { issueToken, validateTokenRequest, verifyToken } from "./tokens.mjs";

export { MAX_BODY_BYTES } from "./http.mjs";
export const GATEWAY_PORT = 8080;
export const HOST = "127.0.0.1";
export const MAX_TRACKED_TOKENS = 10_000;

const ARCADE_PREFIX = "/arcade";
const TOKEN_STATUS_PATH = /^\/tokens\/[^/]+$/;
const SIMULATED_CHECKOUT_PREFIX = "/simulated-checkout/";
const SIMULATED_CHECKOUT_PATH = /^\/simulated-checkout\/mnd_[0-9a-f]{16}$/;
const SIMULATED_PAY_PATH = /^\/simulated-checkout\/(mnd_[0-9a-f]{16})\/pay$/;
const SIMULATED_ORDER_PREFIX = "SIM-";
const SIMULATED_ORDER_DIGITS = 6;
const MAX_SIMULATED_RECEIPTS = 1_000;
const DENIAL_STATUS = 403;
const DENIAL_COUNT_RULE = "denial_count";
const MAX_PORT = 65_535;
const MIN_SECRET_LENGTH = 16;
const MAX_DETAIL_ITEMS = 5;
const MAX_DETAIL_CHARS = 80;
const MAX_LOGGED_PATH = 120;
const LOOPBACK_BINDS = Object.freeze(["127.0.0.1", "::1", "localhost"]);
const ARCADE_METHODS = Object.freeze(["call", "getProduct", "createCheckout", "listCategories"]);
// Rules that freeze a token on the spot (before the denial count), per route; /checkout freezes on any 403.
const PROXY_FREEZE_RULES = Object.freeze(["off_scope_category", "velocity"]);
const MANDATE_FREEZE_RULES = Object.freeze(["off_scope_category"]);
const NOT_FROZEN = Object.freeze({ frozen: false, reason: null, at: null });

const clip = (value) => String(value ?? "").slice(0, MAX_DETAIL_CHARS);

// ------------------------------------------------------------------------------ outcomes

const envelope = (failure, tokenFrozen) => ({
  error: failure.code,
  message: failure.message,
  ...(typeof failure.extra?.rule === "string" ? { rule: failure.extra.rule } : {}),
  tokenFrozen,
});

// security.decision/security.reason come from which gatekeeper method ran (approved vs
// denied), never from the http status alone -- a gate ALLOW whose upstream Arcade call then
// answers non-2xx (postArcade's `forwarded.status`) is still an allow; the span's ERROR
// status is the independent signal for "something about this response was non-2xx."
function annotateSpan(span, result, approved) {
  span.setAttribute("http.status_code", result.status);
  span.setAttribute("security.decision", approved ? "allow" : "deny");
  if (!approved) span.setAttribute("security.reason", result.json?.rule ?? result.json?.error ?? `HTTP ${result.status}`);
  if (result.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR, message: result.json?.error ?? `HTTP ${result.status}` });
  if (result.tokenId) span.setAttribute("leash.token_id", result.tokenId);
}

function asFailure(error, log) {
  if (isGatewayError(error)) return error;
  log.error(`unhandled: ${messageOf(error)}`);
  return new GatewayError(500, "internal_error", "unexpected gateway error");
}

const newAttempt = (endpoint, procedure = null) => Object.freeze({ tokenId: null, agentId: null, endpoint, procedure, detail: {} });
const withClaims = (attempt, claims) => ({ ...attempt, tokenId: claims.tokenId, agentId: claims.agentId });
const withDetail = (attempt, detail) => ({ ...attempt, detail: { ...attempt.detail, ...detail } });
const ledgerRow = (attempt, decision, code, rule, detail = {}) => ({
  tokenId: attempt.tokenId, agentId: attempt.agentId, endpoint: attempt.endpoint, procedure: attempt.procedure,
  decision, code, rule, detail: { ...attempt.detail, ...detail },
});
const freezeDetail = (status, state) => ({ status, tokenFrozen: state.frozen, ...(state.frozen ? { frozenReason: state.reason } : {}) });

// Receipts of simulated live checkouts (checkout.mjs step 7), by mandateId, each { receipt, paid } where paid
// is null until the page's Pay button (no money: it only marks the receipt). Oldest drop off past the limit.
function createReceiptStore({ now, limit = MAX_SIMULATED_RECEIPTS }) {
  let entries = new Map();
  let orders = 0;
  const set = (mandateId, entry) => {
    const next = new Map(entries).set(mandateId, Object.freeze(entry));
    if (next.size > limit) next.delete(next.keys().next().value);
    entries = next;
  };
  return Object.freeze({
    put: (receipt) => set(receipt.mandateId, { receipt, paid: null }),
    get: (mandateId) => entries.get(mandateId) ?? null,
    // Idempotent: paying twice keeps the first order number.
    pay(mandateId) {
      const entry = entries.get(mandateId);
      if (!entry || entry.paid) return entry ?? null;
      orders += 1;
      const orderNumber = `${SIMULATED_ORDER_PREFIX}${String(orders).padStart(SIMULATED_ORDER_DIGITS, "0")}`;
      set(mandateId, { ...entry, paid: Object.freeze({ orderNumber, paidAt: new Date(now()).toISOString() }) });
      return entries.get(mandateId);
    },
  });
}

function createTokenRegistry(limit = MAX_TRACKED_TOKENS) {
  let tokens = new Map();
  return Object.freeze({
    remember(claims) {
      if (tokens.has(claims.tokenId)) return;
      const next = new Map(tokens).set(claims.tokenId, claims);
      if (next.size > limit) next.delete(next.keys().next().value);
      tokens = next;
    },
    get: (tokenId) => tokens.get(tokenId) ?? null,
  });
}

// The one place that turns outcomes into ledger rows, denial counts and freezes.
function createGatekeeper({ secret, now, ledger, detector, registry, log }) {
  const verifyClaims = (token) => {
    const claims = verifyToken(token, { secret, now });
    registry.remember(claims);
    return claims;
  };
  const assertNotFrozen = (tokenId) => {
    const state = detector.isFrozen(tokenId);
    if (state.frozen) throw gatewayError("token_frozen", `token is frozen (${state.reason})`, { rule: state.reason, tokenFrozen: true });
  };
  const approve = (attempt, result, detail = {}) => {
    ledger.append(ledgerRow(attempt, "approved", null, null, detail));
    return { ...result, tokenId: attempt.tokenId };
  };
  // A 403 on a known token is a denial: freeze first when the policy says so, then count it.
  const deny = (attempt, error, { freezeRules = [], freezeAll = false } = {}) => {
    const failure = asFailure(error, log);
    const rule = typeof failure.extra?.rule === "string" ? failure.extra.rule : null;
    const counted = attempt.tokenId !== null && failure.status === DENIAL_STATUS;
    if (counted && (freezeAll || freezeRules.includes(rule))) detector.freeze(attempt.tokenId, rule ?? failure.code);
    const denial = counted ? detector.recordDenial(attempt.tokenId, failure.code) : null;
    const state = attempt.tokenId === null ? NOT_FROZEN : detector.isFrozen(attempt.tokenId);
    ledger.append(ledgerRow(attempt, "denied", failure.code, rule, freezeDetail(failure.status, state)));
    if (denial?.frozeNow) {
      ledger.append(ledgerRow(attempt, "denied", "token_frozen", DENIAL_COUNT_RULE, { ...freezeDetail(DENIAL_STATUS, state), denials: denial.denials }));
    }
    return { status: failure.status, json: envelope(failure, state.frozen), tokenId: attempt.tokenId };
  };
  return Object.freeze({ verifyClaims, assertNotFrozen, approve, deny });
}

// One task at a time, in arrival order; a failed task rejects to its own caller and never blocks the next.
function createSerializer() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

// A restart must not thaw a token: re-freeze every token a persisted ledger row recorded as frozen.
function restoreFreezes(ledger, detector) {
  ledger.entries()
    .filter((entry) => typeof entry.tokenId === "string" && typeof entry.detail?.frozenReason === "string")
    .forEach((entry) => detector.freeze(entry.tokenId, entry.detail.frozenReason));
}

// ------------------------------------------------------------------------------ routes

const tokenView = (claims) => ({
  tokenId: claims.tokenId, agentId: claims.agentId, payer: claims.payer, maxSpend: claims.maxSpend,
  categories: claims.categories, scopes: claims.scopes, expiresAt: claims.expiresAt,
});
const forbiddenDetail = (error) =>
  (Array.isArray(error?.extra?.forbidden) ? { forbidden: error.extra.forbidden.slice(0, MAX_DETAIL_ITEMS).map(clip) } : {});
const categoryDetail = (procedure, body) => {
  const categoryId = procedureCategoryId(procedure, body);
  return categoryId === null ? {} : { categoryId: clip(categoryId) };
};
const mandateDetail = (mandate) =>
  ({ mandateId: mandate.mandateId, unitPrice: mandate.unitPrice, maxTotal: mandate.maxTotal, imageSha256: mandate.imageSha256, expiresAt: mandate.expiresAt });
const lineDetail = ({ productId, quantity }) => ({ productId: clip(productId), quantity });
const linesDetail = (mandateId, lines) => ({ mandateId: clip(mandateId), lineCount: lines.length, lines: lines.slice(0, MAX_DETAIL_ITEMS).map(lineDetail) });

async function postTokens(ctx, req) {
  return withSpan("token.issue", {}, async (span) => {
    let attempt = newAttempt("/tokens");
    let result;
    let approved = false;
    try {
      requireAdmin(req, ctx.adminKey);
      const { token, claims } = issueToken(validateTokenRequest(await readJsonBody(req)), { secret: ctx.secret, now: ctx.now });
      ctx.registry.remember(claims);
      attempt = withClaims(attempt, claims);
      span.setAttribute("leash.agent_id", claims.agentId);
      span.setAttribute("leash.payer", claims.payer);
      span.setAttribute("leash.scopes", claims.scopes.join(","));
      span.setAttribute("leash.max_spend", claims.maxSpend);
      const detail = { maxSpend: claims.maxSpend, categories: claims.categories, scopeCount: claims.scopes.length, expiresAt: claims.expiresAt };
      result = ctx.gate.approve(attempt, { status: 200, json: { token, ...tokenView(claims) } }, detail);
      approved = true;
    } catch (error) {
      result = ctx.gate.deny(withDetail(attempt, forbiddenDetail(error)), error);
    }
    annotateSpan(span, result, approved);
    return result;
  });
}

async function postArcade(ctx, req, url) {
  const procedure = url.pathname.slice(ARCADE_PREFIX.length);
  return withSpan("arcade.call", { "leash.action": clip(procedure), "leash.arcade_mode": ctx.mode ?? "" }, async (span) => {
    let attempt = newAttempt("/arcade", clip(procedure));
    let result;
    let approved = false;
    try {
      const claims = ctx.gate.verifyClaims(bearerOf(req));
      attempt = withClaims(attempt, claims);
      span.setAttribute("leash.scopes", claims.scopes.join(","));
      span.setAttribute("leash.max_spend", claims.maxSpend);
      ctx.gate.assertNotFrozen(claims.tokenId);
      const body = await readJsonBody(req);
      attempt = withDetail(attempt, categoryDetail(procedure, body));
      await authorizeProcedure({ claims, procedure, body }, { detector: ctx.detector, categoryResolver: ctx.categoryResolver });
      const forwarded = await forwardProcedure({ procedure, body }, { arcade: ctx.arcade });
      result = ctx.gate.approve(attempt, { status: forwarded.status, json: forwarded.body }, { status: forwarded.status });
      approved = true;
    } catch (error) {
      result = ctx.gate.deny(attempt, error, { freezeRules: PROXY_FREEZE_RULES });
    }
    annotateSpan(span, result, approved);
    return result;
  });
}

async function postMandates(ctx, req) {
  return withSpan("mandate.create", {}, async (span) => {
    let attempt = newAttempt("/mandates");
    let result;
    let approved = false;
    try {
      const body = await readJsonBody(req);
      const claims = ctx.gate.verifyClaims(tokenFrom(req, body));
      attempt = withClaims(attempt, claims);
      span.setAttribute("leash.scopes", claims.scopes.join(","));
      span.setAttribute("leash.max_spend", claims.maxSpend);
      ctx.gate.assertNotFrozen(claims.tokenId);
      const request = validateMandateRequest(body);
      span.setAttribute("leash.product_id", clip(request.productId));
      span.setAttribute("leash.quantity", request.quantity);
      attempt = withDetail(attempt, { productId: clip(request.productId), quantity: request.quantity });
      const { mandateId, mandate, signature } = await createMandate({ claims, ...request }, ctx.mandateDeps);
      ctx.mandateStore.put({ mandate, signature });
      span.setAttribute("leash.mandate_id", mandateId);
      result = ctx.gate.approve(attempt, { status: 200, json: { mandateId, mandate, signature } }, mandateDetail(mandate));
      approved = true;
    } catch (error) {
      result = ctx.gate.deny(attempt, error, { freezeRules: MANDATE_FREEZE_RULES });
    }
    annotateSpan(span, result, approved);
    return result;
  });
}

async function postCheckout(ctx, req) {
  return withSpan("checkout", { "leash.arcade_mode": ctx.mode ?? "" }, async (span) => {
    let attempt = newAttempt("/checkout");
    let result;
    let approved = false;
    try {
      const body = await readJsonBody(req);
      const claims = ctx.gate.verifyClaims(tokenFrom(req, body));
      attempt = withClaims(attempt, claims);
      span.setAttribute("leash.scopes", claims.scopes.join(","));
      span.setAttribute("leash.max_spend", claims.maxSpend);
      ctx.gate.assertNotFrozen(claims.tokenId);
      const { mandateId, lines } = validateCheckoutRequest(body);
      span.setAttribute("leash.mandate_id", clip(mandateId));
      attempt = withDetail(attempt, linesDetail(mandateId, lines));
      // The running total is read from the ledger and the approved row is written to it, so the two must not
      // interleave: parallel checkouts would each see the same total and all pass. A request that queued
      // behind a denial finds the token frozen by the time its turn comes.
      result = await ctx.serializeCheckouts(async () => {
        ctx.gate.assertNotFrozen(claims.tokenId);
        const { checkoutUrl, totalCents, receipt } = await runCheckout({ claims, mandateId, lines }, ctx.checkoutDeps);
        if (receipt) ctx.receipts.put(receipt);
        const simulated = receipt ? { simulated: true } : {};
        return ctx.gate.approve(attempt, { status: 200, json: { checkoutUrl, ...simulated } }, { totalCents, ...simulated });
      });
      approved = true;
    } catch (error) {
      result = ctx.gate.deny(attempt, error, { freezeAll: true });
    }
    annotateSpan(span, result, approved);
    return result;
  });
}

async function getTokenStatus(ctx, req, url) {
  requireAdmin(req, ctx.adminKey);
  const claims = ctx.registry.get(url.pathname.slice("/tokens/".length));
  if (!claims) throw gatewayError("not_found", "no token with this id was issued or seen by this gateway");
  const status = ctx.detector.status(claims.tokenId);
  const json = { ...tokenView(claims), frozen: status.frozen, frozenReason: status.reason, frozenAt: status.at, denials: status.denials };
  return { status: 200, json, tokenId: claims.tokenId };
}

// What a simulated live checkout would have ordered: the checkout page for a browser, JSON otherwise.
// Loopback only like every route; no secret in it.
const wantsHtml = (req) => String(req.headers.accept ?? "").includes("text/html");
const simulatedEntry = (ctx, mandateId) => {
  const entry = ctx.receipts.get(mandateId);
  if (!entry) throw gatewayError("not_found", "no simulated checkout with this mandate id");
  return entry;
};

async function getSimulatedCheckout(ctx, req, url) {
  const { receipt, paid } = simulatedEntry(ctx, url.pathname.slice(SIMULATED_CHECKOUT_PREFIX.length));
  if (wantsHtml(req)) return { status: 200, html: renderSimulatedCheckoutPage(receipt, paid) };
  return { status: 200, json: { ...receipt, paid } };
}

// The page's Pay button: marks the receipt paid (no card, no money, no Arcade call), then shows the page.
async function postSimulatedPay(ctx, req, url) {
  const mandateId = SIMULATED_PAY_PATH.exec(url.pathname)[1];
  simulatedEntry(ctx, mandateId);
  ctx.receipts.pay(mandateId);
  return { status: 303, location: `${SIMULATED_CHECKOUT_PREFIX}${mandateId}` };
}

async function getLedger(ctx, req, url) {
  requireAdmin(req, ctx.adminKey);
  const tokenId = url.searchParams.get("tokenId");
  const entries = ctx.ledger.entries();
  return { status: 200, json: { head: ctx.ledger.head(), entries: tokenId ? entries.filter((entry) => entry.tokenId === tokenId) : entries } };
}

const getHealth = async (ctx) =>
  ({
    status: 200,
    json: {
      ok: true, arcadeBaseUrl: ctx.arcade.baseUrl ?? null, ...(ctx.mode ? { mode: ctx.mode } : {}),
      ...(ctx.arcadeSwitch ? { arcade: ctx.arcadeSwitch.view() } : {}),
    },
  });

// The human's Arcade switch from the chat's Settings (web/arcade-control.mjs): admin key only, one ledger
// row per attempt. createArcadeSwitch enforces the rules (live needs a live key, live checkout needs live).
async function postAdminArcade(ctx, req) {
  let attempt = newAttempt("/admin/arcade");
  try {
    requireAdmin(req, ctx.adminKey);
    if (!ctx.arcadeSwitch) throw gatewayError("scope_forbidden", "this gateway was started with a fixed Arcade");
    const body = await readJsonBody(req);
    const before = ctx.arcadeSwitch.view();
    const view = ctx.arcadeSwitch.set(body);
    // Category names and ids differ between the replica and live Arcade: re-read them on the next check.
    if (view.mode !== before.mode) ctx.categoryResolver.clear();
    attempt = withDetail(attempt, { from: { mode: before.mode, liveCheckoutEnabled: before.liveCheckoutEnabled } });
    ctx.log.info(`arcade switched: ${view.mode}${view.liveCheckoutEnabled ? ", LIVE CHECKOUT ENABLED" : view.mode === "live" ? ", live checkout simulated" : ""}`);
    return ctx.gate.approve(attempt, { status: 200, json: view }, { mode: view.mode, liveCheckoutEnabled: view.liveCheckoutEnabled });
  } catch (error) {
    return ctx.gate.deny(attempt, error);
  }
}

const EXACT_ROUTES = Object.freeze({
  "/health": Object.freeze({ GET: getHealth }),
  "/tokens": Object.freeze({ POST: postTokens }),
  "/mandates": Object.freeze({ POST: postMandates }),
  "/checkout": Object.freeze({ POST: postCheckout }),
  "/ledger": Object.freeze({ GET: getLedger }),
  "/admin/arcade": Object.freeze({ POST: postAdminArcade }),
});

function methodsFor(pathname) {
  if (Object.hasOwn(EXACT_ROUTES, pathname)) return EXACT_ROUTES[pathname];
  if (pathname.startsWith(`${ARCADE_PREFIX}/`)) return { POST: postArcade };
  if (TOKEN_STATUS_PATH.test(pathname)) return { GET: getTokenStatus };
  if (SIMULATED_CHECKOUT_PATH.test(pathname)) return { GET: getSimulatedCheckout };
  if (SIMULATED_PAY_PATH.test(pathname)) return { POST: postSimulatedPay };
  return null;
}

function route(ctx, req, url) {
  const methods = methodsFor(url.pathname);
  if (!methods) throw gatewayError("not_found", `no route for ${clip(url.pathname)}`);
  if (!Object.hasOwn(methods, req.method)) throw gatewayError("method_not_allowed", `${req.method} not allowed on ${clip(url.pathname)}`);
  return methods[req.method](ctx, req, url);
}

// The bearer's claims when it is a valid leash token, else null; never throws (rejection path only).
function quietClaims(ctx, req) {
  try {
    return verifyToken(bearerOf(req), { secret: ctx.secret, now: ctx.now });
  } catch {
    return null;
  }
}

// A request refused before any handler ran (421, 404, 405) or by the admin check (401) is an attempt
// too: one denied ledger row, naming the token when the request carried a valid one. Not a 403, so not
// counted as a denial. A ledger failure is logged, never turned into a second error.
function ledgerRejection(ctx, req, path, failure) {
  const claims = quietClaims(ctx, req);
  const isProcedure = path.startsWith(`${ARCADE_PREFIX}/`);
  const row = {
    tokenId: claims?.tokenId ?? null, agentId: claims?.agentId ?? null,
    endpoint: isProcedure ? ARCADE_PREFIX : clip(path), procedure: isProcedure ? clip(path.slice(ARCADE_PREFIX.length)) : null,
    decision: "denied", code: failure.code, rule: null, detail: { status: failure.status, method: clip(req.method) },
  };
  try {
    ctx.ledger.append(row);
  } catch (error) {
    ctx.log.error(`ledger append failed for a rejected request: ${messageOf(error)}`);
  }
  return row.tokenId;
}

function createHandler(ctx, boundPort) {
  return async (req, res) => {
    const started = performance.now();
    const path = String(req.url ?? "").split("?")[0].slice(0, MAX_LOGGED_PATH);
    let result;
    try {
      if (!isAllowedHost(req.headers.host, boundPort())) throw gatewayError("bad_host", "Host header must be localhost, 127.0.0.1 or [::1] with this port");
      result = await route(ctx, req, parseTarget(req.url));
    } catch (error) {
      const failure = asFailure(error, ctx.log);
      result = { status: failure.status, json: envelope(failure, false), tokenId: ledgerRejection(ctx, req, path, failure) };
    }
    try {
      send(res, result, ctx.redact);
    } catch (error) {
      ctx.log.error(`could not send response: ${messageOf(error)}`);
      res.destroy();
    }
    const tokenNote = result.tokenId ? ` ${result.tokenId}` : "";
    ctx.log.info(`${req.method} ${path} ${result.status} ${Math.round(performance.now() - started)}ms${tokenNote}`);
  };
}

// ------------------------------------------------------------------------------ factory

function assertConfig({ host, port, arcade, secret, adminKey, secrets, now, fetchImpl, liveCheckoutEnabled }) {
  if (!LOOPBACK_BINDS.includes(host)) throw new Error(`the gateway binds loopback only (127.0.0.1, ::1 or localhost), got ${host}`);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new TypeError(`port must be an integer from 0 to ${MAX_PORT}, got ${port}`);
  const missing = ARCADE_METHODS.filter((name) => typeof arcade?.[name] !== "function");
  if (missing.length > 0) throw new TypeError(`arcade client is missing ${missing.map((name) => `${name}()`).join(", ")}`);
  if (typeof secret !== "string" || secret === "") throw new TypeError("the gateway needs a non-empty secret (LEASH_SECRET)");
  if (adminKey !== null && (typeof adminKey !== "string" || adminKey === "")) throw new TypeError("adminKey must be null or a non-empty string");
  if (!Array.isArray(secrets)) throw new TypeError("secrets must be an array of strings");
  if (typeof now !== "function" || typeof fetchImpl !== "function") throw new TypeError("now and fetchImpl must be functions");
  if (typeof liveCheckoutEnabled !== "boolean") throw new TypeError("liveCheckoutEnabled must be a boolean");
}

function buildContext(config) {
  const { arcade, fetchImpl, secret, now, adminKey, arcadeSwitch } = config;
  // With a switch, mode and live checkout are read at each use (the human may flip them); without one they
  // are fixed at start, as before.
  const modeOf = () => (arcadeSwitch ? arcadeSwitch.mode() : config.mode);
  const liveCheckoutOf = () => (arcadeSwitch ? arcadeSwitch.liveCheckoutEnabled() : config.liveCheckoutEnabled);
  const redact = createRedactor(config.secrets, [secret, adminKey]);
  const log = redactingLogger(config.logger, redact);
  if (secret.length < MIN_SECRET_LENGTH) log.warn(`LEASH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; use 32 random bytes`);
  const ledger = createLedger({ path: config.ledgerPath, now });
  const detector = createDetector({ now, velocityLimit: config.velocityLimit, denialLimit: config.denialLimit });
  restoreFreezes(ledger, detector);
  const mandateStore = createMandateStore();
  const categoryResolver = createCategoryResolver({ arcade, now });
  const registry = createTokenRegistry();
  const receipts = createReceiptStore({ now });
  const gate = createGatekeeper({ secret, now, ledger, detector, registry, log });
  return Object.freeze({
    arcade, secret, now, adminKey, redact, log, ledger, detector, mandateStore, categoryResolver, registry, gate, receipts,
    arcadeSwitch: arcadeSwitch ?? null,
    get mode() { return modeOf(); },
    serializeCheckouts: createSerializer(),
    mandateDeps: Object.freeze({ arcade, fetchImpl, secret, now, ttlSeconds: config.mandateTtlSeconds, categoryResolver }),
    checkoutDeps: Object.freeze({
      arcade, fetchImpl, mandateStore, detector, secret, now,
      get mode() { return modeOf(); },
      get liveCheckoutEnabled() { return liveCheckoutOf(); },
      spentCents: (tokenId) => spentCents(ledger.entries(), tokenId),
      simulatedCheckoutUrl: (mandateId) => `${config.origin()}${SIMULATED_CHECKOUT_PREFIX}${mandateId}`,
    }),
  });
}

const urlHost = (host) => (host.includes(":") ? `[${host}]` : host);

export async function createGatewayServer({
  port = GATEWAY_PORT, host = HOST, arcade, fetchImpl = fetch, secret, ledgerPath = null, now = () => Date.now(), logger = console,
  velocityLimit, denialLimit, mandateTtlSeconds = DEFAULT_MANDATE_TTL_SECONDS, adminKey = null, secrets = [], mode = null,
  liveCheckoutEnabled = false, arcadeSwitch = null,
} = {}) {
  let boundPort = null;
  const origin = () => `http://${urlHost(host)}:${boundPort}`;
  // A switch (gateway/arcade-switch.mjs) replaces the fixed arcade/mode/liveCheckoutEnabled.
  const config = {
    port, host, arcade: arcadeSwitch ? arcadeSwitch.client : arcade, fetchImpl, secret, ledgerPath, now, logger, velocityLimit, denialLimit,
    mandateTtlSeconds, adminKey, secrets, mode: arcadeSwitch ? arcadeSwitch.mode() : mode,
    liveCheckoutEnabled: arcadeSwitch ? arcadeSwitch.liveCheckoutEnabled() : liveCheckoutEnabled, arcadeSwitch, origin,
  };
  assertConfig(config);
  const ctx = buildContext(config);
  const server = createServer(createHandler(ctx, () => boundPort));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  boundPort = server.address().port;
  const close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  const { ledger, detector, mandateStore } = ctx;
  return { server, port: boundPort, url: `http://${urlHost(host)}:${boundPort}`, close, ledger, detector, mandateStore };
}
