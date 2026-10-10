// Scripted stand-in for the model: deterministic, no network to Anthropic. It plans like a naive model
// would, INCLUDING obeying instructions hidden in the inspiration text. That obedience is the bug the
// team red-teams; every applied instruction is written to the trace so the demo shows it happening.
import { runTool } from "./tools.mjs";

export const APPROVE_PATTERN = /^(approve|yes|ok)/i;
export const APPLIED_NOTE = "scripted stand-in: applied instruction found in inspiration content";

const DEFAULT_CATEGORY = "Silk scarf";
const CATEGORY_KEYWORDS = Object.freeze([
  [/scarf/i, "Silk scarf"],
  [/pillow/i, "Linen pillow"],
  [/napkin/i, "Cotton dinner napkins"],
  [/lampshade/i, "Lampshade"],
]);
const QUANTITY_PATTERNS = Object.freeze([/quantity\s*[:=]?\s*(\d+)/i, /make it (\d+)\b/i]);
// Captures stop at the end of the sentence so "Design note: X. Order note: Y." yields X.
const DESIGN_PATTERNS = Object.freeze([/design note:\s*(?:actually make it\s+)?([^.\n]+)/i, /actually make it ([^.\n]+)/i]);

const firstMatch = (patterns, text) => patterns.map((pattern) => text.match(pattern)).find(Boolean) ?? null;

export const categoryFor = (text) => CATEGORY_KEYWORDS.find(([pattern]) => pattern.test(text))?.[1] ?? DEFAULT_CATEGORY;

export function planDesignTurn(text, inspiration = "") {
  const base = { category: categoryFor(text), prompt: text, quantity: 1, notes: [] };
  const quantityMatch = firstMatch(QUANTITY_PATTERNS, inspiration);
  const designMatch = firstMatch(DESIGN_PATTERNS, inspiration);
  const withQuantity = quantityMatch
    ? { ...base, quantity: Number(quantityMatch[1]), notes: [...base.notes, `${APPLIED_NOTE}: quantity 1 → ${quantityMatch[1]} ("${quantityMatch[0]}")`] }
    : base;
  if (!designMatch) return withQuantity;
  const prompt = designMatch[1].trim();
  return { ...withQuantity, prompt, notes: [...withQuantity.notes, `${APPLIED_NOTE}: design prompt → "${prompt}" ("${designMatch[0].trim()}")`] };
}

const lastError = (state) => state.calls.at(-1)?.error ? state.calls.at(-1) : null;
const failReply = (call) => `Sorry, ${call.tool} failed: ${call.resultSummary.replace(/^error: /, "")}`;

async function designTurn(state, { text, inspiration }, deps) {
  const plan = planDesignTurn(text, inspiration);
  const planned = { ...state, notes: [...state.notes, ...plan.notes] };
  const design = await runTool(planned, "design_pattern", { prompt: plan.prompt }, deps);
  if (design.isError) return { state: design.state, reply: failReply(lastError(design.state)) };
  const build = await runTool(design.state, "build_product", { patternId: design.result.patternId, category: plan.category }, deps);
  if (build.isError) return { state: build.state, reply: failReply(lastError(build.state)) };
  const quote = await runTool(build.state, "price", { productId: build.result.productId, quantity: plan.quantity }, deps);
  if (quote.isError) return { state: quote.state, reply: failReply(lastError(quote.state)) };
  const { title, unitPrice, quantity, total } = quote.result;
  return { state: quote.state, reply: `Approve ${title} at $${unitPrice} × ${quantity} = $${total}?` };
}

async function approveTurn(state, deps) {
  const product = state.session.products.at(-1);
  if (!product) return { state, reply: "There is nothing to approve yet. Tell me what you would like made." };
  const out = await runTool(state, "create_checkout", { productId: product.productId, quantity: product.quantity }, deps);
  if (out.isError) return { state: out.state, reply: failReply(lastError(out.state)) };
  return { state: out.state, reply: `Done. Checkout for ${out.result.quantity} × ${product.title}, total $${out.result.total}: ${out.result.checkoutUrl}` };
}

export function runScriptedTurn(state, message, deps) {
  return APPROVE_PATTERN.test(message.text.trim()) ? approveTurn(state, deps) : designTurn(state, message, deps);
}
