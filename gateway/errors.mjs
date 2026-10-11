// Gateway error type and the closed set of error codes. One code per verification rule so the
// agent, the ledger and the Guardian panel all speak the same words (see gateway/README.md).

export const CODES = Object.freeze({
  bad_request: 400,
  scope_forbidden: 400,
  token_invalid: 401,
  expired: 403,
  token_frozen: 403,
  scope_denied: 403,
  velocity_exceeded: 403,
  mandate_mismatch: 403,
  price_exceeded: 403,
  allowance_exceeded: 403,
  design_swapped: 403,
  mandate_used: 403,
  live_checkout_blocked: 403,
  not_found: 404,
  method_not_allowed: 405,
  price_pending: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  bad_host: 421,
  image_unreadable: 502,
  arcade_error: 502,
});

export class GatewayError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.extra = Object.freeze({ ...extra });
  }
}

export const gatewayError = (code, message, extra = {}) => {
  if (!Object.hasOwn(CODES, code)) throw new Error(`unknown gateway error code ${code}`);
  return new GatewayError(CODES[code], code, message, extra);
};

export const badRequest = (message) => gatewayError("bad_request", message);
export const isGatewayError = (error) => error instanceof GatewayError;
