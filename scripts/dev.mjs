#!/usr/bin/env node
// `npm run demo`: start the Arcade replica (mock) on 8788, wait until it answers, then start
// the web + agent server on 8787 and wait for it too. Ctrl-C stops both; if either child dies,
// the other is stopped and the exit code is 1. Never talks to platform.arcade.ai unless
// ARCADE_MODE=live, and in live mode the mock is skipped.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./_env.mjs";
import { resolveWebConfig, WEB_PORT } from "../web/config.mjs";
import { mockPort } from "../src/endpoint.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const PROBE_TIMEOUT_MS = 1000;
const PROBE_HEADERS = { "User-Agent": "leash-demo/0.1" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
let stopping = false;

function stopAll() {
  children.filter((child) => child.exitCode === null).forEach((child) => child.kill("SIGTERM"));
}

const start = (label, script) => {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
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

async function main() {
  loadDotEnv();
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

  await assertPortsFree(isMock ? [mockOrigin, webOrigin] : [webOrigin]);
  if (isMock) await waitFor("mock", start("mock", "mock/arcade-mock.mjs"), `${mockOrigin}/`);
  await waitFor("web", start("web", "web/server.mjs"), `${webOrigin}/api/config`);
  console.log("");
  console.log(`[demo] open        ${webOrigin}`);
  if (isMock) console.log(`[demo] Arcade mock ${mockOrigin}/v1`);
  console.log(`[demo] arcade ${publicConfig.arcadeMode} (${publicConfig.baseUrl}) | agent ${publicConfig.agentMode} | model ${publicConfig.model} | key ${publicConfig.keyPrefix}`);
  console.log("[demo] Ctrl-C stops both");
}

main().catch((error) => {
  console.error(`[demo] ${error.message}`);
  stopping = true;
  stopAll();
  process.exitCode = 1;
});
