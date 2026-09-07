"""Test support hosts import to exercise their hooks without a wallet or a
swap provider: the fake wallet, the fake provider and the shared fixtures.
Testkit mode prices with `openreceive.rates.StaticPriceProvider`."""

from openreceive.rates.static import StaticPriceProvider
from openreceive.testing.fake_swap_provider import FakeSwapProvider
from openreceive.testing.fake_wallet import FakeWallet

__all__ = ["FakeSwapProvider", "FakeWallet", "StaticPriceProvider"]
