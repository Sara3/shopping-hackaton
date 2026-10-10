#!/usr/bin/env node
// Arcade API replica for the sandbox: `node mock/arcade-mock.mjs` serves http://localhost:8788/v1
// with the same paths and JSON shapes as https://platform.arcade.ai/v1. Nothing here talks to Arcade.
// Env: MOCK_PORT (8788), MOCK_HOST (127.0.0.1), MOCK_LATENCY_MS (2000), MOCK_STATE_FILE (mock/state.json).
// MOCK_HOST must be a loopback name (127.0.0.1, ::1, localhost). Sharing one replica over the LAN needs an
// explicit MOCK_ALLOW_LAN=1: the replica accepts ANY bearer key, including a real one sent by mistake.
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../scripts/_env.mjs";
import { DEFAULT_HOST, DEFAULT_LATENCY_MS, DEFAULT_PORT, createMockServer } from "./server.mjs";

export { createMockServer } from "./server.mjs";

const DEFAULT_STATE_FILE = fileURLToPath(new URL("./state.json", import.meta.url));
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1", "localhost"]);

export function resolveMockHost(env = process.env) {
  const host = env.MOCK_HOST || DEFAULT_HOST;
  if (LOOPBACK_HOSTS.includes(host)) return host;
  if (env.MOCK_ALLOW_LAN !== "1") {
    throw new Error(`MOCK_HOST=${host} is not loopback; use 127.0.0.1, ::1 or localhost (or set MOCK_ALLOW_LAN=1 on purpose)`);
  }
  console.warn(`[mock] WARNING: MOCK_ALLOW_LAN=1, replica exposed on ${host}; it accepts any bearer key from anyone on this network`);
  return host;
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

async function main() {
  loadDotEnv();
  const port = intFromEnv("MOCK_PORT", DEFAULT_PORT);
  const latencyMs = intFromEnv("MOCK_LATENCY_MS", DEFAULT_LATENCY_MS);
  const host = resolveMockHost(process.env);
  const stateFile = process.env.MOCK_STATE_FILE || DEFAULT_STATE_FILE;
  const mock = await createMockServer({ port, host, latencyMs, stateFile });
  console.log(`Arcade replica (mock) on ${mock.apiUrl}  latency ${latencyMs}ms  state ${stateFile}`);
  const shutdown = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[mock] failed to start: ${error.message}`);
    process.exit(1);
  });
}
