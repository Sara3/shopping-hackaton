// The chat's Arcade switch (Settings → Arcade), Doraemon stack only. This process holds the gateway's admin
// key, so it is the one caller of the gateway's admin-only POST /admin/arcade; the gateway enforces the rules
// (gateway/arcade-switch.mjs). It also remembers the last known state, which every Doraemon turn carries so
// Doraemon knows which Arcade it is on and whether its checkout may be real.
import { normalizeLeashUrl } from "../gateway/client.mjs";
import { USER_AGENT } from "../src/arcade.mjs";
import { HttpError } from "./validate.mjs";

const TIMEOUT_MS = 5000;
const UNKNOWN = Object.freeze({ mode: "mock", liveCheckoutEnabled: false, liveAvailable: false, switchable: false });

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateArcadeBody(body) {
  if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "body must be a JSON object");
  if (!["mock", "live"].includes(body.mode)) throw new HttpError(400, "bad_request", "mode must be mock or live");
  if (typeof body.liveCheckoutEnabled !== "boolean") throw new HttpError(400, "bad_request", "liveCheckoutEnabled must be a boolean");
  return Object.freeze({ mode: body.mode, liveCheckoutEnabled: body.liveCheckoutEnabled });
}

export function createArcadeControl({ leashUrl, adminKey, fetchImpl = fetch }) {
  const root = normalizeLeashUrl(leashUrl);
  let last = UNKNOWN;

  const remember = (view) => {
    if (isPlainObject(view)) last = Object.freeze({ ...UNKNOWN, ...view });
    return last;
  };

  async function request(path, init = {}) {
    const response = await fetchImpl(`${root}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }

  // The gateway's current state (GET /health is open); the last known one when it does not answer.
  async function status() {
    try {
      const { ok, body } = await request("/health", { headers: { "User-Agent": USER_AGENT } });
      return ok ? remember(body.arcade) : last;
    } catch {
      return last;
    }
  }

  async function set(next) {
    let reply;
    try {
      reply = await request("/admin/arcade", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Authorization: `Bearer ${adminKey}` },
        body: JSON.stringify(next),
      });
    } catch (error) {
      throw new HttpError(502, "leash_unavailable", `the gateway did not answer: ${error.message}`);
    }
    if (!reply.ok) throw new HttpError(reply.status === 400 ? 400 : 502, reply.body?.error ?? "arcade_switch_refused", reply.body?.message ?? "the gateway refused the switch");
    return remember(reply.body);
  }

  return Object.freeze({ status, set, current: () => last });
}
