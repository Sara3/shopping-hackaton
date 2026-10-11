// Leash off on a live stack (LEASH_OFF_ALLOWED=true): the web process keeps the Arcade key so the header's
// Leash button can turn Leash off, and the naive agent's checkout is then simulated at the gateway (a sim_
// receipt over the admin route) instead of becoming a real Arcade order. Offline: the replica stands in for
// live Arcade (ARCADE_MODE=live with ARCADE_BASE_URL at the mock), the gateway runs in live mode with an admin key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockServer } from "../mock/arcade-mock.mjs";
import { createClient } from "../src/arcade.mjs";
import { createGatewayServer } from "../gateway/server.mjs";
import { createRuntime, withSimulatedCheckout, withoutArcadeKey } from "../web/bootstrap.mjs";
import { isLeashOffAllowed } from "../web/config.mjs";
import { createWebServer } from "../web/server.mjs";

const NORMAL = "silk scarf for my mom, blue florals on linen";
const ALLOWANCE = Object.freeze({
  maxSpend: "200.00", period: "week", categories: ["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"], days: 7,
});
const GATEWAY_KEY = "arcade_sk_live_gatewaysideonly00";
const WEB_KEY = "arcade_sk_live_keptinwebbyoptin0";
const LEASH_SECRET = "leash-off-secret-0123456789abcdef";
const ADMIN_KEY = "leash-off-admin-key-0123456789";
const silent = { info() {}, warn() {}, error() {} };

let mock;
let gateway;
before(async () => {
  mock = await createMockServer({ port: 0, latencyMs: 0, stateFile: null, logger: null });
  const arcade = createClient({ apiKey: GATEWAY_KEY, baseUrl: mock.apiUrl });
  gateway = await createGatewayServer({ port: 0, arcade, secret: LEASH_SECRET, adminKey: ADMIN_KEY, mode: "live", logger: silent, secrets: [GATEWAY_KEY] });
});
after(async () => {
  await gateway?.close();
  await mock?.close();
});

const checkoutCount = () => Object.keys(mock.getState().checkouts).length;

// ------------------------------------------------------------------------------ the flag

test("isLeashOffAllowed and withoutArcadeKey: only LEASH_OFF_ALLOWED=true keeps the key beside LEASH_URL", () => {
  assert.deepEqual(["true", "TRUE", "True"].map((flag) => isLeashOffAllowed({ LEASH_OFF_ALLOWED: flag })), [true, true, true]);
  assert.deepEqual([{}, { LEASH_OFF_ALLOWED: "" }, { LEASH_OFF_ALLOWED: "false" }, { LEASH_OFF_ALLOWED: "1" }].map(isLeashOffAllowed), [false, false, false, false]);
  const env = Object.freeze({ LEASH_URL: "http://127.0.0.1:8080", ARCADE_API_KEY: WEB_KEY, PORT: "0" });
  assert.deepEqual(withoutArcadeKey(env), { LEASH_URL: env.LEASH_URL, PORT: "0" });
  const kept = withoutArcadeKey({ ...env, LEASH_OFF_ALLOWED: "true" });
  assert.deepEqual(kept, { ...env, LEASH_OFF_ALLOWED: "true" });
  assert.equal(withoutArcadeKey({ ...env, LEASH_OFF_ALLOWED: "false" }).ARCADE_API_KEY, undefined);
});

// ------------------------------------------------------------------------------ the wrapped client

