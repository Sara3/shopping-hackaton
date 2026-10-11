// Pure pieces of the Settings allowance: the body validator, the token config an allowance turns into,
// the LEASH_MAX_SPEND boot allowance, and the plain-words block the mandate wrapper puts on a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { configFor, createAllowanceStore } from "../web/allowance.mjs";
import { blockedOutcome } from "../web/blocked.mjs";
import {
  DEFAULT_CATEGORIES, SECONDS_PER_DAY, TOKEN_TTL_SECONDS, allowanceFromEnv, leashConfigForAllowance, resolveLeashConfig,
} from "../web/leash.mjs";
import { HttpError, KNOWN_CATEGORIES, validateAllowanceBody } from "../web/validate.mjs";

const LEASH = "http://127.0.0.1:8080";
const GOOD = Object.freeze({ maxSpend: "200.00", period: "week", categories: ["Silk scarf", "Lampshade"], days: 7 });
const deepFreeze = (value) => {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

// ------------------------------------------------------------------------------ validateAllowanceBody

test("KNOWN_CATEGORIES are the four catalog names", () => {
  assert.deepEqual([...KNOWN_CATEGORIES], ["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"]);
});

test("validateAllowanceBody returns a frozen, normalized allowance", () => {
  const checked = validateAllowanceBody({ maxSpend: "200", period: "month", categories: [...KNOWN_CATEGORIES], days: 30 });
  assert.deepEqual(checked, { maxSpend: "200.00", period: "month", categories: [...KNOWN_CATEGORIES], days: 30 });
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.categories), true);
  assert.equal(validateAllowanceBody({ ...GOOD, maxSpend: 200 }).maxSpend, "200.00");
  assert.equal(validateAllowanceBody({ ...GOOD, maxSpend: "1" }).maxSpend, "1.00");
  assert.equal(validateAllowanceBody({ ...GOOD, maxSpend: "100000.00" }).maxSpend, "100000.00");
  assert.equal(validateAllowanceBody({ ...GOOD, maxSpend: 12.5 }).maxSpend, "12.50");
  assert.equal(validateAllowanceBody({ ...GOOD, days: 1 }).days, 1);
});

test("validateAllowanceBody refuses every out-of-range or malformed field with a 400 bad_request in plain words", () => {
  const bad = [
    [{ ...GOOD, maxSpend: "0.99" }, /maxSpend/], [{ ...GOOD, maxSpend: 0 }, /maxSpend/], [{ ...GOOD, maxSpend: "abc" }, /maxSpend/],
    [{ ...GOOD, maxSpend: "100000.01" }, /maxSpend/], [{ ...GOOD, maxSpend: 100001 }, /maxSpend/], [{ ...GOOD, maxSpend: "1.234" }, /maxSpend/],
    [{ ...GOOD, maxSpend: Number.NaN }, /maxSpend/], [{ ...GOOD, maxSpend: null }, /maxSpend/], [{ ...GOOD, maxSpend: "-5" }, /maxSpend/],
    [{ ...GOOD, period: "day" }, /period/], [{ ...GOOD, period: undefined }, /period/],
    [{ ...GOOD, categories: [] }, /categories/], [{ ...GOOD, categories: ["Boat"] }, /categories/], [{ ...GOOD, categories: ["Silk scarf", "Silk scarf"] }, /categories/],
    [{ ...GOOD, categories: [...KNOWN_CATEGORIES, "Silk scarf"] }, /categories/], [{ ...GOOD, categories: "Silk scarf" }, /categories/],
    [{ ...GOOD, days: 0 }, /days/], [{ ...GOOD, days: 31 }, /days/], [{ ...GOOD, days: 2.5 }, /days/], [{ ...GOOD, days: "7" }, /days/],
    [null, /object/], [[GOOD], /object/], ["x", /object/],
  ];
  for (const [body, pattern] of bad) {
    const error = (() => { try { validateAllowanceBody(body); } catch (caught) { return caught; } return null; })();
    assert.ok(error instanceof HttpError, `not refused: ${JSON.stringify(body)}`);
    assert.deepEqual([error.status, error.code], [400, "bad_request"]);
    assert.match(error.message, pattern);
  }
});

// ------------------------------------------------------------------- leashConfigForAllowance / env

