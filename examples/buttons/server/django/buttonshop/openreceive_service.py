"""TESTKIT WALLET MODE, and the only branch in the OpenReceive wiring.

`DEMO_WALLET=testkit` replaces THREE THINGS — the wallet, the swap provider
and the price feed — with the engine's own in-memory fakes
(`openreceive.testing`), so the whole shop can be clicked through (Lightning,
a swap deposit, a refund) with no NWC_URI, no swap-provider keys and no
network. Everything else is the production wiring: the three hooks, the
engine, the migration, the views and the SPA run exactly as they do in
compose. That is the whole value of it — a test lane that also swapped the
engine would prove the fakes work; this one proves the integration does.

The fakes are built once per process and kept here, because the /__testkit
control surface has to reach the SAME wallet the engine mints into.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

from openreceive.django import conf
from openreceive.server import Service
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider


def testkit_enabled(env: Mapping[str, str] | None = None) -> bool:
    environment = os.environ if env is None else env
    return (environment.get("DEMO_WALLET") or "").strip().lower() == "testkit"


@dataclass
class Fakes:
    wallet: FakeWallet = field(default_factory=FakeWallet)
    provider: FakeSwapProvider = field(default_factory=FakeSwapProvider)


fakes = Fakes()


def build_service(env: Mapping[str, str]) -> Service:
    if testkit_enabled(env):
        # BTC at a fixed $50,000, the constant every engine's testkit shares, so
        # a $1.00 button is 2,000 sats on every stack.
        return Service(
            fakes.wallet,
            price_provider=StaticPriceProvider(),
            swap_providers=[fakes.provider],
            price_currencies=["USD"],
        )
    # The adapter's default: NwcReceiveClient over NWC_URI, the cached live
    # BTC/USD feed, providers auto-built from LSC_URI_PRIMARY / LSC_URI_BACKUP.
    return conf.build_service({**conf.DEFAULTS, "PRICE_CURRENCIES": ["USD"]}, env)
