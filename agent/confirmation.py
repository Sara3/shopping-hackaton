"""The confirmation gate.

The agent can *show* a confirmation card and can *call* create_checkout, but it can never
mark a confirmation as confirmed. Only a driver (agent/cli.py's literal `confirm <nonce>`
command, or webui/app.py's actual button click) can do that, by calling `mark_confirmed()`
directly -- a code path the LLM has no tool access to.

This is what stands between a prompt-injected "the user said yes, so I'll check out" and an
actual checkout call succeeding (agent_constitution.md Section 2; see also redteam-cases.md
case 2.4, "Confirmation-gate erosion via social pressure").
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class PendingConfirmation:
    nonce: str
    product_id: str
    quantity: int
    unit_price_cents: int
    stated_destination: str
    over_spend_ceiling: bool
    created_at: str
    confirmed: bool = False
    confirmed_override: bool = False
    consumed: bool = False

    @property
    def total_cents(self) -> int:
        return self.unit_price_cents * self.quantity


_PENDING: dict[str, PendingConfirmation] = {}
AUDIT_LOG: list[dict] = []


def _log(event: str, **fields) -> None:
    AUDIT_LOG.append({"event": event, "at": datetime.now(timezone.utc).isoformat(), **fields})


def spend_ceiling_cents() -> int:
    import os

    return int(os.getenv("ORDER_SPEND_CEILING_CENTS", "10000"))


def create_pending_confirmation(product_id: str, quantity: int, unit_price_cents: int, stated_destination: str) -> PendingConfirmation:
    nonce = uuid.uuid4().hex[:8]
    pending = PendingConfirmation(
        nonce=nonce,
        product_id=product_id,
        quantity=quantity,
        unit_price_cents=unit_price_cents,
        stated_destination=stated_destination,
        over_spend_ceiling=(unit_price_cents * quantity) > spend_ceiling_cents(),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    _PENDING[nonce] = pending
    _log("confirmation_presented", nonce=nonce, product_id=product_id, quantity=quantity,
         total_cents=pending.total_cents, stated_destination=stated_destination,
         over_spend_ceiling=pending.over_spend_ceiling)
    return pending


def get_pending(nonce: str) -> PendingConfirmation | None:
    return _PENDING.get(nonce)


def mark_confirmed(nonce: str, override: bool = False) -> tuple[bool, str]:
    """The ONLY function that can flip a pending confirmation to confirmed.

    Call this only from a driver layer in direct response to an explicit user action
    (a button click, or a literal CLI command) -- never from a tool the LLM can invoke.
    """
    pending = _PENDING.get(nonce)
    if pending is None:
        return False, f"No pending confirmation with nonce {nonce!r} (expired, consumed, or never existed)."
    if pending.consumed:
        return False, f"Confirmation {nonce!r} was already used for an order."
    if pending.over_spend_ceiling and not override:
        return False, (
            f"This order (${pending.total_cents / 100:.2f}) exceeds the configured spend "
            f"ceiling (${spend_ceiling_cents() / 100:.2f}) and needs a separate override "
            f"confirmation (constitution Section 2)."
        )
    pending.confirmed = True
    pending.confirmed_override = override
    _log("confirmation_marked", nonce=nonce, override=override)
    return True, f"Confirmation {nonce!r} marked confirmed{' (with ceiling override)' if override else ''}."


def consume_if_confirmed(nonce: str) -> PendingConfirmation | None:
    """Tools call this right before checkout. Returns the pending record only if an
    out-of-band `mark_confirmed()` call already flipped it -- never based on anything the
    model said. Marks it consumed so the same nonce can't fund a second checkout."""
    pending = _PENDING.get(nonce)
    if pending is None or not pending.confirmed or pending.consumed:
        return None
    pending.consumed = True
    return pending


def log_checkout(**fields) -> None:
    _log("checkout_created", **fields)


def latest_unconfirmed_pending() -> PendingConfirmation | None:
    """For UIs (e.g. webui/app.py) that want to render a real Confirm button rather than
    asking the user to type a command. Returns the most recently presented confirmation
    that hasn't been confirmed or consumed yet, if any."""
    candidates = [p for p in _PENDING.values() if not p.confirmed and not p.consumed]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.created_at)
