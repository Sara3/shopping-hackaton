import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, spentCents, verifyChain, GENESIS_HASH } from "../gateway/ledger.mjs";
import { canonicalJson, sha256Hex } from "../gateway/signing.mjs";

const T0 = Date.parse("2026-10-11T18:00:00.000Z");
const STEP_MS = 1000;

const steppingClock = (start = T0) => {
  let current = start - STEP_MS;
  return () => (current += STEP_MS);
};

const row = (overrides = {}) => ({
  tokenId: "tok_0123456789abcdef",
  agentId: "web-agent",
  endpoint: "/arcade",
  procedure: "/categories/list",
  decision: "approved",
  code: null,
  rule: null,
  detail: { status: 200 },
  ...overrides,
});

const recompute = (record) => {
  const { prevHash, hash, ...rest } = record;
  return sha256Hex(prevHash + canonicalJson(rest));
};

const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "leash-ledger-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const fillLedger = (ledger) => [
  ledger.append(row()),
  ledger.append(row({ endpoint: "/mandates", procedure: null, detail: { productId: "prd_1", quantity: 1 } })),
  ledger.append(row({ endpoint: "/checkout", procedure: null, decision: "denied", code: "mandate_mismatch", rule: "quantity_above_mandate", detail: { quantity: 50 } })),
];

test("GENESIS_HASH is 64 zeros", () => {
  assert.equal(GENESIS_HASH, "0".repeat(64));
});

test("an empty ledger has size 0 and head GENESIS", () => {
  const ledger = createLedger();
  assert.equal(ledger.size(), 0);
  assert.equal(ledger.head(), GENESIS_HASH);
  assert.deepEqual(ledger.entries(), []);
});

test("append chains seq, prevHash and hash from GENESIS", () => {
  const ledger = createLedger({ now: steppingClock() });
  const [first, second, third] = fillLedger(ledger);

  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(first.at, "2026-10-11T18:00:00.000Z");
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  assert.equal(second.at, "2026-10-11T18:00:01.000Z");
  assert.equal(third.seq, 3);
  assert.equal(third.prevHash, second.hash);
  assert.equal(ledger.head(), third.hash);
  assert.equal(ledger.size(), 3);
  assert.equal(third.rule, "quantity_above_mandate");
  assert.equal(third.detail.quantity, 50);
});

test("hash is sha256Hex(prevHash + canonicalJson({ seq, at, ...entry })) exactly", () => {
  const ledger = createLedger({ now: () => T0 });
  const entry = row({ detail: { b: 2, a: 1 } });
  const record = ledger.append(entry);
  const expected = sha256Hex(GENESIS_HASH + canonicalJson({ seq: 1, at: "2026-10-11T18:00:00.000Z", ...entry }));
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  assert.equal(record.hash, expected);
  assert.equal(recompute(record), record.hash);
});

test("records and entries() are frozen copies the caller cannot change", () => {
  const ledger = createLedger({ now: () => T0 });
  const entry = row({ detail: { nested: { value: 1 } } });
  const record = ledger.append(entry);
  entry.detail.nested.value = 999;
  entry.decision = "denied";

  const entries = ledger.entries();
  assert.ok(Object.isFrozen(entries));
  assert.ok(Object.isFrozen(entries[0]));
  assert.ok(Object.isFrozen(entries[0].detail.nested));
  assert.throws(() => entries.push(record), TypeError);
  assert.throws(() => { record.decision = "denied"; }, TypeError);
  assert.equal(ledger.entries()[0].detail.nested.value, 1);
  assert.equal(ledger.entries()[0].decision, "approved");
  assert.notEqual(ledger.entries(), entries);
});

test("append rejects non-object entries and reserved keys", () => {
  const ledger = createLedger();
  for (const bad of [null, undefined, "text", 7, ["array"]]) {
    assert.throws(() => ledger.append(bad), /ledger entry must be a plain object/);
  }
  for (const key of ["seq", "at", "prevHash", "hash"]) {
    assert.throws(() => ledger.append(row({ [key]: "forged" })), new RegExp(`reserved field ${key}`));
  }
  assert.equal(ledger.size(), 0);
  assert.equal(ledger.head(), GENESIS_HASH);
});

test("verifyChain accepts an intact chain and an empty one", () => {
  const ledger = createLedger({ now: steppingClock() });
  fillLedger(ledger);
  assert.deepEqual(verifyChain(ledger.entries()), { ok: true });
  assert.deepEqual(verifyChain([]), { ok: true });
});

test("verifyChain reports the first broken seq when a middle record is mutated", () => {
  const ledger = createLedger({ now: steppingClock() });
  fillLedger(ledger);
  const records = ledger.entries();
  const tampered = [records[0], { ...records[1], detail: { productId: "prd_1", quantity: 50 } }, records[2]];
  assert.deepEqual(verifyChain(tampered), { ok: false, brokenAt: 2 });

  const rehashed = { ...tampered[1], hash: recompute(tampered[1]) };
  assert.deepEqual(verifyChain([records[0], rehashed, records[2]]), { ok: false, brokenAt: 3 });
});

