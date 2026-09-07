"""The pay-in asset catalog (kernel vocabulary) plus the network matching the
FixedFloat provider uses to map /ccies rows. Twin of Ruby `Swap::Assets`."""

from __future__ import annotations

import re
from typing import Any

from openreceive._generated.tables import SWAP_ASSET_INFO, SWAP_PAY_IN_ASSETS

PAY_IN_ASSETS: tuple[str, ...] = SWAP_PAY_IN_ASSETS
ASSET_INFO: dict[str, dict[str, str]] = SWAP_ASSET_INFO


def is_pay_in_asset(value: object) -> bool:
    return isinstance(value, str) and value in PAY_IN_ASSETS


def info(pay_in_asset: str) -> dict[str, Any]:
    return dict(ASSET_INFO[pay_in_asset])


def list_info() -> list[dict[str, Any]]:
    return [dict(ASSET_INFO[asset]) for asset in PAY_IN_ASSETS]


def normalize_network(value: object) -> str:
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def network_matches(expected: str, actual: str) -> bool:
    normalized_expected = normalize_network(expected)
    normalized_actual = normalize_network(actual)
    if normalized_actual == normalized_expected:
        return True
    if normalized_expected == "TRX":
        return normalized_actual in ("TRON", "TRC20", "TRC")
    if normalized_expected == "ETH":
        return normalized_actual in ("ETHEREUM", "ERC20", "ERC")
    if normalized_expected == "SOL":
        return normalized_actual == "SOLANA"
    return False


def is_lightning_network(value: object) -> bool:
    return normalize_network(value) in ("LN", "LIGHTNING", "LIGHTNINGNETWORK", "BTCLN", "BTCBOLT11")
