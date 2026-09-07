"""Repository fixtures: SQLite on a temp file always; PostgreSQL and MySQL when
OPENRECEIVE_TEST_PGSQL_URL / OPENRECEIVE_TEST_MYSQL_URL are set (the lock
paths). Each test gets uniquely named tables so runs never collide."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, create_engine, text

from openreceive.storage.sql import SqlPaymentRepository

BACKENDS = ["sqlite"]
if os.environ.get("OPENRECEIVE_TEST_PGSQL_URL"):
    BACKENDS.append("postgres")
if os.environ.get("OPENRECEIVE_TEST_MYSQL_URL"):
    BACKENDS.append("mysql")


def _engine_for(backend: str, tmp_path: Path) -> Engine:
    if backend == "sqlite":
        return create_engine(f"sqlite:///{tmp_path / 'openreceive.sqlite3'}")
    if backend == "postgres":
        url = os.environ["OPENRECEIVE_TEST_PGSQL_URL"].replace(
            "postgres://", "postgresql+psycopg://", 1
        )
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        return create_engine(url)
    url = os.environ["OPENRECEIVE_TEST_MYSQL_URL"]
    if url.startswith("mysql://"):
        url = url.replace("mysql://", "mysql+pymysql://", 1)
    return create_engine(url)


@pytest.fixture(params=BACKENDS)
def engine(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[Engine]:
    engine = _engine_for(str(request.param), tmp_path)
    yield engine
    engine.dispose()


@pytest.fixture
def clock() -> dict[str, int]:
    return {"now": 1_700_000_000}


@pytest.fixture
def repository(engine: Engine, clock: dict[str, int]) -> Iterator[SqlPaymentRepository]:
    suffix = uuid.uuid4().hex[:8]
    repository = SqlPaymentRepository(
        engine,
        table_name=f"openreceive_payments_{suffix}",
        meta_table_name=f"openreceive_meta_{suffix}",
        clock=lambda: clock["now"],
    )
    repository.create_tables()
    yield repository
    with engine.begin() as connection:
        connection.execute(text(f"DROP TABLE IF EXISTS {repository.tables.payments.name}"))
        connection.execute(text(f"DROP TABLE IF EXISTS {repository.tables.meta.name}"))
