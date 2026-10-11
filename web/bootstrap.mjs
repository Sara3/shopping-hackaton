import { loadDotEnv } from "../scripts/_env.mjs";
import { createClient } from "../src/arcade.mjs";
import { resolveWebConfig, WEB_PORT } from "./config.mjs";
import { createCheckoutRecorder } from "./recorder.mjs";
import { LEASH_KEY_PREFIX } from "./allowance.mjs";
import { createArcadeControl } from "./arcade-control.mjs";
import {
  allowanceFromEnv, createLeashSession, leashConfigForAllowance, resolveLeashConfig, wrapAgentWithMandates,
} from "./leash.mjs";

const MAX_PORT = 65_535;
const MAX_REMEMBERED_SESSIONS = 20;

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

// Doraemon, answered by the Python service. `arcade` must be the Leash client: Doraemon never runs on the key.
async function loadDoraemon(leash, config, env, arcadeState) {
  const { createDoraemonAgent, DEFAULT_DORAEMON_URL } = await import("../agent/doraemon-agent.mjs");
  return createDoraemonAgent({
    leash, url: env.DORAEMON_URL || DEFAULT_DORAEMON_URL, serviceKey: env.DORAEMON_SERVICE_KEY, model: config.model,
    userId: env.LEASH_PAYER || "web-user", arcadeState,
  });
}

// The agent is loaded dynamically so a broken agent/ still lets the UI start and report the error.
async function loadAgent(arcade, config, { logger, env, arcadeState = null }) {
  try {
    if (config.agentBackend === "doraemon") return { agent: await loadDoraemon(arcade, config, env, arcadeState), agentError: null };
    const module = await import("../agent/naive-agent.mjs");
    const { defaultBrowseOrigins } = await import("../agent/browse.mjs");
    const agent = module.createNaiveAgent({
      arcade, mode: config.agentMode, model: config.model, logger, keyPrefix: config.keyPrefix, browseOrigins: defaultBrowseOrigins(env),
    });
    return { agent, agentError: null };
  } catch (error) {
    const agentError = `agent failed to load: ${error.message}`;
    logger.error(agentError);
    return { agent: null, agentError };
  }
}

// The naive agent: the FULL account key goes to its client on purpose, that is the flaw under test. With a
// gateway but no key in this process (live mode) there is no naive agent: it waits for an allowance.
async function loadDirectAgent({ publicConfig, apiKey }, { recorder, logger, env, hasGateway }) {
  // Doraemon never holds the account key: with a gateway it waits for an allowance (a Leash token).
  if (publicConfig.agentBackend === "doraemon") {
    return { agent: null, agentError: hasGateway ? null : "Doraemon runs only behind Leash: set LEASH_URL (the npm demo scripts do)" };
  }
  if (hasGateway && !apiKey) return { agent: null, agentError: null };
  const arcade = createClient({ apiKey, baseUrl: publicConfig.baseUrl, fetchImpl: recorder.fetchImpl });
  return loadAgent(arcade, publicConfig, { logger, env });
}

// Every Leash session this process started, so every token ever issued (renewed, rotated, or under an
// allowance since replaced) stays redacted. Replaced, never mutated; the oldest drop off past the limit.
function createSessionRegistry() {
  let sessions = Object.freeze([]);
  return Object.freeze({
    add(session) { sessions = Object.freeze([...sessions, session].slice(-MAX_REMEMBERED_SESSIONS)); },
    secrets: () => sessions.flatMap((session) => session.secrets()),
  });
}

// A Leash agent for one config: its client is the Leash client (a scoped token, no Arcade key) on the
// recorder's fetch, so the raw box still records checkout attempts, and every approval runs inside a
// gateway-signed mandate. `strict` waits for the first token and fails with the gateway's error; the
// boot path is lenient (a gateway that is down at start only delays the token, it renews lazily).
// The UI's Reset mints a fresh token with the admin key (session.reset); the agent never sees `session`.
async function buildLeashAgent({ base, config, allowance, strict }, { recorder, registry, logger, now, env, arcadeState = null }) {
  const session = createLeashSession(config, { fetchImpl: recorder.fetchImpl, now, logger });
  registry.add(session);
  const firstToken = session.getToken();
  if (strict) await firstToken;
  else await firstToken.catch((error) => logger.error(`leash: no token from ${config.leashUrl} yet: ${error.message}`));
  const publicConfig = { ...base.publicConfig, keyPresent: false, keyPrefix: LEASH_KEY_PREFIX };
  const { agent: inner, agentError } = await loadAgent(session.client, publicConfig, { logger, env, arcadeState });
  if (!inner) throw new Error(agentError);
  return { agent: wrapAgentWithMandates(inner, session, { logger, allowance }), leash: session };
}

