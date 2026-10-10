// Agent mode detection: "llm" when Anthropic credentials resolve, else the deterministic "scripted" stand-in.
// Checks env and the ant auth profile directory with fs only; never runs a command at request time.
// This is the only detector: web/config.mjs and scripts/dev.mjs import it.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_MODES = Object.freeze(["scripted", "llm"]);
export const DEFAULT_MODEL = "claude-opus-5-5";

const hasProfileIn = (dir) => {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

const profileDirs = (env, home) => [
  ...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, "anthropic")] : []),
  join(home, ".config", "anthropic"),
];

export function resolveAgentMode(env = process.env, home = homedir()) {
  if (AGENT_MODES.includes(env.AGENT_MODE)) return env.AGENT_MODE;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "llm";
  return profileDirs(env, home).some(hasProfileIn) ? "llm" : "scripted";
}
