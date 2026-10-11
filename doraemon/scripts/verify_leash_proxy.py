"""Live check of ProxiedArcadeClient against a running Leash gateway -- no LLM call.

Start the gateway first, from the shopping-hackaton repo root, with a fixed admin key:
    LEASH_ADMIN_KEY=<key> npm run demo:leash
Then, from doraemon/:
    LEASH_ADMIN_KEY=<key> python -m scripts.verify_leash_proxy

Each run freezes one throwaway token on purpose (the out-of-scope check). The mandate +
checkout leg runs only when the gateway reports mock mode, so it never creates a live
Arcade checkout.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.arcade_client import ProxiedArcadeClient

PASS = "\033[32m[PASS]\033[0m"
FAIL = "\033[31m[FAIL]\033[0m"
PROXY_URL = os.getenv("LEASH_PROXY_URL", "http://127.0.0.1:8080")
ADMIN_KEY = os.getenv("LEASH_ADMIN_KEY", "")
IN_SCOPE = "Silk scarf"
JOB_POLL_SECONDS = 1
JOB_TIMEOUT_SECONDS = 120

failures = 0


def check(label: str, condition: bool, detail: object = None) -> None:
    global failures
    print(f"{PASS if condition else FAIL} {label}")
    if not condition:
        failures += 1
        if detail is not None:
            print(f"       got: {json.dumps(detail)[:300]}")


def gateway_mode() -> str | None:
    with urllib.request.urlopen(f"{PROXY_URL.rstrip('/')}/health", timeout=5) as response:
        return json.loads(response.read()).get("mode")


def client(**overrides) -> ProxiedArcadeClient:
    return ProxiedArcadeClient(proxy_url=PROXY_URL, admin_key=ADMIN_KEY, categories=[IN_SCOPE], **overrides)


def wait_for_job(arcade: ProxiedArcadeClient, job: dict) -> dict:
    # A refusal has no jobId; a job always carries an "error" key (null until it fails).
    deadline = time.time() + JOB_TIMEOUT_SECONDS
    while "jobId" in job and job.get("status") not in ("succeeded", "failed") and time.time() < deadline:
        time.sleep(JOB_POLL_SECONDS)
        job = arcade.get_job(job["jobId"])
    return job


def check_scopes() -> dict[str, str]:
    arcade = client()
    listed = arcade.list_categories()
    items = listed.get("items", [])
    check("list_categories returns the catalog through Leash", len(items) > 0, listed)
    ids = {item["name"]: item["categoryId"] for item in items}
    in_scope = ids.get(IN_SCOPE)
    out_of_scope = next((cid for name, cid in ids.items() if name != IN_SCOPE), None)

    allowed = arcade.get_category(in_scope, {})
    check(f"get_category on {IN_SCOPE} (in scope) passes", allowed.get("canManufacture") is True, allowed)

    token = arcade.leash_token
    denied = arcade.get_category(out_of_scope, {})
    check(
        "get_category outside the token's categories is a 403 scope_denied",
        denied.get("status") == 403 and denied.get("error") == "scope_denied",
        denied,
    )
    check("the gateway froze the token for it", denied.get("tokenFrozen") is True, denied)

    after = arcade.list_categories()
    check("the next call is refused as token_frozen", after.get("error") == "token_frozen", after)
    check("the client did not mint its way around the freeze", arcade.leash_token == token)

    order = arcade.get_order(order_id="1")
    check("get_order is refused locally (orders:get is forbidden)", order.get("error") == "scope_forbidden", order)
    return ids


def check_stale_token() -> None:
    stale = "leash_not-a-real-token"
    arcade = client(leash_token=stale)
    listed = arcade.list_categories()
    check("a 401 on a stale token re-mints once and the call succeeds", "items" in listed, listed)
    check("the stale token was replaced", arcade.leash_token not in (None, stale))


def check_checkout(category_id: str) -> None:
    arcade = client()
    pattern = wait_for_job(arcade, arcade.create_pattern(uuid.uuid4().hex, "large red roses on a black ground"))
    check("create_pattern + get_job succeed through Leash", pattern.get("status") == "succeeded", pattern)
    if pattern.get("status") != "succeeded":
        return
    selections = arcade.get_category(category_id, {}).get("selections", {})
    product_job = arcade.create_product(uuid.uuid4().hex, pattern["result"]["patternId"], category_id, selections)
    product_job = wait_for_job(arcade, product_job)
    check("create_product + get_job succeed through Leash", product_job.get("status") == "succeeded", product_job)
    if product_job.get("status") != "succeeded":
        return
    product_id = product_job["result"]["productId"]
    product = arcade.get_product(product_id)
    check("get_product returns a unitPrice", bool(product.get("unitPrice", {}).get("amount")), product)

    over = arcade.create_checkout("unused", [{"productId": product_id, "quantity": 50}])
    check("a mandate above maxSpend is refused (price_exceeded)", over.get("error") == "price_exceeded", over)

    checkout = arcade.create_checkout("unused", [{"productId": product_id, "quantity": 1}])
    check("POST /mandates -> POST /checkout returns a checkoutUrl", str(checkout.get("checkoutUrl", "")).startswith("http"), checkout)


def main() -> None:
    if not ADMIN_KEY:
        print("Set LEASH_ADMIN_KEY to the key the gateway was started with.")
        sys.exit(2)
    try:
        mode = gateway_mode()
    except OSError as exc:
        print(f"No Leash gateway at {PROXY_URL}: {exc}")
        sys.exit(2)
    print(f"Leash gateway at {PROXY_URL} (arcade {mode})\n")

    ids = check_scopes()
    check_stale_token()
    if mode == "mock" and IN_SCOPE in ids:
        check_checkout(ids[IN_SCOPE])
    else:
        print(f"(skipped the mandate + checkout leg: gateway arcade mode is {mode!r}, not 'mock')")

    print()
    if failures:
        print(f"{failures} check(s) failed.")
        sys.exit(1)
    print("All checks passed.")


if __name__ == "__main__":
    main()
