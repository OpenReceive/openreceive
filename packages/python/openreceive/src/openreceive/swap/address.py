"""Swap deposit/refund address checksums (`swap-address` vectors). These are
checksum checks, not shape guards: a refund goes to whatever address the payer
typed, so a transposed character must be refused rather than sent somewhere
unrecoverable. Tron is Base58Check (double-SHA-256 tail over the 0x41-prefixed
payload), Ethereum is verified against EIP-55 whenever the address carries
mixed case, Solana must decode to exactly a 32-byte ed25519 public key.
Twin of Ruby `OpenReceive::SwapAddress`."""

from __future__ import annotations

import hashlib
import re

from openreceive.swap import base58, keccak

ETH_ADDRESS_PATTERN = re.compile(r"\A0x[0-9a-fA-F]{40}\Z")
TRON_ADDRESS_PREFIX = 0x41
BASE58CHECK_CHECKSUM_BYTES = 4
TRON_ADDRESS_PATTERN = re.compile(r"\AT[1-9A-HJ-NP-Za-km-z]{33}\Z")
SOLANA_ADDRESS_PATTERN = re.compile(r"\A[1-9A-HJ-NP-Za-km-z]{32,44}\Z")


def valid_solana_address(address: str) -> bool:
    if SOLANA_ADDRESS_PATTERN.match(address) is None:
        return False
    decoded = base58.decode(address)
    return decoded is not None and len(decoded) == 32


def valid_tron_address(address: str) -> bool:
    if TRON_ADDRESS_PATTERN.match(address) is None:
        return False
    decoded = base58.decode(address)
    if decoded is None or len(decoded) != 21 + BASE58CHECK_CHECKSUM_BYTES:
        return False
    if decoded[0] != TRON_ADDRESS_PREFIX:
        return False
    payload = decoded[:21]
    expected = hashlib.sha256(hashlib.sha256(payload).digest()).digest()
    return decoded[21:] == expected[:BASE58CHECK_CHECKSUM_BYTES]


def valid_ethereum_address(address: str) -> bool:
    if ETH_ADDRESS_PATTERN.match(address) is None:
        return False
    body = address[2:]
    lowercase = body.lower()
    # No mixed case means no EIP-55 bits to verify.
    if body == lowercase or body == body.upper():
        return True
    digest = keccak.digest(lowercase.encode("ascii"))
    for index, character in enumerate(lowercase):
        if not ("a" <= character <= "f"):
            continue
        nibble = digest[index // 2] >> 4 if index % 2 == 0 else digest[index // 2] & 0x0F
        if (nibble >= 8) != (body[index] == character.upper()):
            return False
    return True


def valid_for_network(network: str, address: str) -> bool:
    if len(address) > 200 or re.search(r"\s", address):
        return False
    if network == "ETH":
        return valid_ethereum_address(address)
    if network == "SOL":
        return valid_solana_address(address)
    if network in ("TRX", "TRON"):
        return valid_tron_address(address)
    # An unknown network has no rule to apply, so nothing may be accepted.
    return False


def network_for_pay_in_asset(pay_in_asset: object) -> str | None:
    """USDT_ETH → "ETH", USDT_TRON → "TRX", SOL_SOL → "SOL", else None."""
    suffix = str(pay_in_asset or "").split("_")[-1].upper()
    if suffix == "ETH":
        return "ETH"
    if suffix == "SOL":
        return "SOL"
    if suffix in ("TRON", "TRX"):
        return "TRX"
    return None


def valid_for_pay_in_asset(pay_in_asset: str, address: str) -> bool:
    network = network_for_pay_in_asset(pay_in_asset)
    if network is None:
        return 5 <= len(address) <= 200 and re.search(r"\s", address) is None
    return valid_for_network(network, address)


def refund_address_error(pay_in_asset: str, address: str, network_label: str) -> str | None:
    """Payer-facing refund address error, or None when empty (callers keep
    required-field handling) or valid. Copy mirrors the JS strings exactly."""
    trimmed = (address or "").strip()
    if not trimmed or valid_for_pay_in_asset(pay_in_asset, trimmed):
        return None
    network = network_for_pay_in_asset(pay_in_asset)
    if network == "ETH":
        if ETH_ADDRESS_PATTERN.match(trimmed):
            return (
                f"That {network_label} address failed its checksum. Copy it again from your wallet."
            )
        return f"That doesn't look like an {network_label} address. Use a 0x address."
    if network == "TRX":
        if TRON_ADDRESS_PATTERN.match(trimmed):
            return (
                f"That {network_label} address failed its checksum. Copy it again from your wallet."
            )
        return f"That doesn't look like a {network_label} address. Use an address starting with T."
    return f"That doesn't look like a {network_label} address. Check you pasted the full address."
