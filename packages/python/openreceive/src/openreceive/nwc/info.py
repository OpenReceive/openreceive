"""NIP-47 wallet service info normalization (the kind 13194 payload):
method-name normalization, encryption-mode choice, spend-capability detection
and receive readiness (`nwc-info` vectors). Twin of Ruby
`OpenReceive::Server::WalletInfo`.
"""

from __future__ import annotations

import re
from typing import Any

from openreceive._generated.tables import NWC_REQUIRED_RECEIVE_METHODS, NWC_SPEND_METHODS
from openreceive.values import stringify

REQUIRED_RECEIVE_METHODS = NWC_REQUIRED_RECEIVE_METHODS
SPEND_METHODS = NWC_SPEND_METHODS


def _unwrap(value: object) -> object:
    data = stringify(value)
    return data["result"] if "result" in data else value


def string_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    if isinstance(value, str):
        return [item for item in re.split(r"[,\s]+", value) if item.strip()]
    return []


def normalize_method_name(value: str) -> str:
    return re.sub(r"[-\s]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value.strip())).lower()


def choose_encryption_mode(modes: list[str]) -> str | None:
    normalized = [mode.lower().replace("-", "_").replace(" ", "_") for mode in modes]
    if any(mode in ("nip44_v2", "nip44", "nip_44") for mode in normalized):
        return "nip44_v2"
    if not normalized or "nip04" in normalized or "nip_04" in normalized:
        # No advertised list at all: assume the NIP-47 baseline (NIP-04).
        return "nip04"
    # An advertised list containing no mode we speak: None, so preflight can
    # fail loudly instead of failing cryptically at RPC time.
    return None


def summarize(raw_info: object) -> dict[str, Any]:
    unwrapped = _unwrap(raw_info)
    info = stringify(unwrapped)
    raw_methods: object = next(
        (
            info[key]
            for key in ("methods", "capabilities", "supported_methods", "supportedMethods")
            if info.get(key) is not None
        ),
        None,
    )
    if raw_methods is None and isinstance(unwrapped, str):
        raw_methods = unwrapped
    methods = [normalize_method_name(name) for name in string_list(raw_methods)]
    encryption_source = (
        info.get("encryptions") if info.get("encryption") is None else info.get("encryption")
    )
    encryption = choose_encryption_mode(string_list(encryption_source))
    spend = [name for name in methods if name in SPEND_METHODS]
    missing = [name for name in REQUIRED_RECEIVE_METHODS if name not in methods]
    return {
        "methods": methods,
        "encryption": encryption,
        "spend_capability_advertised": bool(spend),
        "receive_checkout_ready": not missing,
        "warnings": [
            f"Wallet advertises spend method '{name}'; OpenReceive checkout will not expose it."
            for name in spend
        ],
    }
