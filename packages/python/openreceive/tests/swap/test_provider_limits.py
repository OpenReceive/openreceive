"""The request guard is sized by who the provider is, and obeys the wait a 429
names: the provider's host picks its limits, the transport hands the guard the
429's path and wait, and a check asks whether a create is available without
using any budget."""

from __future__ import annotations

import json
from typing import Any

import pytest

from openreceive.swap import providers_from_connections
from openreceive.swap.budget import (
    FIXEDFLOAT_LIMITS,
    LIGHTNING_SWAP_LIMITS,
    SwapProviderWeightBudget,
    WeightBudgetError,
    limits_for_base_url,
)
from openreceive.swap.fixedfloat import (
    FixedFloatApiError,
    FixedFloatProvider,
    read_retry_after_seconds,
)

ORDER = {
    "provider": "fixedfloat",
    "provider_order_id": "fixture-order",
    "provider_token": "test-private",
    "pay_in_asset": "USDT_TRON",
    "deposit_address": "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    "deposit_amount": "1.05",
    "expires_at": 1_700_001_000,
    "state": "awaiting_deposit",
}
ORDER_BODY = {
    "id": "fixture-order",
    "token": "test-private",
    "status": "NEW",
    "from": {"address": "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", "amount": "1.05"},
    "time": {"expiration": 1_700_001_000},
}


def provider_answering(answer: dict[str, Any], **options: Any) -> FixedFloatProvider:
    return FixedFloatProvider(
        key="synthetic-key", secret="synthetic-secret", http=lambda **_: answer, **options
    )


def denial_of(guard: SwapProviderWeightBudget, path: str) -> dict[str, Any]:
    with pytest.raises(WeightBudgetError) as refused:
        guard.reserve(path)
    return refused.value.denial


def test_the_providers_host_picks_its_limits_and_an_unknown_host_gets_fixedfloat() -> None:
    for url in (
        "https://lightning-swap.com",
        "https://lightning-swap.com/",
        "https://api.lightning-swap.com/v1",
        "https://LIGHTNING-SWAP.com",
    ):
        assert limits_for_base_url(url) is LIGHTNING_SWAP_LIMITS, url
    for url in (
        "https://ff.io",
        "https://swap.example/v1",
        # A look-alike host is not Lightning Swap.
        "https://evil-lightning-swap.com",
        "https://lightning-swap.com.example",
        "https://lightning-swap.com:not-a-port",
        "not a url",
        "",
        None,
    ):
        assert limits_for_base_url(url) is FIXEDFLOAT_LIMITS, url
    lightning_swap = FixedFloatProvider(key="k", secret="s", base_url="https://lightning-swap.com")
    assert lightning_swap.limits.profile == "lightning-swap"
    assert FixedFloatProvider(key="k", secret="s").limits.profile == "fixedfloat"


def test_each_configured_connection_is_sized_by_its_own_host() -> None:
    # The base URLs an LSC connection parses to: a trailing slash and all.
    primary, backup = providers_from_connections(
        [
            {
                "provider_id": "lightning-swap-com",
                "base_url": "https://lightning-swap.com/",
                "key": "synthetic-key",
                "secret": "synthetic-secret",
            },
            {
                "provider_id": "ff-io",
                "base_url": "https://ff.io/",
                "key": "synthetic-key",
                "secret": "synthetic-secret",
            },
        ]
    )
    assert primary.limits is LIGHTNING_SWAP_LIMITS
    assert backup.limits is FIXEDFLOAT_LIMITS


def test_a_fixedfloat_guard_still_allows_three_creates_a_minute() -> None:
    clock = {"now": 1_000}
    guard = SwapProviderWeightBudget("fixedfloat", lambda: clock["now"])
    for _ in range(3):
        guard.reserve("create")
    with pytest.raises(WeightBudgetError, match="weight budget exhausted"):
        guard.reserve("create")
    clock["now"] += 60
    guard.reserve("create")


def test_a_lightning_swap_guard_allows_thirty_creates_and_keeps_status_calls_going() -> None:
    clock = {"now": 1_000}
    guard = SwapProviderWeightBudget(
        "lightning-swap-com", lambda: clock["now"], LIGHTNING_SWAP_LIMITS
    )
    for _ in range(30):
        guard.reserve("create")
    denial = denial_of(guard, "create")
    assert denial["message"] == "Swap provider create budget exhausted (30+1 > 30)."
    assert denial["reason"] == "exhausted"
    assert denial["creates"] == 30 and denial["create_limit"] == 30
    # The swaps that exist can still be read and refunded.
    guard.reserve("order")
    guard.reserve("emergency")
    clock["now"] += 60
    guard.reserve("create")


