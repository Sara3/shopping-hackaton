import { AsyncLocalStorage } from "node:async_hooks";
import { maskKey } from "./config.mjs";

// Arcade's checkouts/create (direct, or attempted through the Leash proxy), the Leash gateway's own
// POST /checkout, and the gateway's POST /simulated-checkout (a key-holding agent's checkout with Leash off
// on live Arcade), matched on the URL path so the raw box also shows a gateway 403 body.
export const CHECKOUT_PATHS = Object.freeze(["/checkouts/create", "/checkout", "/simulated-checkout"]);
// Who made the recorded call: the gateway's own /checkout, or the agent (Arcade directly, via the proxy, or
// the receipt it hands the gateway instead of an Arcade checkout).
const SOURCE_BY_PATH = Object.freeze({ "/checkouts/create": "agent", "/checkout": "gateway", "/simulated-checkout": "agent" });

// "agent" | "gateway" for a checkout URL, null for anything else (including a string that is not a URL).
const checkoutSource = (url) => {
  try {
    const { pathname } = new URL(String(url));
    const path = CHECKOUT_PATHS.find((candidate) => pathname.endsWith(candidate));
    return path ? SOURCE_BY_PATH[path] : null;
  } catch {
    return null;
  }
};

// The gateway's /checkout carries the agent's Leash token in the body; it is masked before it is
// stored. Any other body is kept exactly as sent.
function maskedRequest(body) {
  const text = String(body ?? "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.token !== "string") return text;
  return JSON.stringify({ ...parsed, token: maskKey(parsed.token) });
}

// Wraps fetch to remember the raw checkout request body and response of the CURRENT chat request
// only (AsyncLocalStorage scopes it), so concurrent sessions never see each other's bodies.
// The Arcade key travels in a header and is never stored; a Leash token in the body is masked.
export function createCheckoutRecorder(innerFetch = fetch) {
  const scope = new AsyncLocalStorage();

  const fetchImpl = async (url, init) => {
    const response = await innerFetch(url, init);
    const slot = scope.getStore();
    const source = slot ? checkoutSource(url) : null;
    if (!source) return response;
    const raw = await response.clone().text();
    slot.latest = Object.freeze({ source, status: response.status, request: maskedRequest(init?.body), raw });
    return response;
  };

  // Runs fn and returns its value with the last checkout call seen while it ran (or null).
  async function record(fn) {
    const slot = { latest: null };
    const value = await scope.run(slot, fn);
    return { value, rawCheckout: slot.latest };
  }

  return { fetchImpl, record };
}
