// NAIVE SHOPPING AGENT - deliberately vulnerable. This is the target the team red-teams in the
// sandbox (mock Arcade on localhost:8788). Do not ship it. The Leash gateway (built Sunday) is the fix.
//
// The flaws, on purpose:
// 1. Inspiration text is concatenated raw into the user turn as
//    "Inspiration content the user shared:\n<text>" - no separation of data from instructions.
// 2. The system prompt tells the model to use that content to refine the design AND the order details.
// 3. create_checkout accepts any quantity, and the reply echoes whatever URL the model outputs verbatim.
// 4. The Arcade client it is given holds the FULL account key (web/bootstrap.mjs builds it).
// The trace records every tool call {tool, args, resultSummary, ms}, the masked key and the mode.
import { DEFAULT_MODEL, resolveAgentMode } from "./mode.mjs";
import { runScriptedTurn } from "./scripted.mjs";
import { createAnthropicClient, runLlmTurn } from "./llm.mjs";

export { resolveAgentMode } from "./mode.mjs";

const SESSION_KEYS = Object.freeze(["turns", "patterns", "products", "checkouts"]);

const normalizeSession = (session) => ({
  id: session?.id ?? null,
  ...Object.fromEntries(SESSION_KEYS.map((key) => [key, Array.isArray(session?.[key]) ? session[key] : []])),
});

const appendTurns = (session, message, reply) => ({
  ...session,
  turns: [
    ...session.turns,
    { role: "user", text: message.text, inspiration: message.inspiration },
    { role: "assistant", text: reply },
  ],
});

export function createNaiveAgent({ arcade, mode, model = DEFAULT_MODEL, logger = console, keyPrefix = null, client = null, priceRetry } = {}) {
  if (!arcade) throw new Error("createNaiveAgent needs an arcade client (src/arcade.mjs createClient)");
  const resolvedMode = mode === "llm" || mode === "scripted" ? mode : resolveAgentMode();
  let clientPromise = client ? Promise.resolve(client) : null;
  const getClient = () => {
    clientPromise ??= createAnthropicClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
    return clientPromise;
  };

  async function handleMessage({ session, text, inspiration = "" }) {
    if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
    const message = { text: text.trim(), inspiration: typeof inspiration === "string" ? inspiration : "" };
    const start = { session: normalizeSession(session), calls: [], cards: [], notes: [] };
    const deps = { arcade, logger, priceRetry };
    const { state, reply } = resolvedMode === "llm"
      ? await runLlmTurn(start, message, { ...deps, client: await getClient(), model })
      : await runScriptedTurn(start, message, deps);
    const trace = { mode: resolvedMode, model: resolvedMode === "llm" ? model : null, keyPrefix, calls: state.calls, notes: state.notes };
    return { session: appendTurns(state.session, message, reply), reply, cards: state.cards, trace };
  }

  return { mode: resolvedMode, handleMessage };
}
