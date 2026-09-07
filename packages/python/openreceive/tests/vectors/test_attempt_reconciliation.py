import pytest

from openreceive.payments import reconciliation
from tests.conftest import load_vector

VECTOR = load_vector("attempt-reconciliation.json")


def test_grace_constant_matches_the_shared_vectors() -> None:
    assert reconciliation.ATTEMPT_EXPIRY_GRACE_SECONDS == VECTOR["expiry_grace_seconds"]


@pytest.mark.parametrize("vector", VECTOR["vectors"], ids=lambda vector: vector["name"])
def test_attempt_reconciliation(vector: dict) -> None:
    actual = reconciliation.transition(
        expires_at=vector["attempt"]["expires_at"],
        status=vector["status"],
        observed_at=vector["observed_at"],
        transaction_state=vector.get("transaction_state"),
    )
    assert actual == vector["expected"]
