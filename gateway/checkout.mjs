// The checkout gate: the only road from an agent to checkouts/create. Every check runs outside the
// model, in a fixed order, against the signed mandate and a fresh products/get; the first failure
// denies with its rule and Arcade is never called. Only Arcade's checkoutUrl leaves this module.
import { gatewayError } from "./errors.mjs";
import { hashImage } from "./image-hash.mjs";
import {
  arcadeFailure, imageUrlOf, isValidProductId, priceDelta, readProduct, unitPriceOf, verifyMandateSignature,
} from "./mandates.mjs";
import { formatCents, toCents } from "./money.mjs";
import { maxSpendCents } from "./tokens.mjs";

export const MAX_CHECKOUT_LINES = 50;
const MAX_MANDATE_ID_CHARS = 200;
const CHECKOUT_URL_PROTOCOLS = Object.freeze(["http:", "https:"]);

const mismatch = (rule, message) => gatewayError("mandate_mismatch", message, { rule });
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const lineMismatch = (message) => mismatch("line_mismatch", message);
// Any positive integer: a quantity above the mandate (even 5000) must reach checkLines and freeze as
// quantity_above_mandate, not stop here as a malformed request.
const isPositiveQuantity = (value) => Number.isSafeInteger(value) && value >= 1;

function validateLine(line, index) {
  if (!isPlainObject(line)) throw lineMismatch(`lines[${index}] must be an object`);
  if (!isValidProductId(line.productId)) throw lineMismatch(`lines[${index}].productId must be a non-empty string`);
  if (!isPositiveQuantity(line.quantity)) throw lineMismatch(`lines[${index}].quantity must be a positive integer`);
  return { productId: line.productId, quantity: line.quantity };
}

// Runs only after the token verified, so a checkout that names no mandate, or no well-formed line, is
// itself a purchase attempt outside what the human approved: a 403 mandate_mismatch that freezes the
// token (deny by default), never a 400 that a hijacked agent could repeat for free.
export function validateCheckoutRequest(body) {
  const { mandateId, lines } = isPlainObject(body) ? body : {};
  if (typeof mandateId !== "string" || mandateId.trim() === "" || mandateId.length > MAX_MANDATE_ID_CHARS) {
    throw mismatch("mandate_unknown", "a checkout needs the mandateId of a purchase the human approved");
  }
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_CHECKOUT_LINES) {
    throw lineMismatch(`lines must be an array of 1 to ${MAX_CHECKOUT_LINES} { productId, quantity }`);
  }
  return { mandateId, lines: lines.map(validateLine) };
}

// 1. The mandate exists, belongs to this token and still carries the gateway's signature.
function loadMandate(claims, mandateId, { mandateStore, secret }) {
  const stored = mandateStore.get(mandateId);
  if (!stored) throw mismatch("mandate_unknown", `no mandate ${mandateId} was issued by this gateway`);
  if (stored.mandate?.tokenId !== claims.tokenId) throw mismatch("line_mismatch", "this mandate was issued to another token");
  if (!verifyMandateSignature(stored.mandate, stored.signature, secret)) throw mismatch("line_mismatch", "the mandate signature does not verify");
  return stored.mandate;
}

// 2. Not expired (an unparseable expiry counts as expired).
function checkExpiry(mandate, now) {
  const expiresMs = Date.parse(mandate.expiresAt);
  if (Number.isFinite(expiresMs) && now() < expiresMs) return;
  throw gatewayError("expired", `mandate ${mandate.mandateId} expired at ${mandate.expiresAt}`, { rule: "expired" });
}

// 3. Exactly the one mandated line: same product, same quantity.
function checkLines(mandate, lines) {
  if (!Array.isArray(lines) || lines.length !== 1) {
    throw mismatch("line_mismatch", `a mandate covers exactly one line, got ${Array.isArray(lines) ? lines.length : "none"}`);
  }
  const [line] = lines;
  if (line?.productId !== mandate.productId) throw mismatch("line_mismatch", `line product ${line?.productId} is not the mandated ${mandate.productId}`);
  if (line.quantity > mandate.quantity) {
    throw mismatch("quantity_above_mandate", `line quantity ${line.quantity} is above the mandated ${mandate.quantity}`);
  }
  if (line.quantity !== mandate.quantity) throw mismatch("line_mismatch", `line quantity ${line.quantity} is not the mandated ${mandate.quantity}`);
}

// 4. Arcade's price now: not above the mandated unit price, total or the token's cap. Returns the product
// and the total this checkout would cost, in cents.
async function checkPrice(mandate, claims, arcade) {
  const product = await readProduct(arcade, mandate.productId, mandate.quantity);
  const { unitCents, currency } = unitPriceOf(product);
  const totalCents = unitCents * mandate.quantity;
  if (currency !== mandate.currency) throw priceDelta(`price currency changed from ${mandate.currency} to ${currency}`);
  if (unitCents > toCents(mandate.unitPrice)) throw priceDelta(`unit price rose from ${mandate.unitPrice} to ${formatCents(unitCents)}`);
  if (totalCents > toCents(mandate.maxTotal)) throw priceDelta(`total ${formatCents(totalCents)} is above the mandated ${mandate.maxTotal}`);
  if (totalCents > maxSpendCents(claims)) throw priceDelta(`total ${formatCents(totalCents)} is above this token's maxSpend ${claims.maxSpend}`);
  return { product, totalCents };
}

