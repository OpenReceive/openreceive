"""The Odoo module's copy of the payment tables matches the library's canonical
PostgreSQL schema, apart from `IF NOT EXISTS`. Runs in the library's own
environment (it needs SQLAlchemy to render the canonical DDL):

    uv run --project packages/python/openreceive pytest packages/python/odoo/tests
"""

import importlib.util
import re
from pathlib import Path

from openreceive.storage.sql.ddl import payments_schema_sql

MODULE = Path(__file__).resolve().parents[1] / "payment_openreceive"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, MODULE / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalized(sql: str) -> str:
    sql = re.sub(r"\bIF NOT EXISTS\s+", "", sql)
    return re.sub(r"\s+", " ", sql).replace("( ", "(").replace(" )", ")").strip()


def test_payments_ddl_matches_the_library():
    assert normalized(load("schema").PAYMENTS_DDL) == normalized(payments_schema_sql("postgresql"))


def test_manifest_version_matches_the_library():
    import openreceive

    manifest = (MODULE / "__manifest__.py").read_text(encoding="utf-8")
    version = re.search(r'"version":\s*"([^"]+)"', manifest)
    assert version is not None
    assert version.group(1) == openreceive.__version__