test("leashConfigForAllowance returns a new frozen config: the allowance's limits and days * 86400 s, the rest of the base", () => {
  const base = resolveLeashConfig({ LEASH_URL: LEASH, LEASH_ADMIN_KEY: "adm", LEASH_PAYER: "mom" });
  const config = leashConfigForAllowance(base, GOOD);
  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual([config.maxSpend, config.categories, config.ttlSeconds], ["200.00", ["Silk scarf", "Lampshade"], 7 * SECONDS_PER_DAY]);
  assert.deepEqual([config.leashUrl, config.agentId, config.payer, config.adminKey], [LEASH, "web-agent", "mom", "adm"]);
  assert.equal(base.ttlSeconds, TOKEN_TTL_SECONDS, "the base config is untouched");
  assert.equal(base.maxSpend, "200.00");
  assert.equal(Object.isFrozen(config.categories), true);
  assert.equal(leashConfigForAllowance(base, { ...GOOD, days: 30 }).ttlSeconds, 2_592_000);
});

test("allowanceFromEnv: only LEASH_URL plus LEASH_MAX_SPEND pre-saves an allowance (week, token TTL rounded up to 1 day)", () => {
  assert.equal(allowanceFromEnv({}), null);
  assert.equal(allowanceFromEnv({ LEASH_URL: LEASH }), null, "no LEASH_MAX_SPEND: the agent starts naive");
  assert.equal(allowanceFromEnv({ LEASH_MAX_SPEND: "200.00" }), null, "no gateway, nothing to pre-save");
  assert.deepEqual(allowanceFromEnv({ LEASH_URL: LEASH, LEASH_MAX_SPEND: "75.50" }), { maxSpend: "75.50", period: "week", categories: [...DEFAULT_CATEGORIES], days: 1 });
  const custom = allowanceFromEnv({ LEASH_URL: LEASH, LEASH_MAX_SPEND: "50", LEASH_CATEGORIES: " Silk scarf , Lampshade ," });
  assert.deepEqual([custom.maxSpend, custom.categories], ["50", ["Silk scarf", "Lampshade"]]);
  assert.equal(Object.isFrozen(custom), true);
});

// ----------------------------------------------------------------------------- allowance store / config

test("the allowance store replaces its state and never mutates it", () => {
  const store = createAllowanceStore();
  assert.equal(store.current(), null);
  const first = { allowance: GOOD, agent: { handleMessage() {} } };
  store.replace(first);
  const held = store.current();
  assert.equal(Object.isFrozen(held), true);
  assert.deepEqual([held.allowance, held.leash], [GOOD, null]);
  store.replace({ allowance: { ...GOOD, days: 2 } });
  assert.equal(held.allowance.days, 7);
  assert.equal(store.current().allowance.days, 2);
  store.clear();
  assert.equal(store.current(), null);
  assert.equal(createAllowanceStore({ allowance: GOOD }).current().allowance, GOOD);
});

test("configFor: the key line follows who holds what, and `leash` appears only with a gateway", () => {
  const base = Object.freeze({ arcadeMode: "mock", keyPresent: true, keyPrefix: "mock_k…" });
  const leash = { publicInfo: () => ({ tokenId: "tok_0123456789abcdef", maxSpend: "200.00" }) };
  assert.deepEqual(configFor(base, null, false), { ...base, allowance: null, gateway: false });
  assert.deepEqual(configFor(base, { allowance: GOOD, leash: null }, false), { ...base, allowance: GOOD, gateway: false });
  assert.deepEqual(configFor(base, null, true), { ...base, allowance: null, gateway: true, leash: null });
  assert.deepEqual(configFor(base, { allowance: GOOD, leash }, true), {
    ...base, keyPresent: false, keyPrefix: "none (leash)", allowance: GOOD, gateway: true, leash: { tokenId: "tok_0123456789abcdef", maxSpend: "200.00" },
  });
  assert.equal(base.keyPresent, true, "the base config is untouched");
});

// ------------------------------------------------------------------------------------ blockedOutcome

