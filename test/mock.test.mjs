import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockServer, resolveMockHost } from "../mock/arcade-mock.mjs";
import { paletteFor, shapeFor } from "../mock/images.mjs";

const LATENCY_MS = 20;
const HEADERS = { Authorization: "Bearer mock_key", "Content-Type": "application/json", "User-Agent": "mock-test/1.0" };
let mock;
let seq = 0;
const rid = (prefix) => `${prefix}-${process.pid}-${(seq += 1)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  mock = await createMockServer({ port: 0, latencyMs: LATENCY_MS, stateFile: null, logger: null });
});
after(() => mock.close());

async function api(path, body = {}, headers = HEADERS) {
  const response = await fetch(`${mock.apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, contentType: response.headers.get("content-type") };
}

async function waitJob(jobId) {
  for (let i = 0; i < 100; i += 1) {
    const { json } = await api("/jobs/get", { jobId });
    if (json.status !== "running") return json;
    await sleep(LATENCY_MS / 2);
  }
  throw new Error(`job ${jobId} never finished`);
}

async function makePattern(prompt = "blue florals on linen") {
  const created = await api("/patterns/create", { requestId: rid("pat"), prompt });
  const job = await waitJob(created.json.jobId);
  return job.result.patternId;
}

async function categoryByName(name) {
  const { json } = await api("/categories/list", {});
  return json.items.find((item) => item.name === name);
}

async function makeProduct(categoryName = "Silk scarf", prompt) {
  const patternId = await makePattern(prompt);
  const category = await categoryByName(categoryName);
  const { json: cat } = await api("/categories/get", { categoryId: category.categoryId, selections: {} });
  const created = await api("/products/create", {
    requestId: rid("prod"), patternId, categoryId: category.categoryId, selections: cat.selections, fit: { mode: "fill" },
  });
  const job = await waitJob(created.json.jobId);
  return { productId: job.result.productId, patternId };
}

test("401 UNAUTHORIZED without a bearer key", async () => {
  const { Authorization, ...noAuth } = HEADERS;
  const { status, json } = await api("/models/list", {}, noAuth);
  assert.equal(status, 401);
  assert.deepEqual({ code: json.code, status: json.status }, { code: "UNAUTHORIZED", status: 401 });
  assert.equal(typeof json.message, "string");
});

test("403 with a non-JSON body when the User-Agent is missing or a library default", async () => {
  const response = await fetch(`${mock.apiUrl}/models/list`, {
    method: "POST", headers: { Authorization: "Bearer k", "Content-Type": "application/json", "User-Agent": "" }, body: "{}",
  });
  const text = await response.text();
  assert.equal(response.status, 403);
  assert.throws(() => JSON.parse(text));
  const { Authorization, "User-Agent": ua, ...rest } = HEADERS;
  const nodeDefault = await fetch(`${mock.apiUrl}/models/list`, { method: "POST", headers: { ...rest, Authorization }, body: "{}" });
  assert.equal(nodeDefault.status, 403);
});

test("422 INPUT_VALIDATION_FAILED on a missing prompt, with fieldErrors and formErrors", async () => {
  const { status, json } = await api("/patterns/create", { requestId: rid("bad") });
  assert.equal(status, 422);
  assert.equal(json.code, "INPUT_VALIDATION_FAILED");
  assert.ok(json.data.fieldErrors.prompt);
  assert.deepEqual(json.data.formErrors, []);
});

test("400 plain text on malformed JSON", async () => {
  const response = await fetch(`${mock.apiUrl}/models/list`, { method: "POST", headers: HEADERS, body: "{nope" });
  assert.equal(response.status, 400);
});

test("requestId replay with the same body is idempotent; a different body is 409 CONFLICT", async () => {
  const requestId = rid("idem");
  const first = await api("/patterns/create", { requestId, prompt: "red stripes" });
  const replay = await api("/patterns/create", { prompt: "red stripes", requestId });
  assert.equal(first.status, 200);
  assert.deepEqual(replay.json, first.json);
  const clash = await api("/patterns/create", { requestId, prompt: "green dots" });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, "CONFLICT");
});

