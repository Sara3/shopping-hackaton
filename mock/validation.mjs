// Tiny schema checks. Each rule returns an error message or null; validate() collects
// them into Arcade's { fieldErrors, formErrors } and returns a 422 result or null.
import { validationFailed } from "./errors.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const str = ({ min = 1, max = Infinity, optional = false, nullable = false, pattern } = {}) => (value) => {
  if (value === undefined) return optional ? null : "Required";
  if (value === null) return nullable ? null : "Expected string, received null";
  if (typeof value !== "string") return `Expected string, received ${typeof value}`;
  if (value.length < min) return `String must contain at least ${min} character(s)`;
  if (value.length > max) return `String must contain at most ${max} character(s)`;
  if (pattern && !pattern.test(value)) return "Invalid format";
  return null;
};

export const int = ({ min = -Infinity, max = Infinity, optional = false } = {}) => (value) => {
  if (value === undefined) return optional ? null : "Required";
  if (!Number.isInteger(value)) return "Expected integer";
  if (value < min) return `Number must be greater than or equal to ${min}`;
  if (value > max) return `Number must be less than or equal to ${max}`;
  return null;
};

export const bool = ({ optional = false } = {}) => (value) => {
  if (value === undefined) return optional ? null : "Required";
  return typeof value === "boolean" ? null : "Expected boolean";
};

export const oneOf = (allowed, { optional = false } = {}) => (value) => {
  if (value === undefined) return optional ? null : "Required";
  return allowed.includes(value) ? null : `Expected one of: ${allowed.join(", ")}`;
};

export const stringArray = ({ maxItems = Infinity, optional = false } = {}) => (value) => {
  if (value === undefined) return optional ? null : "Required";
  if (!Array.isArray(value)) return "Expected array";
  if (value.length > maxItems) return `Array must contain at most ${maxItems} element(s)`;
  return value.every((item) => typeof item === "string" && item.length > 0) ? null : "Expected non-empty strings";
};

export const stringMap = ({ optional = false } = {}) => (value) => {
  if (value === undefined) return optional ? null : "Required";
  if (!isObject(value)) return "Expected object";
  return Object.values(value).every((item) => typeof item === "string") ? null : "Expected string values";
};

export const requestIdRule = str({ min: 1, max: 128 });

export function collectErrors(body, schema) {
  return Object.entries(schema).reduce((errors, [field, rule]) => {
    const message = rule(body[field]);
    return message ? { ...errors, [field]: [message] } : errors;
  }, {});
}

export function validate(body, schema, extraChecks = () => ({})) {
  if (!isObject(body)) return validationFailed({}, ["Expected a JSON object body"]);
  const fieldErrors = { ...collectErrors(body, schema), ...extraChecks(body) };
  return Object.keys(fieldErrors).length ? validationFailed(fieldErrors) : null;
}

export const LIMITS = Object.freeze({ patterns: 60, references: 60, products: 100, orders: 50 });
export const DEFAULT_LIMITS = Object.freeze({ patterns: 24, references: 24, products: 24, orders: 20 });

export const listSchema = (kind) => ({
  cursor: str({ optional: true, nullable: true }),
  limit: int({ min: 1, max: LIMITS[kind], optional: true }),
});
