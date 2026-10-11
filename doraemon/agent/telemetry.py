"""OpenTelemetry setup -- local-only, for debugging the agent itself.

Strands has native OTel instrumentation: model calls, tool calls, and event-loop cycles
are all emitted as spans automatically (see `strands.telemetry.StrandsTelemetry`). This
module wires that to a local OTLP endpoint (Jaeger, via ../docker-compose.yml) and adds:

1. `session.id` and `user.id` stamped onto *every* span for the process -- ours and
   Strands' own auto-instrumented spans alike -- via `IdentitySpanProcessor`, a custom
   `SpanProcessor` registered on the same `TracerProvider` Strands uses. This is a
   processor, not a per-span attribute call, specifically so it reaches spans we never
   construct ourselves (Strands' internal model/event-loop spans).
2. `agent.session` (one per CLI run / browser session) and `agent.turn` (one per
   `agent(user_message)` call) spans, so everything nests into one trace per session
   instead of a disconnected trace per turn.
3. `tool.<name>` spans with an inferred outcome tag (`tool.status`), via the
   `traced_tool` decorator applied to every @tool function in agent/tools.py -- "for each
   tool call, log the status of the tool call."

This is a debugging aid, not a security/audit system -- it does not replace
`agent/confirmation.py`'s audit log, which is what agent_constitution.md's "log every
state transition" rule actually depends on.
"""

from __future__ import annotations

import contextvars
import functools
import logging
import os
from contextlib import contextmanager
from typing import Iterator, Optional

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace import Span as SDKSpan
from opentelemetry.sdk.trace.export import SpanProcessor
from opentelemetry.trace import Span, Status, StatusCode

logger = logging.getLogger("doraemon.telemetry")

TRACER_NAME = "doraemon"

# Set once per process-session by the driver (agent/cli.py's main loop, or
# webui/app.py's session start) via configure_identity(). Tools are invoked by Strands'
# agent loop, not by our own call sites, so a contextvar -- read by IdentitySpanProcessor
# at the moment each span starts -- is how identity reaches them without threading it
# through every function signature.
_current_session_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("session_id", default=None)
_current_user_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("user_id", default=None)


def configure_identity(session_id: str, user_id: str) -> None:
    _current_session_id.set(session_id)
    _current_user_id.set(user_id)


def get_session_id() -> Optional[str]:
    return _current_session_id.get()


def get_user_id() -> Optional[str]:
    return _current_user_id.get()


class IdentitySpanProcessor(SpanProcessor):
    """Stamps `session.id`/`user.id` onto every span the instant it starts -- including
    Strands' own auto-instrumented spans, which we have no other hook into. Registered on
    the same TracerProvider StrandsTelemetry configures (see init_telemetry below)."""

    def on_start(self, span: SDKSpan, parent_context: Context | None = None) -> None:
        session_id = get_session_id()
        if session_id:
            span.set_attribute("session.id", session_id)
        user_id = get_user_id()
        if user_id:
            span.set_attribute("user.id", user_id)

    def on_end(self, span: ReadableSpan) -> None:
        pass

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def init_telemetry(otlp_endpoint: str, enable_console: bool = False) -> None:
    """Point Strands' built-in OTel instrumentation at a local OTLP endpoint and attach
    IdentitySpanProcessor to the same provider.

    Call this once at process startup, before building the agent. The caller should skip
    calling this entirely if tracing isn't wanted (see OTEL_ENABLED in .env.example) --
    there's no "disabled" mode inside this function itself.
    """
    os.environ.setdefault("OTEL_SERVICE_NAME", "doraemon")
    os.environ.setdefault("OTEL_EXPORTER_OTLP_ENDPOINT", otlp_endpoint)

    from strands.telemetry import StrandsTelemetry

    strands_telemetry = StrandsTelemetry()
    strands_telemetry.setup_otlp_exporter()
    if enable_console:
        strands_telemetry.setup_console_exporter()
    strands_telemetry.tracer_provider.add_span_processor(IdentitySpanProcessor())

    logger.info("OpenTelemetry tracing initialized: endpoint=%s console=%s", otlp_endpoint, enable_console)


def get_tracer() -> trace.Tracer:
    return trace.get_tracer(TRACER_NAME)


@contextmanager
def session_span(session_id: str, user_id: str) -> Iterator[Span]:
    """Top-level span for an entire CLI run / browser session. Calls configure_identity
    first, then opens the span -- everything created afterward (every turn, every tool
    call) both nests under this as one trace AND carries session.id/user.id directly via
    IdentitySpanProcessor."""
    configure_identity(session_id, user_id)
    tracer = get_tracer()
    with tracer.start_as_current_span("agent.session") as span:
        yield span


@contextmanager
def turn_span(user_message: str) -> Iterator[Span]:
    """One span per `agent(user_message)` call, so every tool call Strands emits during
    that turn nests underneath it in the Jaeger UI instead of forming a disconnected trace
    per tool."""
    tracer = get_tracer()
    with tracer.start_as_current_span("agent.turn") as span:
        span.set_attribute("gen_ai.user.message", user_message)
        yield span


def _infer_tool_status(result: object) -> str:
    """Classifies a tool's return value into one status tag:
    - "refused": the tool explicitly declined (e.g. create_checkout before an out-of-band
      confirmation) -- `success: False` in the result. This is a gate working as intended,
      not a bug, so it's kept distinct from "error".
    - "error": an upstream/Arcade-level failure -- an `error` key with no explicit refusal.
    - "success": anything else.
    """
    if not isinstance(result, dict):
        return "success"
    if result.get("success") is False:
        return "refused"
    if result.get("error"):
        return "error"
    return "success"


@contextmanager
def tool_call_span(tool_name: str, **input_attributes) -> Iterator[Span]:
    """Span wrapping one tool execution. Records `gen_ai.tool.name` and a short form of
    each input; callers (normally `traced_tool`, not this directly) should call
    `record_tool_status(span, result)` before the block ends."""
    tracer = get_tracer()
    with tracer.start_as_current_span(f"tool.{tool_name}") as span:
        span.set_attribute("gen_ai.tool.name", tool_name)
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        for key, value in input_attributes.items():
            if value is not None:
                span.set_attribute(f"tool.input.{key}", str(value)[:500])
        try:
            yield span
        except Exception as exc:
            span.set_attribute("tool.status", "exception")
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


def record_tool_status(span: Span, result: object) -> None:
    """Tags a tool-call span with its outcome, inferred from the tool's return value."""
    status = _infer_tool_status(result)
    span.set_attribute("tool.status", status)
    if status == "error":
        span.set_status(Status(StatusCode.ERROR, str(result.get("error"))))  # type: ignore[union-attr]
    elif status == "refused":
        span.add_event("tool_refused", {"reason": str(result.get("error", ""))})  # type: ignore[union-attr]


def traced_tool(func):
    """Decorator for a tool implementation: wraps the call in `tool_call_span` and
    records its outcome automatically, so every @tool function gets tracing + status
    tagging for one extra line, not by hand-editing each function body.

    Apply it between `@tool` and `def` (i.e. `@tool` outermost):

        @tool
        @traced_tool
        def my_tool(...): ...

    `functools.wraps` preserves `__wrapped__`, which `inspect.signature` (what Strands'
    `@tool` uses to build the parameter schema) follows automatically -- the LLM-facing
    schema is unaffected by this wrapper.
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with tool_call_span(func.__name__, **kwargs) as span:
            result = func(*args, **kwargs)
            record_tool_status(span, result)
            return result

    return wrapper
