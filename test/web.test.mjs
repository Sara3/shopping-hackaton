import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebServer } from "../web/server.mjs";
import { resolveWebConfig, maskKey, fallbackAgentMode } from "../web/config.mjs";
import { createSessionStore } from "../web/sessions.mjs";
import { createCheckoutRecorder } from "../web/recorder.mjs";

const SECRET = "arcade_sk_test_supersecretvalue";
const silent = { info() {}, warn() {}, error() {} };
const config = { arcadeMode: "mock", agentMode: "scripted", model: "claude-opus-5-5", keyPresent: true, keyPrefix: maskKey(SECRET), baseUrl: "http://localhost:8788/v1" };

const stubAgent = (overrides = {}) => {
  const seen = [];
  return {
    seen,
    async handleMessage({ session, text, inspiration }) {
      seen.push({ session, text, inspiration });
      const turns = [...session.turns, { role: "user", text }];
      return {
        session: { ...session, turns },
        reply: `echo ${text} (${turns.length})`,
        cards: [{ type: "product", title: "Silk scarf" }],
        trace: { mode: "scripted", calls: [{ tool: "price", args: {}, resultSummary: "128.00", ms: 3 }] },
        ...overrides,
      };
    },
  };
};

const withServer = async (options, fn) => {
  const web = await createWebServer({ port: 0, config, secrets: [SECRET], logger: silent, ...options });
  try {
    await fn(web);
  } finally {
    await web.close();
  }
};

