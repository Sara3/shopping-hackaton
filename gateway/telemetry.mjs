/**
 * OpenTelemetry setup for the Leash gateway. One span per route handler in server.mjs
 * (`token.issue`, `mandate.create`, `checkout`, `arcade.call`), each carrying
 * `security.decision`/`security.reason` and token identity attributes (tokenId/scopes/
 * maxSpend), exported to a local Jaeger over OTLP HTTP. No ledger, no second destination
 * -- the hash-chained ledger (ledger.mjs) already owns the audit trail; Jaeger is for
 * live trace inspection during the demo.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const TRACER_NAME = "leash-gateway";

let sdk = null;

/** Call once at process startup, before the server starts accepting requests. No-ops
 * (no exporter, no SDK) when OTEL_ENABLED isn't "true", so `node --test` -- which builds
 * many gateway instances via createGatewayServer() directly -- never touches this. */
export function initTelemetry() {
  if ((process.env.OTEL_ENABLED ?? "false").toLowerCase() !== "true") return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "leash-gateway" }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  });
  sdk.start();
  console.log(`[telemetry] gateway tracing to ${endpoint} -- Jaeger UI: http://localhost:16686`);
}

export async function shutdownTelemetry() {
  if (sdk) await sdk.shutdown();
}

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Wraps `fn` in a span named `name`, applying `attributes` up front and recording the
 * outcome (status + any thrown error) automatically. `fn` receives the live span so call
 * sites can add attributes discovered mid-operation (e.g. `security.decision` once the
 * gatekeeper has actually decided).
 *
 * @template T
 * `fn` may be sync or async -- this always awaits it, so a live Arcade call (a real
 * network request) keeps the span open for its actual duration instead of closing it
 * immediately after returning a pending Promise.
 *
 * @param {string} name
 * @param {Record<string, string|number|boolean>} attributes
 * @param {(span: import("@opentelemetry/api").Span) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSpan(name, attributes, fn) {
  const span = getTracer().startSpan(name, { attributes });
  try {
    // No `span.setStatus(OK)` here on success: call sites may have already set ERROR on
    // the span despite returning normally rather than throwing (a 403 envelope is a
    // normal return from the route handler, not a thrown error) -- unconditionally
    // setting OK here would silently overwrite that.
    return await fn(span);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw err;
  } finally {
    span.end();
  }
}