test("withSimulatedCheckout: createCheckout reads the product, posts the receipt to the gateway with the admin key, returns { checkoutId, checkoutUrl }; everything else is untouched", async () => {
  const calls = [];
  const product = {
    productId: "prod_1", title: "Silk scarf · roses", unitPrice: { amount: "128.00", currency: "USD" }, images: [{ url: "https://cdn.example/x.png" }],
    selectionLabel: "90 × 90 cm", maker: { name: "Odette" },
  };
  const arcade = {
    baseUrl: "https://platform.arcade.ai/v1",
    getProduct: async (productId, quantity) => { calls.push(["getProduct", productId, quantity]); return product; },
    createCheckout: async () => { throw new Error("the real createCheckout must never run"); },
    listCategories: async () => ({ items: [] }),
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
    return Response.json({ checkoutId: "sim_0123456789abcdef", checkoutUrl: "http://127.0.0.1:8080/simulated-checkout/sim_0123456789abcdef", simulated: true });
  };
  const wrapped = withSimulatedCheckout(arcade, { leashUrl: "http://127.0.0.1:8080/", adminKey: ADMIN_KEY, fetchImpl });
  const checkout = await wrapped.createCheckout({ lines: [{ productId: "prod_1", quantity: 50 }], dropShip: true });
  assert.deepEqual(checkout, { checkoutId: "sim_0123456789abcdef", checkoutUrl: "http://127.0.0.1:8080/simulated-checkout/sim_0123456789abcdef", simulated: true });
  assert.deepEqual(calls, [["getProduct", "prod_1", 50]]);
  assert.deepEqual(requests, [{
    url: "http://127.0.0.1:8080/simulated-checkout", method: "POST", authorization: `Bearer ${ADMIN_KEY}`,
    body: { productId: "prod_1", quantity: 50, unitPrice: "128.00", currency: "USD", title: "Silk scarf · roses", imageUrl: "https://cdn.example/x.png", selectionLabel: "90 × 90 cm", maker: "Odette" },
  }]);
  assert.equal(wrapped.getProduct, arcade.getProduct);
  assert.equal(wrapped.listCategories, arcade.listCategories);
  assert.equal(wrapped.baseUrl, arcade.baseUrl);
  await assert.rejects(() => wrapped.createCheckout({ lines: [] }), /exactly one line, got 0/);
  await assert.rejects(() => wrapped.createCheckout({}), /exactly one line, got none/);

  const refused = withSimulatedCheckout(arcade, { leashUrl: "http://127.0.0.1:8080", adminKey: null, fetchImpl: async () => Response.json({ error: "token_invalid", message: "this route needs Authorization: Bearer <admin key>" }, { status: 401 }) });
  await assert.rejects(() => refused.createCheckout({ lines: [{ productId: "prod_1", quantity: 1 }] }), /Leash \/simulated-checkout → HTTP 401: token_invalid/);
});

// ------------------------------------------------------------------------------ the runtime, end to end

async function startRuntime(extraEnv = {}) {
  const env = {
    ARCADE_MODE: "live", ARCADE_BASE_URL: mock.apiUrl, ARCADE_API_KEY: WEB_KEY, MOCK_PORT: new URL(mock.url).port, AGENT_MODE: "scripted", PORT: "0",
    LEASH_URL: gateway.url, LEASH_ADMIN_KEY: ADMIN_KEY, ...extraEnv,
  };
  const runtime = await createRuntime(env, { createWebServer, logger: silent });
  const texts = [];
  const read = async (response) => {
    const text = await response.text();
    texts.push(text);
    return { status: response.status, json: JSON.parse(text) };
  };
  const json = async (method, path, body) => read(await fetch(`${runtime.web.url}${path}`, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }));
  return {
    runtime, texts,
    chat: async (sessionId, text) => (await json("POST", "/api/chat", { sessionId, text, inspiration: "" })).json,
    config: async () => (await json("GET", "/api/config")).json,
    saveAllowance: (body) => json("POST", "/api/allowance", body),
    removeAllowance: () => json("DELETE", "/api/allowance"),
    paidStatus: (id) => json("GET", `/api/simulated-checkout?mandateId=${id}`),
  };
}

const checkoutUrlOf = (reply) => reply.split(" ").at(-1);
const fetchPage = (url, init = {}) => fetch(url, { redirect: "manual", ...init, headers: { Accept: "text/html", ...init.headers } });

