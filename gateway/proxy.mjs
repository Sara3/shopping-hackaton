// The /arcade/* gate. An agent call reaches Arcade only when the token is not frozen, the procedure
// is one of the token's scopes and never a forbidden one, the category it names (if any) is one of
// the token's categories, and it is inside the velocity budget. Arcade's own errors pass through.
import { ArcadeError } from "../src/arcade.mjs";
import { badRequest, gatewayError } from "./errors.mjs";
import { canonicalJson, sha256Hex } from "./signing.mjs";
import {
  isAgentScope, isForbiddenScope, isValidProcedure, isWorkStarting, procedureCategoryId, scopeForProcedure,
} from "./scopes.mjs";

const MAX_ECHOED_CHARS = 80;
const CATEGORY_PROBE = Object.freeze({ categoryId: "probe" });

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const echo = (value) => String(value ?? "").slice(0, MAX_ECHOED_CHARS);
// A procedure "names a category" when procedureCategoryId reads a categoryId from its body.
const namesCategory = (procedure) => procedureCategoryId(procedure, CATEGORY_PROBE) !== null;
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// Shape, forbidden list and the agent allow-list: checked again on forward, whatever the claims say.
function proxiableScope(procedure) {
  const scope = scopeForProcedure(procedure);
  if (!isValidProcedure(procedure) || isForbiddenScope(scope) || !isAgentScope(scope)) {
    throw gatewayError("scope_denied", `procedure ${echo(procedure)} is never proxied for an agent`, { rule: "scope" });
  }
  return scope;
}

function checkNotFrozen(claims, detector) {
  const status = detector.isFrozen(claims.tokenId);
  if (!status.frozen) return;
  throw gatewayError("token_frozen", `token is frozen (${status.reason})`, { rule: status.reason, tokenFrozen: true });
}

function checkScope(claims, procedure) {
  const scope = proxiableScope(procedure);
  if (Array.isArray(claims.scopes) && claims.scopes.includes(scope)) return scope;
  throw gatewayError("scope_denied", `procedure ${echo(procedure)} is outside this token's scopes`, { rule: "scope" });
}

async function checkCategory(claims, procedure, body, categoryResolver) {
  if (!namesCategory(procedure)) return;
  const categoryId = procedureCategoryId(procedure, body);
  if (categoryId === null) throw badRequest(`${procedure} needs categoryId as a non-empty string`);
  if (await categoryResolver.isAllowed(claims.categories, categoryId)) return;
  throw gatewayError("scope_denied", `category ${echo(categoryId)} is outside this token's categories`, { rule: "off_scope_category" });
}

// One logical work start: the shared client retries a 429/5xx with the very same body (same requestId),
// which Arcade answers idempotently, so it counts once. No requestId → every call counts.
const workStartKey = (procedure, body) =>
  (typeof body.requestId === "string" && body.requestId !== "" ? sha256Hex(`${procedure}\n${canonicalJson(body)}`) : null);

// Counted only after scope and category passed, so a denied call never spends velocity budget.
function checkVelocity(claims, procedure, body, detector) {
  if (!isWorkStarting(procedure)) return false;
  if (detector.recordWorkStart(claims.tokenId, workStartKey(procedure, body)).allowed) return true;
  throw gatewayError("velocity_exceeded", "too many work-starting calls inside one minute", { rule: "velocity" });
}

export async function authorizeProcedure({ claims, procedure, body }, { detector, categoryResolver }) {
  checkNotFrozen(claims, detector);
  const scope = checkScope(claims, procedure);
  if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
  await checkCategory(claims, procedure, body, categoryResolver);
  const workStarting = checkVelocity(claims, procedure, body, detector);
  return { scope, workStarting };
}

export async function forwardProcedure({ procedure, body }, { arcade }) {
  proxiableScope(procedure);
  if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
  try {
    return { status: 200, body: await arcade.call(procedure, body) };
  } catch (error) {
    if (error instanceof ArcadeError) return { status: error.status, body: error.body };
    throw gatewayError("arcade_error", `Arcade ${procedure} failed: ${messageOf(error)}`);
  }
}
