import { loadDotEnv } from "./_env.mjs";
import { createClient } from "../src/arcade.mjs";

loadDotEnv();
const prompt = process.argv.slice(2).join(" ") || "Small blue and white block-print florals on natural linen";
const client = createClient();
const log = (step, detail) => console.log(`${new Date().toISOString().slice(11, 19)}  ${step.padEnd(18)} ${detail}`);

log("pattern", `prompt: "${prompt}"`);
const pattern = await client.generatePattern({ prompt }, { onPoll: (job) => log("  poll", `${job.kind} ${job.status}`) });
log("pattern ready", `${pattern.patternId} ${pattern.width}x${pattern.height}\n  ${pattern.imageUrl}`);

const { items } = await client.listCategories();
const categoryId = process.env.ARCADE_CATEGORY_ID || items[0]?.categoryId;
if (!categoryId) throw new Error("No categories returned");
const category = await client.getCategory(categoryId, {});
log("category", `${category.name} canManufacture=${category.canManufacture} selections=${JSON.stringify(category.selections)}`);
if (!category.canManufacture) throw new Error("Default selection cannot be manufactured; pick other option values");

const product = await client.buildProduct(
  { patternId: pattern.patternId, categoryId, selections: category.selections, fit: { mode: "fill" } },
  { onPoll: (job) => log("  poll", `${job.kind} ${job.status}`) },
);
const price = product.unitPrice ? `${product.unitPrice.amount} ${product.unitPrice.currency}` : "pricing pending (re-read later)";
log("product ready", `${product.productId} "${product.title}" by ${product.maker.name}\n  price: ${price}\n  image: ${product.imageUrl}`);
log("done", "no checkout was created (nothing charged)");
