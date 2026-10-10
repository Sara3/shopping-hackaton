import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, ArcadeError } from "../src/arcade.mjs";

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fakeFetch = (responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, calls };
};

test("throws a clear error when the API key is missing", () => {
  assert.throws(() => createClient({ apiKey: "" }), /ARCADE_API_KEY is not set/);
});

test("sends bearer auth, User-Agent and JSON body", async () => {
  const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { items: [] })]);
  const client = createClient({ apiKey: "k", fetchImpl });
  await client.listCategories();
  assert.equal(calls[0].url, "https://platform.arcade.ai/v1/categories/list");
  assert.equal(calls[0].headers.Authorization, "Bearer k");
  assert.match(calls[0].headers["User-Agent"], /shopping-hackaton/);
});

test("retries a 429 using Retry-After, then succeeds", async () => {
  const { fetchImpl, calls } = fakeFetch([
    jsonResponse(429, { error: "rate_limit_exceeded", message: "slow down" }, { "retry-after": "0" }),
    jsonResponse(200, { items: [{ categoryId: "c1", name: "Pillow", imageUrl: null }] }),
  ]);
  const client = createClient({ apiKey: "k", fetchImpl });
  const result = await client.listCategories();
  assert.equal(calls.length, 2);
  assert.equal(result.items[0].categoryId, "c1");
});

test("does not retry a 422 and surfaces the API message", async () => {
  const { fetchImpl, calls } = fakeFetch([
    jsonResponse(422, { code: "INPUT_VALIDATION_FAILED", status: 422, message: "prompt is required" }),
  ]);
  const client = createClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.createPattern({ prompt: "" }), (error) => {
    assert.ok(error instanceof ArcadeError);
    assert.equal(error.status, 422);
    assert.match(error.message, /prompt is required/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("generatePattern polls the job until it succeeds and returns the pattern", async () => {
  const running = { jobId: "j1", kind: "pattern", status: "running", result: null, error: null };
  const succeeded = { ...running, status: "succeeded", result: { patternId: "p1" } };
  const pattern = { patternId: "p1", imageUrl: "https://x/p1.png", thumbnailUrl: "https://x/t.png", width: 1024, height: 1024, prompt: "hi", sourcePatternId: null, createdAt: "2026-10-10T00:00:00Z" };
  const { fetchImpl, calls } = fakeFetch([jsonResponse(200, running), jsonResponse(200, running), jsonResponse(200, succeeded), jsonResponse(200, pattern)]);
  const client = createClient({ apiKey: "k", fetchImpl });
  const polls = [];
  const result = await client.generatePattern({ prompt: "hi", requestId: "r1" }, { intervalMs: 1, onPoll: (job) => polls.push(job.status) });
  assert.deepEqual(polls, ["running", "succeeded"]);
  assert.equal(calls[0].body.requestId, "r1");
  assert.equal(calls[1].body.jobId, "j1");
  assert.equal(result.patternId, "p1");
});

test("waitForJob rejects with the job error message when the job fails", async () => {
  const failed = { jobId: "j2", kind: "product", status: "failed", result: null, error: { message: "aspect ratio mismatch" } };
  const { fetchImpl } = fakeFetch([jsonResponse(200, failed)]);
  const client = createClient({ apiKey: "k", fetchImpl });
  await assert.rejects(client.waitForJob("j2", { intervalMs: 1 }), /aspect ratio mismatch/);
});

test("createCheckout defaults dropShip to true for single-item consumer orders", async () => {
  const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { checkoutId: "1", checkoutUrl: "https://pay/1" })]);
  const client = createClient({ apiKey: "k", fetchImpl });
  await client.createCheckout({ lines: [{ productId: "pr1", quantity: 1 }] });
  assert.equal(calls[0].body.dropShip, true);
  assert.equal(calls[0].body.lines[0].quantity, 1);
});
