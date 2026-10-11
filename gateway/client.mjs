// Agent-side Leash client. The agent holds a short-lived Leash token, never the Arcade key: this is
// src/arcade.mjs createClient (same User-Agent, retries and job polling) pointed at <leash>/arcade,
// with a fetch wrapper that puts the CURRENT token in the Authorization header. Checkout is not an
// Arcade procedure here: createCheckout goes to the gateway's POST /checkout with the signed mandate
// the human approved, and only the gateway's { checkoutUrl } comes back.
import { AsyncLocalStorage } from "node:async_hooks";
import { ArcadeError, USER_AGENT, createClient } from "../src/arcade.mjs";
import { isLocalUrl } from "../src/endpoint.mjs";
import { CODES } from "./errors.mjs";
import { TOKEN_PREFIX } from "./tokens.mjs";

// createClient refuses an empty key; this placeholder is overwritten on every request by the wrapper.
const PLACEHOLDER_KEY = "leash";
const TOKEN_ID_PATTERN = /^tok_[0-9a-f]{16}$/;
const SAFE_PROTOCOLS = Object.freeze(["http:", "https:"]);
// The Arcade procedures an agent may reach through the proxy (getOrder is not an agent scope).
const PROXIED_METHODS = Object.freeze([
  "call", "waitForJob", "listModels", "listCategories", "getCategory", "createPattern", "getPattern",
  "createProduct", "getProduct", "generatePattern", "buildProduct",
]);

const isGatewayBody = (body) => typeof body?.error === "string" && Object.hasOwn(CODES, body.error);

export class LeashError extends Error {
  constructor(status, body, path) {
    const code = isGatewayBody(body) ? body.error : `http_${status}`;
    const detail = typeof body === "object" && body?.message ? body.message : typeof body === "string" ? body : "";
    super(`Leash ${path} → HTTP ${status}: ${code}${detail ? ` ${detail}` : ""}`);
    this.name = "LeashError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.path = path;
  }
}

// Plain http only to a loopback gateway; anything else must be https. No credentials, query or hash.
export function normalizeLeashUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error(`LEASH_URL must be a URL like http://127.0.0.1:8080, got ${JSON.stringify(value)}`);
  }
  if (!SAFE_PROTOCOLS.includes(url.protocol)) throw new Error(`LEASH_URL must be http(s), got ${url.protocol}`);
  if (url.protocol === "http:" && !isLocalUrl(url.href)) throw new Error("LEASH_URL over plain http must be loopback (localhost, 127.0.0.1, [::1]); use https otherwise");
  if (url.username || url.password || url.search || url.hash) throw new Error("LEASH_URL must not carry credentials, a query or a fragment");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

