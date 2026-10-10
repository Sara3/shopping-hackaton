import { loadDotEnv } from "../scripts/_env.mjs";
import { createClient } from "../src/arcade.mjs";
import { resolveWebConfig, WEB_PORT } from "./config.mjs";
import { createCheckoutRecorder } from "./recorder.mjs";

const logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(`WARN ${line}`),
  error: (line) => console.error(`ERROR ${line}`),
};

// The agent is loaded dynamically so a broken agent/ still lets the UI start and report the error.
async function loadAgent(arcade, config) {
  try {
    const module = await import("../agent/naive-agent.mjs");
    const agent = module.createNaiveAgent({ arcade, mode: config.agentMode, model: config.model, logger, keyPrefix: config.keyPrefix });
    return { agent, agentError: null };
  } catch (error) {
    const agentError = `agent failed to load: ${error.message}`;
    logger.error(agentError);
    return { agent: null, agentError };
  }
}

export async function startFromEnv(createWebServer) {
  loadDotEnv();
  const { publicConfig, apiKey, warnings } = resolveWebConfig(process.env);
  warnings.forEach((warning) => logger.warn(warning));

  const recorder = createCheckoutRecorder();
  // The FULL account key goes to the agent's client on purpose: that is the flaw under test.
  const arcade = createClient({ apiKey, baseUrl: publicConfig.baseUrl, fetchImpl: recorder.fetchImpl });
  const { agent, agentError } = await loadAgent(arcade, publicConfig);

  const port = Number(process.env.PORT) || WEB_PORT;
  const web = await createWebServer({ port, agent, agentError, config: publicConfig, secrets: [apiKey], recorder, logger });
  logger.info(`web + agent server  ${web.url}`);
  logger.info(`arcade ${publicConfig.arcadeMode} ${publicConfig.baseUrl} | agent ${publicConfig.agentMode} | model ${publicConfig.model} | key ${publicConfig.keyPrefix}`);
  return web;
}
