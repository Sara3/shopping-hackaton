// Low-level HTTP helpers: body reading with a size cap, JSON/text/HTML replies, CORS, request log.

export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ORIGINS = Object.freeze(["http://localhost:8787", "http://127.0.0.1:8787"]);
// Missing, empty, or an HTTP library's default User-Agent is refused at the "edge" (plain-text 403).
const LIBRARY_DEFAULT_UA = /^(node|undici|python-urllib)\b/i;

export class BodyTooLargeError extends Error {}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError(`Body over ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

export function send(res, req, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": contentType, ...corsHeaders(req), ...extraHeaders });
  res.end(body);
}

export const sendJson = (res, req, status, body) => send(res, req, status, JSON.stringify(body), "application/json; charset=utf-8");
export const sendText = (res, req, status, text) => send(res, req, status, text, "text/plain; charset=utf-8");
export const sendHtml = (res, req, status, html) => send(res, req, status, html, "text/html; charset=utf-8");

export const isRejectedUserAgent = (userAgent) => !userAgent || !userAgent.trim() || LIBRARY_DEFAULT_UA.test(userAgent.trim());

export function bearerKey(authorization) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return match ? match[1] : null;
}

export function logRequests(req, res, logger) {
  if (!logger) return;
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger(`${req.method} ${req.url.split("?")[0]} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
}
