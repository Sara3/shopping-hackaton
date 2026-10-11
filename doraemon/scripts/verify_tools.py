"""Standalone check of the mock Arcade client + confirmation gate -- no API key, no LLM
call.

Run with: python -m scripts.verify_tools
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.arcade_client import get_arcade_client
from agent.confirmation import consume_if_confirmed, create_pending_confirmation, mark_confirmed

PASS = "\033[32m[PASS]\033[0m"
FAIL = "\033[31m[FAIL]\033[0m"

failures = 0


def check(label: str, condition: bool) -> None:
    global failures
    print(f"{PASS if condition else FAIL} {label}")
    if not condition:
        failures += 1


def main() -> None:
    arcade = get_arcade_client()

    categories = arcade.list_categories()
    check("list_categories returns items", len(categories["items"]) > 0)

    category = arcade.get_category("mugs", {})
    check("get_category fills in defaults", category["selections"].get("size") == "11oz")
    check("get_category reports canManufacture", category["canManufacture"] is True)

    pattern_job = arcade.create_pattern("req-1", "a blue ceramic mug with a cartoon cat")
    check("create_pattern job succeeded", pattern_job["status"] == "succeeded")
    pattern_id = pattern_job["result"]["patternId"]

    job_again = arcade.get_job(pattern_job["jobId"])
    check("get_job returns the same job", job_again["jobId"] == pattern_job["jobId"])

    product_job = arcade.create_product("req-2", pattern_id, "mugs", {"size": "15oz", "finish": "matte"})
    check("create_product job succeeded", product_job["status"] == "succeeded")
    product_id = product_job["result"]["productId"]

    product = arcade.get_product(product_id, quantity=2)
    check("get_product returns a unitPrice", "unitPrice" in product and product["unitPrice"]["amount"])
    expected_cents = 1800 + 300 + 150  # base + 15oz surcharge + matte surcharge
    check(
        "get_product price reflects selections",
        round(float(product["unitPrice"]["amount"]) * 100) == expected_cents,
    )

    # --- Confirmation gate: the part that matters most ---
    unit_cents = round(float(product["unitPrice"]["amount"]) * 100)
    pending = create_pending_confirmation(product_id, quantity=2, unit_price_cents=unit_cents, stated_destination="123 Demo St, SF")

    blocked = consume_if_confirmed(pending.nonce)
    check("checkout is blocked before out-of-band confirmation", blocked is None)

    ok, _ = mark_confirmed("not-a-real-nonce")
    check("mark_confirmed rejects an unknown nonce", ok is False)

    ok, _ = mark_confirmed(pending.nonce)
    check("mark_confirmed accepts the real nonce", ok is True)

    consumed = consume_if_confirmed(pending.nonce)
    check("checkout proceeds after confirmation", consumed is not None)

    consumed_again = consume_if_confirmed(pending.nonce)
    check("the same nonce cannot fund a second checkout", consumed_again is None)

    # --- Spend ceiling ---
    import os

    os.environ["ORDER_SPEND_CEILING_CENTS"] = "100"  # 1 dollar, deliberately tiny
    expensive = create_pending_confirmation("prod_x", quantity=1, unit_price_cents=5000, stated_destination="123 Demo St, SF")
    check("over-ceiling order is flagged", expensive.over_spend_ceiling is True)
    ok, _ = mark_confirmed(expensive.nonce)
    check("over-ceiling order needs override, not a plain confirm", ok is False)
    ok, _ = mark_confirmed(expensive.nonce, override=True)
    check("override confirms the over-ceiling order", ok is True)
    del os.environ["ORDER_SPEND_CEILING_CENTS"]

    # --- Checkout + order polling lifecycle ---
    checkout = arcade.create_checkout("req-3", [{"productId": product_id, "quantity": 2}])
    check("create_checkout returns a checkoutUrl", checkout["checkoutUrl"].startswith("https://"))
    order1 = arcade.get_order(order_id=checkout["checkoutId"])
    order2 = arcade.get_order(order_id=checkout["checkoutId"])
    check("polling get_order advances the mock fulfillment lifecycle", order1["status"] != order2["status"])

    print()
    if failures:
        print(f"{failures} check(s) failed.")
        sys.exit(1)
    print("All checks passed.")


if __name__ == "__main__":
    main()
