// The allowance a person sets in Settings, and the agent it switches on. One store per process, holding
// { allowance, agent, leash } or null; it is replaced, never mutated. With a gateway the state carries a
// Leash agent (a scoped token, mandates) built for that allowance; without one it only remembers it.
import { HttpError } from "./validate.mjs";

export const LEASH_KEY_PREFIX = "none (leash)";
export const SET_ALLOWANCE_MESSAGE = "set an allowance first (no account key in this process)";

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export const allowanceState = ({ allowance, agent = null, leash = null }) => Object.freeze({ allowance, agent, leash });

export function createAllowanceStore(initial = null) {
  let current = initial ? allowanceState(initial) : null;
  return Object.freeze({
    current: () => current,
    replace(next) { current = allowanceState(next); },
    clear() { current = null; },
  });
}

// What /api/config shows: the base config, with the key line following who holds what (a Leash token
// instead of the account key once an allowance is live) and the allowance itself. `leash` appears only
// when a gateway is configured, so a process without one keeps the config it always had.
export function configFor(base, state, hasGateway) {
  const isLeashed = Boolean(state?.leash);
  return {
    ...base,
    keyPresent: isLeashed ? false : base.keyPresent,
    keyPrefix: isLeashed ? LEASH_KEY_PREFIX : base.keyPrefix,
    allowance: state?.allowance ?? null,
    gateway: hasGateway,
    ...(hasGateway && { leash: state?.leash?.publicInfo?.() ?? null }),
  };
}

// The new store state for a validated allowance. With a gateway the factory issues the token now, so a
// gateway that cannot is a 502 here and the previous state stays in place.
export async function buildAllowanceState(allowance, leashFactory) {
  if (!leashFactory) return allowanceState({ allowance });
  try {
    const { agent, leash } = await leashFactory(allowance);
    if (typeof agent?.handleMessage !== "function") throw new Error("the agent for this allowance did not load");
    return allowanceState({ allowance, agent, leash });
  } catch (error) {
    throw new HttpError(502, "leash_unavailable", messageOf(error));
  }
}
