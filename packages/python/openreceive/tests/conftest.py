"""Shared fixtures: the spec vector loader (every vector test reads
`spec/test-vectors/<family>.json` by path so the coverage detector sees the
literal file name in the test source) and a repository-root locator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
VECTORS_DIR = REPO_ROOT / "spec" / "test-vectors"


def load_vector(file_name: str) -> dict[str, Any]:
    with (VECTORS_DIR / file_name).open(encoding="utf-8") as handle:
        data: dict[str, Any] = json.load(handle)
    return data


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def vectors_dir() -> Path:
    return VECTORS_DIR
