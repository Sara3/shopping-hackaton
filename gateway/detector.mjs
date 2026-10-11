// Per-token hijack detector: velocity of work-starting calls, denial count, freeze state and
// single-use mandates. State lives in private Maps/Sets that are replaced, never mutated in place,
// on every write (same pattern as web/sessions.mjs); everything handed out is a frozen snapshot.
// Bad configuration throws: a NaN limit or clock would silently switch a rule off.

export const VELOCITY_LIMIT = 5;
export const VELOCITY_WINDOW_MS = 60_000;
export const DENIAL_LIMIT = 3;
export const VELOCITY_RULE = "velocity";
export const DENIAL_RULE = "denial_count";
const UNSPECIFIED_REASON = "unspecified";
const DIGITS = /^\d+$/;

const EMPTY_TOKEN = Object.freeze({ frozen: false, reason: null, at: null, denials: 0, workStarts: Object.freeze([]) });

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" && DIGITS.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${name} must be a positive integer, got ${String(value)}`);
  return number;
}

function assertTokenId(tokenId) {
  if (typeof tokenId !== "string" || tokenId === "") throw new TypeError("tokenId must be a non-empty string");
  return tokenId;
}

const reasonOrDefault = (reason) => (typeof reason === "string" && reason.trim() !== "" ? reason : UNSPECIFIED_REASON);
const inWindow = (workStarts, nowMs) => workStarts.filter((start) => nowMs - start.at < VELOCITY_WINDOW_MS);
const isRepeat = (recent, key) => key !== null && recent.some((start) => start.key === key);
const withFreeze = (state, reason, nowMs) =>
  state.frozen ? state : { ...state, frozen: true, reason: reasonOrDefault(reason), at: new Date(nowMs).toISOString() };

const frozenView = (state) => Object.freeze({ frozen: state.frozen, reason: state.reason, at: state.at });
const statusView = (state, nowMs) =>
  Object.freeze({ ...frozenView(state), denials: state.denials, workStartsLastMinute: inWindow(state.workStarts, nowMs).length });

function createTokenTable() {
  let tokens = new Map();
  return {
    read: (tokenId) => tokens.get(assertTokenId(tokenId)) ?? EMPTY_TOKEN,
    write(tokenId, state) {
      const stored = Object.freeze(state);
      tokens = new Map(tokens).set(tokenId, stored);
      return stored;
    },
  };
}

function createClock(now) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  return () => {
    const ms = now();
    if (!Number.isFinite(ms)) throw new Error(`detector clock returned a non-finite time: ${ms}`);
    return ms;
  };
}

function freeze({ table, clock }, tokenId, reason) {
  const nowMs = clock();
  const state = table.read(tokenId);
  const next = state.frozen ? state : table.write(tokenId, withFreeze(state, reason, nowMs));
  return statusView(next, nowMs);
}

// Sliding window over the last VELOCITY_WINDOW_MS. A frozen token is never allowed and stops
// accumulating entries, so the stored window never exceeds velocityLimit + 1 entries. `key` names one
// logical call (the proxy passes procedure + requestId + body): a client retry resends the same body,
// which Arcade replays idempotently, so a key already inside the window starts no new work.
function recordWorkStart({ table, clock, limits }, tokenId, key = null) {
  const nowMs = clock();
  const state = table.read(tokenId);
  const recent = inWindow(state.workStarts, nowMs);
  if (state.frozen) return Object.freeze({ allowed: false, count: recent.length });
  if (isRepeat(recent, key)) return Object.freeze({ allowed: true, count: recent.length });
  const workStarts = Object.freeze([...recent, Object.freeze({ at: nowMs, key })]);
  const allowed = workStarts.length <= limits.velocity;
  const next = { ...state, workStarts };
  table.write(tokenId, allowed ? next : withFreeze(next, VELOCITY_RULE, nowMs));
  return Object.freeze({ allowed, count: workStarts.length });
}

// Every denial counts the same whatever its code. frozeNow is true only on the call that froze the
// token for denial_count, so the server writes that ledger row exactly once.
function recordDenial({ table, clock, limits }, tokenId) {
  const nowMs = clock();
  const state = table.read(tokenId);
  const counted = { ...state, denials: state.denials + 1 };
  const frozeNow = !state.frozen && counted.denials >= limits.denials;
  const next = table.write(tokenId, frozeNow ? withFreeze(counted, DENIAL_RULE, nowMs) : counted);
  return Object.freeze({ denials: next.denials, frozen: next.frozen, frozeNow });
}

function createConsumedMandates() {
  let consumed = new Set();
  return (mandateId) => {
    if (typeof mandateId !== "string" || mandateId === "" || consumed.has(mandateId)) return false;
    consumed = new Set(consumed).add(mandateId);
    return true;
  };
}

export function createDetector({ now = () => Date.now(), velocityLimit, denialLimit } = {}) {
  const ctx = Object.freeze({
    table: createTokenTable(),
    clock: createClock(now),
    limits: Object.freeze({
      velocity: positiveInteger(velocityLimit, VELOCITY_LIMIT, "velocityLimit"),
      denials: positiveInteger(denialLimit, DENIAL_LIMIT, "denialLimit"),
    }),
  });
  return Object.freeze({
    isFrozen: (tokenId) => frozenView(ctx.table.read(tokenId)),
    freeze: (tokenId, reason) => freeze(ctx, tokenId, reason),
    recordWorkStart: (tokenId, key = null) => recordWorkStart(ctx, tokenId, typeof key === "string" && key !== "" ? key : null),
    recordDenial: (tokenId, _code) => recordDenial(ctx, tokenId),
    consumeMandate: createConsumedMandates(),
    status: (tokenId) => statusView(ctx.table.read(tokenId), ctx.clock()),
  });
}
