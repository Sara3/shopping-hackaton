// One place that decides which Arcade the code talks to. Mock mode (the default) only ever reaches a
// local replica with a mock key; only ARCADE_MODE=live may reach platform.arcade.ai.
export const DEFAULT_MOCK_PORT = 8788;
export const LIVE_BASE_URL = "https://platform.arcade.ai/v1";
export const MOCK_KEY = "mock_key";
export const LIVE_KEY_PREFIX = "arcade_sk_live_";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const mockPort = (env = process.env) => Number(env.MOCK_PORT) || DEFAULT_MOCK_PORT;
export const mockBaseUrl = (env = process.env) => `http://localhost:${mockPort(env)}/v1`;
export const MOCK_BASE_URL = mockBaseUrl({});

export const isLocalUrl = (value) => {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

export function resolveArcadeMode(env = process.env) {
  return env.ARCADE_MODE === "live" ? "live" : "mock";
}

export function resolveArcadeEndpoint(env = process.env) {
  const mode = resolveArcadeMode(env);
  const warnings = [];
  if (mode === "live") {
    return { mode, baseUrl: env.ARCADE_BASE_URL || LIVE_BASE_URL, apiKey: env.ARCADE_API_KEY ?? "", warnings };
  }
  const fallback = mockBaseUrl(env);
  let baseUrl = env.ARCADE_BASE_URL || fallback;
  if (!isLocalUrl(baseUrl)) {
    warnings.push(`ARCADE_MODE=mock but ARCADE_BASE_URL is not local; using ${fallback}`);
    baseUrl = fallback;
  }
  const candidate = env.ARCADE_API_KEY ?? "";
  const isLive = candidate.startsWith(LIVE_KEY_PREFIX);
  if (isLive) warnings.push("a live ARCADE_API_KEY is set; mock mode ignores it and uses a mock key");
  return { mode, baseUrl, apiKey: candidate && !isLive ? candidate : MOCK_KEY, warnings };
}
