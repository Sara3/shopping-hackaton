// checkouts/create, orders/get, orders/list, feedback/create, and placeOrder() used by
// the mock hosted checkout page when the human clicks "Pay (mock, no money)".
import { findCategory, selectionLabel } from "../catalog.mjs";
import { notFound, ok, preconditionFailed, validationFailed } from "../errors.mjs";
import { priceLine } from "../pricing.mjs";
import { bumpCounter, decodeCursor, newestFirst, paginate, putRecord, replaceRecord } from "../state.mjs";
import { DEFAULT_LIMITS, bool, int, listSchema, oneOf, requestIdRule, str, validate } from "../validation.mjs";
import { orderSummaryView, orderView } from "../views.mjs";
import { readyProduct } from "./products.mjs";

const MAX_LINES = 50;
const MAX_QUANTITY = 1000;
const MAX_FEEDBACK_CHARS = 4000;
const DIGITS = /^\d+$/;
export const ORDER_STATUSES = Object.freeze([
  "ordered", "cadReview", "sampleReview", "inProduction", "inReview", "inCorrection",
  "approved", "updatedInfo", "shipped", "delivered", "fulfilled", "refunded",
]);

function lineErrors(body) {
  const { lines } = body;
  if (!Array.isArray(lines)) return { lines: [lines === undefined ? "Required" : "Expected array"] };
  if (lines.length < 1 || lines.length > MAX_LINES) return { lines: [`Array must contain between 1 and ${MAX_LINES} element(s)`] };
  return lines.reduce((errors, line, index) => {
    const productError = str()(line?.productId);
    const quantityError = int({ min: 1, max: MAX_QUANTITY })(line?.quantity);
    return {
      ...errors,
      ...(productError && { [`lines.${index}.productId`]: [productError] }),
      ...(quantityError && { [`lines.${index}.quantity`]: [quantityError] }),
    };
  }, {});
}

function snapshotLine(product, quantity) {
  const category = findCategory(product.categoryId);
  const { unitCents, lineCents, discountCents } = priceLine({ basePriceCents: category.basePriceCents, quantity });
  return {
    productId: product.productId,
    patternId: product.patternId,
    title: product.title,
    selectionLabel: selectionLabel(category, product.selections),
    makerName: category.maker.name,
    quantity,
    baseCents: category.basePriceCents,
    unitCents,
    lineCents,
    discountCents,
  };
}

const sumBy = (lines, key) => lines.reduce((sum, line) => sum + line[key], 0);

function createCheckout(body, { state, origin, now }) {
  const invalid = validate(body, { requestId: requestIdRule, dropShip: bool({ optional: true }) }, lineErrors);
  if (invalid) return invalid;
  if (body.lines.some((line) => line.quantity === 1) && body.dropShip !== true) {
    return preconditionFailed('A line has quantity 1: set "dropShip": true (no active subscription on this account).');
  }
  const products = body.lines.map((line) => readyProduct(state, line.productId, now()));
  const missingIndex = products.findIndex((product) => !product);
  if (missingIndex >= 0) return notFound(`Product ${body.lines[missingIndex].productId} not found.`);
  const lines = products.map((product, index) => snapshotLine(product, body.lines[index].quantity));
  const { state: counted, value } = bumpCounter(state, "checkout");
  const checkoutId = String(value);
  const checkout = {
    checkoutId,
    lines,
    dropShip: body.dropShip === true,
    subtotalCents: lines.reduce((sum, line) => sum + line.baseCents * line.quantity, 0),
    discountCents: sumBy(lines, "discountCents"),
    totalCents: sumBy(lines, "lineCents"),
    createdAt: new Date(now()).toISOString(),
    orderId: null,
  };
  return { ...ok({ checkoutId, checkoutUrl: `${origin}/checkout/${checkoutId}` }), state: putRecord(counted, "checkouts", checkoutId, checkout) };
}

export function placeOrder(state, checkoutId, nowMs) {
  const checkout = state.checkouts[checkoutId];
  if (!checkout) return { state, order: null };
  if (checkout.orderId) return { state, order: state.orders[checkout.orderId] };
  const { state: s1, value: orderValue } = bumpCounter(state, "order");
  const { state: s2, value: orderNumber } = bumpCounter(s1, "orderNumber");
  const orderId = String(orderValue);
  const order = {
    orderId,
    orderCode: `MOCK-${orderNumber}`,
    orderNumber: `#${orderNumber}`,
    checkoutId,
    status: "ordered",
    placedAt: new Date(nowMs).toISOString(),
    lines: checkout.lines,
    subtotalCents: checkout.subtotalCents,
    discountCents: checkout.discountCents,
    totalCents: checkout.totalCents,
  };
  const withOrder = putRecord(s2, "orders", orderId, order);
  return { state: replaceRecord(withOrder, "checkouts", checkoutId, { ...checkout, orderId }), order };
}

function findOrder(state, { orderId, checkoutId }) {
  if (orderId) return state.orders[orderId] ?? null;
  const placedId = state.checkouts[checkoutId]?.orderId;
  return placedId ? state.orders[placedId] : null;
}

function getOrder(body, { state, origin }) {
  const idRule = str({ optional: true, pattern: DIGITS });
  const invalid = validate(body, { orderId: idRule, checkoutId: idRule });
  if (invalid) return invalid;
  if (!body.orderId && !body.checkoutId) return validationFailed({}, ["Send orderId or checkoutId"]);
  const order = findOrder(state, body);
  return order ? ok(orderView(order, origin)) : notFound("Order not found.");
}

function listOrders(body, { state, origin }) {
  const invalid = validate(body, { ...listSchema("orders"), status: oneOf(ORDER_STATUSES, { optional: true }) });
  if (invalid) return invalid;
  const offset = decodeCursor(body.cursor);
  if (offset === null) return validationFailed({ cursor: ["Invalid cursor"] });
  const matching = newestFirst(Object.values(state.orders)).filter((order) => !body.status || order.status === body.status);
  const page = paginate(matching, offset, body.limit ?? DEFAULT_LIMITS.orders);
  return ok({ items: page.items.map((order) => orderSummaryView(order, origin)), nextCursor: page.nextCursor });
}

function createFeedback(body) {
  const invalid = validate(body, { requestId: requestIdRule, text: str({ min: 1, max: MAX_FEEDBACK_CHARS }) });
  return invalid ?? ok({ requestId: body.requestId });
}

export const orderRoutes = {
  "/checkouts/create": { handler: createCheckout, idempotent: true },
  "/orders/get": { handler: getOrder },
  "/orders/list": { handler: listOrders },
  "/feedback/create": { handler: createFeedback },
};
