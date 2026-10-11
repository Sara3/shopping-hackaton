import { test } from "node:test";
import assert from "node:assert/strict";
import { createDetector, VELOCITY_LIMIT, VELOCITY_WINDOW_MS, DENIAL_LIMIT } from "../gateway/detector.mjs";
import { createMandateStore, MAX_MANDATES } from "../gateway/mandate-store.mjs";

const T0 = Date.parse("2026-10-11T18:00:00.000Z");
const TOKEN = "tok_aaaaaaaaaaaaaaaa";
const OTHER = "tok_bbbbbbbbbbbbbbbb";
const STATUS_KEYS = ["at", "denials", "frozen", "reason", "workStartsLastMinute"];

const manualClock = (start = T0) => {
  let current = start;
  const now = () => current;
  return { now, set: (ms) => (current = ms), advance: (ms) => (current += ms) };
};

const startN = (detector, tokenId, count) => Array.from({ length: count }, () => detector.recordWorkStart(tokenId));

test("constants match the contract", () => {
  assert.equal(VELOCITY_LIMIT, 5);
  assert.equal(VELOCITY_WINDOW_MS, 60_000);
  assert.equal(DENIAL_LIMIT, 3);
});

test("an unknown token is not frozen and status() has the contract shape", () => {
  const detector = createDetector({ now: () => T0 });
  assert.deepEqual(detector.isFrozen(TOKEN), { frozen: false, reason: null, at: null });
  const status = detector.status(TOKEN);
  assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
  assert.deepEqual(status, { frozen: false, reason: null, at: null, denials: 0, workStartsLastMinute: 0 });
});

test("5 work starts are allowed, the 6th inside 60 s is denied and freezes with velocity", () => {
  const clock = manualClock();
  const detector = createDetector({ now: clock.now });
  const results = [0, 10_000, 20_000, 30_000, 40_000].map((offset) => {
    clock.set(T0 + offset);
    return detector.recordWorkStart(TOKEN);
  });
  assert.deepEqual(results.map((result) => result.allowed), [true, true, true, true, true]);
  assert.deepEqual(results.map((result) => result.count), [1, 2, 3, 4, 5]);
  assert.equal(detector.isFrozen(TOKEN).frozen, false);

  clock.set(T0 + VELOCITY_WINDOW_MS - 1);
  assert.deepEqual(detector.recordWorkStart(TOKEN), { allowed: false, count: 6 });
  assert.deepEqual(detector.isFrozen(TOKEN), { frozen: true, reason: "velocity", at: new Date(T0 + 59_999).toISOString() });
});

test("the velocity window slides with the injected clock", () => {
  const clock = manualClock();
  const detector = createDetector({ now: clock.now });
  [0, 10_000, 20_000, 30_000, 40_000].forEach((offset) => {
    clock.set(T0 + offset);
    detector.recordWorkStart(TOKEN);
  });
  clock.set(T0 + VELOCITY_WINDOW_MS);
  assert.deepEqual(detector.recordWorkStart(TOKEN), { allowed: true, count: 5 });
  assert.equal(detector.status(TOKEN).workStartsLastMinute, 5);

  clock.set(T0 + VELOCITY_WINDOW_MS + 1);
  assert.deepEqual(detector.recordWorkStart(TOKEN), { allowed: false, count: 6 });
  assert.equal(detector.isFrozen(TOKEN).reason, "velocity");
});

test("status() reports work starts in the last minute and they decay as the clock moves", () => {
  const clock = manualClock();
  const detector = createDetector({ now: clock.now });
  startN(detector, TOKEN, 3);
  assert.equal(detector.status(TOKEN).workStartsLastMinute, 3);
  clock.advance(VELOCITY_WINDOW_MS);
  assert.equal(detector.status(TOKEN).workStartsLastMinute, 0);
  assert.deepEqual(detector.recordWorkStart(TOKEN), { allowed: true, count: 1 });
});

test("velocityLimit is configurable", () => {
  const detector = createDetector({ now: () => T0, velocityLimit: 2 });
  const results = startN(detector, TOKEN, 3);
  assert.deepEqual(results.map((result) => result.allowed), [true, true, false]);
  assert.equal(detector.isFrozen(TOKEN).reason, "velocity");
});

test("a frozen token is never allowed to start work and its count stops growing", () => {
  const detector = createDetector({ now: () => T0 });
  detector.freeze(TOKEN, "quantity_above_mandate");
  assert.deepEqual(detector.recordWorkStart(TOKEN), { allowed: false, count: 0 });
  assert.deepEqual(detector.recordWorkStart(TOKEN), { allowed: false, count: 0 });
  assert.equal(detector.isFrozen(TOKEN).reason, "quantity_above_mandate");
});

