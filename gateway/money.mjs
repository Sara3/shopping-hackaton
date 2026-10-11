// Money in integer cents. Prices arrive as decimal strings ("128.00") and leave the same way;
// no float arithmetic ever touches a price, so 50 x 102.40 is exactly 5120.00.
import { badRequest } from "./errors.mjs";

const CENTS = 100;
const DECIMAL = /^\d{1,12}(\.\d{1,2})?$/;

export const isDecimalAmount = (value) => typeof value === "string" && DECIMAL.test(value.trim());

export function toCents(value) {
  const text = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toFixed(2) : String(value ?? "").trim();
  if (!DECIMAL.test(text)) throw badRequest(`amount must be a non-negative decimal like "128.00", got ${JSON.stringify(value)}`);
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * CENTS + Number(fraction.padEnd(2, "0"));
}

export function formatCents(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`formatCents needs a non-negative integer, got ${cents}`);
  return `${Math.floor(cents / CENTS)}.${String(cents % CENTS).padStart(2, "0")}`;
}
