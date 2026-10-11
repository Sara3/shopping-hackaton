// sha256 of a product image's exact bytes. A mandate pins this hash, so a design swapped behind the
// same productId (new bytes, or an image URL pointing at another design) fails the checkout gate.
// Image hosts are third parties: the request carries our User-Agent and never the Arcade key.
import { USER_AGENT } from "../src/arcade.mjs";
import { gatewayError } from "./errors.mjs";
import { sha256Hex } from "./signing.mjs";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 10_000;
const FETCHABLE_PROTOCOLS = Object.freeze(["http:", "https:"]);

const unreadable = (where, why) => gatewayError("image_unreadable", `product image ${where} is unreadable: ${why}`);

function parseImageUrl(url) {
  if (typeof url !== "string" || url === "") throw unreadable("(none)", "the product has no image URL");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw unreadable("(invalid)", "the image URL does not parse");
  }
  if (!FETCHABLE_PROTOCOLS.includes(parsed.protocol)) throw unreadable(parsed.protocol, "only http(s) image URLs are fetched");
  return parsed;
}

// Origin + path only: signed image URLs carry credentials in the query string.
const describe = (parsed) => `${parsed.origin}${parsed.pathname}`;

const failureReason = (error, timeoutMs) =>
  error?.name === "TimeoutError" || error?.name === "AbortError" ? `no complete response within ${timeoutMs} ms` : error?.message ?? String(error);

const discardBody = (response) => {
  response?.body?.cancel().catch(() => {});
};

async function readImageBytes(response, where, timeoutMs) {
  if (!response?.ok) {
    discardBody(response);
    throw unreadable(where, `HTTP ${response?.status ?? "(no response)"}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    discardBody(response);
    throw unreadable(where, `declared ${declared} bytes, over the ${MAX_IMAGE_BYTES}-byte cap`);
  }
  let bytes;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw unreadable(where, failureReason(error, timeoutMs));
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw unreadable(where, `${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte cap`);
  return Buffer.from(bytes);
}

export async function hashImage(url, fetchImpl = fetch, { timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  const parsed = parseImageUrl(url);
  const where = describe(parsed);
  let response;
  try {
    response = await fetchImpl(parsed.href, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw unreadable(where, failureReason(error, timeoutMs));
  }
  return sha256Hex(await readImageBytes(response, where, timeoutMs));
}
