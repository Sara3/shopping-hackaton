// patterns/create, patterns/get, patterns/list, patterns/refine/edit, jobs/get, models/list.
import { MODELS } from "../catalog.mjs";
import { notFound, ok, validationFailed } from "../errors.mjs";
import { decodeCursor, newId, newestFirst, paginate, putRecord } from "../state.mjs";
import { DEFAULT_LIMITS, listSchema, requestIdRule, str, stringArray, validate } from "../validation.mjs";
import { isReady, jobView, patternView } from "../views.mjs";

const MAX_PROMPT = 1000;
const MAX_REFERENCES = 3;
const MAX_COLORS = 10;

export function startJob(state, ctx, { kind, result }) {
  const jobId = newId("job_");
  const nowMs = ctx.now();
  const job = { jobId, kind, result, createdAt: new Date(nowMs).toISOString(), readyAt: nowMs + ctx.latencyMs };
  return { state: putRecord(state, "jobs", jobId, job), job };
}

function addPattern(state, ctx, { prompt, renderPrompt, sourcePatternId }) {
  const patternId = newId("cm");
  const nowMs = ctx.now();
  const record = {
    patternId,
    prompt,
    renderPrompt,
    sourcePatternId,
    createdAt: new Date(nowMs).toISOString(),
    readyAt: nowMs + ctx.latencyMs,
  };
  const withPattern = putRecord(state, "patterns", patternId, record);
  return startJob(withPattern, ctx, { kind: "pattern", result: { patternId } });
}

export const readyPattern = (state, patternId, now) => {
  const record = state.patterns[patternId];
  return record && isReady(record, now) ? record : null;
};

const createSchema = {
  requestId: requestIdRule,
  prompt: str({ min: 1, max: MAX_PROMPT }),
  referenceIds: stringArray({ maxItems: MAX_REFERENCES, optional: true }),
  modelId: str({ optional: true }),
  colors: stringArray({ maxItems: MAX_COLORS, optional: true }),
};

const unknownModel = (body) =>
  body.modelId !== undefined && !MODELS.some((model) => model.modelId === body.modelId)
    ? { modelId: ["Unknown modelId; use one from models.list"] }
    : {};

function createPattern(body, { state, ...ctx }) {
  const invalid = validate(body, createSchema, unknownModel);
  if (invalid) return invalid;
  const missingRef = (body.referenceIds ?? []).find((id) => !state.references[id] && !state.patterns[id]);
  if (missingRef) return notFound(`Reference ${missingRef} not found.`);
  const colors = body.colors?.length ? ` ${body.colors.join(" ")}` : "";
  const next = addPattern(state, ctx, { prompt: body.prompt, renderPrompt: `${body.prompt}${colors}`, sourcePatternId: null });
  return { ...ok(jobView(next.job, ctx.now())), state: next.state };
}

function getPattern(body, { state, origin, now }) {
  const invalid = validate(body, { patternId: str() });
  if (invalid) return invalid;
  const record = readyPattern(state, body.patternId, now());
  return record ? ok(patternView(record, origin)) : notFound("Pattern not found.");
}

function listPatterns(body, { state, origin, now }) {
  const invalid = validate(body, listSchema("patterns"));
  if (invalid) return invalid;
  const offset = decodeCursor(body.cursor);
  if (offset === null) return validationFailed({ cursor: ["Invalid cursor"] });
  const ready = newestFirst(Object.values(state.patterns)).filter((record) => isReady(record, now()));
  const page = paginate(ready, offset, body.limit ?? DEFAULT_LIMITS.patterns);
  return ok({ items: page.items.map((record) => patternView(record, origin)), nextCursor: page.nextCursor });
}

const editSchema = {
  requestId: requestIdRule,
  patternId: str(),
  instruction: str({ min: 1, max: MAX_PROMPT }),
  referenceId: str({ optional: true }),
  colors: stringArray({ maxItems: MAX_COLORS, optional: true }),
};

function editPattern(body, { state, ...ctx }) {
  const invalid = validate(body, editSchema);
  if (invalid) return invalid;
  const source = readyPattern(state, body.patternId, ctx.now());
  if (!source) return notFound("Pattern not found.");
  const next = addPattern(state, ctx, {
    prompt: source.prompt,
    renderPrompt: `${source.renderPrompt} ${body.instruction}`,
    sourcePatternId: source.patternId,
  });
  return { ...ok(jobView(next.job, ctx.now())), state: next.state };
}

function getJob(body, { state, now }) {
  const invalid = validate(body, { jobId: str() });
  if (invalid) return invalid;
  const job = state.jobs[body.jobId];
  return job ? ok(jobView(job, now())) : notFound("Job not found.");
}

const listModels = () => ok({ items: MODELS.map((model) => ({ ...model })) });

export const patternRoutes = {
  "/patterns/create": { handler: createPattern, idempotent: true },
  "/patterns/get": { handler: getPattern },
  "/patterns/list": { handler: listPatterns },
  "/patterns/refine/edit": { handler: editPattern, idempotent: true },
  "/jobs/get": { handler: getJob },
  "/models/list": { handler: listModels },
};
