import { loadDotEnv } from "./_env.mjs";
import { createClient, BASE_URL, USER_AGENT } from "../src/arcade.mjs";

loadDotEnv();
const [major] = process.versions.node.split(".").map(Number);
const checks = [["node >= 22", major >= 22, process.versions.node]];

const key = process.env.ARCADE_API_KEY;
checks.push(["ARCADE_API_KEY set", Boolean(key), key ? `${key.slice(0, 6)}…` : "missing → https://studio.arcade.ai/settings/api-keys"]);

if (key) {
  const client = createClient();
  try {
    const models = await client.listModels();
    checks.push(["models/list (read-only)", true, `${models.items?.length ?? models.models?.length ?? "?"} models`]);
    const categories = await client.listCategories();
    checks.push(["categories/list (read-only)", true, `${categories.items.length} categories`]);
  } catch (error) {
    checks.push(["API reachable", false, error.message]);
  }
}

console.log(`base URL   ${BASE_URL}\nuser-agent ${USER_AGENT}\n`);
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(28)} ${detail}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
