import { formatCents, isDecimalAmount, toCents } from "../gateway/money.mjs";
import { DEFAULT_CATEGORIES } from "./leash.mjs";
import { SESSION_ID_PATTERN } from "./sessions.mjs";

export const MAX_TEXT_LENGTH = 2000;
export const MAX_INSPIRATION_LENGTH = 8000;
// What the Settings screen lets a person allow: the catalog names the gateway matches categories on.
export const KNOWN_CATEGORIES = DEFAULT_CATEGORIES;
export const ALLOWANCE_PERIODS = Object.freeze(["week", "month"]);
export const MIN_ALLOWANCE_CENTS = 100;
export const MAX_ALLOWANCE_CENTS = 10_000_000;
export const MIN_ALLOWANCE_DAYS = 1;
export const MAX_ALLOWANCE_DAYS = 30;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new HttpError(400, "bad_request", message);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw bad("sessionId must be 1-80 characters of letters, digits, _ or -");
  }
  return value;
}

export function validateChatBody(body) {
  if (!isPlainObject(body)) throw bad("body must be a JSON object");
  const sessionId = validateSessionId(body.sessionId);
  if (typeof body.text !== "string" || body.text.trim() === "") throw bad("text must be a non-empty string");
  if (body.text.length > MAX_TEXT_LENGTH) throw bad(`text must be at most ${MAX_TEXT_LENGTH} characters`);
  const inspiration = body.inspiration ?? "";
  if (typeof inspiration !== "string") throw bad("inspiration must be a string");
  if (inspiration.length > MAX_INSPIRATION_LENGTH) throw bad(`inspiration must be at most ${MAX_INSPIRATION_LENGTH} characters`);
  return { sessionId, text: body.text.trim(), inspiration };
}

export function validateResetBody(body) {
  if (!isPlainObject(body)) throw bad("body must be a JSON object");
  return { sessionId: validateSessionId(body.sessionId) };
}

export function validateAgentResult(result) {
  if (!isPlainObject(result) || !isPlainObject(result.session) || typeof result.reply !== "string") {
    throw new HttpError(502, "agent_bad_result", "agent returned an unexpected result (need session object and reply string)");
  }
  return {
    session: result.session,
    reply: result.reply,
    cards: Array.isArray(result.cards) ? result.cards : [],
    trace: result.trace ?? {},
  };
}

// Numbers are read through String() so 12.345 is refused instead of silently rounded (as the gateway does).
function validateAllowanceAmount(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const range = `${formatCents(MIN_ALLOWANCE_CENTS)} to ${formatCents(MAX_ALLOWANCE_CENTS)}`;
  if (typeof text !== "string" || !isDecimalAmount(text)) throw bad(`maxSpend must be a dollar amount from ${range} with at most 2 decimals`);
  const cents = toCents(text);
  if (cents < MIN_ALLOWANCE_CENTS || cents > MAX_ALLOWANCE_CENTS) throw bad(`maxSpend must be a dollar amount from ${range}`);
  return formatCents(cents);
}

function validateAllowanceCategories(value) {
  const limit = KNOWN_CATEGORIES.length;
  const isKnown = Array.isArray(value) && value.every((name) => KNOWN_CATEGORIES.includes(name));
  if (!isKnown || value.length < 1 || value.length > limit || new Set(value).size !== value.length) {
    throw bad(`categories must name 1 to ${limit} different things from: ${KNOWN_CATEGORIES.join(", ")}`);
  }
  return Object.freeze([...value]);
}

// { maxSpend: "200.00", period: "week", categories: [...], days: 7 }: what a person lets the agent spend.
export function validateAllowanceBody(body) {
  if (!isPlainObject(body)) throw bad("body must be a JSON object");
  if (!ALLOWANCE_PERIODS.includes(body.period)) throw bad(`period must be one of: ${ALLOWANCE_PERIODS.join(", ")}`);
  if (!Number.isInteger(body.days) || body.days < MIN_ALLOWANCE_DAYS || body.days > MAX_ALLOWANCE_DAYS) {
    throw bad(`days must be a whole number from ${MIN_ALLOWANCE_DAYS} to ${MAX_ALLOWANCE_DAYS}`);
  }
  return Object.freeze({
    maxSpend: validateAllowanceAmount(body.maxSpend),
    period: body.period,
    categories: validateAllowanceCategories(body.categories),
    days: body.days,
  });
}