def test_asking_whether_a_create_is_available_uses_no_budget() -> None:
    guard = SwapProviderWeightBudget("fixedfloat", lambda: 1_000)
    for _ in range(10):
        guard.assert_available("create")
    for _ in range(3):
        guard.reserve("create")
    with pytest.raises(WeightBudgetError, match="weight budget exhausted"):
        guard.assert_available("create")
    # A FixedFloat denial reports no create count: the profile has none.
    assert "create_limit" not in denial_of(guard, "create")


def test_a_lightning_swap_429_on_a_create_stops_creates_for_the_wait_it_names() -> None:
    clock = {"now": 1_000}
    guard = SwapProviderWeightBudget(
        "lightning-swap-com", lambda: clock["now"], LIGHTNING_SWAP_LIMITS
    )
    guard.mark_rate_limited(path="create", retry_after_seconds=12)
    denial = denial_of(guard, "create")
    assert denial["reason"] == "backoff" and denial["backoff_until"] == 1_012
    guard.reserve("order")
    clock["now"] = 1_012
    guard.reserve("create")

    # A 429 on any other call means the account's API budget is spent: all stop.
    guard.mark_rate_limited(path="order", retry_after_seconds=30)
    for path in ("order", "create"):
        with pytest.raises(WeightBudgetError, match="in backoff until 1042"):
            guard.reserve(path)

    # No wait named: one minute. A day-long wait is retried after five minutes,
    # because the provider can lift it sooner.
    clock["now"] = 2_000
    guard.mark_rate_limited(path="create")
    with pytest.raises(WeightBudgetError, match="in backoff until 2060"):
        guard.reserve("create")
    clock["now"] = 3_000
    guard.mark_rate_limited(path="create", retry_after_seconds=86_000)
    with pytest.raises(WeightBudgetError, match="in backoff until 3300"):
        guard.reserve("create")


def test_a_fixedfloat_429_stops_every_call_for_at_least_a_minute() -> None:
    clock = {"now": 1_000}
    guard = SwapProviderWeightBudget("fixedfloat", lambda: clock["now"])
    guard.mark_rate_limited(path="create", retry_after_seconds=5)
    with pytest.raises(WeightBudgetError, match="in backoff until 1060"):
        guard.reserve("order")
    clock["now"] = 2_000
    guard.mark_rate_limited(path="create", retry_after_seconds=600)
    with pytest.raises(WeightBudgetError, match="in backoff until 2600"):
        guard.reserve("order")
    clock["now"] = 5_000
    guard.mark_rate_limited(retry_after_seconds=999_999)
    with pytest.raises(WeightBudgetError, match="in backoff until 8600"):
        guard.reserve("order")


@pytest.mark.parametrize("wait", [None, 0, -3, True, "12", float("nan"), float("inf")])
def test_a_wait_that_is_not_a_positive_number_means_the_profiles_own_backoff(wait: Any) -> None:
    guard = SwapProviderWeightBudget("lightning-swap-com", lambda: 1_000, LIGHTNING_SWAP_LIMITS)
    guard.mark_rate_limited(path="create", retry_after_seconds=wait)
    assert denial_of(guard, "create")["backoff_until"] == 1_060


def test_a_fractional_wait_is_rounded_up_and_an_absurd_one_is_capped() -> None:
    guard = SwapProviderWeightBudget("lightning-swap-com", lambda: 1_000, LIGHTNING_SWAP_LIMITS)
    guard.mark_rate_limited(path="create", retry_after_seconds=0.2)
    assert denial_of(guard, "create")["backoff_until"] == 1_001
    guard.mark_rate_limited(path="create", retry_after_seconds=10**400)
    assert denial_of(guard, "create")["backoff_until"] == 1_300


class RecordingGuard:
    """What the transport tells the guard, and nothing else."""

    def __init__(self) -> None:
        self.notices: list[dict[str, Any]] = []

    def reserve(self, path: str) -> None:
        return None

    def assert_available(self, path: str) -> None:
        return None

    def mark_rate_limited(
        self, *, path: str | None = None, retry_after_seconds: float | None = None
    ) -> None:
        self.notices.append({"path": path, "retry_after_seconds": retry_after_seconds})