test("live stack, LEASH_OFF_ALLOWED=true: the naive agent exists (the button can turn Leash off), Approve yields a sim_ checkout page, Pay confirms the order, the chat's poll sees it paid, and no Arcade checkout exists", async () => {
  const { runtime, texts, chat, config, paidStatus } = await startRuntime({ LEASH_OFF_ALLOWED: "true" });
  try {
    const shown = await config();
    assert.deepEqual([shown.naiveAgent, shown.gateway, shown.allowance ?? null, shown.keyPresent, shown.arcadeMode], [true, true, null, true, "live"]);
    assert.equal(shown.keyPrefix, "arcade…");
    const before = checkoutCount();

    await chat("off", NORMAL);
    const done = await chat("off", "approve");
    assert.match(done.reply, /^Done\. Checkout for 1 × .+, total \$128\.00: http:\/\/127\.0\.0\.1:\d+\/simulated-checkout\/sim_[0-9a-f]{16}$/, done.reply);
    const checkoutUrl = checkoutUrlOf(done.reply);
    const checkoutId = checkoutUrl.split("/").at(-1);
    assert.equal(done.trace.leash, undefined, "no Leash token was involved");
    assert.deepEqual([done.rawCheckout.source, done.rawCheckout.status], ["agent", 200]);
    assert.deepEqual(JSON.parse(done.rawCheckout.request).quantity, 1);
    assert.equal(JSON.parse(done.rawCheckout.raw).checkoutId, checkoutId);
    assert.equal(checkoutCount(), before, "no checkout reached Arcade");

    const page = await fetchPage(checkoutUrl);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes("Review and pay") && html.includes("Pay $128.00") && html.includes("The agent held the account key; nothing was charged."), html);
    assert.deepEqual((await paidStatus(checkoutId)).json, { mandateId: checkoutId, paid: null, total: "128.00", currency: "USD" });

    assert.equal((await fetchPage(`${checkoutUrl}/pay`, { method: "POST" })).status, 303);
    assert.ok((await (await fetchPage(checkoutUrl)).text()).includes("Order confirmed"));
    const paid = (await paidStatus(checkoutId)).json;
    assert.deepEqual([paid.paid.orderNumber, paid.total], ["SIM-000001", "128.00"]);
    assert.equal(checkoutCount(), before);

    const all = texts.join("\n");
    assert.equal(all.includes(WEB_KEY), false, "the web key never leaves the process unmasked");
    assert.equal(all.includes(ADMIN_KEY), false, "the admin key never leaves the process");
  } finally {
    await runtime.web.close();
  }
});

test("live stack, LEASH_OFF_ALLOWED=true: Leash on (an allowance) still checks out under a mandate (mnd_), and Leash off again goes back to the naive agent", async () => {
  const { runtime, chat, config, saveAllowance, removeAllowance } = await startRuntime({ LEASH_OFF_ALLOWED: "true" });
  try {
    const before = checkoutCount();
    const saved = await saveAllowance(ALLOWANCE);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.match((await config()).leash.tokenId, /^tok_/);
    await chat("on", NORMAL);
    const leashed = await chat("on", "approve");
    assert.match(leashed.reply, /\/simulated-checkout\/mnd_[0-9a-f]{16}$/, leashed.reply);
    assert.match(leashed.trace.leash.mandateId, /^mnd_/);

    assert.equal((await removeAllowance()).status, 200);
    assert.deepEqual([(await config()).naiveAgent, (await config()).allowance ?? null], [true, null]);
    await chat("off-again", NORMAL);
    const naive = await chat("off-again", "approve");
    assert.match(naive.reply, /\/simulated-checkout\/sim_[0-9a-f]{16}$/, naive.reply);
    assert.equal(checkoutCount(), before, "neither path reached Arcade");
  } finally {
    await runtime.web.close();
  }
});

test("live stack without LEASH_OFF_ALLOWED: unchanged, the web holds no key and there is no agent without an allowance", async () => {
  const { runtime, chat, config } = await startRuntime();
  try {
    const shown = await config();
    assert.deepEqual([shown.naiveAgent, shown.keyPresent, shown.keyPrefix], [false, false, ""]);
    const refused = await fetch(`${runtime.web.url}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "none", text: NORMAL, inspiration: "" }),
    });
    assert.equal(refused.status, 503);
    assert.equal(typeof chat, "function");
  } finally {
    await runtime.web.close();
  }
});
