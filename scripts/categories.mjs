import { loadDotEnv } from "./_env.mjs";
import { createClient } from "../src/arcade.mjs";

loadDotEnv();
const client = createClient();
const { items } = await client.listCategories();
console.log(`${items.length} categories\n`);

for (const { categoryId, name } of items) {
  const category = await client.getCategory(categoryId, {});
  const options = category.options.map((option) => `${option.key}(${option.values.length})`).join(" ");
  console.log(`${categoryId}\t${name}\tcanManufacture=${category.canManufacture}\n  options: ${options}\n  defaults: ${JSON.stringify(category.selections)}`);
}
