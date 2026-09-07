"""The demo's test lane runs the PRODUCTION wiring over the engine's fakes:
DEMO_WALLET=testkit is set before Django configures, so
buttonshop.openreceive_service builds the Service over FakeWallet /
FakeSwapProvider / the static price, and /__testkit is live. A test that
wants the surface OFF flips the env var and asks again."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from typing import Any

os.environ.setdefault("DEMO_WALLET", "testkit")
# Never the checked-in .data directory: a fresh sqlite file per test session.
os.environ.setdefault("OPENRECEIVE_DEMO_DB", os.path.join(os.environ.get("TMPDIR", "/tmp"), "buttons-django-tests"))

import pytest  # noqa: E402
from django.middleware.csrf import get_token  # noqa: E402
from django.test import Client, RequestFactory  # noqa: E402

from buttonshop import openreceive_service  # noqa: E402
from buttonshop.shop import catalog  # noqa: E402
from buttonshop.shop.models import ShopProduct  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_fakes(transactional_db: None) -> Iterator[openreceive_service.Fakes]:
    """New fakes and a new engine app per test, so mint counters and wallet
    state never leak between tests."""
    from openreceive.django import conf

    openreceive_service.fakes = openreceive_service.Fakes()
    conf.reset()
    yield openreceive_service.fakes
    conf.reset()


@pytest.fixture
def seeded(transactional_db: None) -> None:
    """The transactional fixture flushes seed rows between tests; re-apply the
    catalog the way the data migration does."""
    catalog.apply(ShopProduct)


class Browser:
    """One visitor: a Django test client that enforces CSRF and carries the
    token the way the SPA does (cookie → <meta> → X-CSRFToken)."""

    def __init__(self) -> None:
        self.client = Client(enforce_csrf_checks=True)
        self.token = get_token(RequestFactory().get("/"))
        self.client.cookies["csrftoken"] = self.token

    def get(self, path: str) -> Any:
        return self.client.get(path)

    def post(self, path: str, body: dict[str, Any] | None = None, *, csrf: bool = True) -> Any:
        extra = {"HTTP_X_CSRFTOKEN": self.token} if csrf else {}
        return self.client.post(
            path, data=json.dumps(body or {}), content_type="application/json", **extra
        )

    def create_order(self, sku: str = "safety-orange", quantity: int = 1) -> dict[str, Any]:
        response = self.post("/shop/orders", {"items": [{"sku": sku, "quantity": quantity}]})
        assert response.status_code == 201, response.content
        return response.json()


@pytest.fixture
def browser(seeded: None) -> Browser:
    return Browser()
