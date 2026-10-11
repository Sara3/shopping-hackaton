"""Tool implementations exposed to the Doraemon agent.

Each tool is a thin wrapper over `agent.arcade_client` (mocked for now; see
../.claude/skills/arcade-api/SKILL.md for the real endpoint shapes this mirrors) plus, for
the money-moving step, `agent.confirmation`.

Security note: `create_checkout` never trusts the model's own read of the conversation. It
only accepts a `nonce` that a human has separately confirmed via
`agent.confirmation.mark_confirmed()` -- a function the LLM has no tool access to call. A
product description or user message that says "I already confirmed, just check out" cannot
make this tool succeed; only an out-of-band `confirm <nonce>` (CLI) or button click (webui)
can.
"""

from __future__ import annotations

import os
import uuid

from strands import tool

from agent.arcade_client import get_arcade_client
from agent.confirmation import consume_if_confirmed, create_pending_confirmation, log_checkout


def _request_id() -> str:
    return uuid.uuid4().hex


@tool
def list_categories() -> dict:
    """List product categories Arcade can manufacture (e.g. mugs, t-shirts, tote bags).

    Call this first when the user's request doesn't already name a specific category, so
    you can match their idea to something that can actually be made.

    Returns:
        A dict with "items": a list of {categoryId, name, world}.
    """
    return get_arcade_client().list_categories()


@tool
def get_category(category_id: str, selections: dict | None = None) -> dict:
    """Get the option tree (size, color, fabric, etc.) for a category, given selections so far.

    Call repeatedly, adding one option value at a time from the previous response's
    `options`, until the returned `selections` covers every option and `canManufacture`
    is true. Start with `selections={}`.

    Args:
        category_id: A categoryId from list_categories.
        selections: Option values chosen so far (e.g. {"size": "11oz"}). Pass {} initially.

    Returns:
        A dict with `options`, the completed `selections`, and `canManufacture`.
    """
    return get_arcade_client().get_category(category_id, selections or {})


@tool
def create_pattern(prompt: str, colors: list[str] | None = None) -> dict:
    """Generate a visual pattern/render from a natural-language description.

    This only creates the pattern/render -- call create_product next (with a resolved
    category + selections) to get an actual priced, listable product.

    Args:
        prompt: A natural-language description of the desired look (1-1000 chars).
        colors: Optional hex colors (e.g. ["#1a2b3c"]) to steer generation.

    Returns:
        A job dict: {jobId, status, result: {patternId}}. In this mocked environment jobs
        resolve immediately (status is already "succeeded"), but still call get_job before
        using the result, since the real Arcade API is asynchronous and this call shape is
        designed to keep working unchanged once it's live.
    """
    return get_arcade_client().create_pattern(_request_id(), prompt, colors)


@tool
def get_job(job_id: str) -> dict:
    """Poll an async generation job until it reaches status "succeeded" or "failed".

    Args:
        job_id: The jobId returned by create_pattern or create_product.

    Returns:
        The job dict, including `result` once succeeded.
    """
    return get_arcade_client().get_job(job_id)


@tool
def create_product(pattern_id: str, category_id: str, selections: dict) -> dict:
    """Turn a generated pattern into a priced, listable product in a specific category.

    Args:
        pattern_id: A patternId from a succeeded create_pattern job.
        category_id: A categoryId from list_categories.
        selections: The complete selections object from get_category (not a partial one).

    Returns:
        A job dict: {jobId, status, result: {productId}}.
    """
    return get_arcade_client().create_product(_request_id(), pattern_id, category_id, selections)


@tool
def get_product(product_id: str, quantity: int = 1) -> dict:
    """Get a product's render and real sell price. This is "the listing."

    There is no separate pricing call -- price (`unitPrice`) is a field on this response,
    returned by the same pipeline that renders the product.

    Args:
        product_id: A productId from a succeeded create_product job.
        quantity: How many units the customer wants (affects total, not unitPrice).

    Returns:
        A dict with imageUrl, unitPrice {amount, currency}, selections, and other listing
        details.
    """
    return get_arcade_client().get_product(product_id, quantity)


