// Settings → Arcade on the Doraemon stack: the gateway's switch between the replica and live Arcade (and
// live checkout), its admin-only route, the web control that calls it, and the launcher that turns it on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createArcadeSwitch } from "../gateway/arcade-switch.mjs";
import { createGatewayServer } from "../gateway/server.mjs";
import { createArcadeControl } from "../web/arcade-control.mjs";
import { createDoraemonAgent } from "../agent/doraemon-agent.mjs";
import { createLeashClient } from "../gateway/client.mjs";

const SECRET = "arcade-switch-test-secret-0123456789";
const ADMIN_KEY = "arcade-switch-admin-key-0123";
const SILENT = Object.freeze({ info() {}, warn() {}, error() {} });

function fakeArcade(name) {
  const calls = [];
  const call = async (path) => { calls.push(path); return { from: name }; };
  const listCategories = async () => { calls.push("/categories/list"); return { items: [{ categoryId: `${name}-cat`, name: "Scarves" }] }; };
  const unused = async () => { throw new Error("not used here"); };
  return { client: { baseUrl: `http://${name}.test/v1`, call, getProduct: unused, createCheckout: unused, listCategories }, calls };
}

async function withGateway(arcadeSwitch, fn) {
  const gateway = await createGatewayServer({ port: 0, arcadeSwitch, secret: SECRET, adminKey: ADMIN_KEY, logger: SILENT });
  try {
    await fn(gateway);
  } finally {
    await gateway.close();
  }
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
    .then(async (response) => ({ status: response.status, json: await response.json() }));

test("arcade switch: calls go to the selected Arcade; live checkout needs live; back to the replica turns it off", async () => {
  const mock = fakeArcade("mock"), live = fakeArcade("live");
  const arcade = createArcadeSwitch({ mock: mock.client, live: live.client, switchable: true });
  assert.deepEqual(await arcade.client.call("/x"), { from: "mock" });
  assert.throws(() => arcade.set({ mode: "mock", liveCheckoutEnabled: true }), /live checkout needs live Arcade/);
  assert.equal(arcade.set({ mode: "live", liveCheckoutEnabled: true }).liveCheckoutEnabled, true);
  assert.deepEqual(await arcade.client.call("/x"), { from: "live" });
  assert.equal(arcade.client.baseUrl, "http://live.test/v1");
  const back = arcade.set({ mode: "mock" });
  assert.deepEqual({ mode: back.mode, liveCheckoutEnabled: back.liveCheckoutEnabled }, { mode: "mock", liveCheckoutEnabled: false });
});

test("arcade switch: no live key means no live mode; a fixed gateway refuses to switch", () => {
  const noLive = createArcadeSwitch({ mock: fakeArcade("mock").client, switchable: true });
  assert.throws(() => noLive.set({ mode: "live", liveCheckoutEnabled: false }), /live Arcade is not available/);
  const fixed = createArcadeSwitch({ mock: fakeArcade("mock").client, live: fakeArcade("live").client });
  assert.throws(() => fixed.set({ mode: "live" }), /fixed Arcade/);
});

test("gateway: POST /admin/arcade needs the admin key, is ledgered, and /health reports the new state", async () => {
  const mock = fakeArcade("mock"), live = fakeArcade("live");
  await withGateway(createArcadeSwitch({ mock: mock.client, live: live.client, switchable: true }), async (gw) => {
    const anonymous = await post(`${gw.url}/admin/arcade`, { mode: "live", liveCheckoutEnabled: true });
    assert.equal(anonymous.status, 401);
    const switched = await post(`${gw.url}/admin/arcade`, { mode: "live", liveCheckoutEnabled: true }, { Authorization: `Bearer ${ADMIN_KEY}` });
    assert.equal(switched.status, 200);
    assert.deepEqual({ mode: switched.json.mode, liveCheckoutEnabled: switched.json.liveCheckoutEnabled }, { mode: "live", liveCheckoutEnabled: true });
    const health = await (await fetch(`${gw.url}/health`)).json();
    assert.equal(health.mode, "live");
    assert.equal(health.arcade.liveCheckoutEnabled, true);
    assert.equal(health.arcadeBaseUrl, "http://live.test/v1");
    const rows = (await (await fetch(`${gw.url}/ledger`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } })).json()).entries
      .filter((row) => row.endpoint === "/admin/arcade");
    assert.deepEqual(rows.map((row) => row.decision), ["denied", "approved"]);
    assert.equal(rows[1].detail.liveCheckoutEnabled, true);
  });
});

test("web control: switches through the gateway with the admin key and remembers the state for Doraemon's turns", async () => {
  const mock = fakeArcade("mock"), live = fakeArcade("live");
  await withGateway(createArcadeSwitch({ mock: mock.client, live: live.client, switchable: true }), async (gw) => {
    const control = createArcadeControl({ leashUrl: gw.url, adminKey: ADMIN_KEY });
    assert.equal((await control.status()).mode, "mock");
    await control.set({ mode: "live", liveCheckoutEnabled: false });
    assert.deepEqual({ mode: control.current().mode, live: control.current().liveCheckoutEnabled }, { mode: "live", live: false });
    await assert.rejects(control.set({ mode: "mock", liveCheckoutEnabled: true }), (error) => error.status === 400);
  });
});

test("doraemon agent: each turn carries the Arcade switch's state", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ reply: "ok", cards: [], calls: [], notes: [], session: { id: "s1", turns: [{}] } }), { status: 200 });
  };
  const leash = createLeashClient({ leashUrl: "http://127.0.0.1:8080", getToken: async () => "leash_t", fetchImpl });
  let state = { mode: "mock", liveCheckoutEnabled: false };
  const agent = createDoraemonAgent({ leash, serviceKey: "service-key-0123456789", fetchImpl, arcadeState: () => state });
  await agent.handleMessage({ session: { id: "s1", turns: [] }, text: "hi" });
  state = { mode: "live", liveCheckoutEnabled: true };
  await agent.handleMessage({ session: { id: "s1", turns: [{}] }, text: "hi" });
  assert.deepEqual(bodies.map((body) => body.arcade), [{ mode: "mock", liveCheckout: false }, { mode: "live", liveCheckout: true }]);
});
