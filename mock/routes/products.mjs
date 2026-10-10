// categories/list, categories/get, products/create, products/get, products/list.
import { CATEGORIES, defaultSelections, findCategory } from "../catalog.mjs";
import { notFound, ok, validationFailed } from "../errors.mjs";
import { decodeCursor, newId, newestFirst, paginate, putRecord } from "../state.mjs";
import { DEFAULT_LIMITS, int, listSchema, requestIdRule, str, stringMap, validate } from "../validation.mjs";
import { isReady, jobView, productSummaryView, productView } from "../views.mjs";
import { readyPattern, startJob } from "./patterns.mjs";

const TITLE_PROMPT_CHARS = 40;
const MIN_CROP_PX = 16;
const ZOOM_LEVELS = Object.freeze([1, 2, 3, 4, 8, 12]);

const listCategories = () =>
  ok({ items: CATEGORIES.map(({ categoryId, name }) => ({ categoryId, name, imageUrl: null })) });

function selectionErrors(category, selections, { requireComplete }) {
  const errors = Object.entries(selections).flatMap(([key, value]) => {
    const opt = category.options.find((candidate) => candidate.key === key);
    if (!opt) return [`Unknown option "${key}"`];
    return opt.values.some((candidate) => candidate.value === value) ? [] : [`Unknown value "${value}" for option "${key}"`];
  });
  const missing = requireComplete ? category.options.filter((opt) => !(opt.key in selections)).map((opt) => `Missing option "${opt.key}"`) : [];
  return [...errors, ...missing];
}

const optionsView = (category) =>
  category.options.map((opt) => ({
    key: opt.key,
    label: opt.label,
    values: opt.values.map((value) => ({ ...value, available: true })),
  }));

function getCategory(body) {
  const invalid = validate(body, { categoryId: str(), selections: stringMap({ optional: true }) });
  if (invalid) return invalid;
  const category = findCategory(body.categoryId);
  if (!category) return notFound("Category not found.");
  const sent = body.selections ?? {};
  const problems = selectionErrors(category, sent, { requireComplete: false });
  if (problems.length) return validationFailed({ selections: problems });
  return ok({
    categoryId: category.categoryId,
    name: category.name,
    options: optionsView(category),
    selections: { ...defaultSelections(category), ...sent },
    canManufacture: true,
  });
}

function fitErrors(fit) {
  if (fit === undefined) return [];
  if (fit === null || typeof fit !== "object") return ["Expected object"];
  if (fit.mode === "fill") return Object.keys(fit).length === 1 ? [] : ['fill takes no other keys than "mode"'];
  if (fit.mode !== "crop") return ['mode must be "fill" or "crop"'];
  const crop = fit.crop ?? {};
  const cropOk = [crop.left, crop.top].every((n) => Number.isInteger(n) && n >= 0)
    && [crop.width, crop.height].every((n) => Number.isInteger(n) && n >= MIN_CROP_PX);
  return [
    ...(cropOk ? [] : [`crop needs integer left/top >= 0 and width/height >= ${MIN_CROP_PX}`]),
    ...(ZOOM_LEVELS.includes(fit.zoomLevel) ? [] : [`zoomLevel must be one of ${ZOOM_LEVELS.join(", ")}`]),
  ];
}

const createSchema = { requestId: requestIdRule, patternId: str(), categoryId: str(), selections: stringMap() };

function createProduct(body, { state, ...ctx }) {
  const invalid = validate(body, createSchema, (b) => (fitErrors(b.fit).length ? { fit: fitErrors(b.fit) } : {}));
  if (invalid) return invalid;
  const pattern = readyPattern(state, body.patternId, ctx.now());
  if (!pattern) return notFound("Pattern not found.");
  const category = findCategory(body.categoryId);
  if (!category) return notFound("Category not found.");
  const problems = selectionErrors(category, body.selections, { requireComplete: true });
  if (problems.length) return validationFailed({ selections: problems });
  const productId = newId("prod_");
  const nowMs = ctx.now();
  const record = {
    productId,
    title: `${category.name} · ${(pattern.prompt ?? "Custom pattern").slice(0, TITLE_PROMPT_CHARS)}`,
    categoryId: category.categoryId,
    patternId: pattern.patternId,
    selections: { ...body.selections },
    createdAt: new Date(nowMs).toISOString(),
    readyAt: nowMs + ctx.latencyMs,
  };
  const next = startJob(putRecord(state, "products", productId, record), ctx, { kind: "product", result: { productId } });
  return { ...ok(jobView(next.job, nowMs)), state: next.state };
}

export const readyProduct = (state, productId, now) => {
  const record = state.products[productId];
  return record && isReady(record, now) ? record : null;
};

function getProduct(body, { state, origin, now }) {
  const invalid = validate(body, { productId: str(), quantity: int({ min: 1, optional: true }) });
  if (invalid) return invalid;
  const record = readyProduct(state, body.productId, now());
  return record ? ok(productView(record, origin, body.quantity ?? 1)) : notFound("Product not found.");
}

function listProducts(body, { state, origin, now }) {
  const invalid = validate(body, listSchema("products"));
  if (invalid) return invalid;
  const offset = decodeCursor(body.cursor);
  if (offset === null) return validationFailed({ cursor: ["Invalid cursor"] });
  const ready = newestFirst(Object.values(state.products)).filter((record) => isReady(record, now()));
  const page = paginate(ready, offset, body.limit ?? DEFAULT_LIMITS.products);
  return ok({ items: page.items.map((record) => productSummaryView(record, origin)), nextCursor: page.nextCursor });
}

export const productRoutes = {
  "/categories/list": { handler: listCategories },
  "/categories/get": { handler: getCategory },
  "/products/create": { handler: createProduct, idempotent: true },
  "/products/get": { handler: getProduct },
  "/products/list": { handler: listProducts },
};
