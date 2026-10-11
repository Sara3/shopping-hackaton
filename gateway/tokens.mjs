// Agent tokens: short-lived, HMAC-signed claims naming who may spend how much, on which
// categories, through which Arcade procedures. The agent holds this instead of the Arcade key.
// checkouts:create is never issuable and is filtered again on verify, so no token can carry it.
import { randomBytes } from "node:crypto";
import { gatewayError, badRequest } from "./errors.mjs";
import { toCents, formatCents, isDecimalAmount } from "./money.mjs";
import { encodeSigned, decodeSigned } from "./signing.mjs";
import { AGENT_SCOPES, isAgentScope, isForbiddenScope } from "./scopes.mjs";

export const TOKEN_PREFIX = "leash_";
export const DEFAULT_TTL_SECONDS = 600;
export const MAX_TTL_SECONDS = 3600;
export const MAX_SPEND_CENTS = 10_000_000;
export const MAX_CATEGORIES = 20;
export const MAX_TOKEN_LENGTH = 8192;

const TOKEN_VERSION = 1;
const TOKEN_ID_BYTES = 8;
const MS_PER_SECOND = 1000;
const MAX_PAYER_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 120;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const TOKEN_ID_PATTERN = /^tok_[0-9a-f]{16}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isBoundedText = (value, max) => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text !== "" && text.length <= max && !CONTROL_CHARS.test(text);
};
const isAgentId = (value) => typeof value === "string" && AGENT_ID_PATTERN.test(value);
const isIssuableScope = (scope) => isAgentScope(scope) && !isForbiddenScope(scope);
const isSpendCents = (cents) => Number.isInteger(cents) && cents > 0 && cents <= MAX_SPEND_CENTS;
const isCategoryList = (value) =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_CATEGORIES && value.every((entry) => isBoundedText(entry, MAX_CATEGORY_LENGTH));
const invalid = (message) => gatewayError("token_invalid", message);

function assertSecret(secret) {
  const usable = (typeof secret === "string" || Buffer.isBuffer(secret)) && secret.length > 0;
  if (!usable) throw new Error("leash secret must be a non-empty string (set LEASH_SECRET)");
}

function readClock(now) {
  const ms = now();
  if (!Number.isFinite(ms)) throw new Error("clock must return epoch milliseconds");
  return ms;
}

const freezeClaims = (claims) =>
  Object.freeze({ ...claims, categories: Object.freeze([...claims.categories]), scopes: Object.freeze([...claims.scopes]) });

// ------------------------------------------------------------------------- request validation

function validateAgentId(value) {
  if (!isAgentId(value)) throw badRequest("agentId must be 1-80 characters of letters, digits, _ . : or -");
  return value;
}

function validatePayer(value) {
  if (!isBoundedText(value, MAX_PAYER_LENGTH)) throw badRequest(`payer must be a non-empty string of at most ${MAX_PAYER_LENGTH} characters, no control characters`);
  return value.trim();
}

// Numbers are read through String() so 12.345 is refused instead of silently rounded.
function validateMaxSpend(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const limit = formatCents(MAX_SPEND_CENTS);
  if (!isDecimalAmount(text)) throw badRequest(`maxSpend must be a decimal amount like "200.00" (at most 2 decimals, at most ${limit})`);
  const cents = toCents(text);
  if (!isSpendCents(cents)) throw badRequest(`maxSpend must be more than 0.00 and at most ${limit}`);
  return cents;
}

function validateCategories(value) {
  if (!isCategoryList(value)) {
    throw badRequest(`categories must be an array of 1-${MAX_CATEGORIES} category ids or names, each a non-empty string of at most ${MAX_CATEGORY_LENGTH} characters`);
  }
  return value.map((entry) => entry.trim());
}

function validateTtl(value) {
  const ttl = value ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) throw badRequest(`ttlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}`);
  return ttl;
}

// Omitted scopes mean every agent scope. Anything outside AGENT_SCOPES (checkouts:create first
// of all) is refused outright rather than dropped, so a caller never believes it got a scope.
function validateScopes(value) {
  if (value === undefined || value === null) return [...AGENT_SCOPES];
  if (!Array.isArray(value) || value.length === 0) throw badRequest("scopes must be a non-empty array of scope strings when given");
  const forbidden = value.filter((scope) => !isAgentScope(scope));
  if (forbidden.length > 0) {
    throw gatewayError("scope_forbidden", `scopes may only name agent scopes; refused: ${forbidden.map(String).join(", ")}`, { forbidden });
  }
  return AGENT_SCOPES.filter((scope) => value.includes(scope));
}

