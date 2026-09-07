"""A fake wallet and a running fake relay for the transport tests."""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

# `fake_relay` is a sibling module, importable by name whether or not this
# directory ever gains an ``__init__.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_relay import WALLET_SECRET, FakeRelay, FakeWallet  # noqa: E402


@pytest.fixture
def wallet() -> FakeWallet:
    return FakeWallet(WALLET_SECRET)


@pytest.fixture
def relay(wallet: FakeWallet) -> Iterator[FakeRelay]:
    with FakeRelay(wallet) as running:
        yield running