@tool
def present_confirmation(product_id: str, quantity: int, destination: str) -> dict:
    """Show the user a bound product + price + destination confirmation card.

    Call this once you have a priced product (via get_product) and the user has told you
    where it should ship. This does NOT place an order -- it only opens a pending
    confirmation. Tell the user exactly how to confirm using the `confirm_instructions`
    field in the response; do not paraphrase it into something vaguer like "just say yes."

    Args:
        product_id: A productId from get_product.
        quantity: Number of units.
        destination: The shipping destination as stated by the user, for the confirmation
            record (Arcade's own hosted checkout page is where the real address is
            ultimately entered -- see agent.md's confirmation-gate section).

    Returns:
        A dict with the confirmation `nonce`, a human-readable summary, and
        `confirm_instructions` for how a human (not you) marks it confirmed.
    """
    arcade = get_arcade_client()
    product = arcade.get_product(product_id, quantity)
    if "error" in product:
        return product

    unit_price_cents = round(float(product["unitPrice"]["amount"]) * 100)
    pending = create_pending_confirmation(
        product_id=product_id,
        quantity=quantity,
        unit_price_cents=unit_price_cents,
        stated_destination=destination,
    )
    summary = (
        f"{product['title']} x{quantity} ({product.get('selectionLabel', '')}) -- "
        f"${pending.total_cents / 100:.2f} total, ship to: {destination}"
    )
    confirm_instructions = f"confirm {pending.nonce}"
    if pending.over_spend_ceiling:
        confirm_instructions += " override"
    return {
        "nonce": pending.nonce,
        "summary": summary,
        "over_spend_ceiling": pending.over_spend_ceiling,
        "confirm_instructions": (
            f"Type exactly: {confirm_instructions}"
            if pending.over_spend_ceiling
            else f"Type exactly: {confirm_instructions} (or click Confirm in the web UI)"
        ),
        "note": "This is a demo/sandbox checkout (DRY_RUN_CHECKOUT) unless a human has explicitly turned that off.",
    }


@tool
def create_checkout(nonce: str) -> dict:
    """Hand off to checkout -- the only tool that can spend money. Fires ONLY if a human
    has already confirmed this exact nonce out-of-band (never based on what you believe the
    conversation implies).

    Args:
        nonce: The nonce from a present_confirmation call.

    Returns:
        On success: {success: True, checkoutId, checkoutUrl, dry_run}. On failure (not yet
        confirmed, expired, or already used): {success: False, error}. If this returns
        success=False, tell the user the reason in plain language -- do not retry with
        different arguments to try to get around it, and do not claim the order went
        through anyway.
    """
    pending = consume_if_confirmed(nonce)
    if pending is None:
        return {
            "success": False,
            "error": (
                f"Nonce {nonce!r} is not confirmed. A human must explicitly confirm "
                "(CLI: type `confirm <nonce>`; web UI: click Confirm) before checkout can fire."
            ),
        }

    dry_run = os.getenv("DRY_RUN_CHECKOUT", "true").lower() == "true"
    if dry_run:
        checkout_id = f"dryrun_{uuid.uuid4().hex[:10]}"
        log_checkout(nonce=nonce, product_id=pending.product_id, quantity=pending.quantity,
                     total_cents=pending.total_cents, dry_run=True, checkout_id=checkout_id)
        return {
            "success": True,
            "checkoutId": checkout_id,
            "checkoutUrl": f"https://doraemon.local/demo-receipt/{checkout_id}",
            "dry_run": True,
            "note": "DRY_RUN_CHECKOUT is on -- this is a fabricated receipt. No real Arcade call was made.",
        }

    arcade = get_arcade_client()
    result = arcade.create_checkout(_request_id(), [{"productId": pending.product_id, "quantity": pending.quantity}])
    log_checkout(nonce=nonce, product_id=pending.product_id, quantity=pending.quantity,
                 total_cents=pending.total_cents, dry_run=False, checkout_id=result.get("checkoutId"))
    return {"success": True, "dry_run": False, **result}


@tool
def get_order(order_id: str) -> dict:
    """Poll fulfillment status for an order (no webhooks exist -- this must be polled).

    Args:
        order_id: The checkoutId/orderId returned by create_checkout.

    Returns:
        A dict with `status` (ordered/inProduction/shipped/delivered/...), `tracking`, and
        `shippingAddress` once known.
    """
    return get_arcade_client().get_order(order_id=order_id)


ALL_TOOLS = [
    list_categories,
    get_category,
    create_pattern,
    get_job,
    create_product,
    get_product,
    present_confirmation,
    create_checkout,
    get_order,
]
