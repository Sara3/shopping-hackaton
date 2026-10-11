import { loadDotEnv } from "../scripts/_env.mjs";
import { createClient } from "../src/arcade.mjs";
import { resolveWebConfig, WEB_PORT } from "./config.mjs";
import { createCheckoutRecorder } from "./recorder.mjs";
import { createLeashSession, resolveLeashConfig, wrapAgentWithMandates } from "./leash.mjs";

const MAX_PORT = 65_535;
const LEASH_KEY_PREFIX = "none (leash)";

const consoleLogger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(`WARN ${line}`),
  error: (line) => console.error(`ERROR ${line}`),
};

// With LEASH_URL set the web process (where the agent runs) must never hold the Arcade key: a new env
// without it (the gateway is the only holder). Without LEASH_URL the env is returned as is.
export function withoutArcadeKey(env) {
  if (!env.LEASH_URL) return env;
  const { ARCADE_API_KEY: _dropped, ...rest } = env;
  return rest;
}

// PORT unset or invalid → WEB_PORT; "0" asks the OS for a free port (tests).
export function resolvePort(value) {
  if (value === undefined || value === null || String(value).trim() === "") return WEB_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= MAX_PORT ? port : WEB_PORT;
}

// The agent is loaded dynamically so a broken agent/ still lets the UI start and report the error.
async function loadAgent(arcade, config, logger) {
  try {
    const module = await import("../agent/naive-agent.mjs");
    const agent = module.createNaiveAgent({ arcade, mode: config.agentMode, model: config.model, logger, keyPrefix: config.keyPrefix });
    return { agent, agentError: null };
  } catch (error) {
    const agentError = `agent failed to load: ${error.message}`;
    logger.error(agentError);
    return { agent: null, agentError };
  }
}

// Without LEASH_URL: exactly the naive wiring.
async function directWiring({ publicConfig, apiKey }, { recorder, logger }) {
  // The FULL account key goes to the agent's client on purpose: that is the flaw under test.
  const arcade = createClient({ apiKey, baseUrl: publicConfig.baseUrl, fetchImpl: recorder.fetchImpl });
  const { agent, agentError } = await loadAgent(arcade, publicConfig, logger);
  return { agent, agentError, config: publicConfig, secrets: [apiKey], leash: null };
}

// With LEASH_URL: the agent's client is the Leash client (a scoped token, no Arcade key), built on the
// recorder's fetch so the raw box still records checkout attempts, and every approval runs inside a
// gateway-signed mandate. The token is fetched now (and renewed lazily); a gateway that is down at
// start only delays it. `leash` in the public config is a getter so /api/config shows the live token.
async function leashWiring({ publicConfig, apiKey }, leashConfig, { recorder, logger, now }) {
  const session = createLeashSession(leashConfig, { fetchImpl: recorder.fetchImpl, now, logger });
  const firstToken = await session.getToken().catch((error) => {
    logger.error(`leash: no token from ${leashConfig.leashUrl} yet: ${error.message}`);
    return null;
  });
  const config = { ...publicConfig, keyPresent: false, keyPrefix: LEASH_KEY_PREFIX, get leash() { return session.publicInfo(); } };
  const { agent: inner, agentError } = await loadAgent(session.client, config, logger);
  const agent = inner ? wrapAgentWithMandates(inner, session, { logger }) : null;
  // apiKey here is only the mock placeholder or "": withoutArcadeKey dropped the real one before resolveWebConfig.
  const secrets = [apiKey, firstToken, leashConfig.adminKey].filter(Boolean);
  return { agent, agentError, config, secrets, leash: session };
}

export async function createRuntime(env, { createWebServer, fetchImpl = fetch, logger = consoleLogger, now = () => Date.now() } = {}) {
  if (typeof createWebServer !== "function") throw new TypeError("createRuntime needs createWebServer");
  const agentEnv = withoutArcadeKey(env);
  const { publicConfig, apiKey, warnings } = resolveWebConfig(agentEnv);
  warnings.forEach((warning) => logger.warn(warning));
  const leashConfig = resolveLeashConfig(agentEnv);

  const recorder = createCheckoutRecorder(fetchImpl);
  const base = { publicConfig, apiKey };
  const wiring = leashConfig
    ? await leashWiring(base, leashConfig, { recorder, logger, now })
    : await directWiring(base, { recorder, logger });

  const { agent, agentError, config, secrets, leash } = wiring;
  const web = await createWebServer({ port: resolvePort(agentEnv.PORT), agent, agentError, config, secrets, recorder, logger });
  return { web, config, leash };
}

export async function startFromEnv(createWebServer) {
  loadDotEnv();
  // The one deliberate process.env write: in Leash mode the key .env just loaded leaves this process.
  if (process.env.LEASH_URL) delete process.env.ARCADE_API_KEY;
  const logger = consoleLogger;
  const { web, config, leash } = await createRuntime(process.env, { createWebServer, logger });
  logger.info(`web + agent server  ${web.url}`);
  logger.info(`arcade ${config.arcadeMode} ${config.baseUrl} | agent ${config.agentMode} | model ${config.model} | key ${config.keyPrefix}`);
  if (leash) {
    const info = leash.publicInfo();
    logger.info(`leash ${info.url} | token ${info.tokenId ?? "pending"} | maxSpend ${info.maxSpend} | categories ${info.categories.join(", ")}`);
  }
  return web;
}
