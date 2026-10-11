// Signed purchase mandates: exactly what the human approved, pinned at approval time. The gateway
// re-reads products/get itself (never the agent's numbers), checks the token's categories and spend
// cap, hashes the product image bytes and signs the result. POST /checkout later holds Arcade to it.
import { randomBytes } from "node:crypto";
import { ArcadeError } from "../src/arcade.mjs";
import { badRequest, gatewayError, isGatewayError } from "./errors.mjs";
import { hashImage } from "./image-hash.mjs";
import { formatCents, toCents } from "./money.mjs";
import { canonicalJson, hmacHex, safeEqualHex } from "./signing.mjs";
import { maxSpendCents } from "./tokens.mjs";

export const DEFAULT_MANDATE_TTL_SECONDS = 600;
export const MAX_QUANTITY = 1000;
export const CATEGORY_CACHE_TTL_MS = 60_000;
export const MAX_PRODUCT_ID_CHARS = 200;
const MANDATE_VERSION = 1;
const MANDATE_ID_BYTES = 8;
const MS_PER_SECOND = 1000;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isValidProductId = (value) =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_PRODUCT_ID_CHARS;
export const isValidQuantity = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_QUANTITY;

export function validateMandateRequest(body) {
  if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
  if (!isValidProductId(body.productId)) throw badRequest(`productId must be a non-empty string of at most ${MAX_PRODUCT_ID_CHARS} characters`);
  if (!isValidQuantity(body.quantity)) throw badRequest(`quantity must be an integer from 1 to ${MAX_QUANTITY}`);
  return { productId: body.productId, quantity: body.quantity };
}

// ------------------------------------------------------------------------------ Arcade reads

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// Wraps any non-gateway failure of an Arcade call as 502 arcade_error (never echoes the key: the
// ArcadeError message is "Arcade <path> → HTTP <status>: <Arcade's message>").
export const arcadeFailure = (procedure, error) =>
  isGatewayError(error) ? error : gatewayError("arcade_error", `Arcade ${procedure} failed: ${messageOf(error)}`);

export async function readProduct(arcade, productId, quantity) {
  try {
    return await arcade.getProduct(productId, quantity);
  } catch (error) {
    if (error instanceof ArcadeError && error.status === 404) throw gatewayError("not_found", `product ${productId} not found on Arcade`);
    throw arcadeFailure("/products/get", error);
  }
}

// The guaranteed price Arcade quotes for this quantity, in integer cents. Null means not priced yet.
export function unitPriceOf(product) {
  const amount = product?.unitPrice?.amount;
  if (amount === null || amount === undefined) {
    throw gatewayError("price_pending", "Arcade has not priced this product yet (unitPrice is null); try again shortly");
  }
  try {
    return { unitCents: toCents(amount), currency: product.unitPrice.currency ?? null };
  } catch {
    throw gatewayError("arcade_error", `Arcade returned an unreadable unitPrice ${JSON.stringify(amount)}`);
  }
}

export const imageUrlOf = (product) => product?.images?.[0]?.url ?? product?.imageUrl;

export const priceDelta = (message) => gatewayError("price_exceeded", message, { rule: "price_delta" });

// ------------------------------------------------------------------------------ signing

export const signMandate = (mandate, secret) => hmacHex(secret, canonicalJson(mandate));

export function verifyMandateSignature(mandate, signature, secret) {
  if (!isPlainObject(mandate) || typeof secret !== "string" || secret === "") return false;
  return safeEqualHex(signMandate(mandate, secret), signature);
}

function assertMandateConfig({ secret, ttlSeconds, categoryResolver }) {
  if (typeof secret !== "string" || secret === "") throw new TypeError("createMandate needs a non-empty secret");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new TypeError(`ttlSeconds must be a positive integer, got ${ttlSeconds}`);
  if (typeof categoryResolver?.isAllowed !== "function") throw new TypeError("createMandate needs a categoryResolver");
}