test("3 denials freeze the token with denial_count", () => {
  const clock = manualClock();
  const detector = createDetector({ now: clock.now });
  assert.deepEqual(detector.recordDenial(TOKEN, "scope_denied"), { denials: 1, frozen: false, frozeNow: false });
  assert.deepEqual(detector.recordDenial(TOKEN, "scope_denied"), { denials: 2, frozen: false, frozeNow: false });
  clock.advance(500);
  assert.deepEqual(detector.recordDenial(TOKEN, "price_exceeded"), { denials: 3, frozen: true, frozeNow: true });
  assert.deepEqual(detector.isFrozen(TOKEN), { frozen: true, reason: "denial_count", at: new Date(T0 + 500).toISOString() });
  assert.deepEqual(detector.recordDenial(TOKEN, "token_frozen"), { denials: 4, frozen: true, frozeNow: false });
  assert.equal(detector.status(TOKEN).denials, 4);
});

test("denialLimit is configurable and denials on an already frozen token keep the first reason", () => {
  const detector = createDetector({ now: () => T0, denialLimit: 1 });
  detector.freeze(TOKEN, "velocity");
  assert.deepEqual(detector.recordDenial(TOKEN, "velocity_exceeded"), { denials: 1, frozen: true, frozeNow: false });
  assert.equal(detector.isFrozen(TOKEN).reason, "velocity");
  assert.deepEqual(detector.recordDenial(OTHER, "scope_denied"), { denials: 1, frozen: true, frozeNow: true });
});

test("freeze is idempotent: the first reason and timestamp win", () => {
  const clock = manualClock();
  const detector = createDetector({ now: clock.now });
  const first = detector.freeze(TOKEN, "quantity_above_mandate");
  assert.deepEqual(Object.keys(first).sort(), STATUS_KEYS);
  assert.equal(first.frozen, true);
  assert.equal(first.reason, "quantity_above_mandate");
  assert.equal(first.at, new Date(T0).toISOString());

  clock.advance(5_000);
  const again = detector.freeze(TOKEN, "price_delta");
  assert.equal(again.reason, "quantity_above_mandate");
  assert.equal(again.at, new Date(T0).toISOString());
  assert.deepEqual(detector.isFrozen(TOKEN), { frozen: true, reason: "quantity_above_mandate", at: new Date(T0).toISOString() });
});

test("freeze without a reason still freezes (fail closed)", () => {
  const detector = createDetector({ now: () => T0 });
  assert.equal(detector.freeze(TOKEN).reason, "unspecified");
  assert.equal(detector.freeze(OTHER, "   ").reason, "unspecified");
  assert.equal(detector.isFrozen(OTHER).frozen, true);
});

test("tokens are tracked independently", () => {
  const detector = createDetector({ now: () => T0, velocityLimit: 1 });
  detector.recordWorkStart(TOKEN);
  detector.recordWorkStart(TOKEN);
  assert.equal(detector.isFrozen(TOKEN).frozen, true);
  assert.equal(detector.isFrozen(OTHER).frozen, false);
  assert.deepEqual(detector.recordWorkStart(OTHER), { allowed: true, count: 1 });
});

test("consumeMandate is single use per mandateId", () => {
  const detector = createDetector({ now: () => T0 });
  assert.equal(detector.consumeMandate("mnd_0123456789abcdef"), true);
  assert.equal(detector.consumeMandate("mnd_0123456789abcdef"), false);
  assert.equal(detector.consumeMandate("mnd_fedcba9876543210"), true);
  for (const bad of [undefined, null, "", 42, {}]) assert.equal(detector.consumeMandate(bad), false);
});

test("returned objects are frozen snapshots that cannot change detector state", () => {
  const detector = createDetector({ now: () => T0 });
  detector.recordDenial(TOKEN, "scope_denied");
  const status = detector.status(TOKEN);
  assert.ok(Object.isFrozen(status));
  assert.ok(Object.isFrozen(detector.isFrozen(TOKEN)));
  assert.ok(Object.isFrozen(detector.recordWorkStart(TOKEN)));
  assert.ok(Object.isFrozen(detector.recordDenial(OTHER, "scope_denied")));
  assert.throws(() => { status.frozen = true; }, TypeError);
  assert.equal(detector.isFrozen(TOKEN).frozen, false);
});

