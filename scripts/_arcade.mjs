// Shared start-up for the CLI scripts: load .env, resolve the endpoint from ARCADE_MODE (mock by
// default, src/endpoint.mjs), print where calls will go, and make sure the target is there.
import { loadDotEnv } from "./_env.mjs";
import { createClient, USER_AGENT } from "../src/arcade.mjs";
import { resolveArcadeEndpoint } from "../src/endpoint.mjs";

const PROBE_TIMEOUT_MS = 2000;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

async function mockIsUp(baseUrl) {
  try {
    await fetch(new URL("/", baseUrl), { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

// Returns { client, endpoint }. Exits 1 with a clear message when mock mode has no replica running.
export async function connectFromEnv({ script }) {
  loadDotEnv();
  const endpoint = resolveArcadeEndpoint(process.env);
  endpoint.warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  console.log(`[${script}] arcade ${endpoint.mode}  ${endpoint.baseUrl}`);
  if (endpoint.mode === "mock" && !(await mockIsUp(endpoint.baseUrl))) {
    fail(`[${script}] ARCADE_MODE=mock (the default) but the replica is not running on ${endpoint.baseUrl}.\n` +
      `Start it with \`npm run mock\`, or run against the real API on purpose with ARCADE_MODE=live.`);
  }
  if (endpoint.mode === "live" && !endpoint.apiKey) fail(`[${script}] ARCADE_MODE=live needs ARCADE_API_KEY in .env`);
  const client = createClient({ apiKey: endpoint.apiKey, baseUrl: endpoint.baseUrl });
  return { client, endpoint };
}
