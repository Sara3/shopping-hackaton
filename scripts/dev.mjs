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
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDotEnv } from "./_env.mjs";
import { resolveWebConfig, WEB_PORT } from "../web/config.mjs";
import { isLocalUrl, mockPort } from "../src/endpoint.mjs";
import { normalizeLeashUrl } from "../gateway/client.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DORAEMON_DIR = fileURLToPath(new URL("../doraemon/", import.meta.url));
const DORAEMON_PYTHON = `${DORAEMON_DIR}.venv/bin/python`;
export const DEFAULT_DORAEMON_PORT = 8790;
// Doraemon's own per-order ceiling (over it, its card can't be approved from the chat). Behind Leash the
// allowance is the enforced spend cap, so this only stops outliers: $500 unless ORDER_SPEND_CEILING_CENTS says otherwise.
export const DEFAULT_DORAEMON_CEILING_CENTS = "50000";
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

const start = (label, script, env = process.env, { command = process.execPath, args = [script], cwd = ROOT } = {}) => {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
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

// Pure: the Doraemon service's env and what the web needs to reach it, or null when the chat runs the
// naive agent. Doraemon only ever runs behind Leash, so it needs LEASH_URL. It never gets the Arcade key
// or the gateway's admin key ("" rather than deleted, so its .env cannot refill them). Checkout reaches
// Leash's mandate check only with Doraemon's dry-run off: that is fake money on the replica, so it is off
// there only; against live Arcade, Doraemon's own default (dry-run on) stands until a human flips it.
export function doraemonEnvs(env, { isMock, makeServiceKey = randomAdminKey } = {}) {
  if (env.AGENT_BACKEND !== "doraemon") return null;
  if (!env.LEASH_URL) throw new Error("AGENT_BACKEND=doraemon runs Doraemon behind Leash only: set LEASH_URL (the npm demo scripts do)");
  const port = Number(env.DORAEMON_PORT) || DEFAULT_DORAEMON_PORT;
  const url = `http://127.0.0.1:${port}`;
  const serviceKey = env.DORAEMON_SERVICE_KEY || makeServiceKey();
  return {
    url,
    serviceEnv: {
      ...env, ARCADE_API_KEY: "", LEASH_ADMIN_KEY: "", DORAEMON_PORT: String(port), DORAEMON_SERVICE_KEY: serviceKey,
      ORDER_SPEND_CEILING_CENTS: env.ORDER_SPEND_CEILING_CENTS || DEFAULT_DORAEMON_CEILING_CENTS,
      ...(isMock ? { DRY_RUN_CHECKOUT: "false" } : {}),
    },
    webShared: { DORAEMON_URL: url, DORAEMON_SERVICE_KEY: serviceKey },
  };
}

function assertDoraemonInstalled() {
  if (existsSync(DORAEMON_PYTHON)) return;
  throw new Error("Doraemon's Python env is missing. Once: cd doraemon && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt");
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

  const doraemon = doraemonEnvs(process.env, { isMock });
  if (doraemon) assertDoraemonInstalled();
  // The Doraemon stack can switch Arcade from the chat's Settings, so its replica always runs and its
  // gateway gets LEASH_ARCADE_SWITCH. The naive stage stack keeps one fixed Arcade.
  const runMock = isMock || Boolean(doraemon);
  const gatewayChildEnv = gatewayEnv && doraemon ? { ...gatewayEnv, LEASH_ARCADE_SWITCH: "true" } : gatewayEnv;
  await assertPortsFree([
    ...(runMock ? [mockOrigin] : []), ...(gateway ? [`${gateway.url}/health`] : []), ...(doraemon ? [`${doraemon.url}/health`] : []), webOrigin,
  ]);
  if (runMock) await waitFor("mock", start("mock", "mock/arcade-mock.mjs"), `${mockOrigin}/`);
  if (gateway) await waitFor("gateway", start("gateway", "gateway/leash-gateway.mjs", gatewayChildEnv), `${gateway.url}/health`);
  if (doraemon) {
    const child = start("doraemon", null, doraemon.serviceEnv, { command: DORAEMON_PYTHON, args: ["-m", "agent.service"], cwd: DORAEMON_DIR });
    await waitFor("doraemon", child, `${doraemon.url}/health`);
  }
  await waitFor("web", start("web", "web/server.mjs", { ...webEnv, ...(doraemon?.webShared ?? {}) }), `${webOrigin}/api/config`);
  console.log("");
  console.log(`[demo] open        ${webOrigin}`);
  if (runMock) console.log(`[demo] Arcade mock ${mockOrigin}/v1`);
  if (process.env.LEASH_URL) console.log(`[demo] Leash       ${normalizeLeashUrl(process.env.LEASH_URL)}${gateway ? "" : " (remote, not started here)"}`);
  if (doraemon) console.log(`[demo] Doraemon    ${doraemon.url} (Python agent service; traces to Jaeger when OTEL_ENABLED=true)`);
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
