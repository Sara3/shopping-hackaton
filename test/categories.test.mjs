import { test } from "node:test";
import assert from "node:assert/strict";
import { namesFor, withLiveNames } from "../src/categories.mjs";
import { runTool } from "../agent/tools.mjs";

const LIVE_ITEMS = [
  { categoryId: "live-pillows", name: "Decorative Pillows" },
  { categoryId: "live-scarves", name: "Scarves" },
  { categoryId: "live-ribbon", name: "Ribbon Scarf" },
];

test("namesFor puts the replica name first, then the live Arcade names, case-insensitively", () => {
  assert.deepEqual([...namesFor("Silk scarf")], ["Silk scarf", "Scarves", "Ribbon Scarf"]);
  assert.deepEqual([...namesFor("lampshade")], ["lampshade", "Drum Lampshades"]);
  assert.deepEqual([...namesFor("Tea Towels")], ["Tea Towels"]);
});

test("withLiveNames expands an allowance's categories once each, in order", () => {
  assert.deepEqual([...withLiveNames(["Silk scarf", "Silk scarf", "Napkins"])], ["Silk scarf", "Scarves", "Ribbon Scarf", "Napkins"]);
  assert.deepEqual([...withLiveNames(undefined)], []);
});

test("build_product finds live Arcade's Scarves when the agent asks for a Silk scarf", async () => {
  const asked = [];
  const arcade = {
    listCategories: async () => ({ items: LIVE_ITEMS }),
    getCategory: async (categoryId) => { asked.push(categoryId); return { selections: {} }; },
    buildProduct: async ({ categoryId }) => ({ productId: `prod-${categoryId}`, title: "Scarves", unitPrice: { amount: "64.00" } }),
  };
  const state = { session: { patterns: [{ patternId: "pat-1" }], products: [] }, calls: [], cards: [] };
  const turn = await runTool(state, "build_product", { patternId: "pat-1", category: "Silk scarf" }, { arcade });
  assert.equal(turn.isError, false, JSON.stringify(turn.result));
  assert.deepEqual(asked, ["live-scarves"]);
});
