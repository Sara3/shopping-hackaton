// HTTP plumbing for the Leash gateway (split out of server.mjs): loopback Host check, JSON-only bodies
// with a 64 KB cap, bearer parsing, the admin check, secret redaction and the response writer. Same
// hardening as web/server.mjs; nothing here knows about tokens, mandates or the ledger.
import { badRequest, gatewayError } from "./errors.mjs";
import { safeEqualHex, sha256Hex } from "./signing.mjs";

export const MAX_BODY_BYTES = 64 * 1024;
const BEARER = /^Bearer (\S+)$/;
const MASK_PREFIX_LENGTH = 6;
const MIN_REDACTABLE_LENGTH = 6;
const REDACTED = "[redacted]";
const LOOPBACK_NAMES = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
const SILENT = Object.freeze({ info() {}, warn() {}, error() {} });
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
});

export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// DNS-rebinding guard: a page on another origin that resolves to 127.0.0.1 still sends its own Host.
export const isAllowedHost = (hostHeader, port) =>
  typeof hostHeader === "string" && LOOPBACK_NAMES.some((name) => hostHeader.toLowerCase() === `${name}:${port}`);

export function parseTarget(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) throw badRequest("request target must be a path");
  return new URL(`http://gateway.local${rawUrl}`);
}

const isJsonContentType = (header) => String(header ?? "").split(";")[0].trim().toLowerCase() === "application/json";
const tooLarge = () => gatewayError("payload_too_large", `body over ${MAX_BODY_BYTES} bytes`);

export async function readJsonBody(req) {
  if (!isJsonContentType(req.headers["content-type"])) throw gatewayError("unsupported_media_type", "Content-Type must be application/json");
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("body is not valid JSON");
  }
}

export const bearerOf = (req) => BEARER.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;

// /mandates and /checkout take the token in the body or as Bearer; when both are sent they must agree.
export function tokenFrom(req, body) {
  const header = bearerOf(req);
  if (!isPlainObject(body) || !Object.hasOwn(body, "token")) return header;
  if (header !== null && header !== body.token) throw gatewayError("token_invalid", "the token in the body and in the Authorization header differ");
  return body.token;
}

// Digests first so the comparison is constant-time whatever the lengths.
export function requireAdmin(req, adminKey) {
  if (adminKey === null) return;
  const given = bearerOf(req);
  if (given !== null && safeEqualHex(sha256Hex(given), sha256Hex(adminKey))) return;
  throw gatewayError("token_invalid", "this route needs Authorization: Bearer <admin key>");
}

// Masked secrets keep a 6-character prefix (the Arcade key, like web/server.mjs); hidden ones vanish.
export function createRedactor(masked, hidden) {
  const pairs = [...masked.map((secret) => [secret, `${String(secret).slice(0, MASK_PREFIX_LENGTH)}…`]), ...hidden.map((secret) => [secret, REDACTED])]
    .filter(([secret]) => typeof secret === "string" && secret.length >= MIN_REDACTABLE_LENGTH)
    .flatMap(([secret, mask]) => [[secret, mask], [JSON.stringify(secret).slice(1, -1), mask]])
    .sort(([a], [b]) => b.length - a.length);
  return (text) => pairs.reduce((out, [secret, mask]) => out.split(secret).join(mask), text);
}

export const redactingLogger = (logger, redact) => {
  const target = logger ?? SILENT;
  const emit = (level) => (line) => target[level]?.(redact(String(line)));
  return Object.freeze({ info: emit("info"), warn: emit("warn"), error: emit("error") });
};

// The one HTML the gateway serves: the simulated-checkout page (receipt-page.mjs). Inline style and
// product images only; no script; its form may only post back to this origin.
const HTML_HEADERS = Object.freeze({
  ...SECURITY_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: http:; form-action 'self'; frame-ancestors 'none'",
});

// result: { status, json } by default; { status, html } for the checkout page; { status: 303, location } to redirect.
export function send(res, result, redact) {
  if (typeof result.location === "string") {
    res.writeHead(result.status, { ...SECURITY_HEADERS, Location: result.location, "Content-Length": 0 });
    res.end();
    return;
  }
  const isHtml = typeof result.html === "string";
  const body = redact(isHtml ? result.html : JSON.stringify(result.json ?? null));
  res.writeHead(result.status, { ...(isHtml ? HTML_HEADERS : SECURITY_HEADERS), "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
