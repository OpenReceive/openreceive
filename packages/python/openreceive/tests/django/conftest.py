"""Django-side fixtures. `repository` / `clock` mirror tests/storage/conftest.py
so the SQL repository contract re-runs unchanged against the ORM backend;
`app` installs a fully built OpenReceiveApp (fakes, controllable clock) as the
process-wide one the views resolve."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from openreceive.django import conf
from openreceive.django.repository import DjangoPaymentRepository
from openreceive.server import OpenReceiveApp
from tests.django import host as test_host


@pytest.fixture
def clock() -> dict[str, int]:
    return {"now": 1_700_000_000}


@pytest.fixture
def repository(clock: dict[str, int], transactional_db: None) -> DjangoPaymentRepository:
    return DjangoPaymentRepository(clock=lambda: clock["now"])


@pytest.fixture
def state(transactional_db: None) -> Iterator[test_host.State]:
    yield test_host.reset()
    conf.reset()


@pytest.fixture
def app(state: test_host.State) -> OpenReceiveApp:
    """The app the views serve, built like conf.build_app but with the test
    clock, and installed as the process-wide instance."""
    config = conf.read_settings()
    built = OpenReceiveApp(
        service=conf.build_service(config),
        host=conf.load_host(config),
        repository=DjangoPaymentRepository(clock=lambda: state.now),
        client_ip=conf.client_ip,
        clock=lambda: state.now,
        report_unexpected_error=conf.report_unexpected_error,
    )
    conf._app = built
    return built