def test_a_429_hands_the_guard_the_path_and_the_providers_own_wait() -> None:
    guard = RecordingGuard()
    for answer in (
        # Lightning Swap answers a refused call with Retry-After and a body.
        {
            "status": 429,
            "headers": {"Retry-After": "17"},
            "body": json.dumps({"code": 429, "msg": "Rate limit", "data": None}),
        },
        {
            "status": 429,
            "body": json.dumps(
                {"code": 429, "msg": "Rate limit", "data": {"errors": ["RATE"], "retry_after": 41}}
            ),
        },
        {"status": 429, "body": json.dumps({"code": 1, "msg": "Too many requests"})},
    ):
        provider = provider_answering(answer)
        provider.attach_weight_budget(guard)  # type: ignore[arg-type]
        with pytest.raises(FixedFloatApiError) as refused:
            provider.get_status(ORDER)
        assert refused.value.kind == "rate_limited"
    assert guard.notices == [
        {"path": "order", "retry_after_seconds": 17},
        {"path": "order", "retry_after_seconds": 41},
        {"path": "order", "retry_after_seconds": None},
    ]


@pytest.mark.parametrize(
    ("headers", "data", "expected"),
    [
        ({"retry-after": "17"}, None, 17),
        ({"RETRY-AFTER": " 9 "}, {"retry_after": 41}, 9),
        # A header of zero is still the header's answer: no wait named.
        ({"Retry-After": "0"}, {"retry_after": 41}, 0),
        # An HTTP date, a fraction or a sign is not whole seconds: the body speaks.
        ({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, {"retry_after": 41}, 41),
        ({"Retry-After": "1.5"}, {"retry_after": 2.5}, 2.5),
        ({"Retry-After": "-5"}, None, None),
        ({"Retry-After": "1234567890"}, None, None),
        ({}, {"retry_after": 41}, 41),
        (None, {"retry_after": 41}, 41),
        (None, {"retry_after": "41"}, None),
        (None, {"retry_after": True}, None),
        (None, {"retry_after": 0}, None),
        (None, {"retry_after": -1}, None),
        (None, {"retry_after": float("inf")}, None),
        (None, {"retry_after": 10**400}, 10**400),
        (None, ["retry_after"], None),
        (None, None, None),
    ],
)
def test_the_wait_a_429_names(headers: Any, data: Any, expected: Any) -> None:
    assert read_retry_after_seconds(headers, data) == expected


def test_the_default_transport_hands_over_the_response_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx

    from openreceive.swap.http import default_http_request

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429, headers={"Retry-After": "17"}, json={"code": 429, "msg": "Rate limit"}
        )

    real_client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **options: real_client(transport=httpx.MockTransport(answer), **options),
    )
    response = default_http_request(
        method="POST",
        url="https://swap.example/api/v2/order",
        headers={"Content-Type": "application/json"},
        body="{}",
        timeout_ms=1_000,
    )
    assert response["status"] == 429
    assert json.loads(response["body"])["msg"] == "Rate limit"
    assert read_retry_after_seconds(response["headers"], None) == 17


def test_a_lightning_swap_provider_obeys_the_wait_its_own_429_names() -> None:
    clock = {"now": 1_000}
    answers = {
        "order": {"status": 200, "body": json.dumps({"code": 0, "data": ORDER_BODY})},
        "create": {
            "status": 429,
            "headers": {"retry-after": "12"},
            "body": json.dumps({"code": 429, "msg": "Rate limit", "data": None}),
        },
    }
    calls: list[str] = []

    def transport(**request: Any) -> dict[str, Any]:
        path = request["url"].rsplit("/", 1)[-1]
        calls.append(path)
        return answers[path]

    provider = FixedFloatProvider(
        key="synthetic-key",
        secret="synthetic-secret",
        base_url="https://lightning-swap.com",
        http=transport,
        now=lambda: clock["now"],
    )
    provider._resolve_currencies = lambda: {  # type: ignore[method-assign]
        "pay_in": {"USDT_TRON": {"code": "USDTTRC"}},
        "lightning": {"code": "BTCLN"},
    }
    # A provider nobody attached a guard to is always available.
    provider.assert_create_available()
    provider.attach_weight_budget(
        SwapProviderWeightBudget(provider.name, lambda: clock["now"], provider.limits)
    )
    provider.assert_create_available()
    with pytest.raises(FixedFloatApiError):
        provider.create_swap(pay_in_asset="USDT_TRON", bolt11="lnbc1", invoice_amount_msats=1_000)
    # Creates stand off for the twelve seconds the provider named, and the
    # provider is not asked again; a swap that exists can still be read.
    with pytest.raises(WeightBudgetError, match="in backoff until 1012"):
        provider.assert_create_available()
    with pytest.raises(WeightBudgetError, match="in backoff until 1012"):
        provider.create_swap(pay_in_asset="USDT_TRON", bolt11="lnbc1", invoice_amount_msats=1_000)
    assert calls == ["create"]
    assert provider.get_status(ORDER)["state"] == "awaiting_deposit"
    clock["now"] = 1_012
    provider.assert_create_available()
