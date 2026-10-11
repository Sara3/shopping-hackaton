"""Environment-driven configuration. See ../.env.example."""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - optional dependency
    pass

# A cross-region inference profile id, not a raw foundation-model id -- check
# `aws bedrock list-inference-profiles` in your own account/region if this isn't enabled
# for you, and override via STRANDS_MODEL_ID in .env.
_DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-6"


@dataclass(frozen=True)
class AppConfig:
    model_id: str
    aws_region: str | None
    arcade_mode: str  # "mock" (only supported value for now) | "live" (not yet implemented)
    dry_run_checkout: bool
    order_spend_ceiling_cents: int
    otel_enabled: bool
    otel_exporter_otlp_endpoint: str
    enable_console_tracing: bool


def load_config() -> AppConfig:
    arcade_mode = os.getenv("ARCADE_MODE", "mock").lower()
    if arcade_mode != "mock":
        raise ValueError(
            f"ARCADE_MODE={arcade_mode!r} is not implemented yet -- Arcade's live API isn't "
            "wired up (see .claude/skills/arcade-api/SKILL.md). Only 'mock' works today."
        )

    return AppConfig(
        model_id=os.getenv("STRANDS_MODEL_ID") or _DEFAULT_MODEL_ID,
        aws_region=os.getenv("AWS_REGION"),
        arcade_mode=arcade_mode,
        dry_run_checkout=os.getenv("DRY_RUN_CHECKOUT", "true").lower() == "true",
        order_spend_ceiling_cents=int(os.getenv("ORDER_SPEND_CEILING_CENTS", "10000")),
        # Off by default -- enabling this requires a local OTLP collector (see
        # docker-compose.yml) to actually be running, which plain `python -m agent.cli`
        # doesn't need otherwise.
        otel_enabled=os.getenv("OTEL_ENABLED", "false").lower() == "true",
        otel_exporter_otlp_endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318"),
        enable_console_tracing=os.getenv("ENABLE_CONSOLE_TRACING", "false").lower() == "true",
    )
