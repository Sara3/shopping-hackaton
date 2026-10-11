// HMAC-SHA256 signing and hashing on node:crypto, zero dependencies. Tokens and mandates are
// canonical JSON (sorted keys) so the same claims always sign to the same bytes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const HEX = /^[0-9a-f]+$/i;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
export const hmacHex = (secret, text) => createHmac("sha256", secret).update(text).digest("hex");

export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || a.length !== b.length) return false;
  if (!HEX.test(a) || !HEX.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const base64url = (data) => Buffer.from(data).toString("base64url");
const MALFORMED = Object.freeze({ ok: false, reason: "malformed" });
const BAD_SIGNATURE = Object.freeze({ ok: false, reason: "bad_signature" });

export function encodeSigned(payload, secret) {
  const body = canonicalJson(payload);
  const mac = createHmac("sha256", secret).update(body).digest();
  return `${base64url(body)}.${base64url(mac)}`;
}

// Verifies the signature BEFORE parsing the payload; returns a frozen result, never throws.
export function decodeSigned(text, secret) {
  if (typeof text !== "string") return MALFORMED;
  const parts = text.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return MALFORMED;
  const body = Buffer.from(parts[0], "base64url").toString("utf8");
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(parts[1], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return BAD_SIGNATURE;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return MALFORMED;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return MALFORMED;
  return { ok: true, payload };
}
