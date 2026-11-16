"""The opt-in per-IP limiter never counts an address that cannot be a payer,
and says in the log which address it refused: behind a proxy the address the
host hands over is the proxy's, and every payer would share its limit."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine

from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.server.errors import RateLimitedError
from openreceive.server.handler import HookContext
from openreceive.server.rate_limit import built_in_rate_limit
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeWallet


class Counter:
    """The one repository method the limiter calls, with a scripted answer."""

    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.asked: list[tuple[str, int]] = []

    def count_attempts_from_ip(self, client_ip: str, since_unix_seconds: int) -> int:
        self.asked.append((client_ip, since_unix_seconds))
        return int(self.answer(client_ip) if callable(self.answer) else self.answer)


def limiter_for(counter: Counter, address: str | None, clock: dict[str, int], **settings: Any):
    return built_in_rate_limit(
        counter,  # type: ignore[arg-type]
        settings or True,
        client_ip=lambda request: address,
        clock=lambda: clock["now"],
    )


def create(action: str = "checkout.create") -> HookContext:
    return HookContext(action=action, request=object(), resource={"reference": "order-1"})


def warnings_of(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.levelno == logging.WARNING]


@pytest.mark.parametrize(
    "proxy", ["127.0.0.1", "::ffff:10.0.0.7", "172.18.0.3", "::1", "fd12:3456::9", "100.64.0.1"]
)
def test_a_proxys_own_address_is_never_counted(
    proxy: str, caplog: pytest.LogCaptureFixture
) -> None:
    # The count says the limit is long gone. For a payer's address that is a
    # 429; for a loopback or private address it is the host's proxy, and
    # refusing it would stop every checkout on the site.
    counter = Counter(500)
    limiter = limiter_for(counter, proxy, {"now": 10_000}, limit_per_hour=1, limit_per_day=1)
    with caplog.at_level(logging.WARNING, logger="openreceive"):
        for action in ("checkout.create", "swap.create", "checkout.create"):
            assert limiter(create(action)) is True
    assert counter.asked == [], f"{proxy} must not be counted"
    # Said once, not on every request.
    warnings = warnings_of(caplog)
    assert len(warnings) == 1
    assert "a private or loopback address" in warnings[0]
    assert "your own proxy or network, not the payer" in warnings[0]
    assert "such requests are not limited" in warnings[0]
    assert "https://openreceive.org/guides/rate-limiting.md" in warnings[0]
    # It names the address as the limiter sees it: the bucket it would count.
    seen = {
        "::ffff:10.0.0.7": "10.0.0.7",
        "::1": "0:0:0:0::/64",
        "fd12:3456::9": "fd12:3456:0:0::/64",
    }.get(proxy, proxy)
    assert f"client address is {seen}," in warnings[0]


def test_each_limiter_warns_about_its_own_proxy_once(caplog: pytest.LogCaptureFixture) -> None:
    clock = {"now": 10_000}
    with caplog.at_level(logging.WARNING, logger="openreceive"):
        for _ in range(2):
            limiter = limiter_for(Counter(0), "192.168.1.10", clock)
            for _ in range(3):
                assert limiter(create()) is True
    assert len(warnings_of(caplog)) == 2


def test_a_refusal_names_the_address_in_the_log_at_most_once_a_minute(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = {"now": 10_000}
    counter = Counter(61)
    limiter = limiter_for(counter, "203.0.113.9", clock, limit_per_hour=60)
    with caplog.at_level(logging.WARNING, logger="openreceive"):
        for _ in range(3):
            with pytest.raises(RateLimitedError) as refused:
                limiter(create("swap.create"))
            # The 429 itself is unchanged.
            assert refused.value.status == 429 and refused.value.code == "RATE_LIMITED"
            assert str(refused.value) == "Too many payment attempts. Please try again later."
            assert refused.value.retryable is True and refused.value.retry_after_seconds == 60
        clock["now"] += 59
        with pytest.raises(RateLimitedError):
            limiter(create())
        assert len(warnings_of(caplog)) == 1
        clock["now"] += 1
        with pytest.raises(RateLimitedError):
            limiter(create())
    warnings = warnings_of(caplog)
    assert len(warnings) == 2
    assert (
        "refused a new payment from 203.0.113.9: 61 made in the last hour, limit 60" in warnings[0]
    )
    # The line an operator needs when the address is their own load balancer.
    assert "If 203.0.113.9 is your proxy, load balancer or CDN" in warnings[0]
    assert "every payer is sharing this limit" in warnings[0]
    assert "https://openreceive.org/guides/rate-limiting.md" in warnings[0]
    assert counter.asked[0] == ("203.0.113.9", 10_000 - 3_600)


def test_a_daily_refusal_names_its_own_window(caplog: pytest.LogCaptureFixture) -> None:
    counter = Counter(7)
    limiter = limiter_for(
        counter,
        "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
        {"now": 100_000},
        limit_per_hour=60,
        limit_per_day=7,
    )
    with caplog.at_level(logging.WARNING, logger="openreceive"):
        with pytest.raises(RateLimitedError):
            limiter(create())
    assert counter.asked == [
        ("2001:db8:1:2::/64", 100_000 - 3_600),
        ("2001:db8:1:2::/64", 100_000 - 86_400),
    ]
    assert (
        "refused a new payment from 2001:db8:1:2::/64: 7 made in the last 24 hours, limit 7"
        in warnings_of(caplog)[0]
    )


def test_a_host_supplied_identifier_is_counted_as_given(caplog: pytest.LogCaptureFixture) -> None:
    counter = Counter(lambda key: 2 if key == "account-42" else 0)
    limiter = limiter_for(counter, "account-42", {"now": 10_000}, limit_per_hour=2)
    with caplog.at_level(logging.WARNING, logger="openreceive"):
        with pytest.raises(RateLimitedError):
            limiter(create())
    assert "refused a new payment from account-42" in warnings_of(caplog)[0]


def test_a_payer_under_the_limit_is_counted_and_allowed_without_a_word(
    caplog: pytest.LogCaptureFixture,
) -> None:
    counter = Counter(3)
    limiter = limiter_for(counter, "198.51.100.7", {"now": 10_000}, limit_per_hour=60)
    with caplog.at_level(logging.WARNING, logger="openreceive"):
        assert limiter(create()) is True
        # Only the minting actions are metered.
        assert limiter(create("payment.check")) is True
    assert counter.asked == [("198.51.100.7", 10_000 - 3_600)]
    assert warnings_of(caplog) == []


def test_behind_a_proxy_the_app_mints_past_the_limit_and_still_stamps_the_address(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # The whole path: the host hands over its proxy's address on every request.
    engine = create_engine(f"sqlite:///{tmp_path / 'proxy.sqlite3'}")
    repository = SqlPaymentRepository(engine, clock=lambda: 1_700_000_000)
    repository.create_tables()
    app = OpenReceiveApp(
        service=Service(
            FakeWallet(clock=lambda: 1_700_000_000),
            price_provider=False,
            swap_providers=[],
            clock=lambda: 1_700_000_000,
        ),
        host=Host(
            amount_for=lambda reference: {"sats": 1000},
            authorize=lambda context: True,
            on_paid=lambda payment: None,
        ),
        repository=repository,
        rate_limiting={"limit_per_hour": 1},
        clock=lambda: 1_700_000_000,
    )

    def mint(reference: str, address: str) -> int:
        raw = b'{"reference":"%s"}' % reference.encode()
        status, _body, _headers = app.handle(
            HttpRequest(
                method="POST",
                path="/openreceive/checkouts",
                headers={"content-type": "application/json"},
                body=raw,
                content_length=len(raw),
                remote_addr=address,
            )
        )
        return status

    with caplog.at_level(logging.WARNING, logger="openreceive"):
        assert [mint(f"order-{index}", "10.0.0.7") for index in range(3)] == [201, 201, 201]
        # A payer's own address is still held to the limit.
        assert mint("order-a", "203.0.113.9") == 201
        assert mint("order-b", "203.0.113.9") == 429
    # The address stored on the payment rows is unchanged: all three carry it.
    assert repository.count_attempts_from_ip("10.0.0.7", 0) == 3
    warnings = warnings_of(caplog)
    assert sum("a private or loopback address" in line for line in warnings) == 1
    assert sum("refused a new payment from 203.0.113.9" in line for line in warnings) == 1