export function validateTokenRequest(body) {
  if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
  return {
    agentId: validateAgentId(body.agentId),
    payer: validatePayer(body.payer),
    maxSpendCents: validateMaxSpend(body.maxSpend),
    categories: validateCategories(body.categories),
    ttlSeconds: validateTtl(body.ttlSeconds),
    scopes: validateScopes(body.scopes),
  };
}

// --------------------------------------------------------------------------------- issuance

// issueToken re-runs validation so a hand-built object cannot smuggle in a scope or a limit.
function revalidate(validated) {
  if (!isPlainObject(validated) || !Number.isInteger(validated.maxSpendCents) || !Array.isArray(validated.scopes)) {
    throw badRequest("issueToken needs the output of validateTokenRequest");
  }
  const { maxSpendCents: cents, ...rest } = validated;
  return validateTokenRequest({ ...rest, maxSpend: cents > 0 ? formatCents(cents) : "0" });
}

export function issueToken(validated, { secret, now = () => Date.now() } = {}) {
  assertSecret(secret);
  const checked = revalidate(validated);
  const issuedMs = readClock(now);
  const claims = freezeClaims({
    v: TOKEN_VERSION,
    tokenId: `tok_${randomBytes(TOKEN_ID_BYTES).toString("hex")}`,
    agentId: checked.agentId,
    payer: checked.payer,
    maxSpend: formatCents(checked.maxSpendCents),
    categories: checked.categories,
    scopes: checked.scopes.filter(isIssuableScope),
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(issuedMs + checked.ttlSeconds * MS_PER_SECOND).toISOString(),
  });
  return Object.freeze({ token: `${TOKEN_PREFIX}${encodeSigned(claims, secret)}`, claims });
}

// ------------------------------------------------------------------------------ verification

const hasValidIdentity = ({ v, tokenId, agentId, payer }) =>
  v === TOKEN_VERSION && typeof tokenId === "string" && TOKEN_ID_PATTERN.test(tokenId) && isAgentId(agentId) && isBoundedText(payer, MAX_PAYER_LENGTH);

const hasValidLimits = ({ maxSpend, categories, scopes }) =>
  isDecimalAmount(maxSpend) && isSpendCents(toCents(maxSpend)) && isCategoryList(categories) && Array.isArray(scopes);

function hasValidWindow({ issuedAt, expiresAt }) {
  if (typeof issuedAt !== "string" || typeof expiresAt !== "string") return false;
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return false;
  return expiresMs > issuedMs && expiresMs - issuedMs <= MAX_TTL_SECONDS * MS_PER_SECOND;
}

// Only the known fields survive, and scopes are filtered to issuable ones even when signed.
function readClaims(payload) {
  if (!hasValidIdentity(payload) || !hasValidLimits(payload) || !hasValidWindow(payload)) {
    throw invalid("token claims are missing or malformed");
  }
  const { v, tokenId, agentId, payer, maxSpend, categories, scopes, issuedAt, expiresAt } = payload;
  return freezeClaims({ v, tokenId, agentId, payer, maxSpend, categories, scopes: scopes.filter(isIssuableScope), issuedAt, expiresAt });
}

// Order: shape -> signature -> canonical bytes -> claims -> expiry. The canonical re-encode
// rejects base64 variants (ignored characters, padding bits) that decode to the same claims.
export function verifyToken(token, { secret, now = () => Date.now() } = {}) {
  assertSecret(secret);
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > MAX_TOKEN_LENGTH) {
    throw invalid("token is missing or malformed");
  }
  const decoded = decodeSigned(token.slice(TOKEN_PREFIX.length), secret);
  if (!decoded.ok) throw invalid(decoded.reason === "bad_signature" ? "token signature does not verify" : "token is malformed");
  if (`${TOKEN_PREFIX}${encodeSigned(decoded.payload, secret)}` !== token) throw invalid("token is not in canonical form");
  const claims = readClaims(decoded.payload);
  if (readClock(now) >= Date.parse(claims.expiresAt)) {
    throw gatewayError("expired", `token expired at ${claims.expiresAt}`, { rule: "expired" });
  }
  return claims;
}

export const maxSpendCents = (claims) => toCents(claims?.maxSpend);
