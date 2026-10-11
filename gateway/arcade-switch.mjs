// The Arcade the gateway talks to, switchable while it runs: the local replica or live Arcade, and whether a
// live checkout is real or simulated. Only the gateway holds the live key; the web asks for a switch through
// the admin-only POST /admin/arcade, and a human's click in the chat's Settings is the only caller.
//
// Rules, enforced here (not in the UI): live needs a live client (a live ARCADE_API_KEY at start); live
// checkout needs live mode; going back to the replica turns live checkout off. A gateway started without
// `switchable` keeps the mode it started with (the naive stage stack stays replica-only).
import { badRequest, gatewayError } from "./errors.mjs";

export const ARCADE_MODES = Object.freeze(["mock", "live"]);
// The Arcade client methods the gateway calls (server.mjs ARCADE_METHODS plus the shared client's call()).
const DELEGATED = Object.freeze(["call", "getProduct", "createCheckout", "listCategories"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function createArcadeSwitch({ mock = null, live = null, mode = "mock", liveCheckoutEnabled = false, switchable = false }) {
  if (!ARCADE_MODES.includes(mode)) throw new TypeError(`mode must be one of ${ARCADE_MODES.join(", ")}, got ${mode}`);
  if (!(mode === "live" ? live : mock)) throw new TypeError(`no Arcade client for the starting mode ${mode}`);
  let state = Object.freeze({ mode, liveCheckoutEnabled: mode === "live" && liveCheckoutEnabled === true });
  const current = () => (state.mode === "live" ? live : mock);

  // The gateway's single Arcade client: every call goes to whichever Arcade is selected right now.
  const client = Object.freeze({
    ...Object.fromEntries(DELEGATED.map((name) => [name, (...args) => current()[name](...args)])),
    get baseUrl() { return current().baseUrl ?? null; },
  });

  const view = () => Object.freeze({ ...state, liveAvailable: Boolean(live), switchable });

  // body: { mode, liveCheckoutEnabled }. Returns the new view; a refused switch changes nothing.
  function set(body) {
    if (!switchable) throw gatewayError("scope_forbidden", "this gateway was started with a fixed Arcade (no LEASH_ARCADE_SWITCH)");
    if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
    const next = body.mode ?? state.mode;
    if (!ARCADE_MODES.includes(next)) throw badRequest(`mode must be one of ${ARCADE_MODES.join(", ")}`);
    if (body.liveCheckoutEnabled !== undefined && typeof body.liveCheckoutEnabled !== "boolean") throw badRequest("liveCheckoutEnabled must be a boolean");
    if (next === "live" && !live) throw badRequest("live Arcade is not available: start the gateway with a live ARCADE_API_KEY");
    const wantsLiveCheckout = body.liveCheckoutEnabled ?? (next === "live" && state.liveCheckoutEnabled);
    if (wantsLiveCheckout && next !== "live") throw badRequest("live checkout needs live Arcade");
    state = Object.freeze({ mode: next, liveCheckoutEnabled: wantsLiveCheckout === true });
    return view();
  }

  return Object.freeze({ client, view, set, mode: () => state.mode, liveCheckoutEnabled: () => state.liveCheckoutEnabled });
}
