// Route table for POST /v1/<path> and the requestId idempotency layer (reference §3.1):
// same requestId + same body -> the stored response; same requestId + different body -> 409.
// Failed requests (non-200) never consume their requestId.
import { apiError, conflict } from "../errors.mjs";
import { orderRoutes } from "./orders.mjs";
import { patternRoutes } from "./patterns.mjs";
import { productRoutes } from "./products.mjs";
import { referenceRoutes } from "./references.mjs";

export const ROUTES = Object.freeze({ ...patternRoutes, ...referenceRoutes, ...productRoutes, ...orderRoutes });

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const idempotencyKey = (path, requestId) => `${path}|${requestId}`;

function replay(route, path, body, state) {
  if (typeof body?.requestId !== "string") return null;
  const stored = state.idempotency[idempotencyKey(path, body.requestId)];
  if (!stored) return null;
  if (stored.fingerprint !== canonical(body)) {
    return conflict("requestId was already used with a different body; use a new requestId.");
  }
  if (route.replayConflict?.(state, stored.response)) {
    return conflict("The upload for this requestId was already used; use a new requestId.");
  }
  return stored.response;
}

function remember(state, path, body, response) {
  const key = idempotencyKey(path, body.requestId);
  const entry = { fingerprint: canonical(body), response };
  return { ...state, idempotency: { ...state.idempotency, [key]: entry } };
}

// Returns { status, body, state } where state is the next state (same object if unchanged).
export function dispatch(path, body, ctx) {
  const route = ROUTES[path];
  if (!route) return { ...apiError(404, "NOT_FOUND", `No API procedure at ${path}.`), state: ctx.state };
  const replayed = route.idempotent ? replay(route, path, body, ctx.state) : null;
  if (replayed) return { status: replayed.status, body: replayed.body, state: ctx.state };
  const result = route.handler(body, ctx);
  const next = result.state ?? ctx.state;
  if (!route.idempotent || result.status !== 200) return { status: result.status, body: result.body, state: next };
  const response = { status: result.status, body: result.body };
  return { ...response, state: remember(next, path, body, response) };
}
