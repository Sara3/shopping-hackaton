// A simulated checkout the gateway records for an agent that holds the account key (Leash off on a live
// stack, LEASH_OFF_ALLOWED=true): no mandate, no check, no Arcade order. The web process reads the
// product with the key it holds and hands the gateway a receipt over the admin route; the gateway gives
// it a sim_ id and the same checkout page a Leash checkout gets, so the demo can show what the naive
// agent would have bought without buying it.
import { randomBytes } from "node:crypto";
import { badRequest } from "./errors.mjs";
import { MAX_PRODUCT_ID_CHARS, MAX_QUANTITY, isValidProductId, isValidQuantity } from "./mandates.mjs";
import { formatCents, isDecimalAmount, toCents } from "./money.mjs";

export const SIMULATED_ID_PREFIX = "sim_";
export const SIMULATED_ID_BYTES = 8;
// Any id the simulated-checkout page and the web's paid-status proxy accept: a mandate id or a sim_ id.
export const SIMULATED_CHECKOUT_ID = /^(mnd|sim)_[0-9a-f]{16}$/;
export const KEY_HELD_CHECKOUT_MESSAGE =
  "Simulated checkout: Leash was off and the agent held the account key, so this is what it would have ordered; no Arcade order was created and nothing was charged.";
const MAX_TEXT_CHARS = 200;
const MAX_CURRENCY_CHARS = 8;
const CHECKOUT_URL_PROTOCOLS = Object.freeze(["http:", "https:"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const clipText = (value) => (isText(value) ? value.trim().slice(0, MAX_TEXT_CHARS) : null);

const isHttpUrl = (value) => {
  if (typeof value !== "string") return false;
  try {
    return CHECKOUT_URL_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const newSimulatedCheckoutId = () => `${SIMULATED_ID_PREFIX}${randomBytes(SIMULATED_ID_BYTES).toString("hex")}`;

// The receipt the web posts: what the agent was about to buy, as Arcade's products/get described it.
// Identity and money are strict (a bad one is a 400, never stored); display text is clipped.
export function validateSimulatedCheckoutRequest(body) {
  if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
  if (!isValidProductId(body.productId)) throw badRequest(`productId must be a non-empty string of at most ${MAX_PRODUCT_ID_CHARS} characters`);
  if (!isValidQuantity(body.quantity)) throw badRequest(`quantity must be an integer from 1 to ${MAX_QUANTITY}`);
  if (!isDecimalAmount(body.unitPrice)) throw badRequest('unitPrice must be a decimal string like "128.00"');
  if (!isText(body.currency) || body.currency.length > MAX_CURRENCY_CHARS) throw badRequest("currency must be a short non-empty string");
  const textFields = ["title", "imageUrl", "selectionLabel", "maker"];
  const wrongType = textFields.find((field) => body[field] !== undefined && body[field] !== null && typeof body[field] !== "string");
  if (wrongType) throw badRequest(`${wrongType} must be a string or null`);
  return Object.freeze({
    productId: body.productId,
    quantity: body.quantity,
    unitPrice: body.unitPrice.trim(),
    currency: body.currency.trim(),
    title: clipText(body.title),
    imageUrl: isHttpUrl(body.imageUrl) ? body.imageUrl : null,
    selectionLabel: clipText(body.selectionLabel),
    maker: clipText(body.maker),
  });
}

// Same shape as checkout.mjs's simulatedReceipt, with checkoutId in place of a mandate (mandateId null).
export function buildKeyHeldReceipt(request, checkoutId) {
  const totalCents = toCents(request.unitPrice) * request.quantity;
  return Object.freeze({
    simulated: true,
    checkoutId,
    mandateId: null,
    productId: request.productId,
    title: request.title ?? request.productId,
    imageUrl: request.imageUrl,
    selectionLabel: request.selectionLabel,
    maker: request.maker,
    quantity: request.quantity,
    unitPrice: request.unitPrice,
    total: formatCents(totalCents),
    currency: request.currency,
    message: KEY_HELD_CHECKOUT_MESSAGE,
  });
}

// The id a receipt is stored and served under: the mandate for a Leash checkout, the sim_ id otherwise.
export const receiptIdOf = (receipt) => receipt.mandateId ?? receipt.checkoutId;
