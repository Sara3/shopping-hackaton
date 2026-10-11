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
# The Arcade replica's four mock categories (shopping-hackaton mock/catalog.mjs), by name; the
# gateway matches token categories to Arcade category ids or exact names.
_DEFAULT_LEASH_CATEGORIES = "Silk scarf,Linen pillow,Cotton dinner napkins,Lampshade"


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
    use_leash_proxy: bool
    leash_proxy_url: str
    leash_admin_key: str
    leash_token: str | None
    leash_agent_id: str
    leash_payer: str
    leash_max_spend_cents: int
    leash_categories: list[str]
    leash_token_ttl_seconds: int


def load_config() -> AppConfig:
    arcade_mode = os.getenv("ARCADE_MODE", "mock").lower()
    if arcade_mode != "mock":
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
