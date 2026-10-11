// Which Arcade procedures an agent token may ever carry. A procedure path ("/patterns/create")
// maps to a scope ("patterns:create"). checkouts:create and the account-wide reads are never
// issued to an agent: the only road to a checkout is POST /checkout with a signed mandate.

export const AGENT_SCOPES = Object.freeze([
  "patterns:create",
  "patterns:get",
  "patterns:refine:edit",
  "patterns:refine:editRegion",
  "patterns:refine:recolorClusters",
  "patterns:refine:recolor",
  "patterns:refine:crop",
  "patterns:refine:makeSeamless",
  "patterns:refine:extendPattern",
  "patterns:refine:extendScene",
  "patterns:refine:fixDeformity",
  "jobs:get",
  "references:createUpload",
  "references:create",
  "references:get",
  "models:list",
  "categories:list",
  "categories:get",
  "products:create",
  "products:get",
]);

export const FORBIDDEN_SCOPES = Object.freeze([
  "checkouts:create",
  "orders:get",
  "orders:list",
  "patterns:list",
  "products:list",
  "references:list",
  "feedback:create",
]);

// Procedures that start paid work on the account (a generation or a build). Counted by the
// velocity rule; recolorClusters is a synchronous read and is not one of them.
export const WORK_STARTING_PROCEDURES = Object.freeze(new Set([
  "/patterns/create",
  "/patterns/refine/edit",
  "/patterns/refine/editRegion",
  "/patterns/refine/recolor",
  "/patterns/refine/crop",
  "/patterns/refine/makeSeamless",
  "/patterns/refine/extendPattern",
  "/patterns/refine/extendScene",
  "/patterns/refine/fixDeformity",
  "/products/create",
]));

const CATEGORY_BEARING = Object.freeze({ "/categories/get": "categoryId", "/products/create": "categoryId" });
// Two or three plain path segments, letters only: no dots, no encoded slashes, no query.
const PROCEDURE_SHAPE = /^(\/[A-Za-z]+){2,3}$/;

export const isValidProcedure = (path) => typeof path === "string" && PROCEDURE_SHAPE.test(path);
export const scopeForProcedure = (path) => String(path ?? "").split("/").filter(Boolean).join(":");
export const isForbiddenScope = (scope) => FORBIDDEN_SCOPES.includes(scope);
export const isAgentScope = (scope) => AGENT_SCOPES.includes(scope);
export const isWorkStarting = (path) => WORK_STARTING_PROCEDURES.has(path);

export function procedureCategoryId(path, body) {
  const field = CATEGORY_BEARING[path];
  if (!field) return null;
  const value = body?.[field];
  return typeof value === "string" && value !== "" ? value : null;
}
