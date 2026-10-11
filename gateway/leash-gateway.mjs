#!/usr/bin/env node
// `npm run gateway`: the Leash gateway on 127.0.0.1. It is the only process that holds ARCADE_API_KEY;
// agents get short-lived leash tokens from POST /tokens instead. Arcade is the local replica (8788)
// unless ARCADE_MODE=live (src/endpoint.mjs decides).
// Env: ARCADE_MODE, ARCADE_BASE_URL, ARCADE_API_KEY, LEASH_SECRET, LEASH_PORT (8080),
// LEASH_LEDGER (gateway/ledger.jsonl), LEASH_ADMIN_KEY (required), LEASH_VELOCITY_LIMIT,
// LIVE_CHECKOUT_ENABLED (last-line guard on a real order, see checkout.mjs), OTEL_ENABLED,
// OTEL_EXPORTER_OTLP_ENDPOINT (telemetry.mjs).
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../scripts/_env.mjs";
import { createClient } from "../src/arcade.mjs";
import { resolveArcadeEndpoint } from "../src/endpoint.mjs";
import { GATEWAY_PORT, createGatewayServer } from "./server.mjs";
import { initTelemetry, shutdownTelemetry } from "./telemetry.mjs";

export const DEFAULT_LEDGER_PATH = fileURLToPath(new URL("./ledger.jsonl", import.meta.url));
const SECRET_BYTES = 32;
const KEY_PREFIX_LENGTH = 6;
const MAX_PORT = 65_535;
const DIGITS = /^\d+$/;
const RANDOM_SECRET_WARNING = "LEASH_SECRET is not set; using a random secret, so tokens will not survive a restart";
export const MIN_ADMIN_KEY_LENGTH = 16;
const NO_ADMIN_KEY = `LEASH_ADMIN_KEY must be set (at least ${MIN_ADMIN_KEY_LENGTH} characters): without it POST /tokens is open to `
  + "any local process, so a frozen agent could mint itself a fresh token. `npm run demo` generates one per run; "
  + "for `npm run gateway` put it in .env, where the web process reads the same value.";

const logger = Object.freeze({
  info: (line) => console.log(`[leash] ${line}`),
  warn: (line) => console.warn(`[leash] WARN ${line}`),
  error: (line) => console.error(`[leash] ERROR ${line}`),
});

export const maskKey = (key) => (key ? `${String(key).slice(0, KEY_PREFIX_LENGTH)}…` : "(none)");
const randomSecret = () => randomBytes(SECRET_BYTES).toString("hex");

function parsePort(raw) {
  if (raw === undefined || raw === "") return GATEWAY_PORT;
  const port = DIGITS.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port > MAX_PORT) throw new Error(`LEASH_PORT must be an integer from 0 to ${MAX_PORT}, got "${raw}"`);
  return port;
}

const isEnabled = (raw) => (raw ?? "false").toLowerCase() === "true";

// Pure: reads only the env object it is given, so tests never touch .env or process.env.
export function resolveGatewayOptions(env = process.env, { randomSecret: makeSecret = randomSecret } = {}) {
  const endpoint = resolveArcadeEndpoint(env);
  const hasSecret = typeof env.LEASH_SECRET === "string" && env.LEASH_SECRET !== "";
  return Object.freeze({
    mode: endpoint.mode,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    secret: hasSecret ? env.LEASH_SECRET : makeSecret(),
    port: parsePort(env.LEASH_PORT),
    ledgerPath: env.LEASH_LEDGER ? resolve(env.LEASH_LEDGER) : DEFAULT_LEDGER_PATH,
    adminKey: env.LEASH_ADMIN_KEY || null,
    velocityLimit: env.LEASH_VELOCITY_LIMIT || undefined,
    liveCheckoutEnabled: isEnabled(env.LIVE_CHECKOUT_ENABLED),
    warnings: Object.freeze([...endpoint.warnings, ...(hasSecret ? [] : [RANDOM_SECRET_WARNING])]),
  });
}

// The CLI never serves an open POST /tokens (the factory still allows adminKey null for tests).
export function requireAdminKey(options) {
  if (typeof options?.adminKey === "string" && options.adminKey.length >= MIN_ADMIN_KEY_LENGTH) return options;
  throw new Error(NO_ADMIN_KEY);
}

// One start line: never the key, the secret or the admin key, only a 6-character key prefix.
export const startLine = (options, url) => [
  `Leash gateway on ${url}`, `arcade ${options.mode} ${options.baseUrl}`, `key ${maskKey(options.apiKey)}`, `ledger ${options.ledgerPath}`,
  ...(options.adminKey ? ["admin key required"] : []),
  options.mode === "live" ? (options.liveCheckoutEnabled ? "LIVE CHECKOUT ENABLED" : "live checkout blocked") : null,
].filter(Boolean).join("  ");

async function main() {
  loadDotEnv();
  initTelemetry();
  const options = requireAdminKey(resolveGatewayOptions(process.env));
  options.warnings.forEach((warning) => logger.warn(warning));
  const arcade = createClient({ apiKey: options.apiKey, baseUrl: options.baseUrl });
  const gateway = await createGatewayServer({
    port: options.port, arcade, secret: options.secret, ledgerPath: options.ledgerPath, adminKey: options.adminKey,
    velocityLimit: options.velocityLimit, mode: options.mode, secrets: [options.apiKey], logger,
    liveCheckoutEnabled: options.liveCheckoutEnabled,
  });
  logger.info(startLine(options, gateway.url));
  const shutdown = () => gateway.close().then(() => shutdownTelemetry()).then(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    logger.error(`failed to start: ${error.message}`);
    process.exit(1);
  });
}
