import { USER_AGENT } from "../src/arcade.mjs";
import { connectFromEnv } from "./_arcade.mjs";

const { client, endpoint } = await connectFromEnv({ script: "doctor" });
const [major] = process.versions.node.split(".").map(Number);
const checks = [["node >= 22", major >= 22, process.versions.node]];

const key = endpoint.apiKey;
const keyLabel = endpoint.mode === "live" ? "ARCADE_API_KEY set" : "mock key set";
checks.push([keyLabel, Boolean(key), key ? `${key.slice(0, 6)}…` : "missing → https://studio.arcade.ai/settings/api-keys"]);

if (key) {
  try {
    const models = await client.listModels();
    checks.push(["models/list (read-only)", true, `${models.items?.length ?? models.models?.length ?? "?"} models`]);
    const categories = await client.listCategories();
    checks.push(["categories/list (read-only)", true, `${categories.items.length} categories`]);
  } catch (error) {
    checks.push(["API reachable", false, error.message]);
  }
}

console.log(`mode       ${endpoint.mode}\nbase URL   ${endpoint.baseUrl}\nuser-agent ${USER_AGENT}\n`);
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(28)} ${detail}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
