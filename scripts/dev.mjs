#!/usr/bin/env node
// `npm run demo`: start the Arcade replica (mock) on 8788, wait until it answers, then (when
// LEASH_URL points at this machine) the Leash gateway on that port and wait for its /health, then
// the web + agent server on 8787 and wait for it too. Ctrl-C stops all; if any child dies, the
// rest are stopped and the exit code is 1. Never talks to platform.arcade.ai unless
// ARCADE_MODE=live, and in live mode the mock is skipped. With LEASH_URL set the web (agent) process
// never gets ARCADE_API_KEY, and a local gateway gets an admin key (generated per run when unset)
// that only the web shares, so POST /tokens is never open to other local processes.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDotEnv } from "./_env.mjs";
import { resolveWebConfig, WEB_PORT } from "../web/config.mjs";
import { isLocalUrl, mockPort } from "../src/endpoint.mjs";
import { normalizeLeashUrl } from "../gateway/client.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const PROBE_TIMEOUT_MS = 1000;
const PROBE_HEADERS = { "User-Agent": "leash-demo/0.1" };
const ADMIN_KEY_BYTES = 32;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
let stopping = false;

function stopAll() {
  children.filter((child) => child.exitCode === null).forEach((child) => child.kill("SIGTERM"));
}

const start = (label, script, env = process.env) => {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code, signal) => {
    console.log(`[demo] ${label} exited (${signal ?? code})`);
    if (stopping) return;
    stopping = true;
    console.error(`[demo] ${label} stopped unexpectedly; stopping the rest`);
    stopAll();
    process.exitCode = 1;
  });
  children.push(child);
  return child;
};

async function answers(url) {
  try {
    await fetch(url, { headers: PROBE_HEADERS, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label, child, url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before it was ready`);
    if (await answers(url)) return;
    await sleep(READY_POLL_MS);
  }
  throw new Error(`${label} did not answer on ${url} within ${READY_TIMEOUT_MS / 1000}s`);
}

async function assertPortsFree(urls) {
  for (const url of urls) {
    if (await answers(url)) throw new Error(`port in use: ${url} already answers. Stop the old run, then start again.`);
  }
}

// The gateway to start ourselves: only when LEASH_URL is set AND local (a remote gateway is not ours).
function localGateway(env) {
  if (!env.LEASH_URL) return null;
  const url = normalizeLeashUrl(env.LEASH_URL);
  if (!isLocalUrl(url)) return null;
  const parsed = new URL(url);
  return { url, port: parsed.port || (parsed.protocol === "https:" ? "443" : "80") };
}

const randomAdminKey = () => randomBytes(ADMIN_KEY_BYTES).toString("hex");

// Pure: new env objects for the gateway and web children. ARCADE_API_KEY is "" (not deleted) in the
// web env so the child's loadDotEnv cannot refill it from .env.
export function childEnvs(env, { makeAdminKey = randomAdminKey } = {}) {
  if (!env.LEASH_URL) return { gateway: null, gatewayEnv: null, webEnv: env };
  const gateway = localGateway(env);
  const adminKey = env.LEASH_ADMIN_KEY || (gateway ? makeAdminKey() : "");
  const shared = adminKey ? { LEASH_ADMIN_KEY: adminKey } : {};
  return {
    gateway,
    gatewayEnv: gateway ? { ...env, ...shared, LEASH_PORT: gateway.port } : null,
    webEnv: { ...env, ...shared, ARCADE_API_KEY: "" },
  };
}

async function main() {
  loadDotEnv();
  const { gateway, gatewayEnv, webEnv } = childEnvs(process.env);
  const { publicConfig } = resolveWebConfig(process.env);
  const isMock = publicConfig.arcadeMode === "mock";
  const mockOrigin = `http://localhost:${mockPort(process.env)}`;
  const webOrigin = `http://localhost:${Number(process.env.PORT) || WEB_PORT}`;
  const shutdown = () => {
    stopping = true;
    stopAll();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await assertPortsFree([...(isMock ? [mockOrigin] : []), ...(gateway ? [`${gateway.url}/health`] : []), webOrigin]);
  if (isMock) await waitFor("mock", start("mock", "mock/arcade-mock.mjs"), `${mockOrigin}/`);
  if (gateway) await waitFor("gateway", start("gateway", "gateway/leash-gateway.mjs", gatewayEnv), `${gateway.url}/health`);
  await waitFor("web", start("web", "web/server.mjs", webEnv), `${webOrigin}/api/config`);
  console.log("");
  console.log(`[demo] open        ${webOrigin}`);
  if (isMock) console.log(`[demo] Arcade mock ${mockOrigin}/v1`);
  if (process.env.LEASH_URL) console.log(`[demo] Leash       ${normalizeLeashUrl(process.env.LEASH_URL)}${gateway ? "" : " (remote, not started here)"}`);
  const agentKey = process.env.LEASH_URL ? "none (leash token)" : publicConfig.keyPrefix;
  console.log(`[demo] arcade ${publicConfig.arcadeMode} (${publicConfig.baseUrl}) | agent ${publicConfig.agentMode} | model ${publicConfig.model} | key ${agentKey}`);
  console.log(`[demo] Ctrl-C stops ${gateway ? "all" : "both"}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[demo] ${error.message}`);
    stopping = true;
    stopAll();
    process.exitCode = 1;
  });
}
