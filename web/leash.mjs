// Web-side Leash wiring. With LEASH_URL set, the agent gets a Leash client (a scoped, short-lived
// token; never the Arcade key) and every approval turn first asks the gateway for a signed mandate
// that binds what the HUMAN approved (the product on the card they saw, the quantity they typed, one
// pinned token). The agent then runs inside that mandate, so whatever checkout it attempts is held to
// it by the gateway, outside the model. AGENT_MODE-independent: this wraps agent.handleMessage and
// never edits agent/.
import { createLeashClient, fetchTokenStatus, issueAgentToken, normalizeLeashUrl, tokenIdOf } from "../gateway/client.mjs";
import { MAX_SESSIONS } from "./sessions.mjs";

export const DEFAULT_CATEGORIES = Object.freeze(["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"]);
// Exactly agent/scripted.mjs APPROVE_PATTERN (a test pins it; not imported, so a broken agent/ still lets
// the UI start): every turn in which the agent checks out ("okay", "Approved!") gets a mandate.
export const APPROVAL_PATTERN = /^(approve|yes|ok)/i;
export const AGENT_ID = "web-agent";
export const DEFAULT_PAYER = "demo-user";
export const DEFAULT_MAX_SPEND = "200.00";
export const TOKEN_TTL_SECONDS = 600;
export const RENEW_BEFORE_MS = 30_000;
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
// never renewed: the gateway's freeze has to outlive the token, so a human must restart the agent.
export function createLeashSession(config, { fetchImpl = fetch, now = () => Date.now(), logger = console } = {}) {
  let current = null;
  let pending = null;
  const statusOf = (tokenId) => fetchTokenStatus({ leashUrl: config.leashUrl, tokenId, adminKey: config.adminKey, fetchImpl });

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
    const issued = await issueAgentToken({ ...config, fetchImpl });
    current = Object.freeze({ token: issued.token, info: infoOf(issued), renewBlocked: false });
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
  const client = createLeashClient({ leashUrl: config.leashUrl, getToken, fetchImpl, adminKey: config.adminKey });
  return Object.freeze({ client, getToken, tokenInfo, publicInfo });
}

// ------------------------------------------------------------------------------ mandate wrapper

const mandateNote = ({ mandateId, mandate }) =>
  `leash: mandate ${mandateId} binds ${mandate?.quantity} × ${mandate?.productId} at $${mandate?.unitPrice}, max $${mandate?.maxTotal}`;

// The token is read once and pinned for the whole approval turn: the mandate is bound to it.
async function requestMandate(session, productId, quantity, logger) {
  try {
    const token = await session.getToken();
    const issued = await session.client.createMandate({ productId, quantity, token });
    return { mandateId: issued.mandateId, token, note: mandateNote(issued) };
  } catch (error) {
    const code = error?.code ?? "leash_unavailable";
    const detail = error?.body?.message ?? messageOf(error);
    logger.warn?.(`leash: mandate denied ${code}: ${detail}`);
    return { mandateId: null, token: null, note: `leash: mandate denied ${code}: ${detail}` };
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

export function wrapAgentWithMandates(agent, session, { logger = console } = {}) {
  if (typeof agent?.handleMessage !== "function") throw new TypeError("wrapAgentWithMandates needs an agent with handleMessage");
  const shown = createShownProducts();

  async function runTurn(message) {
    const productId = approvedProductId(message, shown);
    if (!productId) return withLeashTrace(await agent.handleMessage(message), session);
    const { mandateId, token, note } = await requestMandate(session, productId, humanQuantity(message.text), logger);
    const run = () => agent.handleMessage(message);
    const result = mandateId ? await session.client.withMandate(mandateId, run, token) : await run();
    return withLeashTrace(result, session, { mandateId, token, notes: [note] });
  }

  async function handleMessage(message) {
    const result = await runTurn(message);
    shown.remember(message?.session?.id, result);
    return result;
  }

  return Object.freeze({ ...agent, handleMessage });
}
