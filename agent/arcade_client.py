"""Arcade API client interface + a mock implementation.

Real Arcade (https://platform.arcade.ai, see ../.claude/skills/arcade-api/SKILL.md for the
endpoint reference) isn't reachable yet, so every call here is served from in-memory mock
data shaped exactly like the documented request/response schemas. `tools.py` talks to the
`ArcadeClient` interface only, never to mock data or an HTTP client directly, so swapping
`MockArcadeClient` for a `LiveArcadeClient` later is a drop-in change with zero changes to
tools.py or the system prompt.

Every mocked response is tagged `"mocked": True` so nothing downstream can mistake it for
a real Arcade call (agent_constitution.md: "never claim a real action succeeded when it
was mocked").
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal


class ArcadeClient(ABC):
    @abstractmethod
    def list_categories(self) -> list[dict]: ...

    @abstractmethod
    def get_category(self, category_id: str, selections: dict) -> dict: ...

    @abstractmethod
    def create_pattern(self, request_id: str, prompt: str, colors: list[str] | None = None) -> dict: ...

    @abstractmethod
    def get_job(self, job_id: str) -> dict: ...

    @abstractmethod
    def create_product(self, request_id: str, pattern_id: str, category_id: str, selections: dict) -> dict: ...

    @abstractmethod
    def get_product(self, product_id: str, quantity: int = 1) -> dict: ...

    @abstractmethod
    def create_checkout(self, request_id: str, lines: list[dict]) -> dict: ...

    @abstractmethod
    def get_order(self, order_id: str | None = None, checkout_id: str | None = None) -> dict: ...


# --- Mock catalog -----------------------------------------------------------------------

_CATEGORIES: list[dict] = [
    {"categoryId": "mugs", "name": "Mugs", "world": "print", "category": {"categoryId": "drinkware", "name": "Drinkware"}},
    {"categoryId": "t-shirts", "name": "T-Shirts", "world": "print", "category": {"categoryId": "apparel", "name": "Apparel"}},
    {"categoryId": "tote-bags", "name": "Tote Bags", "world": "print", "category": {"categoryId": "bags", "name": "Bags"}},
]

_CATEGORY_OPTIONS: dict[str, list[dict]] = {
    "mugs": [
        {"key": "size", "label": "Size", "values": [
            {"value": "11oz", "label": "11 oz", "isDefault": True, "available": True},
            {"value": "15oz", "label": "15 oz", "isDefault": False, "available": True},
        ]},
        {"key": "finish", "label": "Finish", "values": [
            {"value": "glossy", "label": "Glossy", "isDefault": True, "available": True},
            {"value": "matte", "label": "Matte", "isDefault": False, "available": True},
        ]},
    ],
    "t-shirts": [
        {"key": "size", "label": "Size", "values": [
            {"value": "s", "label": "S", "isDefault": False, "available": True},
            {"value": "m", "label": "M", "isDefault": True, "available": True},
            {"value": "l", "label": "L", "isDefault": False, "available": True},
            {"value": "xl", "label": "XL", "isDefault": False, "available": True},
        ]},
        {"key": "fabric", "label": "Fabric", "values": [
            {"value": "cotton", "label": "100% Cotton", "isDefault": True, "available": True},
            {"value": "blend", "label": "Cotton/Poly Blend", "isDefault": False, "available": True},
        ]},
    ],
    "tote-bags": [
        {"key": "size", "label": "Size", "values": [
            {"value": "standard", "label": "Standard", "isDefault": True, "available": True},
            {"value": "large", "label": "Large", "isDefault": False, "available": True},
        ]},
    ],
}

_BASE_PRICE_CENTS: dict[str, int] = {"mugs": 1800, "t-shirts": 2400, "tote-bags": 2200}
_SURCHARGE_CENTS: dict[str, int] = {"15oz": 300, "xl": 200, "large": 400, "matte": 150, "blend": -200}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _price_for(category_id: str, selections: dict) -> int:
    cents = _BASE_PRICE_CENTS.get(category_id, 2000)
    for value in selections.values():
        cents += _SURCHARGE_CENTS.get(value, 0)
    return cents


@dataclass
class MockArcadeClient(ArcadeClient):
    """In-memory stand-in for platform.arcade.ai. No network calls."""

    _jobs: dict[str, dict] = field(default_factory=dict)
    _patterns: dict[str, dict] = field(default_factory=dict)
    _products: dict[str, dict] = field(default_factory=dict)
    _checkouts: dict[str, dict] = field(default_factory=dict)
    _orders: dict[str, dict] = field(default_factory=dict)
    _order_poll_count: dict[str, int] = field(default_factory=dict)

    def list_categories(self) -> list[dict]:
        return {"items": _CATEGORIES, "mocked": True}

    def get_category(self, category_id: str, selections: dict) -> dict:
        options = _CATEGORY_OPTIONS.get(category_id)
        if options is None:
            return {"error": f"Unknown categoryId {category_id!r}", "mocked": True}
        completed = dict(selections or {})
        for opt in options:
            if opt["key"] not in completed:
                default = next((v["value"] for v in opt["values"] if v["isDefault"]), opt["values"][0]["value"])
                completed[opt["key"]] = default
        return {
            "categoryId": category_id,
            "name": next(c["name"] for c in _CATEGORIES if c["categoryId"] == category_id),
            "options": options,
            "selections": completed,
            "canManufacture": True,
            "world": "print",
            "mocked": True,
        }

    def create_pattern(self, request_id: str, prompt: str, colors: list[str] | None = None) -> dict:
        pattern_id = f"pat_{uuid.uuid4().hex[:10]}"
        self._patterns[pattern_id] = {
            "patternId": pattern_id,
            "prompt": prompt,
            "colors": colors or [],
            "imageUrl": f"https://picsum.photos/seed/{pattern_id}/512",
        }
        job_id = f"job_{uuid.uuid4().hex[:10]}"
        job = {
            "jobId": job_id,
            "kind": "pattern",
            "status": "succeeded",
            "result": {"patternId": pattern_id},
            "error": None,
            "createdAt": _now(),
            "completedAt": _now(),
            "mocked": True,
        }
        self._jobs[job_id] = job
        return job

    def get_job(self, job_id: str) -> dict:
        job = self._jobs.get(job_id)
        if job is None:
            return {"error": f"Unknown jobId {job_id!r}", "mocked": True}
        return job

    def create_product(self, request_id: str, pattern_id: str, category_id: str, selections: dict) -> dict:
        pattern = self._patterns.get(pattern_id)
        if pattern is None:
            return {"error": f"Unknown patternId {pattern_id!r}", "mocked": True}
        product_id = f"prod_{uuid.uuid4().hex[:10]}"
        cents = _price_for(category_id, selections)
        self._products[product_id] = {
            "productId": product_id,
            "title": f"Custom {category_id.replace('-', ' ').title()}",
            "categoryId": category_id,
            "patternId": pattern_id,
            "imageUrl": pattern["imageUrl"],
            "images": [{"url": pattern["imageUrl"]}],
            "selections": selections,
            "selectionLabel": ", ".join(f"{k}: {v}" for k, v in selections.items()),
            "unitPrice": {"amount": str(Decimal(cents) / 100), "currency": "USD"},
            "description": f"A custom-generated {category_id.replace('-', ' ')} (mocked render).",
            "careInstructions": "",
            "maker": {"makerId": "mock-maker-1", "name": "Mock Manufacturing Co."},
            "createdAt": _now(),
        }
        job_id = f"job_{uuid.uuid4().hex[:10]}"
        job = {
            "jobId": job_id,
            "kind": "product",
            "status": "succeeded",
            "result": {"productId": product_id},
            "error": None,
            "createdAt": _now(),
            "completedAt": _now(),
            "mocked": True,
        }
        self._jobs[job_id] = job
        return job

    def get_product(self, product_id: str, quantity: int = 1) -> dict:
        product = self._products.get(product_id)
        if product is None:
            return {"error": f"Unknown productId {product_id!r}", "mocked": True}
        return {**product, "quantity": quantity, "mocked": True}

    def create_checkout(self, request_id: str, lines: list[dict]) -> dict:
        checkout_id = str(uuid.uuid4().int % 10**9)
        self._checkouts[checkout_id] = {"lines": lines, "requestId": request_id}
        order_id = checkout_id
        total_cents = 0
        for line in lines:
            product = self._products.get(line["productId"])
            if product:
                total_cents += int(Decimal(product["unitPrice"]["amount"]) * 100) * line.get("quantity", 1)
        self._orders[order_id] = {
            "orderId": order_id,
            "checkoutId": checkout_id,
            "orderNumber": f"#{1000 + len(self._orders)}",
            "status": "ordered",
            "total": {"amount": str(Decimal(total_cents) / 100), "currency": "USD"},
            "lines": lines,
            "shippingAddress": None,
            "tracking": [],
            "placedAt": _now(),
        }
        self._order_poll_count[order_id] = 0
        return {
            "checkoutId": checkout_id,
            "checkoutUrl": f"https://doraemon.local/mock-arcade-checkout/{checkout_id}",
            "mocked": True,
        }

    def get_order(self, order_id: str | None = None, checkout_id: str | None = None) -> dict:
        key = order_id or checkout_id
        order = self._orders.get(key)
        if order is None:
            return {"error": f"Unknown order/checkout id {key!r}", "mocked": True}
        # Advance the mock fulfillment lifecycle by one step each time it's polled,
        # so get_order demoably shows progress without a real manufacturer.
        lifecycle = ["ordered", "inProduction", "shipped", "delivered"]
        count = self._order_poll_count.get(key, 0)
        idx = min(count, len(lifecycle) - 1)
        order["status"] = lifecycle[idx]
        if order["status"] == "shipped":
            order["tracking"] = [{"company": "MockShip", "number": "MOCK123456", "url": "https://doraemon.local/mock-tracking/MOCK123456"}]
        if order["status"] in ("shipped", "delivered") and order["shippingAddress"] is None:
            order["shippingAddress"] = {"name": "Demo Customer", "city": "San Francisco", "provinceCode": "CA", "countryCode": "US"}
        self._order_poll_count[key] = count + 1
        return {**order, "mocked": True}


_default_client: ArcadeClient | None = None


def get_arcade_client() -> ArcadeClient:
    global _default_client
    if _default_client is None:
        _default_client = MockArcadeClient()
    return _default_client
