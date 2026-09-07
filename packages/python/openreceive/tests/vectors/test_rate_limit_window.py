"""Both engines must window the per-IP budget on the same immutable column, so a
wallet clock or a status transition cannot move it. The storage integration
test drives the real repository through these cases; this file pins the rule
and the repository's counting query at the source level, like the Ruby harness."""

from pathlib import Path

import pytest

from openreceive.storage.sql import repository as repository_module
from tests.conftest import load_vector

VECTOR = load_vector("rate-limit-window.json")


def test_the_decided_column() -> None:
    assert VECTOR["column"] == "inserted_at"
    source = Path(repository_module.__file__).read_text(encoding="utf-8")
    counting = source[source.index("def count_attempts_from_ip") :]
    counting = counting[: counting.index("def ", 10)]
    assert f"payments.c.{VECTOR['column']} >=" in counting
    for rejected in VECTOR["rejected_columns"]:
        assert f"payments.c.{rejected['column']} >=" not in counting


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_rate_limit_window(case: dict) -> None:
    stamp = case["attempt"][VECTOR["column"]]
    counted = stamp >= case["now"] - case["window_seconds"]
    assert counted == case["expected"]["counted"]
