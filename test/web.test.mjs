import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebServer } from "../web/server.mjs";
import { resolveWebConfig, maskKey, fallbackAgentMode, inspoUrl, poisonedUrl } from "../web/config.mjs";
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

// What createWebServer does with bad options: the error it throws, or "started" (the server is closed again).
const startOutcome = (options) =>
  createWebServer({ port: 0, logger: silent, ...options }).then(async (web) => { await web.close(); return "started"; }, (error) => error);

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

test("GET / offers the inspiration-page flow and demotes the text box", async () => {
  await withServer({}, async (web) => {
    const html = await (await fetch(web.url)).text();
    assert.match(html, /Paste a listing link/);
    assert.doesNotMatch(html, /Use inspiration page/);
    assert.match(html, /paste text instead/);
    assert.match(html, /<div class="inspo" hidden>/);
    assert.match(html, /Inspiration \(text the agent will read\)/);
    assert.match(html, /Load poisoned sample/);
    assert.ok(html.includes("Create a scarf that looks like this: "));
    assert.ok(html.includes("/inspo/"));
    assert.ok(html.includes("/inspo/blue-linen-scarf"));
    assert.doesNotMatch(html, /linen-look|poisoned link/);
    assert.match(html, /built by the agent after you approved/);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/);
  });
});

