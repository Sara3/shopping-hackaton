"""Environment-driven configuration. See ../.env.example."""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - optional dependency
    pass

# Default provider is the Claude API (Anthropic first-party), keyed by CLAUDE_API_KEY.
# Bedrock is still selectable via MODEL_PROVIDER=bedrock.
_DEFAULT_PROVIDER = "anthropic"
_DEFAULT_ANTHROPIC_MODEL_ID = "claude-opus-5-5"
# A cross-region inference profile id, not a raw foundation-model id -- check
# `aws bedrock list-inference-profiles` in your own account/region if this isn't enabled
# for you, and override via STRANDS_MODEL_ID in .env.
_DEFAULT_BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-6"
# The Arcade replica's four mock categories (shopping-hackaton mock/catalog.mjs), by name; the
# gateway matches token categories to Arcade category ids or exact names.
_DEFAULT_LEASH_CATEGORIES = "Silk scarf,Linen pillow,Cotton dinner napkins,Lampshade"


@dataclass(frozen=True)
class AppConfig:
    model_provider: str  # "anthropic" (default) | "bedrock"
    model_id: str
    anthropic_api_key: str | None
    anthropic_effort: str
    aws_region: str | None
    arcade_mode: str  # "mock" (only supported value for now) | "live" (not yet implemented)
    dry_run_checkout: bool
    order_spend_ceiling_cents: int
    otel_enabled: bool
    otel_exporter_otlp_endpoint: str
    enable_console_tracing: bool
    use_leash_proxy: bool
    leash_proxy_url: str
    leash_admin_key: str
    leash_token: str | None
    leash_agent_id: str
    leash_payer: str
    leash_max_spend_cents: int
    leash_categories: list[str]
    leash_token_ttl_seconds: int


def load_config(via_leash_only: bool = False) -> AppConfig:
    """`via_leash_only`: the caller never builds a process-wide Arcade client -- every Arcade call
    goes through the Leash gateway, which holds the key and decides mock vs live (agent/service.py).
    Then ARCADE_MODE=live is fine here; anywhere else only the in-process mock exists."""
    arcade_mode = os.getenv("ARCADE_MODE", "mock").lower()
    if arcade_mode == "live" and via_leash_only:
        pass
    elif arcade_mode != "mock":
        raise ValueError(
            f"ARCADE_MODE={arcade_mode!r} is not implemented yet -- Arcade's live API isn't "
            "wired up (see .claude/skills/arcade-api/SKILL.md). Only 'mock' works today."
        )

    use_leash_proxy = os.getenv("USE_LEASH_PROXY", "false").lower() == "true"
    leash_admin_key = os.getenv("LEASH_ADMIN_KEY", "")
    leash_token = os.getenv("LEASH_TOKEN") or None
    if use_leash_proxy and not (leash_admin_key or leash_token):
        raise ValueError(
            "USE_LEASH_PROXY=true needs LEASH_ADMIN_KEY (the key the gateway was started with, used "
            "only to mint agent tokens via POST /tokens) or a hand-minted LEASH_TOKEN."
        )

    model_provider = (os.getenv("MODEL_PROVIDER") or _DEFAULT_PROVIDER).lower()
    if model_provider not in {"anthropic", "bedrock"}:
        raise ValueError(f"MODEL_PROVIDER={model_provider!r} is not supported -- use 'anthropic' or 'bedrock'.")
    anthropic_api_key = os.getenv("CLAUDE_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or None
    if model_provider == "anthropic" and not anthropic_api_key:
        raise ValueError("MODEL_PROVIDER=anthropic needs CLAUDE_API_KEY (or ANTHROPIC_API_KEY) set in .env.")

    return AppConfig(
        model_provider=model_provider,
        model_id=(
            os.getenv("ANTHROPIC_MODEL_ID") or _DEFAULT_ANTHROPIC_MODEL_ID
            if model_provider == "anthropic"
            else os.getenv("STRANDS_MODEL_ID") or _DEFAULT_BEDROCK_MODEL_ID
        ),
        anthropic_api_key=anthropic_api_key,
        # Opus 5.5 defaults to "medium" server-side; set explicitly so it's visible here.
        anthropic_effort=os.getenv("ANTHROPIC_EFFORT", "medium"),
        aws_region=os.getenv("AWS_REGION"),
        arcade_mode=arcade_mode,
        dry_run_checkout=os.getenv("DRY_RUN_CHECKOUT", "true").lower() == "true",
        order_spend_ceiling_cents=int(os.getenv("ORDER_SPEND_CEILING_CENTS", "10000")),
        # Off by default -- enabling this requires a local OTLP collector (see
        # ../docker-compose.yml, the repo root's) to actually be running, which plain `python -m agent.cli`
        # doesn't need otherwise.
        otel_enabled=os.getenv("OTEL_ENABLED", "false").lower() == "true",
        otel_exporter_otlp_endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318"),
        enable_console_tracing=os.getenv("ENABLE_CONSOLE_TRACING", "false").lower() == "true",
        # Off by default -- when on, every Arcade call goes through the Leash gateway
        # (shopping-hackaton gateway/server.mjs) instead of the in-process client. See
        # agent/arcade_client.py's ProxiedArcadeClient.
        use_leash_proxy=use_leash_proxy,
        leash_proxy_url=os.getenv("LEASH_PROXY_URL", "http://127.0.0.1:8080"),
        leash_admin_key=leash_admin_key,
        # Optional pin for a hand-minted token (e.g. testing a specific scope/denial case).
        # Leave unset and ProxiedArcadeClient self-mints via POST /tokens instead -- tokens
        # are short-lived by design (10 min by default), so a long-lived pasted secret here
        # would go stale mid-demo the way a raw Arcade key never does.
        leash_token=leash_token,
        leash_agent_id=os.getenv("LEASH_AGENT_ID", "agent_doraemon"),
        leash_payer=os.getenv("LEASH_PAYER", "demo-user"),
        leash_max_spend_cents=int(os.getenv("LEASH_MAX_SPEND_CENTS", "15000")),
        leash_categories=[c.strip() for c in os.getenv("LEASH_CATEGORIES", _DEFAULT_LEASH_CATEGORIES).split(",") if c.strip()],
        leash_token_ttl_seconds=int(os.getenv("LEASH_TOKEN_TTL_SECONDS", "600")),
    )
