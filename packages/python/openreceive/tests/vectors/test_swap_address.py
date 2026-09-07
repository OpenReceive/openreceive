import hashlib

import pytest

from openreceive.swap import address, keccak
from tests.conftest import load_vector

VECTOR = load_vector("swap-address.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_swap_address(case: dict) -> None:
    assert address.valid_for_network(case["network"], case["address"]) == case["expected"]["valid"]


def test_keccak_is_not_sha3() -> None:
    # Known Keccak-256 answers (the Ethereum variant), distinct from NIST SHA-3.
    assert (
        keccak.digest(b"").hex()
        == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    )
    assert (
        keccak.digest(b"abc").hex()
        == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    )
    assert keccak.digest(b"").hex() != hashlib.sha3_256(b"").hexdigest()
    # Multi-block input (longer than the 136-byte rate).
    assert keccak.digest(b"a" * 200).hex() == keccak.digest(b"a" * 200).hex()


def test_network_for_pay_in_asset() -> None:
    assert address.network_for_pay_in_asset("USDT_TRON") == "TRX"
    assert address.network_for_pay_in_asset("USDC_ETH") == "ETH"
    assert address.network_for_pay_in_asset("SOL_SOL") == "SOL"
    assert address.network_for_pay_in_asset("XYZ") is None
    assert address.refund_address_error("USDT_TRON", "", "Tron") is None
    assert "checksum" in str(
        address.refund_address_error("USDT_TRON", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg", "Tron")
    )
