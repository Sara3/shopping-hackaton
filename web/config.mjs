import { AGENT_MODES, DEFAULT_MODEL, resolveAgentMode } from "../agent/mode.mjs";
import { BROWSE_PATH_PREFIX, defaultBrowseOrigins } from "../agent/browse.mjs";
import { CLEAN_SLUG, POISONED_SLUG } from "../mock/inspo.mjs";
import { mockPort, resolveArcadeEndpoint } from "../src/endpoint.mjs";

export { DEFAULT_MODEL } from "../agent/mode.mjs";
export {
  LIVE_BASE_URL, LIVE_KEY_PREFIX, MOCK_BASE_URL, MOCK_KEY, resolveArcadeEndpoint, resolveArcadeMode,
} from "../src/endpoint.mjs";

export const WEB_PORT = 8787;
// Which agent answers the chat: "doraemon" (the Python Doraemon service, only ever behind Leash) or
// "naive" (agent/naive-agent.mjs, the deliberately vulnerable red-team target). The npm demo scripts
// set doraemon; unset means naive, so a bare `npm run web` and the tests keep their old behavior.
export const AGENT_BACKENDS = Object.freeze(["naive", "doraemon"]);
export const resolveAgentBackend = (env) => (env.AGENT_BACKEND === "doraemon" ? "doraemon" : "naive");
export const KEY_PREFIX_LENGTH = 6;
export const MIN_REDACTABLE_SECRET_LENGTH = 6;

// LEASH_OFF_ALLOWED=true keeps ARCADE_API_KEY in the web process beside a gateway, so the header's Leash
// button can turn Leash off on a live stack too. Off by default. With it on, a live checkout by the naive
// agent is simulated at the gateway (web/bootstrap.mjs withSimulatedCheckout), never sent to Arcade.
export const isLeashOffAllowed = (env) => String(env.LEASH_OFF_ALLOWED ?? "").toLowerCase() === "true";

// The listing the "Paste a listing link" button pastes (clean) and the poisoned twin the human types by hand.
// Both resolve the same way: the public static copy when BROWSE_ORIGINS names an origin the agent may read
// (the first one), otherwise the replica's own listing.
function listingUrl(env, slug) {
  const publicOrigin = defaultBrowseOrigins(env).find((item) => item.prefix !== BROWSE_PATH_PREFIX);
  return publicOrigin
    ? `${publicOrigin.origin}${publicOrigin.prefix}${slug}/`
    : `http://localhost:${mockPort(env)}${BROWSE_PATH_PREFIX}${slug}`;
}

export const inspoUrl = (env) => listingUrl(env, CLEAN_SLUG);
export const poisonedUrl = (env) => listingUrl(env, POISONED_SLUG);

export const maskKey = (key) => (key ? `${String(key).slice(0, KEY_PREFIX_LENGTH)}…` : "");

// Kept for callers and tests: the one detector lives in agent/mode.mjs.
export const fallbackAgentMode = resolveAgentMode;

export function resolveWebConfig(env, resolveMode = resolveAgentMode) {
  const endpoint = resolveArcadeEndpoint(env);
  const agentBackend = resolveAgentBackend(env);
  const isDoraemon = agentBackend === "doraemon";
  const publicConfig = {
    arcadeMode: endpoint.mode,
    agentBackend,
    agentMode: isDoraemon ? "doraemon" : AGENT_MODES.includes(env.AGENT_MODE) ? env.AGENT_MODE : resolveMode(env),
    model: (isDoraemon ? env.ANTHROPIC_MODEL_ID : env.AGENT_MODEL) || DEFAULT_MODEL,
    keyPresent: Boolean(endpoint.apiKey),
    keyPrefix: maskKey(endpoint.apiKey),
    baseUrl: endpoint.baseUrl,
    inspoUrl: inspoUrl(env),
    poisonedUrl: poisonedUrl(env),
  };
  return { publicConfig, apiKey: endpoint.apiKey, warnings: endpoint.warnings };
}

export function redactSecrets(json, secrets) {
  return secrets
    .filter((secret) => typeof secret === "string" && secret.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .reduce((text, secret) => text.split(secret).join(maskKey(secret)), json);
}