// LEASH_MAX_SPEND pre-saves an allowance at boot (with its token's own TTL), so `npm run demo:leash` starts leashed.
async function loadEnvAllowance(allowance, leashConfig, deps) {
  try {
    const { agent, leash } = await buildLeashAgent({ base: deps.base, config: leashConfig, allowance, strict: false }, deps);
    return { allowance, agent, leash };
  } catch (error) {
    deps.logger.error(`leash: the LEASH_MAX_SPEND allowance did not start: ${error.message}`);
    return null;
  }
}

export async function createRuntime(env, { createWebServer, fetchImpl = fetch, logger = consoleLogger, now = () => Date.now() } = {}) {
  if (typeof createWebServer !== "function") throw new TypeError("createRuntime needs createWebServer");
  const agentEnv = withoutArcadeKey(env);
  const { publicConfig, apiKey, warnings } = resolveWebConfig(agentEnv);
  warnings.forEach((warning) => logger.warn(warning));
  const leashConfig = resolveLeashConfig(agentEnv);
  const hasGateway = Boolean(leashConfig);

  const recorder = createCheckoutRecorder(fetchImpl);
  const base = { publicConfig, apiKey };
  const registry = createSessionRegistry();
  // Settings → Arcade, Doraemon stack only: the web holds the admin key, the gateway decides.
  const arcadeControl = hasGateway && publicConfig.agentBackend === "doraemon" && leashConfig.adminKey
    ? createArcadeControl({ leashUrl: leashConfig.leashUrl, adminKey: leashConfig.adminKey, fetchImpl })
    : null;
  if (arcadeControl) await arcadeControl.status();
  const arcadeState = arcadeControl ? () => arcadeControl.current() : null;
  const deps = { base, recorder, registry, logger, now, env: agentEnv, arcadeState };
  const { agent, agentError } = await loadDirectAgent(base, { recorder, logger, env: agentEnv, hasGateway });
  const envAllowance = allowanceFromEnv(agentEnv);
  const initialState = envAllowance ? await loadEnvAllowance(envAllowance, leashConfig, deps) : null;
  const leashFactory = hasGateway
    ? (allowance) => buildLeashAgent({ base, config: leashConfigForAllowance(leashConfig, allowance), allowance, strict: true }, deps)
    : null;
  // Read on every response, so every token issued after start (renewed, rotated, or under a new allowance) stays redacted.
  const secrets = () => [apiKey, leashConfig?.adminKey, agentEnv.DORAEMON_SERVICE_KEY, ...registry.secrets()].filter(Boolean);

  const web = await createWebServer({
    port: resolvePort(agentEnv.PORT), agent, agentError, config: publicConfig, secrets, recorder, logger, leashFactory, initialState,
    gatewayUrl: leashConfig?.leashUrl ?? null,
    arcadeControl,
  });
  return { web, config: publicConfig, gatewayUrl: leashConfig?.leashUrl ?? null, get leash() { return web.allowanceState?.()?.leash ?? null; } };
}

export async function startFromEnv(createWebServer) {
  loadDotEnv();
  // The one deliberate process.env write: in Leash mode the key .env just loaded leaves this process.
  if (process.env.LEASH_URL) delete process.env.ARCADE_API_KEY;
  const logger = consoleLogger;
  const runtime = await createRuntime(process.env, { createWebServer, logger });
  const { web, config, gatewayUrl, leash } = runtime;
  logger.info(`web + agent server  ${web.url}`);
  logger.info(`arcade ${config.arcadeMode} ${config.baseUrl} | agent ${config.agentMode} | model ${config.model} | key ${leash ? LEASH_KEY_PREFIX : config.keyPrefix}`);
  if (leash) {
    const info = leash.publicInfo();
    logger.info(`leash ${info.url} | token ${info.tokenId ?? "pending"} | maxSpend ${info.maxSpend} | categories ${info.categories.join(", ")}`);
  } else if (gatewayUrl) {
    const waiting = config.agentBackend === "doraemon" ? "Doraemon starts once you save one in Settings" : "the agent is the naive one until you save one in Settings";
    logger.info(`leash ${gatewayUrl} | no allowance yet: ${waiting}`);
  }
  return web;
}
