import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WEB_PORT, redactSecrets } from "./config.mjs";
import { SET_ALLOWANCE_MESSAGE, buildAllowanceState, configFor, createAllowanceStore } from "./allowance.mjs";
import { createSessionStore, newSession } from "./sessions.mjs";
import {
  HttpError, validateAgentResult, validateAllowanceBody, validateChatBody, validateResetBody, validateSessionId,
} from "./validate.mjs";

const INDEX_PATH = new URL("./index.html", import.meta.url);
const MAX_BODY_BYTES = 64 * 1024;
const HOST = "127.0.0.1";
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; img-src * data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

const LOOPBACK_NAMES = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

// DNS-rebinding guard: a page on another origin that resolves to 127.0.0.1 still sends its own Host.
const isAllowedHost = (hostHeader, port) =>
  typeof hostHeader === "string" && LOOPBACK_NAMES.some((name) => hostHeader.toLowerCase() === `${name}:${port}`);

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// secrets may be a function, read on every response, so tokens minted after start (a Reset) stay redacted.
const secretsOf = (secrets) => {
  const list = typeof secrets === "function" ? secrets() : secrets;
  if (!Array.isArray(list)) throw new TypeError("secrets must be an array or a function returning one");
  return list;
};

// Runs after the session is cleared; a failure is a 502, the session stays cleared.
async function runResetHook(hook, logger) {
  try {
    return (await hook()) ?? null;
  } catch (error) {
    logger.error(`reset hook failed: ${messageOf(error)}`);
    throw new HttpError(502, "leash_reset_failed", messageOf(error));
  }
}

const canResetToken = (state) => typeof state?.leash?.reset === "function";

// Reset after the session is cleared: the process-wide hook, then a fresh token for the saved allowance
// (same limits, new token; a frozen one stays frozen at the gateway). Null when there is nothing to rotate.
async function rotateTokens({ onReset, state, sessionId, logger }) {
  const fromHook = onReset ? await runResetHook(() => onReset({ sessionId }), logger) : null;
  const fromLeash = canResetToken(state) ? await runResetHook(() => state.leash.reset(), logger) : null;
  return fromLeash ?? fromHook;
}

async function readJsonBody(req) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", `body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "body is not valid JSON");
  }
}

function buildRoutes(deps) {
  const { store, allowanceStore, leashFactory, agent: directAgent, agentError, config, recorder, logger, onReset } = deps;

  const missingAgentMessage = () => agentError ?? (leashFactory ? SET_ALLOWANCE_MESSAGE : "agent is not loaded");

  const chat = async (req) => {
    const { sessionId, text, inspiration } = validateChatBody(await readJsonBody(req));
    if (config.arcadeMode === "live" && inspiration.trim() !== "") {
      throw new HttpError(400, "mock_only", "inspiration/poisoned path runs against the replica only");
    }
    const agent = allowanceStore.current()?.agent ?? directAgent;
    if (!agent) throw new HttpError(503, "agent_unavailable", missingAgentMessage());
    if (!store.tryLock(sessionId)) throw new HttpError(409, "session_busy", "this session is still handling a message");
    try {
      const run = () => agent.handleMessage({ session: store.getOrNew(sessionId), text, inspiration });
      const { value: result, rawCheckout } = recorder ? await recorder.record(run) : { value: await run(), rawCheckout: null };
      const checked = validateAgentResult(result);
      store.set(sessionId, checked.session);
      return { status: 200, json: { ...checked, rawCheckout } };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logger.error(`agent failed: ${messageOf(error)}`);
      throw new HttpError(502, "agent_failed", messageOf(error));
    } finally {
      store.unlock(sessionId);
    }
  };

  const state = async (req, url) => {
    const sessionId = validateSessionId(url.searchParams.get("sessionId"));
    return { status: 200, json: { session: store.getOrNew(sessionId) } };
  };

  const reset = async (req) => {
    const { sessionId } = validateResetBody(await readJsonBody(req));
    store.delete(sessionId);
    const state = allowanceStore.current();
    if (!onReset && !canResetToken(state)) return { status: 200, json: { ok: true, session: newSession(sessionId) } };
    const leash = await rotateTokens({ onReset, state, sessionId, logger });
    return { status: 200, json: { ok: true, session: newSession(sessionId), leash } };
  };

  const saveAllowance = async (req) => {
    const allowance = validateAllowanceBody(await readJsonBody(req));
    const next = await buildAllowanceState(allowance, leashFactory);
    allowanceStore.replace(next);
    return { status: 200, json: { ok: true, allowance, gateway: Boolean(leashFactory), leash: next.leash?.publicInfo?.() ?? null } };
  };

  const removeAllowance = async () => {
    allowanceStore.clear();
    return { status: 200, json: { ok: true } };
  };

  const index = async () => ({ status: 200, html: await readFile(INDEX_PATH, "utf8") });

  return new Map([
    ["GET /", index],
    ["GET /index.html", index],
    ["GET /api/config", async () => ({ status: 200, json: configFor(config, allowanceStore.current(), Boolean(leashFactory)) })],
    ["POST /api/allowance", saveAllowance],
    ["DELETE /api/allowance", removeAllowance],
    ["POST /api/chat", chat],
    ["GET /api/state", state],
    ["POST /api/reset", reset],
    ["GET /favicon.ico", async () => ({ status: 204 })],
  ]);
}

