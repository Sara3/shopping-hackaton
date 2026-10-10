import { AsyncLocalStorage } from "node:async_hooks";

const CHECKOUT_PATH = "/checkouts/create";

// Wraps fetch to remember the raw checkouts/create request body and response of the CURRENT chat
// request only (AsyncLocalStorage scopes it), so concurrent sessions never see each other's bodies.
// The key travels in a header and is never stored.
export function createCheckoutRecorder(innerFetch = fetch) {
  const scope = new AsyncLocalStorage();

  const fetchImpl = async (url, init) => {
    const response = await innerFetch(url, init);
    const slot = scope.getStore();
    if (!slot || !String(url).endsWith(CHECKOUT_PATH)) return response;
    const raw = await response.clone().text();
    slot.latest = Object.freeze({ status: response.status, request: String(init?.body ?? ""), raw });
    return response;
  };

  // Runs fn and returns its value with the last checkouts/create seen while it ran (or null).
  async function record(fn) {
    const slot = { latest: null };
    const value = await scope.run(slot, fn);
    return { value, rawCheckout: slot.latest };
  }

  return { fetchImpl, record };
}
