// Append-only, hash-chained audit log of every gateway attempt, approved and denied. Each record's
// hash covers its seq, timestamp and entry plus the previous record's hash, so editing, deleting or
// reordering any line breaks the chain from that point on. With a path the ledger is JSONL on disk:
// verified on load, one line per record, written before append() returns.
import { appendFileSync, readFileSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./signing.mjs";

export const GENESIS_HASH = "0".repeat(64);

const RESERVED_FIELDS = Object.freeze(["seq", "at", "prevHash", "hash"]);
const FILE_MODE = 0o600;
const HASH_SHAPE = /^[0-9a-f]{64}$/;
const CHAIN_OK = Object.freeze({ ok: true });

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// JSON round trip first, so what is hashed is exactly what a reload parses back: Dates become ISO
// strings, undefined keys vanish, NaN becomes null, and a cycle throws here instead of corrupting a line.
export const frozenJsonCopy = (value) => deepFreeze(JSON.parse(JSON.stringify(value)));

const hashOf = (prevHash, body) => sha256Hex(prevHash + canonicalJson(body));

function normaliseEntry(entry) {
  if (!isPlainObject(entry)) throw new TypeError("ledger entry must be a plain object");
  const clean = JSON.parse(JSON.stringify(entry));
  if (!isPlainObject(clean)) throw new TypeError("ledger entry must be a plain object");
  const reserved = RESERVED_FIELDS.find((key) => Object.hasOwn(clean, key));
  if (reserved) throw new TypeError(`ledger entry must not set the reserved field ${reserved}`);
  return clean;
}

function buildRecord(entry, { seq, at, prevHash }) {
  const hash = hashOf(prevHash, { seq, at, ...entry });
  return deepFreeze({ seq, at, prevHash, hash, ...entry });
}

function isIntactLink(record, seq, prevHash) {
  if (!isPlainObject(record) || record.seq !== seq || record.prevHash !== prevHash) return false;
  if (typeof record.hash !== "string" || !HASH_SHAPE.test(record.hash)) return false;
  const { prevHash: _link, hash, ...body } = record;
  return hashOf(prevHash, body) === hash;
}

// Recomputes every hash and every link from GENESIS; brokenAt is the 1-based position of the first bad record.
export function verifyChain(records) {
  if (!Array.isArray(records)) throw new TypeError("verifyChain needs an array of ledger records");
  let prevHash = GENESIS_HASH;
  for (const [index, record] of records.entries()) {
    const seq = index + 1;
    if (!isIntactLink(record, seq, prevHash)) return { ok: false, brokenAt: seq };
    prevHash = record.hash;
  }
  return CHAIN_OK;
}

function parseLine(line, seq) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`ledger chain broken at seq ${seq}`);
  }
}

function loadRecords(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`could not read ledger ${path}: ${error.message}`, { cause: error });
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const records = lines.map((line, index) => parseLine(line, index + 1));
  const result = verifyChain(records);
  if (!result.ok) throw new Error(`ledger chain broken at seq ${result.brokenAt}`);
  return records.map(deepFreeze);
}

export function createLedger({ path = null, now = () => Date.now() } = {}) {
  let records = Object.freeze(path ? loadRecords(path) : []);
  // Create the file up front: an unwritable path fails at start-up, not on the first denial.
  if (path) appendFileSync(path, "", { mode: FILE_MODE });

  const head = () => records.at(-1)?.hash ?? GENESIS_HASH;

  return {
    append(entry) {
      const clean = normaliseEntry(entry);
      const at = new Date(now()).toISOString();
      const record = buildRecord(clean, { seq: records.length + 1, at, prevHash: head() });
      if (path) appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
      records = Object.freeze([...records, record]);
      return record;
    },
    entries: () => Object.freeze([...records]),
    head,
    size: () => records.length,
  };
}