function send(res, result, secrets) {
  const headers = { ...SECURITY_HEADERS };
  if (result.html !== undefined) {
    res.writeHead(result.status, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    res.end(result.html);
    return;
  }
  if (result.json === undefined) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  const body = redactSecrets(JSON.stringify(result.json), secretsOf(secrets));
  res.writeHead(result.status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const errorResult = (error) => {
  if (error instanceof HttpError) return { status: error.status, json: { error: error.code, message: error.message } };
  return { status: 500, json: { error: "internal_error", message: "unexpected server error" } };
};

export async function createWebServer({
  port = WEB_PORT,
  agent = null,
  agentError = null,
  config = {},
  secrets = [],
  recorder = null,
  logger = console,
  onReset = null,
  leashFactory = null,
  initialState = null,
} = {}) {
  if (typeof secrets !== "function" && !Array.isArray(secrets)) throw new TypeError("secrets must be an array or a function returning one");
  if (onReset !== null && typeof onReset !== "function") throw new TypeError("onReset must be null or an async function");
  if (leashFactory !== null && typeof leashFactory !== "function") throw new TypeError("leashFactory must be null or an async function (allowance) => { agent, leash }");
  const allowanceStore = createAllowanceStore(initialState);
  const routes = buildRoutes({
    store: createSessionStore(), allowanceStore, leashFactory, agent, agentError, config, recorder, logger, onReset,
  });
  const knownPaths = new Set([...routes.keys()].map((key) => key.split(" ")[1]));

  let boundPort = null;
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = routes.get(`${req.method} ${url.pathname}`);
    let result;
    try {
      if (!isAllowedHost(req.headers.host, boundPort)) throw new HttpError(421, "bad_host", "Host header must be localhost, 127.0.0.1 or [::1] with this port");
      if (handler) result = await handler(req, url);
      else if (knownPaths.has(url.pathname)) throw new HttpError(405, "method_not_allowed", `${req.method} not allowed here`);
      else throw new HttpError(404, "not_found", `no route for ${url.pathname}`);
    } catch (error) {
      if (!(error instanceof HttpError)) logger.error(`unhandled: ${messageOf(error)}`);
      result = errorResult(error);
    }
    try {
      send(res, result, secrets);
    } catch (error) {
      // Fail closed: nothing is sent unredacted; the generic 500 carries no detail to redact.
      logger.error(`response withheld: ${messageOf(error)}`);
      result = errorResult(error);
      send(res, result, []);
    }
    logger.info(`${req.method} ${url.pathname} ${result.status} ${Date.now() - started}ms`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  boundPort = server.address().port;
  const close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return { server, port: boundPort, url: `http://localhost:${boundPort}`, close, allowanceState: allowanceStore.current };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { startFromEnv } = await import("./bootstrap.mjs");
  await startFromEnv(createWebServer);
}