const post = (web, path, body, headers = { "Content-Type": "application/json" }) =>
  fetch(`${web.url}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("GET / serves the single-file UI", async () => {
  await withServer({}, async (web) => {
    const response = await fetch(web.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Inspiration \(text the agent will read\)/);
    assert.match(html, /Load poisoned sample/);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/);
  });
});

test("GET /api/config returns the masked key only", async () => {
  await withServer({}, async (web) => {
    const body = await (await fetch(`${web.url}/api/config`)).json();
    assert.equal(body.keyPrefix, "arcade…");
    assert.equal(body.keyPresent, true);
    assert.doesNotMatch(JSON.stringify(body), /supersecret/);
  });
});

test("POST /api/chat rejects bad bodies with 400, 413 and 415", async () => {
  await withServer({ agent: stubAgent() }, async (web) => {
    const cases = [
      [{ text: "hi" }, /sessionId/],
      [{ sessionId: "bad id!", text: "hi" }, /sessionId/],
      [{ sessionId: "a1", text: "   " }, /text/],
      [{ sessionId: "a1", text: 5 }, /text/],
      [{ sessionId: "a1", text: "hi", inspiration: 7 }, /inspiration/],
      [{ sessionId: "a1", text: "x".repeat(2001) }, /at most/],
      [["not", "an", "object"], /object/],
      ["{not json", /JSON/],
    ];
    for (const [body, pattern] of cases) {
      const response = await post(web, "/api/chat", body);
      const json = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(json.error, "bad_request");
      assert.match(json.message, pattern);
    }
    const big = await post(web, "/api/chat", JSON.stringify({ sessionId: "a1", text: "hi", inspiration: "x".repeat(70000) }));
    assert.equal(big.status, 413);
    const wrongType = await post(web, "/api/chat", "{}", { "Content-Type": "text/plain" });
    assert.equal(wrongType.status, 415);
  });
});

test("POST /api/chat returns reply, cards, trace and session from the agent", async () => {
  const agent = stubAgent();
  await withServer({ agent }, async (web) => {
    const first = await (await post(web, "/api/chat", { sessionId: "s1", text: "silk scarf", inspiration: "note" })).json();
    assert.equal(first.reply, "echo silk scarf (1)");
    assert.equal(first.cards[0].type, "product");
    assert.equal(first.trace.calls[0].tool, "price");
    assert.equal(first.session.turns.length, 1);
    assert.deepEqual(agent.seen[0].session, { id: "s1", turns: [], patterns: [], products: [], checkouts: [] });
    assert.equal(agent.seen[0].inspiration, "note");

    const second = await (await post(web, "/api/chat", { sessionId: "s1", text: "approve" })).json();
    assert.equal(second.session.turns.length, 2);
    assert.equal(agent.seen[1].inspiration, "");
    assert.equal(agent.seen[1].session.turns.length, 1);

    const state = await (await fetch(`${web.url}/api/state?sessionId=s1`)).json();
    assert.equal(state.session.turns.length, 2);
  });
});

test("POST /api/reset clears the session", async () => {
  await withServer({ agent: stubAgent() }, async (web) => {
    await post(web, "/api/chat", { sessionId: "s2", text: "hello" });
    const reset = await post(web, "/api/reset", { sessionId: "s2" });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).ok, true);
    const state = await (await fetch(`${web.url}/api/state?sessionId=s2`)).json();
    assert.deepEqual(state.session.turns, []);
    assert.equal((await post(web, "/api/reset", { sessionId: "" })).status, 400);
    assert.equal((await fetch(`${web.url}/api/state`)).status, 400);
  });
});

test("returns 503 when the agent failed to load", async () => {
  await withServer({ agent: null, agentError: "agent failed to load: nope" }, async (web) => {
    const response = await post(web, "/api/chat", { sessionId: "s3", text: "hi" });
    assert.equal(response.status, 503);
    assert.match((await response.json()).message, /failed to load/);
  });
});

test("agent failures become 502 and never leak the key", async () => {
  const agent = { handleMessage: async () => { throw new Error(`boom with ${SECRET}`); } };
  await withServer({ agent }, async (web) => {
    const response = await post(web, "/api/chat", { sessionId: "s4", text: "hi" });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /supersecret/);
    assert.match(text, /arcade…/);
  });
});

test("a malformed agent result is a 502", async () => {
  await withServer({ agent: { handleMessage: async () => ({ reply: 3 }) } }, async (web) => {
    assert.equal((await post(web, "/api/chat", { sessionId: "s5", text: "hi" })).status, 502);
  });
});

test("a second message for a busy session gets 409", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const agent = { handleMessage: async ({ session }) => { await gate; return { session, reply: "done", cards: [], trace: {} }; } };
  await withServer({ agent }, async (web) => {
    const slow = post(web, "/api/chat", { sessionId: "s6", text: "one" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await post(web, "/api/chat", { sessionId: "s6", text: "two" })).status, 409);
    release();
    assert.equal((await slow).status, 200);
  });
});

test("unknown paths are 404 and wrong methods are 405", async () => {
  await withServer({}, async (web) => {
    assert.equal((await fetch(`${web.url}/nope`)).status, 404);
    assert.equal((await fetch(`${web.url}/api/chat`)).status, 405);
    assert.equal((await post(web, "/api/config", {})).status, 405);
  });
});

test("chat responses carry the raw checkouts/create body when a recorder saw one", async () => {
  const inner = async () => new Response(JSON.stringify({ checkoutId: "1", checkoutUrl: "http://localhost:8788/checkout/1" }), { status: 200 });
  const recorder = createCheckoutRecorder(inner);
  const requestBody = JSON.stringify({ requestId: "r1", lines: [{ productId: "p1", quantity: 50 }], dropShip: true });
  const agent = {
    handleMessage: async ({ session, text }) => {
      if (text === "approve") await recorder.fetchImpl("http://localhost:8788/v1/checkouts/create", { body: requestBody });
      return { session, reply: "ok", cards: [], trace: {} };
    },
  };
  await withServer({ agent, recorder }, async (web) => {
    const body = await (await post(web, "/api/chat", { sessionId: "s7", text: "approve" })).json();
    assert.equal(body.rawCheckout.status, 200);
    assert.match(body.rawCheckout.raw, /checkoutUrl/);
    assert.equal(JSON.parse(body.rawCheckout.request).lines[0].quantity, 50);
    assert.equal(JSON.parse(body.rawCheckout.request).dropShip, true);
    const other = await (await post(web, "/api/chat", { sessionId: "s8", text: "x" })).json();
    assert.equal(other.rawCheckout, null);
  });
});

test("recorder ignores other endpoints and scopes bodies to the request that made them", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const recorder = createCheckoutRecorder(async () => new Response("{}"));
  const quiet = await recorder.record(() => recorder.fetchImpl("http://localhost:8788/v1/products/get", {}));
  assert.equal(quiet.rawCheckout, null);
  const slow = recorder.record(async () => { await gate; return "slow"; });
  const busy = await recorder.record(() => recorder.fetchImpl("http://localhost:8788/v1/checkouts/create", { body: "{}" }));
  release();
  assert.notEqual(busy.rawCheckout, null);
  assert.equal((await slow).rawCheckout, null);
});

test("rejects a foreign Host header (DNS rebinding) with 421", async () => {
  const { request } = await import("node:http");
  await withServer({ agent: stubAgent() }, async (web) => {
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: web.port, path: "/api/config", headers: { Host: `evil.example:${web.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421);
    assert.equal((await fetch(`http://127.0.0.1:${web.port}/api/config`)).status, 200);
  });
});