const refusal = (overrides = {}) => ({
  tool: "create_checkout", args: { productId: "p2", quantity: 50 }, resultSummary: "error: Leash /checkout → HTTP 403: mandate_mismatch line product p2 is not the mandated p1",
  ms: 3, error: true, source: "gateway", status: 403, code: "mandate_mismatch", rule: "line_mismatch", ...overrides,
});
const turnResult = (call = refusal(), extra = {}) => deepFreeze({
  session: { id: "s", products: [{ productId: "p1", title: "Silk scarf", unitPrice: "128.00", quantity: 1, total: "128.00" }, { productId: "p2", title: "Silk scarf · large red roses on black", unitPrice: "102.40", quantity: 50, total: "5120.00" }] },
  reply: "Sorry, create_checkout failed: Leash /checkout → HTTP 403: mandate_mismatch",
  cards: [{ type: "product", productId: "p2" }],
  trace: { mode: "scripted", calls: [call], notes: [] },
  ...extra,
});
const MANDATE = Object.freeze({ mandateId: "mnd_1", productId: "p1", quantity: 1, unitPrice: "128.00", maxTotal: "128.00" });
const LIMIT = Object.freeze({ maxSpend: "200.00", period: "week", categories: ["Silk scarf"] });

test("blockedOutcome: the reply says what was tried, what was approved and the allowance; a blocked card is appended; nothing is mutated", () => {
  const result = turnResult();
  const out = blockedOutcome(result, { mandate: MANDATE, allowance: LIMIT });
  assert.equal(out.reply, "Leash blocked it. The agent tried to spend $5120.00 on 50 × Silk scarf · large red roses on black. You approved 1 × $128.00 and your allowance is up to $200.00 per week. Nothing was bought.");
  assert.equal(out.cards.length, 2);
  assert.deepEqual(out.cards[0], { type: "product", productId: "p2" });
  assert.deepEqual(out.cards[1], {
    type: "blocked",
    tried: { quantity: 50, total: "5120.00", title: "Silk scarf · large red roses on black" },
    approved: { quantity: 1, total: "128.00" },
    allowance: { maxSpend: "200.00", period: "week", categories: ["Silk scarf"] },
    code: "mandate_mismatch",
    rule: "line_mismatch",
    reason: "not what you approved (different quantity or product)",
    footer: "Nothing was bought.",
  });
  assert.equal(out.trace, result.trace);
  assert.notEqual(out, result);
  assert.match(result.reply, /^Sorry/, "the inner result was not mutated");
  assert.equal(result.cards.length, 1);
});

test("blockedOutcome: a split attempt says how many checkouts went through and which one was refused", () => {
  const ok = { tool: "create_checkout", args: { productId: "p1", quantity: 1, step: 1, of: 30 }, resultSummary: "checkout 1000000001: 1 unit(s), total $128.00", ms: 3 };
  const refused = refusal({
    args: { productId: "p1", quantity: 1, step: 2, of: 30 }, code: "allowance_exceeded", rule: "allowance_exceeded",
    resultSummary: "error: Leash /checkout → HTTP 403: allowance_exceeded running total 256.00 would exceed this token's allowance 200.00 (already spent 128.00)",
  });
  const session = { id: "s", products: [{ productId: "p1", title: "Silk scarf · linen scarf, office gift edition", unitPrice: "128.00", quantity: 1 }] };
  const result = turnResult(refused, { session, trace: { mode: "scripted", calls: [ok, refused], notes: [] } });
  const out = blockedOutcome(result, { mandate: { quantity: 1, unitPrice: "128.00" }, allowance: LIMIT });
  assert.equal(out.reply, "Leash blocked it. The agent split your approval into 30 checkouts of $128.00. 1 went through ($128.00 in total); checkout 2 would take the running total to $256.00, over your allowance of $200.00 per week. The remaining 29 were not created.");
  assert.deepEqual(out.cards.at(-1).tried, { quantity: 30, total: "3840.00", title: "Silk scarf · linen scarf, office gift edition", each: "128.00", created: 1, step: 2 });
  assert.equal(out.cards.at(-1).footer, "Nothing more was bought.");
  assert.deepEqual(out.cards.at(-1).approved, { quantity: 1, total: "128.00" });
  assert.deepEqual([out.cards.at(-1).code, out.cards.at(-1).rule], ["allowance_exceeded", "allowance_exceeded"]);
  const bare = blockedOutcome(result, { mandate: { quantity: 1, unitPrice: "128.00" } });
  assert.equal(bare.reply, "Leash blocked it. The agent split your approval into 30 checkouts of $128.00. 1 went through ($128.00 in total); checkout 2 would take the running total to $256.00. The remaining 29 were not created.");
  const third = blockedOutcome(turnResult(refused, { session, trace: { calls: [ok, { ...ok, args: { ...ok.args, step: 2 } }, { ...refused, args: { ...refused.args, step: 3 } }] } }), { mandate: MANDATE, allowance: LIMIT });
  assert.match(third.reply, /2 went through \(\$256\.00 in total\); checkout 3 would take the running total to \$384\.00.*The remaining 28 were not created\.$/);
});

