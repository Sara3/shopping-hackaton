// Leash gateway HTTP server: the only process holding the Arcade key. Agents present a leash token; every
// call is checked outside the model, every attempt is one hash-chained ledger row, and the server is the
// one place that counts denials and freezes tokens. Hardening mirrors web/server.mjs: loopback Host check,
// JSON only, 64 KB cap, no-store security headers, one error envelope, secrets redacted from every body.
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
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
import { procedureCategoryId } from "./scopes.mjs";
import { issueToken, validateTokenRequest, verifyToken } from "./tokens.mjs";

export { MAX_BODY_BYTES } from "./http.mjs";
export const GATEWAY_PORT = 8080;
export const HOST = "127.0.0.1";
export const MAX_TRACKED_TOKENS = 10_000;

const ARCADE_PREFIX = "/arcade";
const TOKEN_STATUS_PATH = /^\/tokens\/[^/]+$/;
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
  let attempt = newAttempt("/tokens");
  try {
    requireAdmin(req, ctx.adminKey);
    const { token, claims } = issueToken(validateTokenRequest(await readJsonBody(req)), { secret: ctx.secret, now: ctx.now });
    ctx.registry.remember(claims);
    attempt = withClaims(attempt, claims);
    const detail = { maxSpend: claims.maxSpend, categories: claims.categories, scopeCount: claims.scopes.length, expiresAt: claims.expiresAt };
    return ctx.gate.approve(attempt, { status: 200, json: { token, ...tokenView(claims) } }, detail);
  } catch (error) {
    return ctx.gate.deny(withDetail(attempt, forbiddenDetail(error)), error);
  }
}

async function postArcade(ctx, req, url) {
  const procedure = url.pathname.slice(ARCADE_PREFIX.length);
  let attempt = newAttempt("/arcade", clip(procedure));
  try {
    const claims = ctx.gate.verifyClaims(bearerOf(req));
    attempt = withClaims(attempt, claims);
    ctx.gate.assertNotFrozen(claims.tokenId);
    const body = await readJsonBody(req);
    attempt = withDetail(attempt, categoryDetail(procedure, body));
    await authorizeProcedure({ claims, procedure, body }, { detector: ctx.detector, categoryResolver: ctx.categoryResolver });
    const forwarded = await forwardProcedure({ procedure, body }, { arcade: ctx.arcade });
    return ctx.gate.approve(attempt, { status: forwarded.status, json: forwarded.body }, { status: forwarded.status });
  } catch (error) {
    return ctx.gate.deny(attempt, error, { freezeRules: PROXY_FREEZE_RULES });
  }
}

async function postMandates(ctx, req) {
  let attempt = newAttempt("/mandates");
  try {
    const body = await readJsonBody(req);
    const claims = ctx.gate.verifyClaims(tokenFrom(req, body));
    attempt = withClaims(attempt, claims);
    ctx.gate.assertNotFrozen(claims.tokenId);
    const request = validateMandateRequest(body);
    attempt = withDetail(attempt, { productId: clip(request.productId), quantity: request.quantity });
    const { mandateId, mandate, signature } = await createMandate({ claims, ...request }, ctx.mandateDeps);
    ctx.mandateStore.put({ mandate, signature });
    return ctx.gate.approve(attempt, { status: 200, json: { mandateId, mandate, signature } }, mandateDetail(mandate));
  } catch (error) {
    return ctx.gate.deny(attempt, error, { freezeRules: MANDATE_FREEZE_RULES });
  }
}

async function postCheckout(ctx, req) {
  let attempt = newAttempt("/checkout");
  try {
    const body = await readJsonBody(req);
    const claims = ctx.gate.verifyClaims(tokenFrom(req, body));
    attempt = withClaims(attempt, claims);
    ctx.gate.assertNotFrozen(claims.tokenId);
    const { mandateId, lines } = validateCheckoutRequest(body);
    attempt = withDetail(attempt, linesDetail(mandateId, lines));
    // The running total is read from the ledger and the approved row is written to it, so the two must not
    // interleave: parallel checkouts would each see the same total and all pass. A request that queued
    // behind a denial finds the token frozen by the time its turn comes.
    return await ctx.serializeCheckouts(async () => {
      ctx.gate.assertNotFrozen(claims.tokenId);
      const { checkoutUrl, totalCents } = await runCheckout({ claims, mandateId, lines }, ctx.checkoutDeps);
      return ctx.gate.approve(attempt, { status: 200, json: { checkoutUrl } }, { totalCents });
    });
  } catch (error) {
    return ctx.gate.deny(attempt, error, { freezeAll: true });
  }
}