test("verifyChain catches deleted, reordered, relinked and renumbered records", () => {
  const ledger = createLedger({ now: steppingClock() });
  const [first, second, third] = fillLedger(ledger);
  assert.deepEqual(verifyChain([first, third]), { ok: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([second, first, third]), { ok: false, brokenAt: 1 });
  assert.deepEqual(verifyChain([first, { ...second, prevHash: GENESIS_HASH }, third]), { ok: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([{ ...first, seq: 7 }, second, third]), { ok: false, brokenAt: 1 });
  assert.deepEqual(verifyChain([first, null, third]), { ok: false, brokenAt: 2 });
  assert.throws(() => verifyChain("not records"), TypeError);
});

test("file persistence writes one JSON line per record, durable before append returns", () => {
  withTempDir((dir) => {
    const path = join(dir, "ledger.jsonl");
    const ledger = createLedger({ path, now: steppingClock() });
    const first = ledger.append(row());
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8").trim()), first);
    const second = ledger.append(row({ decision: "denied", code: "scope_denied", rule: "scope" }));

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [first, second]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("a reloaded ledger continues the chain from the stored head", () => {
  withTempDir((dir) => {
    const path = join(dir, "ledger.jsonl");
    const original = createLedger({ path, now: steppingClock() });
    fillLedger(original);

    const reloaded = createLedger({ path, now: () => T0 + 60_000 });
    assert.equal(reloaded.size(), 3);
    assert.equal(reloaded.head(), original.head());
    assert.deepEqual(reloaded.entries(), original.entries());

    const fourth = reloaded.append(row({ endpoint: "/tokens", procedure: null }));
    assert.equal(fourth.seq, 4);
    assert.equal(fourth.prevHash, original.head());
    assert.deepEqual(verifyChain(reloaded.entries()), { ok: true });
    assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 4);
  });
});

test("a missing ledger file starts an empty chain and creates the file", () => {
  withTempDir((dir) => {
    const path = join(dir, "fresh.jsonl");
    const ledger = createLedger({ path });
    assert.equal(ledger.size(), 0);
    assert.equal(ledger.head(), GENESIS_HASH);
    assert.ok(existsSync(path));
  });
});

test("a tampered ledger file throws on load", () => {
  withTempDir((dir) => {
    const path = join(dir, "ledger.jsonl");
    fillLedger(createLedger({ path, now: steppingClock() }));
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const forged = { ...JSON.parse(lines[1]), detail: { productId: "prd_1", quantity: 50 } };
    writeFileSync(path, [lines[0], JSON.stringify(forged), lines[2]].join("\n") + "\n");
    assert.throws(() => createLedger({ path }), /^Error: ledger chain broken at seq 2$/);

    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");
    assert.throws(() => createLedger({ path }), /ledger chain broken at seq 2/);
  });
});

test("a ledger file with a non-JSON line throws on load", () => {
  withTempDir((dir) => {
    const path = join(dir, "ledger.jsonl");
    fillLedger(createLedger({ path, now: steppingClock() }));
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, [lines[0], lines[1], "{torn write"].join("\n"));
    assert.throws(() => createLedger({ path }), /ledger chain broken at seq 3/);
  });
});

test("values that JSON cannot round-trip are normalised so the file still verifies", () => {
  withTempDir((dir) => {
    const path = join(dir, "ledger.jsonl");
    const ledger = createLedger({ path, now: () => T0 });
    const record = ledger.append(row({ detail: { when: new Date(T0), skipped: undefined, ratio: Number.NaN } }));
    assert.equal(record.detail.when, "2026-10-11T18:00:00.000Z");
    assert.equal(Object.hasOwn(record.detail, "skipped"), false);
    assert.equal(record.detail.ratio, null);
    assert.equal(createLedger({ path }).head(), record.hash);
  });
});

test("spentCents sums only the approved /checkout rows of that token", () => {
  const ledger = createLedger({ now: steppingClock() });
  const checkoutRow = (overrides = {}) => row({ endpoint: "/checkout", procedure: null, detail: { totalCents: 12800 }, ...overrides });
  const other = "tok_fedcba9876543210";
  ledger.append(checkoutRow());
  ledger.append(checkoutRow({ detail: { totalCents: 500 } }));
  ledger.append(checkoutRow({ tokenId: other, detail: { totalCents: 99_900 } }));
  ledger.append(checkoutRow({ decision: "denied", code: "allowance_exceeded", rule: "allowance_exceeded", detail: { totalCents: 7700 } }));
  ledger.append(row({ endpoint: "/mandates", procedure: null, detail: { totalCents: 4200 } }));
  ledger.append(row({ detail: { totalCents: 4200 } }));
  ledger.append(checkoutRow({ detail: { lines: [] } }));
  ledger.append(checkoutRow({ detail: { totalCents: "300" } }));
  ledger.append(checkoutRow({ detail: { totalCents: 1.5 } }));
  ledger.append(checkoutRow({ detail: null }));

  const entries = ledger.entries();
  assert.equal(spentCents(entries, row().tokenId), 13_300);
  assert.equal(spentCents(entries, other), 99_900);
  assert.equal(spentCents(entries, "tok_0000000000000000"), 0);
  assert.equal(spentCents([], row().tokenId), 0);
});
