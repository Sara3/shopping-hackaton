// Web-side Leash wiring. With LEASH_URL set, the agent gets a Leash client (a scoped, short-lived
// token; never the Arcade key) and every approval turn first asks the gateway for a signed mandate
// that binds what the HUMAN approved (the product on the card they saw, the quantity they typed, one
// pinned token). The agent then runs inside that mandate, so whatever checkout it attempts is held to
// it by the gateway, outside the model. AGENT_MODE-independent: this wraps agent.handleMessage and
// never edits agent/.
import { createLeashClient, fetchTokenStatus, issueAgentToken, normalizeLeashUrl, tokenIdOf } from "../gateway/client.mjs";
import { withLiveNames } from "../src/categories.mjs";
import { blockedOutcome } from "./blocked.mjs";
import { MAX_SESSIONS } from "./sessions.mjs";

export const DEFAULT_CATEGORIES = Object.freeze(["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"]);
// Exactly agent/scripted.mjs APPROVE_PATTERN (a test pins it; not imported, so a broken agent/ still lets
// the UI start): every turn in which the agent checks out ("okay", "Approved!") gets a mandate.
export const APPROVAL_PATTERN = /^(approve|yes|ok)/i;
export const AGENT_ID = "web-agent";
export const DEFAULT_PAYER = "demo-user";
export const DEFAULT_MAX_SPEND = "200.00";
export const TOKEN_TTL_SECONDS = 600;
export const SECONDS_PER_DAY = 86_400;
export const ENV_ALLOWANCE_PERIOD = "week";
export const RENEW_BEFORE_MS = 30_000;
// Tokens this process ever issued stay redacted after a rotation; the oldest drop off past this many.
export const MAX_REMEMBERED_TOKENS = 20;
const HUMAN_QUANTITY = /(?<!\d)(\d{1,3})(?!\d)/;
const DEFAULT_QUANTITY = 1;
const PRODUCT_CARD = "product";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export const isApproval = (text) => typeof text === "string" && APPROVAL_PATTERN.test(text.trim());

// The first 1-3 digit number in the approval text ("approve 2"), else 1. Never what the agent quoted.
export function humanQuantity(text) {
  const match = HUMAN_QUANTITY.exec(String(text ?? ""));
  return match ? Number(match[1]) : DEFAULT_QUANTITY;
}

