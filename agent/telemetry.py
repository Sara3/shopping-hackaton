"""OpenTelemetry setup -- local-only, for debugging the agent itself.

Strands has native OTel instrumentation: model calls, tool calls, and event-loop cycles
are all emitted as spans automatically (see `strands.telemetry.StrandsTelemetry`). This
module just wires that to a local OTLP endpoint (Jaeger, via ../docker-compose.yml) and
adds one custom span per chat turn so multiple tool calls in the same turn nest under one
trace instead of each tool call showing up disconnected.

This is a debugging aid, not a security/audit system -- it does not replace
`agent/confirmation.py`'s audit log, which is what agent_constitution.md's "log every
state transition" rule actually depends on.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Iterator

from opentelemetry import trace
from opentelemetry.trace import Span

logger = logging.getLogger("doraemon.telemetry")

TRACER_NAME = "doraemon"


def init_telemetry(otlp_endpoint: str, enable_console: bool = False) -> None:
    """Point Strands' built-in OTel instrumentation at a local OTLP endpoint.

    Call this once at process startup, before building the agent. No-op the caller should
    skip entirely if tracing isn't wanted (see OTEL_ENABLED in .env.example) -- there's no
    "disabled" mode inside this function itself.
    """
    os.environ.setdefault("OTEL_SERVICE_NAME", "doraemon")
    os.environ.setdefault("OTEL_EXPORTER_OTLP_ENDPOINT", otlp_endpoint)

    from strands.telemetry import StrandsTelemetry

    strands_telemetry = StrandsTelemetry()
    strands_telemetry.setup_otlp_exporter()
    if enable_console:
        strands_telemetry.setup_console_exporter()

    logger.info("OpenTelemetry tracing initialized: endpoint=%s console=%s", otlp_endpoint, enable_console)


def get_tracer() -> trace.Tracer:
    return trace.get_tracer(TRACER_NAME)


@contextmanager
def turn_span(user_message: str) -> Iterator[Span]:
    """One span per `agent(user_message)` call, so every tool call Strands emits during
    that turn nests underneath it in the Jaeger UI instead of forming a disconnected trace
    per tool."""
    tracer = get_tracer()
    with tracer.start_as_current_span("agent.turn") as span:
        span.set_attribute("gen_ai.user.message", user_message)
        yield span