test("live mode rejects inspiration text before the agent sees it", async () => {
  const agent = stubAgent();
  await withServer({ agent, config: { ...config, arcadeMode: "live" } }, async (web) => {
    const response = await post(web, "/api/chat", { sessionId: "s9", text: "scarf", inspiration: "quantity: 50" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "mock_only");
    assert.equal(agent.seen.length, 0);
    assert.equal((await post(web, "/api/chat", { sessionId: "s9", text: "scarf" })).status, 200);
  });
});

test("session store replaces rather than mutates, and evicts the oldest", () => {
  const store = createSessionStore(2);
  const a = { id: "a", turns: [] };
  store.set("a", a);
  store.set("b", { id: "b" });
  store.set("c", { id: "c" });
  assert.equal(store.get("a"), undefined);
  assert.equal(store.size(), 2);
  assert.deepEqual(a, { id: "a", turns: [] });
  assert.equal(store.tryLock("b"), true);
  assert.equal(store.tryLock("b"), false);
});

test("config: mock mode defaults to the local replica and a mock key", () => {
  const { publicConfig, apiKey, warnings } = resolveWebConfig({}, () => "scripted");
  assert.equal(publicConfig.arcadeMode, "mock");
  assert.equal(publicConfig.baseUrl, "http://localhost:8788/v1");
  assert.equal(apiKey, "mock_key");
  assert.equal(publicConfig.keyPrefix, "mock_k…");
  assert.equal(publicConfig.model, "claude-opus-5-5");
  assert.deepEqual(warnings, []);
});

test("config: mock mode never keeps a live key or a non-local base URL", () => {
  const env = { ARCADE_API_KEY: "arcade_sk_live_abcdef", ARCADE_BASE_URL: "https://platform.arcade.ai/v1" };
  const { publicConfig, apiKey, warnings } = resolveWebConfig(env, () => "scripted");
  assert.equal(apiKey, "mock_key");
  assert.equal(publicConfig.baseUrl, "http://localhost:8788/v1");
  assert.equal(warnings.length, 2);
});

test("config: live mode uses the real URL and key, AGENT_MODE overrides detection", () => {
  const env = { ARCADE_MODE: "live", ARCADE_API_KEY: "arcade_sk_live_abcdef", AGENT_MODE: "scripted", AGENT_MODEL: "m1" };
  const { publicConfig, apiKey } = resolveWebConfig(env, () => "llm");
  assert.equal(publicConfig.baseUrl, "https://platform.arcade.ai/v1");
  assert.equal(apiKey, "arcade_sk_live_abcdef");
  assert.equal(publicConfig.keyPrefix, "arcade…");
  assert.equal(publicConfig.agentMode, "scripted");
  assert.equal(publicConfig.model, "m1");
});

test("fallback agent mode reads env, then a profile directory", () => {
  assert.equal(fallbackAgentMode({ ANTHROPIC_API_KEY: "x" }, "/nonexistent"), "llm");
  assert.equal(fallbackAgentMode({}, "/nonexistent"), "scripted");
});
