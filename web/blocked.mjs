// The plain-words block: when the gateway refuses a checkout the agent attempted, the person gets one
// sentence they can read and a "blocked" card, instead of the agent's "Sorry, create_checkout failed".
// Pure functions: the inner result is never mutated, a new one is returned.
import { formatCents, isDecimalAmount, toCents } from "../gateway/money.mjs";

const CHECKOUT_TOOL = "create_checkout";
const GATEWAY_SOURCE = "gateway";
const POLICY_REFUSAL_STATUS = 403;
const LEASH_MARK = /Leash/;
// "error: Leash /checkout → HTTP 403: mandate_mismatch <gateway message>": the message is what follows the code.
const GATEWAY_SUMMARY_PREFIX = /^error: Leash \S+ → HTTP \d+: \S+\s*/;
const TIMES = "×";
const NOT_APPROVED = "not what you approved (different quantity or product)";

// Plain words for the gateway's rule (or, when a refusal names no rule, its code).
export const REASONS = Object.freeze({
  quantity_above_mandate: NOT_APPROVED,
  line_mismatch: NOT_APPROVED,
  price_delta: "over the amount you approved or your allowance",
  design_swapped: "the design changed after you approved",
  token_frozen: "the agent's token is frozen after an earlier violation",
  expired: "the approval expired",
  allowance_exceeded: "this would take the agent past your allowance for the period",
});

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => (Number.isInteger(value) && value >= 1 ? value : null);

const callsOf = (result) => (Array.isArray(result?.trace?.calls) ? result.trace.calls : []);

// The newest create_checkout the gateway refused. Its 403s are policy refusals ("blocked"); a 4xx/5xx of
// another kind (Arcade down, a price still pending) is a failure, not a block, and keeps the agent's reply.
function refusedCheckout(calls) {
  return calls.findLast((call) => {
    if (call?.tool !== CHECKOUT_TOOL || !call.error) return false;
    if (call.source !== GATEWAY_SOURCE && !LEASH_MARK.test(String(call.resultSummary ?? ""))) return false;
    return call.status === undefined || call.status === POLICY_REFUSAL_STATUS;
  }) ?? null;
}

// unit price × quantity in integer cents, as a "5120.00" string; null when the price is unreadable.
function totalOf(unitPrice, quantity) {
  const text = typeof unitPrice === "number" && Number.isFinite(unitPrice) ? unitPrice.toFixed(2) : unitPrice;
  return typeof text === "string" && isDecimalAmount(text) ? formatCents(toCents(text) * quantity) : null;
}

// What the agent re-priced and tried to check out: the product named by the refused call (else the
// session's newest one), at the quantity of that call.
function triedOf(result, call) {
  const products = Array.isArray(result?.session?.products) ? result.session.products : [];
  const product = products.findLast((item) => item?.productId === call.args?.productId) ?? products.at(-1);
  if (!isPlainObject(product)) return null;
  const quantity = positiveInteger(call.args?.quantity) ?? positiveInteger(product.quantity);
  const total = quantity === null ? null : totalOf(product.unitPrice, quantity) ?? product.total ?? null;
  if (total === null) return null;
  return Object.freeze({ quantity, total: String(total), title: String(product.title ?? product.productId ?? "the product") });
}

// What the human approved this turn: the mandate the gateway signed (null when none was issued).
function approvedOf(mandate) {
  const quantity = positiveInteger(mandate?.quantity);
  if (quantity === null) return null;
  const total = totalOf(mandate.unitPrice, quantity) ?? mandate.maxTotal ?? null;
  return total === null ? null : Object.freeze({ quantity, total: String(total) });
}

const allowanceOf = (allowance, tokenInfo) =>
  Object.freeze({
    maxSpend: allowance?.maxSpend ?? tokenInfo?.maxSpend ?? null,
    period: allowance?.period ?? null,
    categories: Object.freeze([...(allowance?.categories ?? tokenInfo?.categories ?? [])]),
  });

