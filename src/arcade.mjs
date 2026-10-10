import { randomUUID } from "node:crypto";

export const BASE_URL = process.env.ARCADE_BASE_URL ?? "https://platform.arcade.ai/v1";
export const USER_AGENT = process.env.ARCADE_USER_AGENT ?? "shopping-hackaton/0.1 (support@withsavvy.ai)";
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 4 * 60 * 1000;
export const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const KEY_URL = "https://studio.arcade.ai/settings/api-keys";

export class ArcadeError extends Error {
  constructor(status, body, path) {
    const message = typeof body === "object" && body?.message ? body.message : String(body);
    super(`Arcade ${path} → HTTP ${status}: ${message}`);
    this.name = "ArcadeError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export const newRequestId = (prefix) => `${prefix}-${randomUUID()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseBody = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const retryDelayMs = (response, attempt) => {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 1000 * 2 ** attempt;
};

export function createClient({ apiKey = process.env.ARCADE_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error(`ARCADE_API_KEY is not set. Create one at ${KEY_URL} and put it in .env`);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  async function call(path, body = {}, attempt = 0) {
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.ok) return parseBody(response);
    const parsed = await parseBody(response);
    if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(response, attempt));
      return call(path, body, attempt + 1);
    }
    throw new ArcadeError(response.status, parsed, path);
  }

  async function waitForJob(jobId, { intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS, onPoll } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await call("/jobs/get", { jobId });
      onPoll?.(job);
      if (job.status === "succeeded") return job;
      if (job.status === "failed") throw new Error(`Job ${jobId} failed: ${job.error?.message ?? "unknown error"}`);
      if (Date.now() > deadline) throw new Error(`Job ${jobId} still running after ${timeoutMs / 1000}s`);
      await sleep(intervalMs);
    }
  }

  const resultIdOrThrow = (job, key) => {
    const id = job.result?.[key];
    if (!id) throw new Error(`Job ${job.jobId} succeeded but result.${key} is null`);
    return id;
  };

  return {
    call,
    waitForJob,
    listModels: () => call("/models/list", {}),
    listCategories: () => call("/categories/list", {}),
    getCategory: (categoryId, selections = {}) => call("/categories/get", { categoryId, selections }),
    createPattern: ({ prompt, referenceIds, colors, modelId, requestId = newRequestId("pattern") }) =>
      call("/patterns/create", { requestId, prompt, ...(referenceIds && { referenceIds }), ...(colors && { colors }), ...(modelId && { modelId }) }),
    getPattern: (patternId) => call("/patterns/get", { patternId }),
    createProduct: ({ patternId, categoryId, selections, fit, requestId = newRequestId("product") }) =>
      call("/products/create", { requestId, patternId, categoryId, selections, ...(fit && { fit }) }),
    getProduct: (productId, quantity = 1) => call("/products/get", { productId, quantity }),
    createCheckout: ({ lines, dropShip = true, requestId = newRequestId("checkout") }) =>
      call("/checkouts/create", { requestId, lines, dropShip }),
    getOrder: (query) => call("/orders/get", query),
    async generatePattern(args, options) {
      const job = await this.createPattern(args);
      const done = await this.waitForJob(job.jobId, options);
      return this.getPattern(resultIdOrThrow(done, "patternId"));
    },
    async buildProduct(args, options) {
      const job = await this.createProduct(args);
      const done = await this.waitForJob(job.jobId, options);
      return this.getProduct(resultIdOrThrow(done, "productId"));
    },
  };
}