test("a failed validation does not consume the requestId", async () => {
  const requestId = rid("retry");
  assert.equal((await api("/patterns/create", { requestId, prompt: "" })).status, 422);
  assert.equal((await api("/patterns/create", { requestId, prompt: "fixed" })).status, 200);
});

test("jobs start running with null result and succeed after latency with result.patternId", async () => {
  const { json: job } = await api("/patterns/create", { requestId: rid("job"), prompt: "pink dots" });
  assert.deepEqual({ status: job.status, result: job.result, error: job.error, kind: job.kind }, { status: "running", result: null, error: null, kind: "pattern" });
  assert.equal(job.completedAt, null);
  const done = await waitJob(job.jobId);
  assert.equal(done.status, "succeeded");
  assert.match(done.result.patternId, /^cm/);
  const { json: pattern } = await api("/patterns/get", { patternId: done.result.patternId });
  assert.deepEqual([pattern.width, pattern.height, pattern.prompt, pattern.sourcePatternId], [1024, 1024, "pink dots", null]);
  assert.equal(pattern.imageUrl, `${mock.url}/img/${pattern.patternId}.svg`);
});

test("patterns/refine/edit makes a new pattern with sourcePatternId", async () => {
  const source = await makePattern("blue dots");
  const { json: job } = await api("/patterns/refine/edit", { requestId: rid("edit"), patternId: source, instruction: "make it red" });
  const done = await waitJob(job.jobId);
  const { json: edited } = await api("/patterns/get", { patternId: done.result.patternId });
  assert.equal(edited.sourcePatternId, source);
  assert.notEqual(edited.patternId, source);
});

test("categories: exactly 4, and categories/get returns a complete selection with canManufacture true", async () => {
  const { json: list } = await api("/categories/list", {});
  assert.deepEqual(list.items.map((item) => item.name), ["Silk scarf", "Linen pillow", "Cotton dinner napkins", "Lampshade"]);
  const scarf = list.items[0];
  const { json: cat } = await api("/categories/get", { categoryId: scarf.categoryId, selections: {} });
  assert.equal(cat.canManufacture, true);
  assert.deepEqual(cat.selections, { size: "90x90", hem: "hand-rolled" });
  assert.ok(cat.options.every((opt) => opt.values.every((value) => value.available === true)));
  const { json: picked } = await api("/categories/get", { categoryId: scarf.categoryId, selections: { size: "70x70" } });
  assert.deepEqual(picked.selections, { size: "70x70", hem: "hand-rolled" });
});

test("products/get prices the scarf at 128.00 and applies the 20% tier for quantity 50", async () => {
  const { productId, patternId } = await makeProduct("Silk scarf", "blue florals on linen");
  const { json: one } = await api("/products/get", { productId });
  assert.deepEqual(one.unitPrice, { amount: "128.00", currency: "USD" });
  assert.equal(one.title, "Silk scarf · blue florals on linen");
  assert.equal(one.maker.makerId, "maker-odette");
  assert.equal(one.patternId, patternId);
  assert.equal(one.images[0].url, `${mock.url}/img/${patternId}.svg`);
  assert.equal(one.volumeDiscounts.tiers.length, 2);
  const { json: fifty } = await api("/products/get", { productId, quantity: 50 });
  assert.deepEqual(fifty.unitPrice, { amount: "102.40", currency: "USD" });
  const { json: ten } = await api("/products/get", { productId, quantity: 10 });
  assert.equal(ten.unitPrice.amount, "115.20");
});