const parseBody = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// One gateway round trip, no retries: /checkout and /mandates must never be replayed blindly.
async function leashRequest(fetchImpl, leashUrl, path, { method = "POST", body, bearer = null } = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    ...(body !== undefined && { "Content-Type": "application/json" }),
    ...(bearer && { Authorization: `Bearer ${bearer}` }),
  };
  const response = await fetchImpl(`${leashUrl}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const parsed = await parseBody(response);
  if (!response.ok) throw new LeashError(response.status, parsed, path);
  return parsed;
}

export async function issueAgentToken({ leashUrl, agentId, payer, maxSpend, categories, ttlSeconds, adminKey = null, fetchImpl = fetch }) {
  const body = { agentId, payer, maxSpend, categories, ttlSeconds };
  const issued = await leashRequest(fetchImpl, normalizeLeashUrl(leashUrl), "/tokens", { body, bearer: adminKey });
  if (typeof issued?.token !== "string" || !issued.token.startsWith(TOKEN_PREFIX) || typeof issued.tokenId !== "string") {
    throw new Error("Leash /tokens answered with no token");
  }
  return issued;
}

// Reads tokenId from the token's (signed) payload without verifying it: only used to name the status URL.
export function tokenIdOf(token) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.slice(TOKEN_PREFIX.length).split(".")[0], "base64url").toString("utf8"));
    return TOKEN_ID_PATTERN.test(payload?.tokenId) ? payload.tokenId : null;
  } catch {
    return null;
  }
}

export async function fetchTokenStatus({ leashUrl, tokenId, adminKey = null, fetchImpl = fetch }) {
  if (!TOKEN_ID_PATTERN.test(String(tokenId))) throw new Error(`not a Leash tokenId: ${JSON.stringify(tokenId)}`);
  return leashRequest(fetchImpl, normalizeLeashUrl(leashUrl), `/tokens/${tokenId}`, { method: "GET", bearer: adminKey });
}

// Leash off on a live stack: the web hands the gateway a receipt for what its key-holding agent was about
// to buy (POST /simulated-checkout, admin only) and gets { checkoutId, checkoutUrl } back; Arcade is never called.
export async function createSimulatedCheckout({ leashUrl, receipt, adminKey = null, fetchImpl = fetch }) {
  return leashRequest(fetchImpl, normalizeLeashUrl(leashUrl), "/simulated-checkout", { body: receipt, bearer: adminKey });
}

// A gateway denial on /arcade/* (token_frozen, scope_denied, ...) arrives as an ArcadeError from the
// shared client; it is re-thrown as a LeashError so the trace names the gateway's code. Arcade's own
// errors (passed through by the gateway) stay ArcadeErrors.
const translate = (error) =>
  error instanceof ArcadeError && isGatewayBody(error.body) ? new LeashError(error.status, error.body, `/arcade${error.path}`) : error;

const guarded = (fn) =>
  async function guardedCall(...args) {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      throw translate(error);
    }
  };

function proxiedClient(leashUrl, getToken, fetchImpl) {
  const withToken = async (url, init = {}) =>
    fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await getToken()}` } });
  const base = createClient({ apiKey: PLACEHOLDER_KEY, baseUrl: `${leashUrl}/arcade`, fetchImpl: withToken });
  return { baseUrl: base.baseUrl, ...Object.fromEntries(PROXIED_METHODS.map((name) => [name, guarded(base[name])])) };
}

// A mandate is bound to the token it was minted with, so the approval turn pins that token: /checkout
// inside withMandate(mandateId, fn, token) sends it even if getToken() renewed in between (a renewed
// token would not match the mandate and the gateway would freeze it).
export function createLeashClient({ leashUrl, getToken, fetchImpl = fetch, adminKey = null }) {
  if (typeof getToken !== "function") throw new TypeError("createLeashClient needs getToken()");
  const root = normalizeLeashUrl(leashUrl);
  const mandateScope = new AsyncLocalStorage();
  const currentMandateId = () => mandateScope.getStore()?.mandateId ?? null;
  // { code, message, rule } when the gateway refused to sign this approval turn's mandate, else null.
  const currentMandateRefusal = () => mandateScope.getStore()?.refusal ?? null;
  // A token pinned with a mandate is never swapped; otherwise the session's, valid for at least minRemainingMs.
  const scopedToken = async (minRemainingMs) => mandateScope.getStore()?.token ?? getToken(minRemainingMs);

  return Object.freeze({
    ...proxiedClient(root, getToken, fetchImpl),
    leashUrl: root,
    currentMandateId,
    currentMandateRefusal,
    // The token this turn must present: the one pinned with the mandate inside withMandate, else
    // the session's current one. An agent that runs out of process (the Doraemon service) is handed it.
    currentToken: scopedToken,
    withMandate: (mandateId, fn, token = null, refusal = null) => mandateScope.run(Object.freeze({ mandateId, token, refusal }), fn),
    createMandate: async ({ productId, quantity, token = null }) =>
      leashRequest(fetchImpl, root, "/mandates", { body: { token: token ?? (await getToken()), productId, quantity } }),
    createCheckout: async ({ lines }) =>
      leashRequest(fetchImpl, root, "/checkout", { body: { token: await scopedToken(undefined), mandateId: currentMandateId(), lines } }),
    tokenStatus: async () => fetchTokenStatus({ leashUrl: root, tokenId: tokenIdOf(await getToken()), adminKey, fetchImpl }),
  });
}