test("GET / serves the link preview card (You shared) and reads the inspiration URL from /api/config", async () => {
  await withServer({}, async (web) => {
    const html = await (await fetch(web.url)).text();
    for (const text of ["You shared", "link-preview", "config.inspoUrl", "http://localhost:8788/inspo/blue-linen-scarf"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/);
  });
});

test("GET / serves the Track block, the five who-said-what labels and the source chips", async () => {
  await withServer({}, async (web) => {
    const html = await (await fetch(web.url)).text();
    assert.match(html, /<section class="track" id="track"/);
    for (const label of ["you typed", "page said", "agent proposed", "you approved", "agent tried"]) assert.ok(html.includes(`"${label}"`), label);
    assert.match(html, /hidden-mark/);
    assert.match(html, /#ffeb3b/);
    for (const source of ["you", "page", "agent", "gateway"]) assert.ok(html.includes(`.src-${source} {`), source);
    assert.ok(html.includes('"leash: "'), "leash notes get the gateway chip");
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
    assert.deepEqual(agent.seen[0].session, { id: "s1", turns: [], patterns: [], products: [], checkouts: [], pages: [] });
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

test("POST /api/reset runs onReset({ sessionId }) after clearing and returns its value as leash; a throwing hook is 502 leash_reset_failed", async () => {
  const cleared = { id: "r1", turns: [], patterns: [], products: [], checkouts: [], pages: [] };
  const calls = [];
  const onReset = async ({ sessionId }) => {
    calls.push(sessionId);
    return { tokenId: "tok_0123456789abcdef" };
  };
  await withServer({ agent: stubAgent(), onReset }, async (web) => {
    await post(web, "/api/chat", { sessionId: "r1", text: "hello" });
    const response = await post(web, "/api/reset", { sessionId: "r1" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, session: cleared, leash: { tokenId: "tok_0123456789abcdef" } });
    assert.deepEqual(calls, ["r1"]);
    assert.equal((await post(web, "/api/reset", { sessionId: "" })).status, 400);
    assert.deepEqual(calls, ["r1"], "onReset ran for an invalid body");
  });
  await withServer({ agent: stubAgent(), onReset: async () => null }, async (web) => {
    assert.equal((await (await post(web, "/api/reset", { sessionId: "r1" })).json()).leash, null);
  });
  await withServer({ agent: stubAgent() }, async (web) => {
    assert.deepEqual(await (await post(web, "/api/reset", { sessionId: "r1" })).json(), { ok: true, session: cleared });
  });

  const errors = [];
  const failing = async () => { throw new Error(`gateway down, key ${SECRET}`); };
  await withServer({ agent: stubAgent(), onReset: failing, logger: { ...silent, error: (line) => errors.push(line) } }, async (web) => {
    await post(web, "/api/chat", { sessionId: "r2", text: "hello" });
    const response = await post(web, "/api/reset", { sessionId: "r2" });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(JSON.parse(text).error, "leash_reset_failed");
    assert.match(JSON.parse(text).message, /gateway down/);
    assert.doesNotMatch(text, /supersecret/);
    assert.ok(errors.some((line) => /gateway down/.test(line)), errors.join(" | "));
    const state = await (await fetch(`${web.url}/api/state?sessionId=r2`)).json();
    assert.deepEqual(state.session.turns, [], "the session was not cleared");
  });
  assert.ok((await startOutcome({ onReset: "nope" })) instanceof TypeError, "a non-function onReset was accepted");
});

test("secrets may be a function, read on every response, so a secret added after start is redacted too", async () => {
  const later = "leash_rotated_after_start_0123456789";
  let current = [SECRET];
  const agent = { handleMessage: async ({ session, text }) => ({ session, reply: `holding ${text}`, cards: [], trace: {} }) };
  await withServer({ agent, secrets: () => current }, async (web) => {
    assert.match(await (await fetch(`${web.url}/api/config`)).text(), /arcade…/);
    const early = await (await post(web, "/api/chat", { sessionId: "f1", text: later })).text();
    assert.equal(early.includes(later), true, "not a secret yet, so not redacted");
    current = [SECRET, later];
    const redacted = await (await post(web, "/api/chat", { sessionId: "f1", text: later })).text();
    assert.equal(redacted.includes(later), false);
    assert.match(redacted, /holding leash_…/);
  });
  assert.ok((await startOutcome({ secrets: "nope" })) instanceof TypeError, "secrets that are neither an array nor a function were accepted");
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
    assert.equal(body.rawCheckout.source, "agent");
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

test("recorder tags who made the checkout call: agent for checkouts/create (direct or proxied), gateway for /checkout", async () => {
  const recorder = createCheckoutRecorder(async () => new Response("{}"));
  const sourceOf = async (url) => (await recorder.record(() => recorder.fetchImpl(url, { body: "{}" }))).rawCheckout.source;
  assert.equal(await sourceOf("http://localhost:8788/v1/checkouts/create"), "agent");
  assert.equal(await sourceOf("http://127.0.0.1:8080/arcade/checkouts/create"), "agent");
  assert.equal(await sourceOf("http://127.0.0.1:8080/checkout"), "gateway");
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

test("config: inspoUrl is the clean replica listing, or the public copy when BROWSE_ORIGINS names an origin", () => {
  const replica = "http://localhost:8788/inspo/blue-linen-scarf";
  assert.equal(resolveWebConfig({}, () => "scripted").publicConfig.inspoUrl, replica);
  assert.equal(resolveWebConfig({ MOCK_PORT: "9001" }, () => "scripted").publicConfig.inspoUrl, "http://localhost:9001/inspo/blue-linen-scarf");
  const pages = { BROWSE_ORIGINS: "https://sara3.github.io" };
  assert.equal(resolveWebConfig(pages, () => "scripted").publicConfig.inspoUrl, "https://sara3.github.io/odette-atelier/blue-linen-scarf/");
  assert.equal(
    resolveWebConfig({ ...pages, BROWSE_PATH_PREFIX: "shop" }, () => "scripted").publicConfig.inspoUrl,
    "https://sara3.github.io/shop/blue-linen-scarf/",
  );
  assert.equal(resolveWebConfig({ BROWSE_ORIGINS: "not a url, ftp://x.test" }, () => "scripted").publicConfig.inspoUrl, replica);
  assert.equal(inspoUrl({ BROWSE_ORIGINS: "https://a.example, https://b.example" }), "https://a.example/odette-atelier/blue-linen-scarf/");
});

test("config: poisonedUrl is the linen-look twin, resolved the same way as inspoUrl", () => {
  const replica = "http://localhost:8788/inspo/linen-look";
  assert.equal(resolveWebConfig({}, () => "scripted").publicConfig.poisonedUrl, replica);
  assert.equal(poisonedUrl({}), replica);
  assert.equal(resolveWebConfig({ MOCK_PORT: "9001" }, () => "scripted").publicConfig.poisonedUrl, "http://localhost:9001/inspo/linen-look");
  const pages = { BROWSE_ORIGINS: "https://sara3.github.io" };
  assert.equal(resolveWebConfig(pages, () => "scripted").publicConfig.poisonedUrl, "https://sara3.github.io/odette-atelier/linen-look/");
  assert.equal(
    resolveWebConfig({ ...pages, BROWSE_PATH_PREFIX: "shop" }, () => "scripted").publicConfig.poisonedUrl,
    "https://sara3.github.io/shop/linen-look/",
  );
  assert.equal(resolveWebConfig({ BROWSE_ORIGINS: "not a url, ftp://x.test" }, () => "scripted").publicConfig.poisonedUrl, replica);
  assert.equal(poisonedUrl({ BROWSE_ORIGINS: "https://a.example, https://b.example" }), "https://a.example/odette-atelier/linen-look/");
  assert.notEqual(inspoUrl(pages), poisonedUrl(pages));
});

test("GET /api/config says whether an agent exists without an allowance (naiveAgent)", async () => {
  await withServer({}, async (web) => assert.equal((await configOf(web)).naiveAgent, false));
  await withServer({ agent: stubAgent() }, async (web) => assert.equal((await configOf(web)).naiveAgent, true));
});

test("GET /api/config carries inspoUrl and poisonedUrl, with and without an allowance", async () => {
  const { inspoUrl: inspo, poisonedUrl: poisoned } = resolveWebConfig({ BROWSE_ORIGINS: "https://sara3.github.io" }, () => "scripted").publicConfig;
  await withServer({ config: { ...config, inspoUrl: inspo, poisonedUrl: poisoned } }, async (web) => {
    const body = await configOf(web);
    assert.equal(body.inspoUrl, "https://sara3.github.io/odette-atelier/blue-linen-scarf/");
    assert.equal(body.poisonedUrl, "https://sara3.github.io/odette-atelier/linen-look/");
  });
  await withServer({ agent: stubAgent(), config: { ...config, inspoUrl: inspo, poisonedUrl: poisoned }, leashFactory: fakeFactory().leashFactory }, async (web) => {
    await post(web, "/api/allowance", allowanceBody());
    const body = await configOf(web);
    assert.equal(body.inspoUrl, inspo);
    assert.equal(body.poisonedUrl, poisoned);
  });
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

// ---------------------------------------------------------------- Settings: the allowance and the runtime switch

const ALLOWANCE = Object.freeze({
  maxSpend: "200.00", period: "week", categories: ["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"], days: 7,
});
const allowanceBody = (overrides = {}) => ({ ...ALLOWANCE, ...overrides });
const del = (web, path) => fetch(`${web.url}${path}`, { method: "DELETE" });
const configOf = async (web) => (await fetch(`${web.url}/api/config`)).json();
const replyOf = async (web, sessionId = "al") => (await (await post(web, "/api/chat", { sessionId, text: "hello" })).json()).reply;

// A stand-in for web/bootstrap.mjs's leashFactory: a stub agent that says where it came from, and a stub session.
function fakeFactory({ fail = null } = {}) {
  const built = [];
  const leashFactory = async (allowance) => {
    if (fail) throw new Error(fail);
    const info = (tokenId) => ({ url: "http://127.0.0.1:8080", tokenId, agentId: "web-agent", maxSpend: allowance.maxSpend, categories: allowance.categories, scopes: [], expiresAt: null });
    const entry = { allowance, resets: 0, tokenId: `tok_${String(built.length).padStart(16, "0")}` };
    const leash = {
      publicInfo: () => info(entry.tokenId),
      reset: async () => { entry.resets += 1; entry.tokenId = `tok_f${String(entry.resets).padStart(15, "0")}`; return info(entry.tokenId); },
    };
    built.push(entry);
    return { agent: stubAgent({ reply: `leashed ${built.length}` }), leash };
  };
  return { built, leashFactory };
}

test("POST /api/allowance rejects a bad body with 400 and a plain message, and stores nothing", async () => {
  await withServer({ agent: stubAgent() }, async (web) => {
    const cases = [
      [allowanceBody({ maxSpend: "0" }), /maxSpend/], [allowanceBody({ maxSpend: 0 }), /maxSpend/], [allowanceBody({ maxSpend: "abc" }), /maxSpend/],
      [allowanceBody({ maxSpend: "100000.01" }), /maxSpend/], [allowanceBody({ maxSpend: "12.345" }), /maxSpend/],
      [allowanceBody({ categories: ["Silk scarf", "Spaceship"] }), /categories/], [allowanceBody({ categories: [] }), /categories/],
      [allowanceBody({ categories: ["Silk scarf", "Silk scarf"] }), /categories/], [allowanceBody({ categories: "Silk scarf" }), /categories/],
      [allowanceBody({ days: 0 }), /days/], [allowanceBody({ days: 31 }), /days/], [allowanceBody({ days: 1.5 }), /days/], [allowanceBody({ days: "7" }), /days/],
      [allowanceBody({ period: "day" }), /period/], [["not", "an", "object"], /object/], ["{not json", /JSON/],
    ];
    for (const [body, pattern] of cases) {
      const response = await post(web, "/api/allowance", body);
      const json = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(json.error, "bad_request");
      assert.match(json.message, pattern);
    }
    assert.equal((await configOf(web)).allowance, null);
    assert.equal((await post(web, "/api/allowance", "{}", { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await fetch(`${web.url}/api/allowance`)).status, 405);
  });
});

test("POST /api/allowance stores the allowance; /api/config shows it, and without a gateway says so and changes nothing else", async () => {
  await withServer({ agent: stubAgent({ reply: "direct" }) }, async (web) => {
    const before = await configOf(web);
    assert.deepEqual([before.allowance, before.gateway, Object.hasOwn(before, "leash")], [null, false, false]);
    const response = await post(web, "/api/allowance", allowanceBody({ maxSpend: 200 }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, allowance: ALLOWANCE, gateway: false, leash: null });
    const after = await configOf(web);
    assert.deepEqual(after.allowance, ALLOWANCE);
    assert.deepEqual([after.keyPresent, after.keyPrefix, after.gateway, Object.hasOwn(after, "leash")], [true, "arcade…", false, false]);
    assert.equal(await replyOf(web), "direct", "with no gateway the naive agent keeps running");
    assert.deepEqual(await (await del(web, "/api/allowance")).json(), { ok: true });
    assert.equal((await configOf(web)).allowance, null);
  });
});

test("with a gateway: before Save the direct agent chats, after Save the allowance's agent, after DELETE the direct one again", async () => {
  const { built, leashFactory } = fakeFactory();
  await withServer({ agent: stubAgent({ reply: "direct" }), leashFactory }, async (web) => {
    const before = await configOf(web);
    assert.deepEqual([before.allowance, before.gateway, before.leash, before.keyPrefix], [null, true, null, "arcade…"]);
    assert.equal(await replyOf(web), "direct");

    const saved = await (await post(web, "/api/allowance", allowanceBody())).json();
    assert.deepEqual([saved.ok, saved.gateway, saved.allowance], [true, true, ALLOWANCE]);
    assert.equal(saved.leash.maxSpend, "200.00");
    assert.deepEqual(built.map((entry) => entry.allowance), [ALLOWANCE]);
    const shown = await configOf(web);
    assert.deepEqual([shown.keyPresent, shown.keyPrefix, shown.allowance], [false, "none (leash)", ALLOWANCE]);
    assert.equal(shown.leash.maxSpend, "200.00");
    assert.equal(await replyOf(web), "leashed 1");

    const replaced = await (await post(web, "/api/allowance", allowanceBody({ maxSpend: "50.00", days: 1 }))).json();
    assert.equal(replaced.leash.maxSpend, "50.00");
    assert.equal(await replyOf(web), "leashed 2");

    assert.equal((await del(web, "/api/allowance")).status, 200);
    const removed = await configOf(web);
    assert.deepEqual([removed.allowance, removed.leash, removed.keyPrefix, removed.keyPresent], [null, null, "arcade…", true]);
    assert.equal(await replyOf(web), "direct");
  });
});

test("Reset keeps the allowance and mints a fresh token under it; a hook-less server with no allowance has nothing to rotate", async () => {
  const { built, leashFactory } = fakeFactory();
  await withServer({ agent: stubAgent({ reply: "direct" }), leashFactory }, async (web) => {
    const early = await (await post(web, "/api/reset", { sessionId: "al" })).json();
    assert.equal(Object.hasOwn(early, "leash"), false, "no allowance, nothing to rotate");
    const saved = await (await post(web, "/api/allowance", allowanceBody())).json();
    await post(web, "/api/chat", { sessionId: "al", text: "hello" });
    const reset = await post(web, "/api/reset", { sessionId: "al" });
    assert.equal(reset.status, 200);
    const json = await reset.json();
    assert.notEqual(json.leash.tokenId, saved.leash.tokenId);
    assert.equal(built[0].resets, 1);
    assert.equal(json.leash.maxSpend, "200.00");
    assert.deepEqual((await configOf(web)).allowance, ALLOWANCE);
    assert.equal((await configOf(web)).leash.tokenId, json.leash.tokenId);
    assert.equal(await replyOf(web), "leashed 1", "the same allowance's agent keeps chatting");
  });
});

test("a gateway that cannot issue the token is 502 leash_unavailable with its message, and the previous state stays", async () => {
  const { leashFactory } = fakeFactory({ fail: "Leash /tokens → HTTP 401: token_invalid admin key missing" });
  await withServer({ agent: stubAgent({ reply: "direct" }), leashFactory }, async (web) => {
    const response = await post(web, "/api/allowance", allowanceBody());
    assert.equal(response.status, 502);
    const json = await response.json();
    assert.equal(json.error, "leash_unavailable");
    assert.match(json.message, /admin key missing/);
    assert.equal((await configOf(web)).allowance, null);
    assert.equal(await replyOf(web), "direct");
  });
  const noAgent = async () => ({ agent: null, leash: null });
  await withServer({ leashFactory: noAgent }, async (web) => {
    assert.equal((await post(web, "/api/allowance", allowanceBody())).status, 502);
  });
  assert.ok((await startOutcome({ leashFactory: "nope" })) instanceof TypeError, "a non-function leashFactory was accepted");
});

test("with a gateway but no account key in this process, chat says to set an allowance first until one is saved", async () => {
  const { leashFactory } = fakeFactory();
  await withServer({ agent: null, leashFactory }, async (web) => {
    const blocked = await post(web, "/api/chat", { sessionId: "nk", text: "hello" });
    assert.equal(blocked.status, 503);
    const json = await blocked.json();
    assert.equal(json.error, "agent_unavailable");
    assert.equal(json.message, "set an allowance first (no account key in this process)");
    await post(web, "/api/allowance", allowanceBody());
    assert.equal(await replyOf(web, "nk"), "leashed 1");
    await del(web, "/api/allowance");
    assert.equal((await post(web, "/api/chat", { sessionId: "nk", text: "hello" })).status, 503);
  });
});

test("a server can start with an allowance already saved (initialState), as LEASH_MAX_SPEND does", async () => {
  const leash = { publicInfo: () => ({ url: "http://127.0.0.1:8080", tokenId: "tok_0123456789abcdef", maxSpend: "200.00", categories: [] }) };
  await withServer({ agent: stubAgent({ reply: "direct" }), initialState: { allowance: ALLOWANCE, agent: stubAgent({ reply: "boot" }), leash }, leashFactory: fakeFactory().leashFactory }, async (web) => {
    assert.deepEqual((await configOf(web)).allowance, ALLOWANCE);
    assert.equal(await replyOf(web), "boot");
    assert.equal(web.allowanceState().leash, leash);
  });
});

test("GET / serves the Settings screen and the blocked card", async () => {
  await withServer({}, async (web) => {
    const html = await (await fetch(web.url)).text();
    for (const text of ["Agent allowance", 'id="settings-panel"', 'id="settings"', "allow-amount", "allow-period", "allow-days", "allow-save", "allow-cancel", "allow-error",
      "Remove allowance", "Blocked by Leash", "Nothing was bought", '<button id="leash-toggle" class="leash" type="button" aria-pressed="false" disabled>Leash off</button>']) {
      assert.ok(html.includes(text), text);
    }
    for (const [name, label] of [["Silk scarf", "scarves"], ["Linen pillow", "pillows"], ["Cotton dinner napkins", "napkins"], ["Lampshade", "lampshades"]]) {
      assert.match(html, new RegExp(`<input type="checkbox" name="allow-category" value="${name}" checked>${label}</label>`));
    }
    assert.match(html, /<section class="settings" id="settings-panel"[^>]* hidden>/);
    assert.ok(html.indexOf('id="settings-panel"') < html.indexOf('id="thread"'), "the panel sits between the header and the thread");
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/);
  });
});

test("GET / serves the token badge, the checkout batch card and the allowance Track line", async () => {
  await withServer({}, async (web) => {
    const html = await (await fetch(web.url)).text();
    assert.match(html, /setBadge\("token"/);
    assert.match(html, /config\.leash\?\.tokenId \?\? "none"/);
    assert.match(html, /\$\("reset"\)\.addEventListener\("click", async \(\) => \{[\s\S]*?await loadConfig\(\);\s*\}\);/, "Reset refreshes the badges, so a fresh token id shows");
    for (const text of ["card batch", "Running total", "show all ", " is over the ", "class: \"over\"", " checkouts of ", " created"]) {
      assert.ok(html.includes(text), text);
    }
    assert.match(html, /\.card \.over \{ color: var\(--danger\)/);
    assert.match(html, /"allowance"/);
    assert.ok(html.includes('trackLine(SOURCES.gateway, "allowance"'), "the sixth Track line is a gateway chip labelled allowance");
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/);
  });
});

// ---------------------------------------------------------------- simulated checkout: paid status proxy

const get = async (web, path) => {
  const response = await fetch(`${web.url}${path}`);
  return { status: response.status, json: await response.json() };
};

test("GET /api/simulated-checkout proxies the gateway's receipt (paid or not), 404s unknown ids, 400s bad ids, 404s without a gateway", async () => {
  const receipts = { mnd_0123456789abcdef: { paid: null, total: "19.41", currency: "USD" }, mnd_fedcba9876543210: { paid: { orderNumber: "SIM-000001", paidAt: "2026-10-11T21:05:22.019Z" }, total: "19.41", currency: "USD" } };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init?.headers?.Accept]);
    const id = String(url).split("/").pop();
    return receipts[id] ? Response.json(receipts[id]) : Response.json({ error: "not_found" }, { status: 404 });
  };
  await withServer({ gatewayUrl: "http://127.0.0.1:8080", fetchImpl }, async (web) => {
    const unpaid = await get(web, "/api/simulated-checkout?mandateId=mnd_0123456789abcdef");
    assert.deepEqual([unpaid.status, unpaid.json], [200, { mandateId: "mnd_0123456789abcdef", paid: null, total: "19.41", currency: "USD" }]);
    const paid = await get(web, "/api/simulated-checkout?mandateId=mnd_fedcba9876543210");
    assert.deepEqual([paid.status, paid.json.paid.orderNumber], [200, "SIM-000001"]);
    assert.deepEqual(seen[0], ["http://127.0.0.1:8080/simulated-checkout/mnd_0123456789abcdef", "application/json"]);
    assert.equal((await get(web, "/api/simulated-checkout?mandateId=mnd_0000000000000000")).status, 404);
    assert.equal((await get(web, "/api/simulated-checkout?mandateId=../ledger")).status, 400);
    assert.equal((await get(web, "/api/simulated-checkout")).status, 400);
  });
  await withServer({ fetchImpl }, async (web) => {
    assert.equal((await get(web, "/api/simulated-checkout?mandateId=mnd_0123456789abcdef")).status, 404);
    assert.equal(seen.length, 3, "no gateway: nothing is fetched");
  });
});
