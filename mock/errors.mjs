// Arcade-shaped JSON error results: { status, body: { code, status, message, data? } }.

export const apiError = (status, code, message, data) => ({
  status,
  body: { code, status, message, ...(data && { data }) },
});

export const notFound = (message) => apiError(404, "NOT_FOUND", message);
export const conflict = (message) => apiError(409, "CONFLICT", message);
export const unauthorized = () =>
  apiError(401, "UNAUTHORIZED", "API key missing, invalid, expired or revoked. Send Authorization: Bearer <key>.");
export const preconditionFailed = (message) => apiError(412, "PRECONDITION_FAILED", message);

export const validationFailed = (fieldErrors = {}, formErrors = []) =>
  apiError(422, "INPUT_VALIDATION_FAILED", summarize(fieldErrors, formErrors), { fieldErrors, formErrors });

const summarize = (fieldErrors, formErrors) => {
  const parts = [...formErrors, ...Object.entries(fieldErrors).map(([field, messages]) => `${field}: ${messages.join(", ")}`)];
  return parts.length ? `Invalid input. ${parts.join("; ")}` : "Invalid input.";
};

export const ok = (body) => ({ status: 200, body });