async function getTokenStatus(ctx, req, url) {
  requireAdmin(req, ctx.adminKey);
  const claims = ctx.registry.get(url.pathname.slice("/tokens/".length));
  if (!claims) throw gatewayError("not_found", "no token with this id was issued or seen by this gateway");
  const status = ctx.detector.status(claims.tokenId);
  const json = { ...tokenView(claims), frozen: status.frozen, frozenReason: status.reason, frozenAt: status.at, denials: status.denials };
  return { status: 200, json, tokenId: claims.tokenId };
}

async function getLedger(ctx, req, url) {
  requireAdmin(req, ctx.adminKey);
  const tokenId = url.searchParams.get("tokenId");
  const entries = ctx.ledger.entries();
  return { status: 200, json: { head: ctx.ledger.head(), entries: tokenId ? entries.filter((entry) => entry.tokenId === tokenId) : entries } };
}

const getHealth = async (ctx) =>
  ({ status: 200, json: { ok: true, arcadeBaseUrl: ctx.arcade.baseUrl ?? null, ...(ctx.mode ? { mode: ctx.mode } : {}) } });

const EXACT_ROUTES = Object.freeze({
  "/health": Object.freeze({ GET: getHealth }),
  "/tokens": Object.freeze({ POST: postTokens }),
  "/mandates": Object.freeze({ POST: postMandates }),
  "/checkout": Object.freeze({ POST: postCheckout }),
  "/ledger": Object.freeze({ GET: getLedger }),
});

function methodsFor(pathname) {
  if (Object.hasOwn(EXACT_ROUTES, pathname)) return EXACT_ROUTES[pathname];
  if (pathname.startsWith(`${ARCADE_PREFIX}/`)) return { POST: postArcade };
  if (TOKEN_STATUS_PATH.test(pathname)) return { GET: getTokenStatus };
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

function assertConfig({ host, port, arcade, secret, adminKey, secrets, now, fetchImpl }) {
  if (!LOOPBACK_BINDS.includes(host)) throw new Error(`the gateway binds loopback only (127.0.0.1, ::1 or localhost), got ${host}`);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new TypeError(`port must be an integer from 0 to ${MAX_PORT}, got ${port}`);
  const missing = ARCADE_METHODS.filter((name) => typeof arcade?.[name] !== "function");
  if (missing.length > 0) throw new TypeError(`arcade client is missing ${missing.map((name) => `${name}()`).join(", ")}`);
  if (typeof secret !== "string" || secret === "") throw new TypeError("the gateway needs a non-empty secret (LEASH_SECRET)");
  if (adminKey !== null && (typeof adminKey !== "string" || adminKey === "")) throw new TypeError("adminKey must be null or a non-empty string");
  if (!Array.isArray(secrets)) throw new TypeError("secrets must be an array of strings");
  if (typeof now !== "function" || typeof fetchImpl !== "function") throw new TypeError("now and fetchImpl must be functions");
}

function buildContext(config) {
  const { arcade, fetchImpl, secret, now, adminKey, mode } = config;
  const redact = createRedactor(config.secrets, [secret, adminKey]);
  const log = redactingLogger(config.logger, redact);
  if (secret.length < MIN_SECRET_LENGTH) log.warn(`LEASH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; use 32 random bytes`);
  const ledger = createLedger({ path: config.ledgerPath, now });
  const detector = createDetector({ now, velocityLimit: config.velocityLimit, denialLimit: config.denialLimit });
  restoreFreezes(ledger, detector);
  const mandateStore = createMandateStore();
  const categoryResolver = createCategoryResolver({ arcade, now });
  const registry = createTokenRegistry();
  const gate = createGatekeeper({ secret, now, ledger, detector, registry, log });
  return Object.freeze({
    arcade, secret, now, adminKey, mode, redact, log, ledger, detector, mandateStore, categoryResolver, registry, gate,
    serializeCheckouts: createSerializer(),
    mandateDeps: Object.freeze({ arcade, fetchImpl, secret, now, ttlSeconds: config.mandateTtlSeconds, categoryResolver }),
    checkoutDeps: Object.freeze({
      arcade, fetchImpl, mandateStore, detector, secret, now, spentCents: (tokenId) => spentCents(ledger.entries(), tokenId),
    }),
  });
}

const urlHost = (host) => (host.includes(":") ? `[${host}]` : host);

export async function createGatewayServer({
  port = GATEWAY_PORT, host = HOST, arcade, fetchImpl = fetch, secret, ledgerPath = null, now = () => Date.now(), logger = console,
  velocityLimit, denialLimit, mandateTtlSeconds = DEFAULT_MANDATE_TTL_SECONDS, adminKey = null, secrets = [], mode = null,
} = {}) {
  const config = { port, host, arcade, fetchImpl, secret, ledgerPath, now, logger, velocityLimit, denialLimit, mandateTtlSeconds, adminKey, secrets, mode };
  assertConfig(config);
  const ctx = buildContext(config);
  let boundPort = null;
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