test("blockedOutcome: the reason is plain words per rule, and the gateway's own message otherwise", () => {
  const reasonFor = (overrides) => blockedOutcome(turnResult(refusal(overrides)), { mandate: MANDATE, allowance: LIMIT }).cards.at(-1).reason;
  assert.match(reasonFor({ rule: "quantity_above_mandate" }), /^not what you approved/);
  assert.equal(reasonFor({ rule: "price_delta", code: "price_exceeded" }), "over the amount you approved or your allowance");
  assert.equal(reasonFor({ rule: "design_swapped", code: "design_swapped" }), "the design changed after you approved");
  assert.equal(reasonFor({ rule: undefined, code: "token_frozen" }), "the agent's token is frozen after an earlier violation");
  assert.equal(reasonFor({ rule: "expired", code: "expired" }), "the approval expired");
  assert.equal(reasonFor({ rule: "mandate_used", code: "mandate_used", resultSummary: "error: Leash /checkout → HTTP 403: mandate_used mandate mnd_1 was already used" }), "mandate mnd_1 was already used");
  assert.equal(reasonFor({ rule: "constructor", code: "scope_denied", resultSummary: "error: Leash /arcade/x → HTTP 403: scope_denied" }), "scope_denied");
});

test("blockedOutcome: the figures come from the refused call and the mandate, not the product's last price", () => {
  const out = blockedOutcome(turnResult(refusal({ args: { productId: "p2", quantity: 3 } })), { mandate: { ...MANDATE, quantity: 2, unitPrice: "64.00", maxTotal: "128.00" }, allowance: LIMIT });
  assert.deepEqual(out.cards.at(-1).tried, { quantity: 3, total: "307.20", title: "Silk scarf · large red roses on black" });
  assert.deepEqual(out.cards.at(-1).approved, { quantity: 2, total: "128.00" });
  assert.match(out.reply, /spend \$307\.20 on 3 ×.*You approved 2 × \$128\.00/);
});

test("blockedOutcome: no mandate, no allowance on the wrapper: the sentence says so and quotes the token's own limits", () => {
  const out = blockedOutcome(turnResult(refusal({ rule: "mandate_unknown" })), { tokenInfo: { maxSpend: "75.00", categories: ["Lampshade"] } });
  assert.equal(out.reply, "Leash blocked it. The agent tried to spend $5120.00 on 50 × Silk scarf · large red roses on black. No approval was in place and your allowance is up to $75.00. Nothing was bought.");
  assert.equal(out.cards.at(-1).approved, null);
  assert.deepEqual(out.cards.at(-1).allowance, { maxSpend: "75.00", period: null, categories: ["Lampshade"] });
});

test("blockedOutcome leaves a turn alone unless the gateway refused a checkout with a 403", () => {
  const same = (result) => assert.equal(blockedOutcome(result, { mandate: MANDATE, allowance: LIMIT }), result);
  same(turnResult(refusal({ error: undefined, source: "agent", status: undefined, resultSummary: "checkout 1: 1 unit(s), total $128.00" })));
  same(turnResult(refusal({ tool: "price" })));
  same(turnResult(refusal({ source: "agent", status: undefined, resultSummary: "error: boom" })));
  same(turnResult(refusal({ status: 502, code: "arcade_error" })));
  same(turnResult(refusal({ status: 409, code: "price_pending" })));
  same(deepFreeze({ session: { products: [] }, reply: "ok", cards: [], trace: {} }));
  same(turnResult(refusal(), { session: { id: "s", products: [] } }));
  same(turnResult(refusal(), { trace: undefined }));
  const viaMessage = refusal({ source: undefined, status: undefined });
  assert.match(blockedOutcome(turnResult(viaMessage), { mandate: MANDATE, allowance: LIMIT }).reply, /^Leash blocked it\./, "an error message naming Leash counts too");
});
