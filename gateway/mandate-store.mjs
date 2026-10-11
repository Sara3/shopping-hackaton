// Signed mandates by mandateId, held only by the gateway. The Map is replaced on every write and
// each stored record is a frozen JSON copy, so nothing a caller still holds can alter a mandate
// after it was signed, and a mandateId can never be overwritten. Past the limit the oldest mandate
// is evicted; an evicted mandate is simply unknown at checkout, which fails closed.
import { frozenJsonCopy } from "./ledger.mjs";

export const MAX_MANDATES = 10_000;

function validateRecord(record) {
  const mandate = record?.mandate;
  if (mandate === null || typeof mandate !== "object" || Array.isArray(mandate)) {
    throw new TypeError("mandate store needs { mandate, signature } with mandate as an object");
  }
  if (typeof mandate.mandateId !== "string" || mandate.mandateId === "") {
    throw new TypeError("mandate store needs mandate.mandateId as a non-empty string");
  }
  if (typeof record.signature !== "string" || record.signature === "") {
    throw new TypeError("mandate store needs signature as a non-empty string");
  }
  return mandate.mandateId;
}

export function createMandateStore({ limit = MAX_MANDATES } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`limit must be a positive integer, got ${limit}`);
  let mandates = new Map();

  return {
    put(record) {
      const mandateId = validateRecord(record);
      if (mandates.has(mandateId)) throw new Error(`mandate ${mandateId} already stored`);
      const stored = frozenJsonCopy({ mandate: record.mandate, signature: record.signature });
      const next = new Map(mandates).set(mandateId, stored);
      if (next.size > limit) next.delete(next.keys().next().value);
      mandates = next;
      return stored;
    },
    get: (mandateId) => (typeof mandateId === "string" ? mandates.get(mandateId) ?? null : null),
    size: () => mandates.size,
  };
}
