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

import base64
import contextvars
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator

from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind, Status, StatusCode
from datetime import datetime, timezone
from decimal import Decimal


class ArcadeClient(ABC):
    @abstractmethod
    def list_categories(self) -> dict: ...

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
    def create_checkout(self, request_id: str, lines: list[dict], mandate: dict | None = None) -> dict:
        """`mandate` ({mandateId, token}) is a Leash mandate the driver already minted for
        what the human approved; clients that don't go through Leash ignore it."""

    @abstractmethod
    def get_order(self, order_id: str | None = None, checkout_id: str | None = None) -> dict: ...


# --- Mock catalog -----------------------------------------------------------------------
# Mirrors the shopping-hackaton Arcade replica (mock/catalog.mjs): same four categories, ids,
# options and base prices, so in-process and Leash-proxied runs show the same products and
# LEASH_CATEGORIES' default names match both.


def _option(key: str, label: str, values: list[str]) -> dict:
    return {
        "key": key,
        "label": label,
        "values": [{"value": v, "label": v, "isDefault": i == 0, "available": True} for i, v in enumerate(values)],
    }


_CATALOG: list[dict] = [
    {
        "categoryId": "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a001",
        "name": "Silk scarf",
        "basePriceCents": 12800,
        "options": [_option("size", "Size", ["90x90", "70x70"]), _option("hem", "Hem", ["hand-rolled", "machine"])],
    },
    {
        "categoryId": "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a002",
        "name": "Linen pillow",
        "basePriceCents": 6400,
        "options": [_option("size", "Size", ["18x18", "20x20"]), _option("insert", "Insert", ["with", "without"])],
    },
    {
        "categoryId": "c314010b-e15a-4014-a376-9b8f4e973461",
        "name": "Cotton dinner napkins",
        "basePriceCents": 4800,
        "options": [_option("fabric", "Fabric", ["cotton", "linen"]), _option("size", "Size", ["20x20", "18x18"])],
    },
    {
        "categoryId": "3f1b6a52-0c7e-4d1a-9e55-5ca1f5c0a004",
        "name": "Lampshade",
        "basePriceCents": 18000,
        "options": [_option("size", "Size", ["small", "medium", "large"])],
    },
]
_CATEGORIES_BY_ID: dict[str, dict] = {c["categoryId"]: c for c in _CATALOG}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class MockArcadeClient(ArcadeClient):
    """In-memory stand-in for platform.arcade.ai. No network calls."""

    _jobs: dict[str, dict] = field(default_factory=dict)
    _patterns: dict[str, dict] = field(default_factory=dict)
    _products: dict[str, dict] = field(default_factory=dict)
    _checkouts: dict[str, dict] = field(default_factory=dict)
    _orders: dict[str, dict] = field(default_factory=dict)
    _order_poll_count: dict[str, int] = field(default_factory=dict)

    def list_categories(self) -> dict:
        items = [{"categoryId": c["categoryId"], "name": c["name"], "imageUrl": None} for c in _CATALOG]
        return {"items": items, "mocked": True}

    def get_category(self, category_id: str, selections: dict) -> dict:
        category = _CATEGORIES_BY_ID.get(category_id)
        if category is None:
            return {"error": f"Unknown categoryId {category_id!r}", "mocked": True}
        options = category["options"]
        completed = dict(selections or {})
        for opt in options:
            if opt["key"] not in completed:
                default = next((v["value"] for v in opt["values"] if v["isDefault"]), opt["values"][0]["value"])
                completed[opt["key"]] = default
        return {
            "categoryId": category_id,
            "name": category["name"],
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
        category = _CATEGORIES_BY_ID.get(category_id)
        if category is None:
            return {"error": f"Unknown categoryId {category_id!r}", "mocked": True}
        product_id = f"prod_{uuid.uuid4().hex[:10]}"
        cents = category["basePriceCents"]
        self._products[product_id] = {
            "productId": product_id,
            "title": f"Custom {category['name']}",
            "categoryId": category_id,
            "patternId": pattern_id,
            "imageUrl": pattern["imageUrl"],
            "images": [{"url": pattern["imageUrl"]}],
            "selections": selections,
            "selectionLabel": ", ".join(f"{k}: {v}" for k, v in selections.items()),
            "unitPrice": {"amount": str(Decimal(cents) / 100), "currency": "USD"},
            "description": f"A custom-generated {category['name'].lower()} (mocked render).",
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

    def create_checkout(self, request_id: str, lines: list[dict], mandate: dict | None = None) -> dict:
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


# --- Proxied client (routes through the Leash gateway) ----------------------------------

_LEASH_USER_AGENT = "doraemon-leash/0.1"
_LEASH_TIMEOUT_SECONDS = 15
_TOKEN_PREFIX = "leash_"
_REFRESH_EARLY_SECONDS = 5
# A /checkout that fails on an expired token is a denial that freezes the token, and the mandate
# never outlives its token, so a checkout starts only on a token with at least this much life.
_CHECKOUT_MIN_TOKEN_SECONDS = 60
_HTTP_UNAUTHORIZED = 401
# The only gateway answers that mean "this token is stale, mint another" are a 401 (e.g. the
# gateway restarted with a new secret) and error == "expired". Every other refusal -- token_frozen,
# scope_denied, velocity_exceeded, price_exceeded, ... -- is the gateway saying no to this agent,
# and a fresh token would undo that, so those are returned as-is.
_STALE_TOKEN_CODES = frozenset({"expired"})


def _amount(cents: int) -> str:
    return f"{cents // 100}.{cents % 100:02d}"


def _parse(raw: bytes) -> object:
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode(errors="replace")


def _read_error_body(exc: urllib.error.HTTPError) -> bytes:
    try:
        return exc.read()
    except (OSError, http.client.HTTPException):
        return b""


# Jobs on the replica take a couple of seconds and real ones 1-2 minutes; Arcade asks for a poll
# every 2-5 s (https://docs.arcade.ai/jobs). jobs:get is not a work-starting call, so polling never
# spends the gateway's velocity budget.
_JOB_POLL_SECONDS = 2.0
_JOB_TIMEOUT_SECONDS = 240.0
_TOKEN_ID_PATTERN = re.compile(r"^tok_[0-9a-f]{16}$")
_tracer = trace.get_tracer("doraemon.leash")


def _token_id(token: str | None) -> str | None:
    """The tokenId inside a leash_ token's signed payload, read without verifying it -- only used
    to label spans, so a trace names the token without ever carrying the token itself."""
    if not (isinstance(token, str) and token.startswith(_TOKEN_PREFIX)):
        return None
    payload = token[len(_TOKEN_PREFIX):].split(".")[0]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, TypeError):
        return None
    token_id = claims.get("tokenId") if isinstance(claims, dict) else None
    return token_id if isinstance(token_id, str) and _TOKEN_ID_PATTERN.match(token_id) else None


def _record_gateway_outcome(span: trace.Span, status: int, body: object) -> None:
    """Tags a gateway call's client span with the gateway's own decision, so a Leash denial is
    readable in the trace (code, rule, frozen) without the gateway having to export spans."""
    span.set_attribute("http.response.status_code", status)
    if 200 <= status < 300:
        span.set_attribute("leash.decision", "allowed")
        return
    envelope = body if isinstance(body, dict) else {}
    is_gateway_denial = isinstance(envelope.get("error"), str) and "tokenFrozen" in envelope
    span.set_attribute("leash.decision", "denied" if is_gateway_denial else "failed")
    if isinstance(envelope.get("error"), str):
        span.set_attribute("leash.code", envelope["error"])
    if isinstance(envelope.get("rule"), str):
        span.set_attribute("leash.rule", envelope["rule"])
    if isinstance(envelope.get("tokenFrozen"), bool):
        span.set_attribute("leash.token_frozen", envelope["tokenFrozen"])
    span.set_status(Status(StatusCode.ERROR, str(envelope.get("error") or f"http_{status}")))


def _refusal(code: str, message: str) -> dict:
    return {"error": code, "message": message, "via": "leash", "mocked": False}


def _leash_error(path: str, status: int, body: object) -> dict:
    """One shape for every failure: the gateway's own envelope ({error, message, rule?,
    tokenFrozen}) when it sent one, else the passed-through Arcade body under `detail`."""
    where = {"status": status, "path": path, "via": "leash", "mocked": False}
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return {**body, **where}
    return {"error": f"http_{status}", "detail": body, **where}


@dataclass
class ProxiedArcadeClient(ArcadeClient):
    """Sends every call to the Leash gateway (shopping-hackaton gateway/server.mjs) instead of
    resolving it in-process. The gateway holds the Arcade key and checks every call outside the
    model; this client only ever holds a short-lived `leash_...` token.

    Routes: an Arcade procedure is POST /arcade/<procedure> with the raw Arcade body and the
    token as Bearer. A checkout is POST /mandates then POST /checkout, because agent tokens
    never carry checkouts:create. orders:get is never issued to an agent, so get_order is
    refused here without a gateway call.

    Tokens are minted via POST /tokens (Bearer `admin_key`) when there is none yet, when this
    client's clock says the current one is about to expire, or when the gateway answers 401 or
    "expired" (one re-mint, one retry). Once any answer says tokenFrozen, the client pins the
    frozen token and never mints again: a frozen agent stays frozen until a human restarts it or
    starts a new session (a new client). A `leash_token` passed in at construction is used until
    its TTL window elapses; if a re-mint then fails, the held token is still sent and the
    gateway decides.
    """

    proxy_url: str
    admin_key: str = field(default="", repr=False)
    leash_token: str | None = field(default=None, repr=False)
    agent_id: str = "agent_doraemon"
    payer: str = "demo-user"
    max_spend_cents: int = 15000
    categories: list[str] = field(default_factory=list)
    token_ttl_seconds: int = 600
    _token_expires_at: float = field(default=0.0, init=False, repr=False)
    _frozen: bool = field(default=False, init=False, repr=False)
    # Strands may run one turn's tool calls in parallel: token state changes only under this lock.
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        # A token handed in at construction gets one TTL window of trust; an absent one
        # forces a mint on the first call.
        self._token_expires_at = time.time() + self.token_ttl_seconds if self.leash_token else 0.0

    def _post(self, path: str, body: dict, bearer: str | None = None, token: str | None = None) -> tuple[int, object]:
        """`token` is the leash token this request presents (as Bearer or in the body), so a
        tokenFrozen answer pins exactly that token."""
        headers = {"Content-Type": "application/json", "User-Agent": _LEASH_USER_AGENT}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        # One client span per gateway call. `traceparent` goes out with it, so the gateway's own
        # spans join this trace as soon as it exports any.
        with _tracer.start_as_current_span(f"leash POST {path}", kind=SpanKind.CLIENT) as span:
            span.set_attribute("http.request.method", "POST")
            span.set_attribute("url.full", f"{self.proxy_url.rstrip('/')}{path}")
            span.set_attribute("leash.path", path)
            token_id = _token_id(token or bearer)
            if token_id:
                span.set_attribute("leash.token_id", token_id)
            if isinstance(body.get("mandateId"), str):
                span.set_attribute("leash.mandate_id", body["mandateId"])
            propagate.inject(headers)
            request = urllib.request.Request(
                f"{self.proxy_url.rstrip('/')}{path}", data=json.dumps(body).encode(), headers=headers, method="POST"
            )
            try:
                with urllib.request.urlopen(request, timeout=_LEASH_TIMEOUT_SECONDS) as response:
                    status, parsed = response.status, _parse(response.read())
            except urllib.error.HTTPError as exc:
                status, parsed = exc.code, _parse(_read_error_body(exc))
            except (OSError, http.client.HTTPException) as exc:
                reason = getattr(exc, "reason", exc)
                span.set_attribute("leash.decision", "unreachable")
                span.set_status(Status(StatusCode.ERROR, "leash_unreachable"))
                return 0, _refusal("leash_unreachable", f"Leash gateway at {self.proxy_url!r} is unreachable: {reason}")
            _record_gateway_outcome(span, status, parsed)
        if token and isinstance(parsed, dict) and parsed.get("tokenFrozen") is True:
            with self._lock:
                self._frozen = True
                self.leash_token = token
        return status, parsed

    @staticmethod
    def _result(path: str, status: int, body: object) -> dict:
        if 200 <= status < 300 and isinstance(body, dict):
            return body
        return _leash_error(path, status, body)

    def _mint_token(self) -> dict | None:
        """Mint a fresh token. Returns None on success, else the refusal (any held token is kept)."""
        body = {
            "agentId": self.agent_id,
            "payer": self.payer,
            "maxSpend": _amount(self.max_spend_cents),
            "categories": self.categories,
            "ttlSeconds": self.token_ttl_seconds,
        }
        with self._lock:
            status, minted = self._post("/tokens", body, bearer=self.admin_key or None)
            token = minted.get("token") if status == 200 and isinstance(minted, dict) else None
            if not (isinstance(token, str) and token.startswith(_TOKEN_PREFIX)):
                return _leash_error("/tokens", status, minted)
            if self._frozen:  # a freeze landed while this mint was in flight: keep the frozen token
                return _refusal("token_frozen", "this agent's token is frozen; a new one is not minted")
            self.leash_token = token
            self._token_expires_at = time.time() + self.token_ttl_seconds - _REFRESH_EARLY_SECONDS
            return None

    def _ensure_token(self, min_seconds: float = 0) -> dict | None:
        """Make sure a token is held. Returns None to go ahead, else the mint refusal."""
        with self._lock:
            if self._frozen or (self.leash_token and time.time() + min_seconds < self._token_expires_at):
                return None
            refused = self._mint_token()
            # A failed mint keeps any held token: the gateway, not this clock, decides if it still works.
            return None if refused and self.leash_token else refused

    def _renew(self, failed_token: str | None, status: int, body: object) -> bool:
        """After a 401 or "expired" on `failed_token`, mint once. True when a retry is worth it."""
        stale = status == _HTTP_UNAUTHORIZED or (isinstance(body, dict) and body.get("error") in _STALE_TOKEN_CODES)
        if not stale:
            return False
        with self._lock:
            if self._frozen:
                return False
            if self.leash_token != failed_token:  # another call already renewed it
                return True
            return self._mint_token() is None

    def _arcade(self, procedure: str, payload: dict) -> dict:
        path = f"/arcade/{procedure}"
        refused = self._ensure_token()
        if refused:
            return refused
        token = self.leash_token
        status, body = self._post(path, payload, bearer=token, token=token)
        if self._renew(token, status, body):
            token = self.leash_token
            status, body = self._post(path, payload, bearer=token, token=token)
        return self._result(path, status, body)

    def list_categories(self) -> dict:
        return self._arcade("categories/list", {})

    def get_category(self, category_id: str, selections: dict) -> dict:
        return self._arcade("categories/get", {"categoryId": category_id, "selections": selections})

    def _wait_for_job(self, job: dict) -> dict:
        """Polls a running job until it finishes, so the agent doesn't spend a model turn per poll.
        A job still running at the timeout comes back as-is for the agent to check with get_job."""
        deadline = time.monotonic() + _JOB_TIMEOUT_SECONDS
        while isinstance(job, dict) and job.get("status") == "running" and "jobId" in job:
            if time.monotonic() >= deadline:
                return {**job, "note": "Job still running -- call get_job with this jobId later."}
            time.sleep(_JOB_POLL_SECONDS)
            job = self.get_job(job["jobId"])
        return job

    def create_pattern(self, request_id: str, prompt: str, colors: list[str] | None = None) -> dict:
        payload = {"requestId": request_id, "prompt": prompt}
        if colors:
            payload["colors"] = colors
        return self._wait_for_job(self._arcade("patterns/create", payload))

    def get_job(self, job_id: str) -> dict:
        return self._arcade("jobs/get", {"jobId": job_id})

    def create_product(self, request_id: str, pattern_id: str, category_id: str, selections: dict) -> dict:
        return self._wait_for_job(self._arcade(
            "products/create",
            {"requestId": request_id, "patternId": pattern_id, "categoryId": category_id, "selections": selections},
        ))

    def get_product(self, product_id: str, quantity: int = 1) -> dict:
        return self._arcade("products/get", {"productId": product_id, "quantity": quantity})

    def create_checkout(self, request_id: str, lines: list[dict], mandate: dict | None = None) -> dict:
        # The gateway signs a mandate for exactly what was approved, then runs the one
        # checkouts/create itself (with its own requestId) and returns only {checkoutUrl}. Both
        # steps go out under the same token, since a mandate is bound to the token that asked
        # for it, and neither is retried: a purchase step is never replayed blindly.
        if len(lines) != 1:
            return _refusal("line_mismatch", f"a Leash mandate covers exactly one line, got {len(lines)}")
        if mandate:
            # The web driver already minted the mandate for what the human approved (agent/service.py):
            # check out against exactly that one, under the token it is bound to. Never mint another.
            line = {"productId": lines[0]["productId"], "quantity": lines[0]["quantity"]}
            token = mandate["token"]
            status, body = self._post(
                "/checkout", {"token": token, "mandateId": mandate["mandateId"], "lines": [line]}, token=token
            )
            return self._result("/checkout", status, body)
        refused = self._ensure_token(min_seconds=_CHECKOUT_MIN_TOKEN_SECONDS)
        if refused:
            return refused
        token = self.leash_token
        line = {"productId": lines[0]["productId"], "quantity": lines[0]["quantity"]}
        status, body = self._post("/mandates", {"token": token, **line}, token=token)
        mandate = self._result("/mandates", status, body)
        if "error" in mandate:
            return mandate
        status, body = self._post("/checkout", {"token": token, "mandateId": mandate["mandateId"], "lines": [line]}, token=token)
        return self._result("/checkout", status, body)

    def get_order(self, order_id: str | None = None, checkout_id: str | None = None) -> dict:
        # orders:get is a forbidden scope for agent tokens: refused here rather than sent and
        # counted as a denial against the token.
        return _refusal(
            "scope_forbidden",
            "Order status is not available to the agent through Leash (orders:get is never issued "
            "to agent tokens); the buyer follows the order from Arcade's checkout page.",
        )


_default_client: ArcadeClient | None = None


def configure_arcade_client(
    *,
    use_leash_proxy: bool,
    leash_proxy_url: str = "",
    leash_admin_key: str = "",
    leash_token: str | None = None,
    leash_agent_id: str = "agent_doraemon",
    leash_payer: str = "demo-user",
    leash_max_spend_cents: int = 15000,
    leash_categories: list[str] | None = None,
    leash_token_ttl_seconds: int = 600,
) -> None:
    """Call once at startup (see agent/agent.py's build_agent) to pick the client
    implementation from config, before any tool call runs get_arcade_client()."""
    global _default_client
    if use_leash_proxy:
        _default_client = ProxiedArcadeClient(
            proxy_url=leash_proxy_url,
            admin_key=leash_admin_key,
            leash_token=leash_token,
            agent_id=leash_agent_id,
            payer=leash_payer,
            max_spend_cents=leash_max_spend_cents,
            categories=leash_categories or [],
            token_ttl_seconds=leash_token_ttl_seconds,
        )
    else:
        _default_client = MockArcadeClient()


# A per-request client (agent/service.py sets one per web session, with that session's own Leash
# token). asyncio.to_thread copies context, so Strands' tool threads see it too.
_session_client: contextvars.ContextVar[ArcadeClient | None] = contextvars.ContextVar("arcade_client", default=None)


@contextmanager
def use_arcade_client(client: ArcadeClient) -> Iterator[ArcadeClient]:
    reset_token = _session_client.set(client)
    try:
        yield client
    finally:
        _session_client.reset(reset_token)


def get_arcade_client() -> ArcadeClient:
    global _default_client
    scoped = _session_client.get()
    if scoped is not None:
        return scoped
    if _default_client is None:
        _default_client = MockArcadeClient()
    return _default_client
