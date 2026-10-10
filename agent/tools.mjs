// The four shopping tools, identical in scripted and LLM mode. Each run returns a NEW turn state
// ({ session, calls, cards, notes }); nothing passed in is mutated. Every call lands in the trace.
import { lineTotal } from "./money.mjs";

const FILL_FIT = Object.freeze({ mode: "fill" });
// The real products/get can return unitPrice null while pricing is pending ("read again later").
export const PRICE_RETRIES = 5;
export const PRICE_RETRY_MS = 3000;
const NOT_PRICED_YET = "Arcade has not priced this product yet, try again in a minute";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPricedProduct(arcade, productId, quantity, retry = {}) {
  const { retries = PRICE_RETRIES, delayMs = PRICE_RETRY_MS } = retry;
  for (let attempt = 0; ; attempt += 1) {
    const product = await arcade.getProduct(productId, quantity);
    if (product.unitPrice?.amount) return product;
    if (attempt >= retries) throw new Error(`${NOT_PRICED_YET} (product ${productId})`);
    await sleep(delayMs);
  }
}

const replaceProduct = (products, productId, patch) =>
  products.map((product) => (product.productId === productId ? { ...product, ...patch } : product));

const findProduct = (session, productId) => session.products.find((product) => product.productId === productId);

async function designPattern({ prompt }, { arcade }, session) {
  const pattern = await arcade.generatePattern({ prompt });
  const entry = { patternId: pattern.patternId, prompt: pattern.prompt, imageUrl: pattern.imageUrl };
  return {
    result: entry,
    summary: `pattern ${entry.patternId}: "${entry.prompt}"`,
    session: { ...session, patterns: [...session.patterns, entry] },
    card: { type: "pattern", ...entry },
  };
}

async function findCategoryId(arcade, name) {
  const { items = [] } = await arcade.listCategories();
  const wanted = String(name ?? "").trim().toLowerCase();
  const match = items.find((item) => item.name.toLowerCase() === wanted)
    ?? items.find((item) => item.name.toLowerCase().includes(wanted));
  if (!match) throw new Error(`no category named "${name}" (have: ${items.map((item) => item.name).join(", ")})`);
  return match.categoryId;
}

async function buildProduct({ patternId, category }, { arcade }, session) {
  const categoryId = await findCategoryId(arcade, category);
  const { selections } = await arcade.getCategory(categoryId, {});
  const product = await arcade.buildProduct({ patternId, categoryId, selections, fit: FILL_FIT });
  const entry = {
    productId: product.productId,
    title: product.title,
    maker: product.maker?.name ?? null,
    imageUrl: product.imageUrl ?? product.images?.[0]?.url ?? null,
    unitPrice: product.unitPrice?.amount ?? null,
    quantity: 1,
    total: product.unitPrice?.amount ?? null,
  };
  return {
    result: { productId: entry.productId, title: entry.title, maker: entry.maker, unitPrice: entry.unitPrice },
    summary: `product ${entry.productId}: ${entry.title}`,
    session: { ...session, products: [...session.products, entry] },
    card: null,
  };
}

async function price({ productId, quantity }, { arcade, priceRetry }, session) {
  const product = await getPricedProduct(arcade, productId, quantity, priceRetry);
  const unitPrice = product.unitPrice.amount;
  const total = lineTotal(unitPrice, quantity);
  const known = findProduct(session, productId);
  const patch = { unitPrice, quantity, total, title: product.title, maker: product.maker?.name ?? known?.maker ?? null };
  const products = known ? replaceProduct(session.products, productId, patch) : [...session.products, { productId, ...patch }];
  const card = { type: "product", productId, imageUrl: product.imageUrl ?? known?.imageUrl ?? null, ...patch };
  return {
    result: { productId, title: product.title, unitPrice, quantity, total, currency: product.unitPrice.currency },
    summary: `$${unitPrice} x ${quantity} = $${total}`,
    session: { ...session, products },
    card,
  };
}

async function totalFor(arcade, session, productId, quantity, priceRetry) {
  const known = findProduct(session, productId);
  if (known && known.quantity === quantity && known.total) return known.total;
  const product = await getPricedProduct(arcade, productId, quantity, priceRetry);
  return lineTotal(product.unitPrice.amount, quantity);
}

// NAIVE on purpose: any quantity is accepted, no cap, no confirmation against what the user typed.
// The total is computed BEFORE checkouts/create, so a pricing failure never leaves an orphan checkout
// that a retry (fresh requestId) would duplicate.
async function createCheckout({ productId, quantity }, { arcade, priceRetry }, session) {
  const total = await totalFor(arcade, session, productId, quantity, priceRetry);
  const checkout = await arcade.createCheckout({ lines: [{ productId, quantity }], dropShip: true });
  const entry = { checkoutId: checkout.checkoutId, checkoutUrl: checkout.checkoutUrl, productId, quantity, total };
  return {
    result: { ...entry, raw: checkout },
    summary: `checkout ${entry.checkoutId}: ${quantity} unit(s), total $${total}`,
    session: { ...session, checkouts: [...session.checkouts, entry] },
    card: { type: "checkout", ...entry },
  };
}

export const TOOL_HANDLERS = Object.freeze({
  design_pattern: designPattern,
  build_product: buildProduct,
  price,
  create_checkout: createCheckout,
});

export async function runTool(state, name, args, deps) {
  const handler = Object.hasOwn(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : null;
  const started = Date.now();
  if (!handler) {
    const call = { tool: name, args, resultSummary: `unknown tool ${name}`, ms: 0, error: true };
    return { state: { ...state, calls: [...state.calls, call] }, result: { error: `unknown tool ${name}` }, isError: true };
  }
  try {
    const out = await handler(args, deps, state.session);
    const call = { tool: name, args, resultSummary: out.summary, ms: Date.now() - started, ...(name === "create_checkout" && { raw: out.result.raw }) };
    const cards = out.card ? [...state.cards, out.card] : state.cards;
    return { state: { ...state, session: out.session, calls: [...state.calls, call], cards }, result: out.result, isError: false };
  } catch (error) {
    deps.logger?.warn?.(`tool ${name} failed: ${error.message}`);
    const call = { tool: name, args, resultSummary: `error: ${error.message}`, ms: Date.now() - started, error: true };
    return { state: { ...state, calls: [...state.calls, call] }, result: { error: error.message }, isError: true };
  }
}
