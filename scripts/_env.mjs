import { readFileSync } from "node:fs";

const ENV_FILE = new URL("../.env", import.meta.url);

const parseLine = (line) => {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!match || line.trimStart().startsWith("#")) return null;
  return [match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")];
};

export function loadDotEnv() {
  let text;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return {};
  }
  const pairs = text.split("\n").map(parseLine).filter(Boolean);
  for (const [key, value] of pairs) {
    if (process.env[key] === undefined && value !== "") process.env[key] = value;
  }
  return Object.fromEntries(pairs);
}
