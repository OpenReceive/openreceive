from pathlib import Path

import pytest

from openreceive.payments.reconciliation import ATTEMPT_EXPIRY_GRACE_SECONDS
from openreceive.storage.repository import ATTEMPT_REUSE_BUFFER_SECONDS
from tests.conftest import load_vector
from tests.vectors.attempt_state_machine_runner import run_sequence

FAMILY = load_vector("attempt-state-machine.json")


def test_vector_constants_match_the_engine() -> None:
    assert FAMILY["expiry_grace_seconds"] == ATTEMPT_EXPIRY_GRACE_SECONDS
    assert FAMILY["reuse_buffer_seconds"] == ATTEMPT_REUSE_BUFFER_SECONDS


@pytest.mark.parametrize("sequence", FAMILY["sequences"], ids=lambda sequence: sequence["name"])
def test_attempt_state_machine(sequence: dict, tmp_path: Path) -> None:
    result = run_sequence(sequence, f"sqlite:///{tmp_path / 'sequence.sqlite3'}")
    assert result["ok"], f"{result} at step: {sequence['steps'][result.get('step', 0)]}"
