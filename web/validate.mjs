import { SESSION_ID_PATTERN } from "./sessions.mjs";

export const MAX_TEXT_LENGTH = 2000;
export const MAX_INSPIRATION_LENGTH = 8000;

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
