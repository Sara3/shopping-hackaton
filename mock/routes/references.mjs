// references/createUpload, references/create, references/get, references/list,
// plus the PUT /uploads/<uploadId> target the signed uploadUrl points at.
import { randomUUID } from "node:crypto";
import { apiError, notFound, ok, validationFailed } from "../errors.mjs";
import { decodeCursor, newId, newestFirst, paginate, putRecord, replaceRecord } from "../state.mjs";
import { DEFAULT_LIMITS, int, listSchema, oneOf, requestIdRule, str, validate } from "../validation.mjs";
import { referenceView } from "../views.mjs";

const MEDIA_EXTENSIONS = Object.freeze({ "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
export const UPLOAD_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(gif|jpg|png|webp)$/;

const createUploadSchema = {
  requestId: requestIdRule,
  mediaType: oneOf(Object.keys(MEDIA_EXTENSIONS)),
  byteLength: int({ min: 1, max: MAX_UPLOAD_BYTES }),
};

function createUpload(body, { state, origin, now }) {
  const invalid = validate(body, createUploadSchema);
  if (invalid) return invalid;
  const uploadId = `${randomUUID()}.${MEDIA_EXTENSIONS[body.mediaType]}`;
  const expiresAt = new Date(now() + UPLOAD_TTL_MS).toISOString();
  const upload = { uploadId, mediaType: body.mediaType, byteLength: body.byteLength, byteCount: null, referenceId: null, expiresAt };
  return {
    ...ok({
      uploadId,
      uploadUrl: `${origin}/uploads/${uploadId}`,
      method: "PUT",
      requiredHeaders: { "Content-Type": body.mediaType },
      expiresAt,
    }),
    state: putRecord(state, "uploads", uploadId, upload),
  };
}

// A createUpload replay is a 409 once its upload was saved as a reference.
const uploadAlreadyUsed = (state, stored) => Boolean(state.uploads[stored.body.uploadId]?.referenceId);

function createReference(body, { state, origin, now }) {
  const invalid = validate(body, { requestId: requestIdRule, uploadId: str({ pattern: UPLOAD_ID_PATTERN }) });
  if (invalid) return invalid;
  const upload = state.uploads[body.uploadId];
  if (!upload) return notFound("Upload not found.");
  if (upload.referenceId) return ok(referenceView(state.references[upload.referenceId], origin));
  if (upload.byteCount === null) return validationFailed({ uploadId: ["The file was not uploaded to uploadUrl yet"] });
  const referenceId = newId("ref_");
  const record = { referenceId, mediaType: upload.mediaType, uploadId: upload.uploadId, createdAt: new Date(now()).toISOString() };
  const withRef = putRecord(state, "references", referenceId, record);
  const next = replaceRecord(withRef, "uploads", upload.uploadId, { ...upload, referenceId });
  return { ...ok(referenceView(record, origin)), state: next };
}

function getReference(body, { state, origin }) {
  const invalid = validate(body, { referenceId: str() });
  if (invalid) return invalid;
  const record = state.references[body.referenceId];
  return record ? ok(referenceView(record, origin)) : notFound("Reference not found.");
}

function listReferences(body, { state, origin }) {
  const invalid = validate(body, listSchema("references"));
  if (invalid) return invalid;
  const offset = decodeCursor(body.cursor);
  if (offset === null) return validationFailed({ cursor: ["Invalid cursor"] });
  const page = paginate(newestFirst(Object.values(state.references)), offset, body.limit ?? DEFAULT_LIMITS.references);
  return ok({ items: page.items.map((record) => referenceView(record, origin)), nextCursor: page.nextCursor });
}

// PUT /uploads/<uploadId>: raw bytes, Content-Type must match requiredHeaders exactly.
export function putUpload(state, { uploadId, contentType, byteCount, now }) {
  const upload = state.uploads[uploadId];
  if (!upload) return apiError(404, "NOT_FOUND", "Upload URL not found.");
  if (Date.parse(upload.expiresAt) < now) return apiError(403, "FORBIDDEN", "Upload URL expired.");
  if (contentType !== upload.mediaType) return apiError(403, "FORBIDDEN", "Content-Type does not match the signed headers.");
  if (byteCount < 1 || byteCount > MAX_UPLOAD_BYTES) return apiError(413, "PAYLOAD_TOO_LARGE", "File size out of range.");
  return { status: 200, body: {}, state: replaceRecord(state, "uploads", uploadId, { ...upload, byteCount }) };
}

export const referenceRoutes = {
  "/references/createUpload": { handler: createUpload, idempotent: true, replayConflict: uploadAlreadyUsed },
  "/references/create": { handler: createReference, idempotent: true },
  "/references/get": { handler: getReference },
  "/references/list": { handler: listReferences },
};
