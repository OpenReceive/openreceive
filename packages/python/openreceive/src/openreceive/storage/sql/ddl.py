"""`payments_schema_sql(dialect)`: the canonical DDL for both engine-owned
tables as one executable script (CREATE TABLE, indexes, the schema_version
seed row), rendered from the same Table objects the repository reads through.
The CLI's `openreceive scaffold payments --sql --dialect …` prints it and
`--alembic` wraps the same statements in a revision."""

from __future__ import annotations

from sqlalchemy.dialects import mysql, postgresql, sqlite
from sqlalchemy.schema import CreateIndex, CreateTable

from openreceive.storage.repository import PAYMENTS_SCHEMA_VERSION, SCHEMA_VERSION_KEY
from openreceive.storage.sql.tables import (
    DEFAULT_META_TABLE_NAME,
    DEFAULT_TABLE_NAME,
    assert_identifier,
    normalize_dialect,
    payments_tables,
)

_DIALECTS = {
    "postgresql": postgresql.dialect,
    "sqlite": sqlite.dialect,
    "mysql": mysql.dialect,
}


def seed_sql(dialect: str, meta_table_name: str = DEFAULT_META_TABLE_NAME) -> str:
    """The idempotent INSERT recording which schema generation is installed.
    Every migration path must run it: the newer-schema refusal only engages
    when the marker exists."""
    normalized = normalize_dialect(dialect)
    assert_identifier(meta_table_name)
    values = f"VALUES ('{SCHEMA_VERSION_KEY}', '{PAYMENTS_SCHEMA_VERSION}', 0)"
    if normalized == "postgresql":
        return (
            f"INSERT INTO {meta_table_name} (key, value, rev) {values} ON CONFLICT (key) DO NOTHING"
        )
    if normalized == "mysql":
        return f"INSERT IGNORE INTO {meta_table_name} (`key`, value, rev) {values}"
    return f"INSERT OR IGNORE INTO {meta_table_name} (key, value, rev) {values}"


def payments_ddl_statements(
    dialect: str,
    table_name: str = DEFAULT_TABLE_NAME,
    meta_table_name: str = DEFAULT_META_TABLE_NAME,
) -> list[str]:
    tables = payments_tables(dialect, table_name, meta_table_name)
    compiler_dialect = _DIALECTS[tables.dialect]()
    statements: list[str] = []
    for table in (tables.payments, tables.meta):
        statements.append(str(CreateTable(table).compile(dialect=compiler_dialect)).strip())
        for index in sorted(table.indexes, key=lambda item: str(item.name)):
            statements.append(str(CreateIndex(index).compile(dialect=compiler_dialect)).strip())
    statements.append(seed_sql(tables.dialect, meta_table_name))
    return statements


def payments_schema_sql(
    dialect: str,
    table_name: str = DEFAULT_TABLE_NAME,
    meta_table_name: str = DEFAULT_META_TABLE_NAME,
) -> str:
    return "\n".join(
        f"{statement};"
        for statement in payments_ddl_statements(dialect, table_name, meta_table_name)
    )