// expiresAt = min(now + ttl, token expiresAt): a mandate never outlives the token that asked for it.
function mandateWindow(claims, nowMs, ttlSeconds) {
  const tokenExpiresMs = Date.parse(claims.expiresAt);
  if (!Number.isFinite(tokenExpiresMs)) throw gatewayError("token_invalid", "token claims carry no valid expiresAt");
  const expiresMs = Math.min(nowMs + ttlSeconds * MS_PER_SECOND, tokenExpiresMs);
  if (expiresMs <= nowMs) throw gatewayError("expired", `token expired at ${claims.expiresAt}`, { rule: "expired" });
  return { issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiresMs).toISOString() };
}

const buildMandate = ({ claims, product, quantity, unitCents, currency, imageSha256, window }) =>
  Object.freeze({
    v: MANDATE_VERSION,
    mandateId: `mnd_${randomBytes(MANDATE_ID_BYTES).toString("hex")}`,
    tokenId: claims.tokenId,
    agentId: claims.agentId,
    payer: claims.payer,
    productId: product.productId,
    categoryId: product.categoryId,
    selections: Object.freeze({ ...(isPlainObject(product.selections) ? product.selections : {}) }),
    quantity,
    unitPrice: formatCents(unitCents),
    currency,
    maxTotal: formatCents(unitCents * quantity),
    imageSha256,
    ...window,
  });

async function checkCategory(categoryResolver, claims, product) {
  if (await categoryResolver.isAllowed(claims.categories, product?.categoryId)) return;
  throw gatewayError("scope_denied", `product category ${product?.categoryId} is outside this token's categories`, { rule: "off_scope_category" });
}

export async function createMandate({ claims, productId, quantity }, deps) {
  const { arcade, fetchImpl = fetch, secret, now = () => Date.now(), ttlSeconds = DEFAULT_MANDATE_TTL_SECONDS, categoryResolver } = deps;
  assertMandateConfig({ secret, ttlSeconds, categoryResolver });
  const product = await readProduct(arcade, productId, quantity);
  await checkCategory(categoryResolver, claims, product);
  const { unitCents, currency } = unitPriceOf(product);
  const totalCents = unitCents * quantity;
  if (totalCents > maxSpendCents(claims)) {
    throw priceDelta(`${quantity} × ${formatCents(unitCents)} = ${formatCents(totalCents)} is over this token's maxSpend ${claims.maxSpend}`);
  }
  const imageSha256 = await hashImage(imageUrlOf(product), fetchImpl);
  const window = mandateWindow(claims, now(), ttlSeconds);
  const mandate = buildMandate({ claims, product: { ...product, productId }, quantity, unitCents, currency, imageSha256, window });
  return { mandateId: mandate.mandateId, mandate, signature: signMandate(mandate, secret) };
}

// ------------------------------------------------------------------------------ categories

const normalize = (text) => text.trim().toLowerCase();

function categoryItems(body) {
  if (!Array.isArray(body?.items)) throw gatewayError("arcade_error", "Arcade categories/list returned no items array");
  return body.items;
}

// Token categories may be Arcade category IDs or names ("Silk scarf"); names match the category's
// exact name, case-insensitively. An unknown categoryId is never allowed.
export function createCategoryResolver({ arcade, now = () => Date.now(), ttlMs = CATEGORY_CACHE_TTL_MS }) {
  let cache = null;
  const load = () => {
    if (cache && now() - cache.at < ttlMs) return cache.items;
    const items = Promise.resolve()
      .then(() => arcade.listCategories())
      .then(categoryItems)
      .catch((error) => {
        if (cache?.items === items) cache = null;
        throw arcadeFailure("/categories/list", error);
      });
    cache = { at: now(), items };
    return items;
  };
  return Object.freeze({
    // The Arcade behind the gateway changed (gateway/arcade-switch.mjs): forget the cached list.
    clear() { cache = null; },
    async isAllowed(allowedList, categoryId) {
      if (!Array.isArray(allowedList) || typeof categoryId !== "string" || categoryId === "") return false;
      if (allowedList.includes(categoryId)) return true;
      const category = (await load()).find((item) => item?.categoryId === categoryId);
      if (typeof category?.name !== "string") return false;
      const wanted = normalize(category.name);
      return allowedList.some((entry) => typeof entry === "string" && normalize(entry) === wanted);
    },
  });
}
