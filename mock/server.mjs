// HTTP server of the Arcade replica. API under /v1 (POST + JSON, same paths as the real API),
// plus the "short-lived URL" hosts: /img/<id>.svg, /uploads/<uploadId>, /checkout/<id>[/pay],
// and the demo's untrusted "inspiration" listings: /inspo/<slug>[/hero.svg].
import { createServer } from "node:http";
import { apiError, unauthorized } from "./errors.mjs";
import {
  BodyTooLargeError, MAX_JSON_BYTES, MAX_UPLOAD_BYTES, bearerKey, isRejectedUserAgent, logRequests,
  readBody, send, sendHtml, sendJson, sendText, corsHeaders,
} from "./http.mjs";
import { renderPatternSvg } from "./images.mjs";
import { inspoPage, renderInspoPage } from "./inspo.mjs";
import { renderCheckoutPage, renderNotFoundPage } from "./pages.mjs";
import { dispatch } from "./routes/index.mjs";
import { placeOrder } from "./routes/orders.mjs";
import { putUpload } from "./routes/references.mjs";
import { createStore } from "./state.mjs";

export const DEFAULT_PORT = 8788;
export const DEFAULT_LATENCY_MS = 2000;
export const DEFAULT_HOST = "127.0.0.1";
const API_PREFIX = "/v1";

function parseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

async function handleApi(req, res, ctx, path) {
  if (isRejectedUserAgent(req.headers["user-agent"])) return sendText(res, req, 403, "Forbidden: set a real User-Agent header");
  if (req.method !== "POST") return sendJson(res, req, 405, apiError(405, "METHOD_NOT_ALLOWED", "Every API call is POST + JSON.").body);
  if (!bearerKey(req.headers.authorization)) return sendJson(res, req, 401, unauthorized().body);
  const parsed = parseJson(await readBody(req, MAX_JSON_BYTES));
  if (!parsed.ok) return sendText(res, req, 400, "Malformed JSON body");
  const result = dispatch(path, parsed.value, { state: ctx.store.get(), origin: ctx.origin(), latencyMs: ctx.latencyMs, now: ctx.now });
  ctx.store.commit(result.state);
  return sendJson(res, req, result.status, result.body);
}

function handleImage(req, res, ctx, id) {
  const state = ctx.store.get();
  const pattern = state.patterns[id];
  const prompt = pattern ? pattern.renderPrompt : state.references[id] ? "uploaded reference image" : null;
  if (prompt === null) return sendText(res, req, 404, "Image not found");
  return send(res, req, 200, renderPatternSvg(prompt), "image/svg+xml; charset=utf-8", { "Cache-Control": "no-store" });
}

async function handleUpload(req, res, ctx, uploadId) {
  const bytes = await readBody(req, MAX_UPLOAD_BYTES);
  const result = putUpload(ctx.store.get(), {
    uploadId, contentType: req.headers["content-type"], byteCount: bytes.length, now: ctx.now(),
  });
  if (result.state) ctx.store.commit(result.state);
  return result.status === 200 ? sendText(res, req, 200, "") : sendText(res, req, result.status, result.body.message);
}

function handleCheckoutPage(req, res, ctx, checkoutId) {
  const state = ctx.store.get();
  const checkout = state.checkouts[checkoutId];
  if (!checkout) return sendHtml(res, req, 404, renderNotFoundPage());
  return sendHtml(res, req, 200, renderCheckoutPage(checkout, checkout.orderId ? state.orders[checkout.orderId] : null));
}

function handlePay(req, res, ctx, checkoutId) {
  const placed = placeOrder(ctx.store.get(), checkoutId, ctx.now());
  if (!placed.order) return sendHtml(res, req, 404, renderNotFoundPage());
  ctx.store.commit(placed.state);
  return send(res, req, 303, "", "text/plain; charset=utf-8", { Location: `/checkout/${encodeURIComponent(checkoutId)}` });
}

const INSPO_NOT_FOUND = "Inspiration page not found";

function handleInspoPage(req, res, ctx, slug) {
  const page = inspoPage(slug);
  if (!page) return sendText(res, req, 404, INSPO_NOT_FOUND);
  const reveal = new URL(req.url, "http://mock.local").searchParams.get("reveal") === "1";
  return sendHtml(res, req, 200, renderInspoPage(page, { reveal }));
}

function handleInspoHero(req, res, ctx, slug) {
  const page = inspoPage(slug);
  if (!page) return sendText(res, req, 404, INSPO_NOT_FOUND);
  return send(res, req, 200, renderPatternSvg(page.heroPrompt), "image/svg+xml; charset=utf-8", { "Cache-Control": "no-store" });
}

const ROUTES = [
  { method: "GET", pattern: /^\/img\/([^/]+)\.svg$/, handler: handleImage },
  { method: "PUT", pattern: /^\/uploads\/([^/]+)$/, handler: handleUpload },
  { method: "GET", pattern: /^\/checkout\/(\d+)$/, handler: handleCheckoutPage },
  { method: "POST", pattern: /^\/checkout\/(\d+)\/pay$/, handler: handlePay },
  { method: "GET", pattern: /^\/inspo\/([a-z0-9-]+)$/, handler: handleInspoPage },
  { method: "GET", pattern: /^\/inspo\/([a-z0-9-]+)\/hero\.svg$/, handler: handleInspoHero },
];

const safeDecode = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

async function route(req, res, ctx) {
  const { pathname } = new URL(req.url, "http://mock.local");
  if (req.method === "OPTIONS") return send(res, req, 204, "", "text/plain", corsHeaders(req));
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) return handleApi(req, res, ctx, pathname.slice(API_PREFIX.length));
  if (req.method === "GET" && pathname === "/") return sendJson(res, req, 200, { name: "Arcade replica (mock)", apiBase: `${ctx.origin()}${API_PREFIX}` });
  const match = ROUTES.map((r) => ({ r, m: req.method === r.method && r.pattern.exec(pathname) })).find(({ m }) => m);
  if (!match) return sendText(res, req, 404, "Not found");
  const id = safeDecode(match.m[1]);
  if (id === null) return sendText(res, req, 400, "Malformed path");
  return match.r.handler(req, res, ctx, id);
}

async function safeRoute(req, res, ctx) {
  try {
    await route(req, res, ctx);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return sendText(res, req, 413, "Payload too large");
    ctx.logger?.(`[mock] ${req.method} ${req.url} failed: ${error.stack ?? error.message}`);
    if (!res.headersSent) sendJson(res, req, 500, apiError(500, "INTERNAL_SERVER_ERROR", "Mock server error.").body);
  }
}

export async function createMockServer({
  port = DEFAULT_PORT, host = DEFAULT_HOST, latencyMs = DEFAULT_LATENCY_MS, stateFile = null,
  logger = console.log, now = () => Date.now(),
} = {}) {
  const store = createStore({ stateFile, logger: logger ?? (() => {}) });
  let url = null;
  const ctx = { store, latencyMs, now, logger, origin: () => url };
  const server = createServer((req, res) => {
    logRequests(req, res, logger);
    safeRoute(req, res, ctx);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  url = `http://localhost:${server.address().port}`;
  const close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return { server, url, apiUrl: `${url}${API_PREFIX}`, close, getState: store.get };
}