// 4b. The token's allowance is a running total: what it already spent plus this checkout must fit, so
// thirty checkouts of 128.00 stop at the second one even though each is under the cap on its own.
function checkAllowance(claims, totalCents, spentCents) {
  const spent = spentCents(claims.tokenId);
  if (spent + totalCents <= maxSpendCents(claims)) return;
  throw gatewayError(
    "allowance_exceeded",
    `running total ${formatCents(spent + totalCents)} would exceed this token's allowance ${claims.maxSpend} (already spent ${formatCents(spent)})`,
    { rule: "allowance_exceeded" },
  );
}

// 5. The product image is still the design the human approved.
async function checkDesign(mandate, product, fetchImpl) {
  if ((await hashImage(imageUrlOf(product), fetchImpl)) === mandate.imageSha256) return;
  throw gatewayError("design_swapped", "the product image no longer matches the approved design", { rule: "design_swapped" });
}

// 6. Single use. Consumed only after every check passed, so a denied attempt never burns it.
function consumeMandate(mandate, detector) {
  if (detector.consumeMandate(mandate.mandateId)) return;
  throw gatewayError("mandate_used", `mandate ${mandate.mandateId} was already used`, { rule: "mandate_used" });
}

// 7. Live Arcade without LIVE_CHECKOUT_ENABLED: this repo never automates payment, and nothing upstream
// stops a real order once every check passes. So the checkout is simulated: every check above has run and
// the mandate is spent (a replay is mandate_used), but no Arcade order is created. The caller gets the
// gateway's own receipt URL, and the running total counts it like a real checkout.
export const SIMULATED_CHECKOUT_MESSAGE =
  "Simulated checkout: live Arcade checkout is off (LIVE_CHECKOUT_ENABLED is not set), so no Arcade order was created and nothing was charged.";

const isSimulated = ({ mode, liveCheckoutEnabled }) => mode === "live" && !liveCheckoutEnabled;

const textOr = (value, fallback = null) => (typeof value === "string" && value.trim() !== "" ? value : fallback);

// Price and quantity come from the mandate; title, image, options and maker from the products/get this
// checkout just made, for the receipt page only.
const simulatedReceipt = (mandate, totalCents, product) =>
  Object.freeze({
    simulated: true,
    mandateId: mandate.mandateId,
    productId: mandate.productId,
    title: textOr(product?.title, mandate.productId),
    imageUrl: isCheckoutUrl(imageUrlOf(product)) ? imageUrlOf(product) : null,
    selectionLabel: textOr(product?.selectionLabel),
    maker: textOr(product?.maker?.name),
    quantity: mandate.quantity,
    unitPrice: mandate.unitPrice,
    total: formatCents(totalCents),
    currency: mandate.currency,
    message: SIMULATED_CHECKOUT_MESSAGE,
  });

function isCheckoutUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return CHECKOUT_URL_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// 7. The one Arcade call. Lines come from the mandate, never from the request.
async function createArcadeCheckout(mandate, arcade) {
  let checkout;
  try {
    checkout = await arcade.createCheckout({ lines: [{ productId: mandate.productId, quantity: mandate.quantity }], dropShip: true });
  } catch (error) {
    throw arcadeFailure("/checkouts/create", error);
  }
  if (!isCheckoutUrl(checkout?.checkoutUrl)) throw gatewayError("arcade_error", "Arcade returned no usable checkoutUrl");
  return checkout.checkoutUrl;
}

// { checkoutUrl, totalCents } for a real Arcade checkout; a simulated one (step 7) adds its receipt.
export async function runCheckout({ claims, mandateId, lines }, deps) {
  const {
    arcade, fetchImpl = fetch, mandateStore, detector, secret, now = () => Date.now(),
    spentCents = () => 0, mode = null, liveCheckoutEnabled = false, simulatedCheckoutUrl = null,
  } = deps;
  const simulated = isSimulated({ mode, liveCheckoutEnabled });
  if (simulated && typeof simulatedCheckoutUrl !== "function") throw new TypeError("a simulated checkout needs simulatedCheckoutUrl(mandateId)");
  const mandate = loadMandate(claims, mandateId, { mandateStore, secret });
  checkExpiry(mandate, now);
  checkLines(mandate, lines);
  const { product, totalCents } = await checkPrice(mandate, claims, arcade);
  checkAllowance(claims, totalCents, spentCents);
  await checkDesign(mandate, product, fetchImpl);
  checkExpiry(mandate, now);
  consumeMandate(mandate, detector);
  if (simulated) return { checkoutUrl: simulatedCheckoutUrl(mandate.mandateId), totalCents, receipt: simulatedReceipt(mandate, totalCents, product) };
  return { checkoutUrl: await createArcadeCheckout(mandate, arcade), totalCents };
}