const reasonFor = (key) => (typeof key === "string" && Object.hasOwn(REASONS, key) ? REASONS[key] : null);

function reasonOf(call) {
  const detail = String(call.resultSummary ?? "").replace(GATEWAY_SUMMARY_PREFIX, "").trim();
  return reasonFor(call.rule) ?? reasonFor(call.code) ?? (detail || call.code || "the gateway refused it");
}

const allowanceClause = ({ maxSpend, period }) => (maxSpend ? `, over your allowance of $${maxSpend}${period ? ` per ${period}` : ""}` : "");

function sentenceOf({ tried, approved, allowance }) {
  const youApproved = approved ? `You approved ${approved.quantity} ${TIMES} $${approved.total}` : "No approval was in place";
  const limit = allowance.maxSpend ? ` and your allowance is up to $${allowance.maxSpend}${allowance.period ? ` per ${allowance.period}` : ""}` : "";
  return `Leash blocked it. The agent tried to spend $${tried.total} on ${tried.quantity} ${TIMES} ${tried.title}. ${youApproved}${limit}. Nothing was bought.`;
}

// A split (salami) attempt: the refused row says "step i of N", and the successful create_checkout rows before
// it are the checkouts that already went through. Cents are integers; null when this is not a readable batch.
function batchOf(calls, call, tried) {
  const of = positiveInteger(call.args?.of);
  if (of === null || of < 2 || !isDecimalAmount(tried.total)) return null;
  const created = calls.slice(0, calls.indexOf(call)).filter((row) => row?.tool === CHECKOUT_TOOL && !row.error).length;
  const step = positiveInteger(call.args?.step) ?? created + 1;
  const each = toCents(tried.total);
  return Object.freeze({
    of, created, step, remaining: Math.max(0, of - step + 1), each: formatCents(each), total: formatCents(of * each),
    spent: formatCents(created * each), attempted: formatCents((created + 1) * each),
  });
}

function batchSentence(batch, allowance) {
  const { of, created, step, remaining, each, spent, attempted } = batch;
  return `Leash blocked it. The agent split your approval into ${of} checkouts of $${each}. ${created} went through ($${spent} in total); checkout ${step} would take the running total to $${attempted}${allowanceClause(allowance)}. The remaining ${remaining} were not created.`;
}

function triedCard(tried, batch) {
  if (!batch) return { quantity: tried.quantity, total: tried.total, title: tried.title };
  return { quantity: batch.of, total: batch.total, title: tried.title, each: batch.each, created: batch.created, step: batch.step };
}

// result: the turn's result. mandate: what the wrapper requested for this turn (or null). allowance: the
// allowance in force ({ maxSpend, period, categories }, or null). tokenInfo: the session's token info.
export function blockedOutcome(result, { mandate = null, allowance = null, tokenInfo = null } = {}) {
  const calls = callsOf(result);
  const call = refusedCheckout(calls);
  const tried = call ? triedOf(result, call) : null;
  if (!tried) return result;
  const approved = approvedOf(mandate);
  const limit = allowanceOf(allowance, tokenInfo);
  const batch = batchOf(calls, call, tried);
  const card = Object.freeze({
    type: "blocked",
    tried: triedCard(tried, batch),
    approved: approved && { quantity: approved.quantity, total: approved.total },
    allowance: { maxSpend: limit.maxSpend, period: limit.period, categories: [...limit.categories] },
    code: call.code ?? null,
    rule: call.rule ?? null,
    reason: reasonOf(call),
    footer: batch ? "Nothing more was bought." : "Nothing was bought.",
  });
  const cards = Array.isArray(result.cards) ? result.cards : [];
  const reply = batch ? batchSentence(batch, limit) : sentenceOf({ tried, approved, allowance: limit });
  return { ...result, reply, cards: [...cards, card] };
}
