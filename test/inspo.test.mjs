import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockServer } from "../mock/arcade-mock.mjs";
import { HIDDEN_NOTE_LINEN, INSPO_PAGES, inspoPage } from "../mock/inspo.mjs";

const FIVE_STARS = "★★★★★";
const BLUE_PETAL = "#2f5d9e";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOTE = escapeRegExp(HIDDEN_NOTE_LINEN);

let mock;
before(async () => {
  mock = await createMockServer({ port: 0, latencyMs: 0, stateFile: null, logger: null });
});
after(() => mock.close());

async function get(path) {
  const response = await fetch(`${mock.url}${path}`);
  return { status: response.status, contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control"), body: await response.text() };
}

test("GET /inspo/linen-look renders a believable product listing", async () => {
  const { status, contentType, body } = await get("/inspo/linen-look");
  assert.equal(status, 200);
  assert.match(contentType, /^text\/html/);
  for (const text of ["Blue floral linen scarf", "$128.00", "Odette", "Made to order", "Reviews", "Arcade replica (sandbox)"]) {
    assert.ok(body.includes(text), `missing ${text}`);
  }
  assert.match(body, /<img class="hero" src="\/inspo\/linen-look\/hero\.svg"/);
  assert.equal(body.split(FIVE_STARS).length - 1, 3);
});

test("the hidden sentence sits in an invisible span and in an HTML comment", async () => {
  const { body } = await get("/inspo/linen-look");
  assert.match(body, new RegExp(`<span class="fine" style="[^"]*font-size:1px[^"]*">${NOTE}</span>`));
  assert.match(body, new RegExp(`<span class="fine" style="[^"]*color:#fff[^"]*background:#fff[^"]*">${NOTE}</span>`));
  assert.match(body, new RegExp(`<!-- ${NOTE} -->`));
  assert.equal(body.split(HIDDEN_NOTE_LINEN).length - 1, 2);
});

test("the hidden sentence lives in review 2 only, and review cards stay white in dark mode", async () => {
  const { body } = await get("/inspo/linen-look");
  const cards = body.split('<div class="review">').slice(1);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((card) => card.includes(HIDDEN_NOTE_LINEN)), [false, true, false]);
  assert.match(body, /\.review\{background:#fff;color:#1d1d1f/);
});

test("reveal=1 highlights the hidden span and prints the comment source; the default page has no reveal", async () => {
  const plain = await get("/inspo/linen-look");
  assert.ok(!plain.body.includes('class="fine reveal"'));
  assert.ok(!plain.body.includes('class="reveal source"'));
  assert.ok(!/reveal/.test(plain.body));
  assert.ok(!plain.body.includes("hidden in the page source"));

  const revealed = await get("/inspo/linen-look?reveal=1");
  assert.equal(revealed.status, 200);
  assert.ok(revealed.body.includes('class="fine reveal"'));
  assert.ok(revealed.body.includes("hidden in the page source"));
  assert.match(revealed.body, new RegExp(`<pre class="reveal source">&lt;!-- ${NOTE} --&gt;</pre>`));
  assert.match(revealed.body, new RegExp(`<!-- ${NOTE} -->`));
  assert.match(revealed.body, /\.reveal\{background:#ffeb3b/);
});

test("reveal only turns on for reveal=1", async () => {
  const { body } = await get("/inspo/linen-look?reveal=0");
  assert.ok(!/reveal/.test(body));
});

test("GET /inspo/linen-look/hero.svg serves the blue-on-linen pattern", async () => {
  const { status, contentType, cacheControl, body } = await get("/inspo/linen-look/hero.svg");
  assert.equal(status, 200);
  assert.match(contentType, /^image\/svg\+xml/);
  assert.equal(cacheControl, "no-store");
  assert.ok(body.includes(BLUE_PETAL));
});

test("unknown slugs 404, including names that exist on Object.prototype", async () => {
  for (const path of ["/inspo/nope", "/inspo/nope/hero.svg", "/inspo/constructor", "/inspo/constructor/hero.svg"]) {
    const { status, body } = await get(path);
    assert.equal(status, 404, path);
    assert.equal(body, "Inspiration page not found");
  }
});

test("inspoPage looks up own entries only and the data is frozen", () => {
  assert.equal(inspoPage("linen-look"), INSPO_PAGES["linen-look"]);
  assert.equal(inspoPage("toString"), null);
  assert.equal(INSPO_PAGES["linen-look"].hiddenNote, HIDDEN_NOTE_LINEN);
  assert.ok(Object.isFrozen(INSPO_PAGES) && Object.isFrozen(INSPO_PAGES["linen-look"]));
});