const parseCategories = (csv) => {
  const names = String(csv ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names : DEFAULT_CATEGORIES;
};

export function resolveLeashConfig(env = process.env) {
  if (!env.LEASH_URL) return null;
  return Object.freeze({
    leashUrl: normalizeLeashUrl(env.LEASH_URL),
    agentId: AGENT_ID,
    payer: env.LEASH_PAYER || DEFAULT_PAYER,
    maxSpend: env.LEASH_MAX_SPEND || DEFAULT_MAX_SPEND,
    categories: parseCategories(env.LEASH_CATEGORIES),
    ttlSeconds: TOKEN_TTL_SECONDS,
    adminKey: env.LEASH_ADMIN_KEY || null,
  });
}

// A person's allowance (from Settings) as the config their agent's token is issued under: a new frozen
// object, the base config is untouched. The token lives as long as the allowance's days.
export const leashConfigForAllowance = (baseConfig, allowance) =>
  Object.freeze({
    ...baseConfig,
    maxSpend: allowance.maxSpend,
    categories: Object.freeze([...allowance.categories]),
    ttlSeconds: allowance.days * SECONDS_PER_DAY,
  });

// The allowance LEASH_MAX_SPEND pre-saves at boot (null when it is unset), so `npm run demo:leash` still
// starts leashed. Its token keeps the env path's TOKEN_TTL_SECONDS; `days` only says how long that is, in days.
export function allowanceFromEnv(env = process.env) {
  if (!env.LEASH_URL || !env.LEASH_MAX_SPEND) return null;
  return Object.freeze({
    maxSpend: env.LEASH_MAX_SPEND,
    period: ENV_ALLOWANCE_PERIOD,
    categories: parseCategories(env.LEASH_CATEGORIES),
    days: Math.max(1, Math.ceil(TOKEN_TTL_SECONDS / SECONDS_PER_DAY)),
  });
}

const infoOf = (issued) =>
  Object.freeze({
    tokenId: issued.tokenId,
    agentId: issued.agentId,
    payer: issued.payer,
    maxSpend: issued.maxSpend,
    categories: Object.freeze([...(issued.categories ?? [])]),
    scopes: Object.freeze([...(issued.scopes ?? [])]),
    expiresAt: issued.expiresAt,
  });

// What /api/config may show about the agent's token: never the token itself, never the payer.
const publicInfoOf = (config, info) =>
  Object.freeze({
    url: config.leashUrl,
    tokenId: info?.tokenId ?? null,
    agentId: info?.agentId ?? config.agentId,
    maxSpend: info?.maxSpend ?? config.maxSpend,
    categories: info?.categories ?? config.categories,
    scopes: info?.scopes ?? [],
    expiresAt: info?.expiresAt ?? null,
  });

// Holds the current token (in this closure only) and renews it 30 s before expiry. A frozen token is
// never renewed: the gateway's freeze has to outlive the token, so only a human re-authorizes, either by
// restarting the agent or through reset() (the UI's Reset button). The agent only ever sees `client`.
export function createLeashSession(config, { fetchImpl = fetch, now = () => Date.now(), logger = console } = {}) {
  let current = null;
  let pending = null;
  let issuedTokens = Object.freeze([]);
  const statusOf = (tokenId) => fetchTokenStatus({ leashUrl: config.leashUrl, tokenId, adminKey: config.adminKey, fetchImpl });

  // Every new token replaces `current` and joins the redaction list (both replaced, never mutated).
  async function issue() {
    // The token carries the live Arcade names too ("Silk scarf" → also "Scarves"), so the same
    // allowance passes the gateway's category check in mock and live mode.
    const issued = await issueAgentToken({ ...config, categories: withLiveNames(config.categories), fetchImpl });
    current = Object.freeze({ token: issued.token, info: infoOf(issued), renewBlocked: false });
    issuedTokens = Object.freeze([...issuedTokens, issued.token].slice(-MAX_REMEMBERED_TOKENS));
    return issued;
  }

  async function mayRenew() {
    try {
      const status = await statusOf(current.info.tokenId);
      if (status?.frozen === false) return true;
      logger.warn(`leash: token ${current.info.tokenId} is frozen (${status?.frozenReason ?? "unknown"}); not renewing it`);
      current = Object.freeze({ ...current, renewBlocked: true });
    } catch (error) {
      logger.warn(`leash: not renewing ${current.info.tokenId}: status check failed (${messageOf(error)})`);
    }
    return false;
  }

  async function renew() {
    if (current && !(await mayRenew())) return current.token;
    const issued = await issue();
    logger.info?.(`leash: token ${issued.tokenId} for ${issued.agentId}, maxSpend ${issued.maxSpend}, expires ${issued.expiresAt}`);
    return current.token;
  }

  const isFresh = () => current && now() < Date.parse(current.info.expiresAt) - RENEW_BEFORE_MS;

  async function getToken() {
    if (isFresh() || current?.renewBlocked) return current.token;
    pending ??= renew().finally(() => { pending = null; });
    return pending;
  }

  const tokenInfo = () => current?.info ?? null;
  const publicInfo = () => publicInfoOf(config, tokenInfo());

  // The human's Reset: a new token no matter how fresh or frozen the current one is. The frozen one stays
  // frozen at the gateway. A renew in flight settles first (its own caller sees any error), so the token
  // this issues is the one left in place.
  async function reset() {
    await pending?.catch(() => null);
    const previous = current?.info.tokenId ?? "none";
    const issued = await issue();
    logger.info?.(`leash: token rotated ${previous} → ${issued.tokenId}`);
    return publicInfo();
  }

  const secrets = () => issuedTokens;
  const client = createLeashClient({ leashUrl: config.leashUrl, getToken, fetchImpl, adminKey: config.adminKey });
  return Object.freeze({ client, getToken, tokenInfo, publicInfo, reset, secrets });
}

// ------------------------------------------------------------------------------ mandate wrapper

const mandateNote = ({ mandateId, mandate }) =>
  `leash: mandate ${mandateId} binds ${mandate?.quantity} × ${mandate?.productId} at $${mandate?.unitPrice}, max $${mandate?.maxTotal}`;

// The token is read once and pinned for the whole approval turn: the mandate is bound to it.
async function requestMandate(session, productId, quantity, logger) {
  try {
    const token = await session.getToken();
    const issued = await session.client.createMandate({ productId, quantity, token });
    return { mandateId: issued.mandateId, token, mandate: issued.mandate ?? null, note: mandateNote(issued) };
  } catch (error) {
    const code = error?.code ?? "leash_unavailable";
    const detail = error?.body?.message ?? messageOf(error);
    logger.warn?.(`leash: mandate denied ${code}: ${detail}`);
    return { mandateId: null, token: null, mandate: null, note: `leash: mandate denied ${code}: ${detail}` };
  }
}

// A new result object: the inner result (and its trace) is never mutated.
function withLeashTrace(result, session, { mandateId = null, token = null, notes = [] } = {}) {
  if (!isPlainObject(result)) return result;
  const trace = isPlainObject(result.trace) ? result.trace : {};
  const prior = Array.isArray(trace.notes) ? trace.notes : [];
  const leash = Object.freeze({ tokenId: tokenIdOf(token) ?? session.tokenInfo()?.tokenId ?? null, mandateId });
  return { ...result, trace: { ...trace, notes: [...prior, ...notes], leash } };
}

// The productId on the newest product card each chat session was shown. That card carries the Approve
// button, so it is what the human approves; session.products.at(-1) is not (a hijacked model can build a
// product it never shows). Map replaced, never mutated; the oldest session is evicted past the limit.
function createShownProducts(limit = MAX_SESSIONS) {
  let shown = new Map();
  const lastProductCard = (result) =>
    (Array.isArray(result?.cards) ? result.cards : []).findLast((card) => card?.type === PRODUCT_CARD && typeof card.productId === "string");
  return Object.freeze({
    remember(sessionId, result) {
      const card = lastProductCard(result);
      if (typeof sessionId !== "string" || !card) return;
      const next = new Map(shown);
      next.delete(sessionId);
      next.set(sessionId, card.productId);
      if (next.size > limit) next.delete(next.keys().next().value);
      shown = next;
    },
    productId: (sessionId) => shown.get(sessionId) ?? null,
  });
}

// An approval binds the carded product, and only while it is still in this session (not after a reset).
function approvedProductId(message, shown) {
  if (!isApproval(message?.text)) return null;
  const productId = shown.productId(message?.session?.id);
  const products = Array.isArray(message?.session?.products) ? message.session.products : [];
  return productId && products.some((product) => product?.productId === productId) ? productId : null;
}

// allowance ({ maxSpend, period, categories }): the allowance in force, quoted when the gateway blocks a
// checkout ("your allowance is up to $200.00 per week"). Without one the token's own limits are quoted.
export function wrapAgentWithMandates(agent, session, { logger = console, allowance = null } = {}) {
  if (typeof agent?.handleMessage !== "function") throw new TypeError("wrapAgentWithMandates needs an agent with handleMessage");
  const shown = createShownProducts();
  const withBlock = (result, mandate) => blockedOutcome(result, { mandate, allowance, tokenInfo: session.tokenInfo() });

  async function runTurn(message) {
    const productId = approvedProductId(message, shown);
    if (!productId) return withBlock(withLeashTrace(await agent.handleMessage(message), session), null);
    const { mandateId, token, mandate, note } = await requestMandate(session, productId, humanQuantity(message.text), logger);
    const run = () => agent.handleMessage(message);
    const result = mandateId ? await session.client.withMandate(mandateId, run, token) : await run();
    return withBlock(withLeashTrace(result, session, { mandateId, token, notes: [note] }), mandate);
  }

  async function handleMessage(message) {
    const result = await runTurn(message);
    shown.remember(message?.session?.id, result);
    return result;
  }

  return Object.freeze({ ...agent, handleMessage });
}
