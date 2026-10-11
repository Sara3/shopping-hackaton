// The Doraemon agent, seen from the web: the same handleMessage({ session, text, inspiration }) contract as
// naive-agent.mjs, answered by the Python Doraemon service (doraemon/agent/service.py) over loopback HTTP.
//
// Doraemon only ever runs behind Leash. This process stays the driver: it hands Doraemon the session's
// current Leash token per turn (never the Arcade key, never the gateway's admin key), and on an approval
// turn the mandate the human's Approve just had the gateway sign (web/leash.mjs wrapAgentWithMandates).
// Doraemon confirms its own card only for an explicit "approve [n]" that arrives with that mandate, then
// checks out against exactly it; the gateway holds the checkout to the mandate either way.
//
// Env: DORAEMON_URL (http://127.0.0.1:8790), DORAEMON_SERVICE_KEY (shared with the service; npm run demo
// generates one per run).
import { LEASH_KEY_PREFIX } from "../web/allowance.mjs";

export const DEFAULT_DORAEMON_URL = "http://127.0.0.1:8790";
// A turn can run several model rounds plus pattern and product jobs.
export const TURN_TIMEOUT_MS = 240_000;
// Doraemon holds the token for the whole turn and cannot renew it (it never gets the admin key), so the
// token it is handed must outlive the longest turn: renewed first when it has less than this left.
export const TOKEN_MIN_REMAINING_MS = TURN_TIMEOUT_MS + 30_000;
const RESET_TIMEOUT_MS = 5_000;

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export class DoraemonError extends Error {
  constructor(status, body, path) {
    const code = typeof body?.error === "string" ? body.error : `http_${status}`;
    super(`Doraemon ${path} → HTTP ${status}: ${code}${body?.message ? ` ${body.message}` : ""}`);
    this.name = "DoraemonError";
    this.status = status;
    this.code = code;
  }
}

async function post(fetchImpl, url, serviceKey, path, body, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Doraemon service at ${url} did not answer ${path}: ${messageOf(error)}`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { message: text.slice(0, 200) };
  }
  if (!response.ok) throw new DoraemonError(response.status, parsed, path);
  return parsed;
}

const isFresh = (session) => !Array.isArray(session?.turns) || session.turns.length === 0;

// leash: the Leash client from web/leash.mjs createLeashSession (currentToken, currentMandateId, leashUrl).
// arcadeState: () => { mode, liveCheckoutEnabled }, the Arcade the gateway is on right now (web/arcade-control.mjs).
export function createDoraemonAgent({
  leash, url = DEFAULT_DORAEMON_URL, serviceKey, model = null, userId = "web-user", fetchImpl = fetch, arcadeState = null,
} = {}) {
  if (typeof leash?.currentToken !== "function" || typeof leash?.currentMandateId !== "function") {
    throw new TypeError("Doraemon runs only behind Leash: createDoraemonAgent needs the Leash client");
  }
  if (typeof serviceKey !== "string" || serviceKey === "") throw new TypeError("createDoraemonAgent needs DORAEMON_SERVICE_KEY");
  const root = String(url).replace(/\/+$/, "");

  async function handleMessage({ session, text, inspiration = "" }) {
    if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
    const sessionId = session?.id;
    const out = await post(fetchImpl, root, serviceKey, "/turn", {
      sessionId,
      text: text.trim(),
      inspiration: typeof inspiration === "string" ? inspiration : "",
      // A session the web just created (first message, or after Reset) starts a new conversation.
      fresh: isFresh(session),
      leash: { url: leash.leashUrl, token: await leash.currentToken(TOKEN_MIN_REMAINING_MS) },
      mandateId: leash.currentMandateId(),
      // Set when the human approved but the gateway refused to sign the mandate (e.g. over the allowance).
      mandateRefusal: leash.currentMandateRefusal?.() ?? null,
      // Which Arcade this turn runs against, and whether a checkout may be real (live checkout switched on).
      ...(arcadeState ? { arcade: { mode: arcadeState().mode, liveCheckout: arcadeState().liveCheckoutEnabled === true } } : {}),
      userId,
    }, TURN_TIMEOUT_MS);
    const trace = {
      mode: "doraemon", model, keyPrefix: LEASH_KEY_PREFIX,
      calls: Array.isArray(out.calls) ? out.calls : [], notes: Array.isArray(out.notes) ? out.notes : [],
      proposal: out.proposal ?? null, traceId: out.traceId ?? null,
    };
    return { session: { ...out.session, id: sessionId }, reply: String(out.reply ?? ""), cards: Array.isArray(out.cards) ? out.cards : [], trace };
  }

  // Best effort: a new web session already starts a fresh conversation (see `fresh`).
  async function reset(sessionId) {
    await post(fetchImpl, root, serviceKey, "/reset", { sessionId }, RESET_TIMEOUT_MS).catch(() => null);
  }

  return Object.freeze({ mode: "doraemon", handleMessage, reset });
}