test("bad options, token ids and clocks fail loudly instead of disabling a rule", () => {
  for (const velocityLimit of [0, -1, 1.5, Number.NaN, "abc", "", true]) {
    assert.throws(() => createDetector({ velocityLimit }), /velocityLimit must be a positive integer/);
  }
  for (const denialLimit of [0, 2.5, "x"]) {
    assert.throws(() => createDetector({ denialLimit }), /denialLimit must be a positive integer/);
  }
  assert.throws(() => createDetector({ now: "soon" }), /now must be a function/);
  const fromEnv = createDetector({ now: () => T0, velocityLimit: "1", denialLimit: null });
  startN(fromEnv, TOKEN, 2);
  assert.equal(fromEnv.isFrozen(TOKEN).reason, "velocity");

  const detector = createDetector({ now: () => T0 });
  for (const bad of [undefined, null, "", 7]) {
    assert.throws(() => detector.recordWorkStart(bad), /tokenId must be a non-empty string/);
    assert.throws(() => detector.isFrozen(bad), TypeError);
  }
  const broken = createDetector({ now: () => Number.NaN });
  assert.throws(() => broken.recordWorkStart(TOKEN), /clock returned a non-finite time/);
});

const mandateRecord = (mandateId = "mnd_0123456789abcdef") => ({
  mandate: { v: 1, mandateId, tokenId: TOKEN, productId: "prd_1", quantity: 1, unitPrice: "128.00", maxTotal: "128.00", selections: { size: "standard" } },
  signature: "ab".repeat(32),
});

test("mandate store: put, get and size", () => {
  const store = createMandateStore();
  assert.equal(store.size(), 0);
  assert.equal(store.get("mnd_0123456789abcdef"), null);
  store.put(mandateRecord());
  assert.equal(store.size(), 1);
  assert.deepEqual(store.get("mnd_0123456789abcdef"), mandateRecord());
  assert.equal(store.get("mnd_missing"), null);
  for (const bad of [undefined, null, "", 3]) assert.equal(store.get(bad), null);
});

test("mandate store keeps a frozen copy the caller cannot alter", () => {
  const store = createMandateStore();
  const input = mandateRecord();
  store.put(input);
  input.mandate.quantity = 50;
  input.mandate.selections.size = "xl";
  const stored = store.get("mnd_0123456789abcdef");
  assert.equal(stored.mandate.quantity, 1);
  assert.equal(stored.mandate.selections.size, "standard");
  assert.ok(Object.isFrozen(stored) && Object.isFrozen(stored.mandate) && Object.isFrozen(stored.mandate.selections));
  assert.throws(() => { stored.mandate.quantity = 50; }, TypeError);
});

test("mandate store refuses to overwrite a mandateId and rejects malformed records", () => {
  const store = createMandateStore();
  store.put(mandateRecord());
  const swapped = { ...mandateRecord(), mandate: { ...mandateRecord().mandate, quantity: 50 } };
  assert.throws(() => store.put(swapped), /mandate mnd_0123456789abcdef already stored/);
  assert.equal(store.get("mnd_0123456789abcdef").mandate.quantity, 1);
  const bad = [undefined, {}, { mandate: {}, signature: "ab" }, { mandate: { mandateId: "" }, signature: "ab" }, { mandate: { mandateId: "mnd_x" }, signature: "" }, { mandate: { mandateId: "mnd_x" } }];
  for (const record of bad) assert.throws(() => store.put(record), TypeError);
  assert.equal(store.size(), 1);
});

test("mandate store evicts the oldest mandate past its limit (evicted = unknown, fail closed)", () => {
  assert.equal(MAX_MANDATES, 10_000);
  const store = createMandateStore({ limit: 2 });
  ["mnd_a", "mnd_b", "mnd_c"].forEach((id) => store.put(mandateRecord(id)));
  assert.equal(store.size(), 2);
  assert.equal(store.get("mnd_a"), null);
  assert.equal(store.get("mnd_c").mandate.mandateId, "mnd_c");
});

test("a repeated work-start key inside the window counts once (client retries resend the same requestId); a new key counts", () => {
  const clock = manualClock();
  const detector = createDetector({ now: clock.now, velocityLimit: 2 });
  const retries = Array.from({ length: 4 }, () => detector.recordWorkStart(TOKEN, "patterns/create#req-1"));
  assert.deepEqual(retries, Array(4).fill({ allowed: true, count: 1 }));
  assert.equal(detector.status(TOKEN).workStartsLastMinute, 1);
  assert.deepEqual(detector.recordWorkStart(TOKEN, "products/create#req-2"), { allowed: true, count: 2 });
  assert.deepEqual(detector.recordWorkStart(TOKEN, "patterns/create#req-3"), { allowed: false, count: 3 });
  assert.equal(detector.isFrozen(TOKEN).reason, "velocity");

  const keyless = createDetector({ now: clock.now, velocityLimit: 2 });
  assert.deepEqual([null, null, null].map(() => keyless.recordWorkStart(OTHER).allowed), [true, true, false]);
  const sliding = createDetector({ now: clock.now });
  sliding.recordWorkStart(TOKEN, "k");
  clock.advance(VELOCITY_WINDOW_MS);
  assert.deepEqual(sliding.recordWorkStart(TOKEN, "k"), { allowed: true, count: 1 });
});
