// Replica state: one plain object, replaced (never mutated) on every write, and
// persisted to a JSON file so restarts keep ids. stateFile null = memory only.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";

const STATE_VERSION = 1;
const ID_BYTES = 12;

export const emptyState = () => ({
  version: STATE_VERSION,
  counters: { seq: 0, checkout: 1000000000, order: 5000000000, orderNumber: 1000 },
  patterns: {},
  jobs: {},
  products: {},
  references: {},
  uploads: {},
  checkouts: {},
  orders: {},
  idempotency: {},
});

export const newId = (prefix) => `${prefix}${randomBytes(ID_BYTES).toString("hex")}`;

export function bumpCounter(state, name) {
  const value = state.counters[name] + 1;
  return { state: { ...state, counters: { ...state.counters, [name]: value } }, value };
}

export function putRecord(state, collection, id, record) {
  const { state: next, value: seq } = bumpCounter(state, "seq");
  return { ...next, [collection]: { ...next[collection], [id]: { ...record, seq } } };
}

export const replaceRecord = (state, collection, id, record) => ({
  ...state,
  [collection]: { ...state[collection], [id]: record },
});

function loadState(stateFile, logger) {
  if (!stateFile) return emptyState();
  let text;
  try {
    text = readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") logger(`[mock] could not read ${stateFile}: ${error.message}; starting empty`);
    return emptyState();
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== STATE_VERSION) throw new Error(`unsupported state version ${parsed?.version}`);
    return { ...emptyState(), ...parsed, counters: { ...emptyState().counters, ...parsed.counters } };
  } catch (error) {
    logger(`[mock] ignoring corrupt ${stateFile}: ${error.message}; starting empty`);
    return emptyState();
  }
}

function persist(stateFile, state, logger) {
  if (!stateFile) return;
  const tmp = `${stateFile}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, stateFile);
  } catch (error) {
    logger(`[mock] could not persist ${stateFile}: ${error.message}`);
  }
}

export function createStore({ stateFile = null, logger = console.log } = {}) {
  let current = loadState(stateFile, logger);
  return {
    get: () => current,
    commit(next) {
      if (next === current) return current;
      current = next;
      persist(stateFile, current, logger);
      return current;
    },
  };
}

const encodeCursor = (offset) => Buffer.from(JSON.stringify({ offset })).toString("base64url");

export function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

export const newestFirst = (records) => [...records].sort((a, b) => b.seq - a.seq);

export function paginate(records, offset, limit) {
  const items = records.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  return { items, nextCursor: nextOffset < records.length ? encodeCursor(nextOffset) : null };
}