test("checkouts/create: 412 for quantity 1 without dropShip, 422 for bad quantities/lines", async () => {
  const { productId } = await makeProduct("Linen pillow");
  const noDrop = await api("/checkouts/create", { requestId: rid("co"), lines: [{ productId, quantity: 1 }] });
  assert.equal(noDrop.status, 412);
  assert.equal(noDrop.json.code, "PRECONDITION_FAILED");
  const tooMany = await api("/checkouts/create", { requestId: rid("co"), lines: [{ productId, quantity: 1001 }], dropShip: true });
  assert.equal(tooMany.status, 422);
  const noLines = await api("/checkouts/create", { requestId: rid("co"), lines: [], dropShip: true });
  assert.equal(noLines.status, 422);
});

test("checkout → orders/get 404 until paid, then status ordered with lines, subtotal and total", async () => {
  const { productId } = await makeProduct("Silk scarf", "large red roses on black");
  const { status, json: checkout } = await api("/checkouts/create", { requestId: rid("co"), lines: [{ productId, quantity: 50 }], dropShip: true });
  assert.equal(status, 200);
  assert.match(checkout.checkoutId, /^\d+$/);
  assert.equal(checkout.checkoutUrl, `${mock.url}/checkout/${checkout.checkoutId}`);

  const unpaid = await api("/orders/get", { checkoutId: checkout.checkoutId });
  assert.equal(unpaid.status, 404);
  assert.equal(unpaid.json.code, "NOT_FOUND");

  const page = await fetch(checkout.checkoutUrl);
  const html = await page.text();
  assert.match(html, /Pay \(mock, no money\)/);
  assert.match(html, /\$102\.40/);
  assert.match(html, /Total: \$5120\.00/);

  const pay = await fetch(`${mock.url}/checkout/${checkout.checkoutId}/pay`, { method: "POST", redirect: "manual" });
  assert.equal(pay.status, 303);

  const { status: paidStatus, json: order } = await api("/orders/get", { checkoutId: checkout.checkoutId });
  assert.equal(paidStatus, 200);
  assert.equal(order.status, "ordered");
  assert.equal(order.lines[0].quantity, 50);
  assert.deepEqual(order.total, { amount: "5120.00", currency: "USD" });
  assert.equal(order.subtotal.amount, "6400.00");
  assert.equal(order.volumeDiscount.amount, "1280.00");
  const byId = await api("/orders/get", { orderId: order.orderId });
  assert.equal(byId.json.orderNumber, order.orderNumber);
  const { json: list } = await api("/orders/list", {});
  assert.ok(list.items.some((item) => item.orderId === order.orderId));
});

