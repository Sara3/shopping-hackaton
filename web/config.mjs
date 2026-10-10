import { AGENT_MODES, DEFAULT_MODEL, resolveAgentMode } from "../agent/mode.mjs";
import { resolveArcadeEndpoint } from "../src/endpoint.mjs";

export { DEFAULT_MODEL } from "../agent/mode.mjs";
export {
  LIVE_BASE_URL, LIVE_KEY_PREFIX, MOCK_BASE_URL, MOCK_KEY, resolveArcadeEndpoint, resolveArcadeMode,
} from "../src/endpoint.mjs";

export const WEB_PORT = 8787;
export const KEY_PREFIX_LENGTH = 6;
export const MIN_REDACTABLE_SECRET_LENGTH = 6;

export const maskKey = (key) => (key ? `${String(key).slice(0, KEY_PREFIX_LENGTH)}…` : "");

// Kept for callers and tests: the one detector lives in agent/mode.mjs.
export const fallbackAgentMode = resolveAgentMode;

export function resolveWebConfig(env, resolveMode = resolveAgentMode) {
  const endpoint = resolveArcadeEndpoint(env);
  const publicConfig = {
    arcadeMode: endpoint.mode,
    agentMode: AGENT_MODES.includes(env.AGENT_MODE) ? env.AGENT_MODE : resolveMode(env),
    model: env.AGENT_MODEL || DEFAULT_MODEL,
    keyPresent: Boolean(endpoint.apiKey),
    keyPrefix: maskKey(endpoint.apiKey),
    baseUrl: endpoint.baseUrl,
  };
  return { publicConfig, apiKey: endpoint.apiKey, warnings: endpoint.warnings };
}

export function redactSecrets(json, secrets) {
  return secrets
    .filter((secret) => typeof secret === "string" && secret.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .reduce((text, secret) => text.split(secret).join(maskKey(secret)), json);
}