test("GET /img/<patternId>.svg returns image/svg+xml drawn from the prompt", async () => {
  const patternId = await makePattern("large red roses on black");
  const response = await fetch(`${mock.url}/img/${patternId}.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
  const svg = await response.text();
  assert.match(svg, /^<svg /);
  assert.match(svg, /#c0392b/);
  assert.match(svg, /large red roses on black/);
  assert.deepEqual(paletteFor("blue florals on linen"), { background: "#e9dfcc", motif: "#2f5d9e" });
  assert.equal(shapeFor("blue florals"), "petals");
  assert.equal(shapeFor("green stripes"), "stripes");
});

test("lists are newest first and paginate with nextCursor", async () => {
  await makePattern("first");
  await makePattern("second");
  const { json: page1 } = await api("/patterns/list", { limit: 1 });
  assert.equal(page1.items[0].prompt, "second");
  assert.ok(page1.nextCursor);
  const { json: page2 } = await api("/patterns/list", { limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.items[0].prompt, "first");
  const { json: products } = await api("/products/list", {});
  assert.ok(Array.isArray(products.items));
});

test("references: createUpload → PUT bytes → create → get; replaying createUpload after use is 409", async () => {
  const body = { requestId: rid("up"), mediaType: "image/png", byteLength: 4 };
  const { json: upload } = await api("/references/createUpload", body);
  assert.match(upload.uploadId, /^[0-9a-f-]{36}\.png$/);
  assert.ok(upload.uploadUrl.startsWith(`${mock.url}/uploads/`));
  const put = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.requiredHeaders, body: new Uint8Array([1, 2, 3, 4]) });
  assert.equal(put.status, 200);
  const { json: ref } = await api("/references/create", { requestId: rid("ref"), uploadId: upload.uploadId });
  assert.ok(ref.referenceId);
  const again = await api("/references/create", { requestId: rid("ref"), uploadId: upload.uploadId });
  assert.equal(again.json.referenceId, ref.referenceId);
  assert.equal((await api("/references/get", { referenceId: ref.referenceId })).status, 200);
  assert.equal((await api("/references/createUpload", body)).status, 409);
});

test("models/list, feedback/create and unknown procedures", async () => {
  const { json: models } = await api("/models/list", {});
  assert.ok(models.items.length > 0 && models.items[0].modelId);
  const { json: feedback } = await api("/feedback/create", { requestId: "fb-1", text: "hello" });
  assert.equal(feedback.requestId, "fb-1");
  assert.equal((await api("/nope/nothing", {})).status, 404);
});

test("CORS allows the web app origin", async () => {
  const response = await fetch(`${mock.apiUrl}/models/list`, { method: "OPTIONS", headers: { Origin: "http://localhost:8787" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:8787");
});

test("state persists to the state file so a restart keeps ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arcade-mock-"));
  const stateFile = join(dir, "state.json");
  try {
    const first = await createMockServer({ port: 0, latencyMs: 0, stateFile, logger: null });
    const created = await fetch(`${first.apiUrl}/patterns/create`, { method: "POST", headers: HEADERS, body: JSON.stringify({ requestId: "persist-1", prompt: "green dots" }) });
    const job = await created.json();
    await first.close();
    const second = await createMockServer({ port: 0, latencyMs: 0, stateFile, logger: null });
    const fetched = await fetch(`${second.apiUrl}/jobs/get`, { method: "POST", headers: HEADERS, body: JSON.stringify({ jobId: job.jobId }) });
    const reloaded = await fetched.json();
    await second.close();
    assert.equal(reloaded.status, "succeeded");
    assert.ok(reloaded.result.patternId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("src/arcade.mjs client works end to end against the replica", async () => {
  process.env.ARCADE_BASE_URL = mock.apiUrl;
  const { createClient } = await import(`../src/arcade.mjs?mock-${Date.now()}`);
  const client = createClient({ apiKey: "mock_key" });
  const pattern = await client.generatePattern({ prompt: "yellow stripes" }, { intervalMs: 5 });
  const { items } = await client.listCategories();
  const lamp = items.find((item) => item.name === "Lampshade");
  const { selections } = await client.getCategory(lamp.categoryId, {});
  const product = await client.buildProduct({ patternId: pattern.patternId, categoryId: lamp.categoryId, selections, fit: { mode: "fill" } }, { intervalMs: 5 });
  assert.equal(product.unitPrice.amount, "180.00");
  const checkout = await client.createCheckout({ lines: [{ productId: product.productId, quantity: 1 }] });
  assert.match(checkout.checkoutUrl, /\/checkout\/\d+$/);
});

test("a malformed percent-escape in a path is a 400, not a 500", async () => {
  const response = await fetch(`${mock.url}/img/%E0%A4%A.svg`);
  assert.equal(response.status, 400);
});

test("MOCK_HOST accepts loopback only unless MOCK_ALLOW_LAN=1", () => {
  assert.equal(resolveMockHost({}), "127.0.0.1");
  assert.equal(resolveMockHost({ MOCK_HOST: "::1" }), "::1");
  assert.throws(() => resolveMockHost({ MOCK_HOST: "0.0.0.0" }), /not loopback/);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(resolveMockHost({ MOCK_HOST: "0.0.0.0", MOCK_ALLOW_LAN: "1" }), "0.0.0.0");
  } finally {
    console.warn = warn;
  }
});
