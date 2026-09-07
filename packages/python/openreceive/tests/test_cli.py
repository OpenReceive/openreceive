"""The `openreceive` console script: scaffold output for the three dialects
and the Alembic revision, the doctor's secret discipline and exit codes,
`--app` resolution against a FastAPI host, and the reconcile verb."""

from __future__ import annotations

import io
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from openreceive.cli import run
from openreceive.nwc.uri import SCHEME

PUBKEY = "a" * 64
SECRET = "b" * 64
RELAY = "wss://relay.test.openreceive.local"
NWC_URI = f"{SCHEME}://{PUBKEY}?relay={RELAY}&secret={SECRET}"


def cli(argv: list[str], **kwargs: Any) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    kwargs.setdefault("env", {})
    code = run(argv, stdout=out, stderr=err, **kwargs)
    return code, out.getvalue(), err.getvalue()


# ------------------------------------------------------------------ scaffold


@pytest.mark.parametrize(
    ("dialect", "marker", "seed"),
    [
        ("postgres", "BIGSERIAL", "ON CONFLICT (key) DO NOTHING"),
        ("sqlite", "INTEGER NOT NULL", "INSERT OR IGNORE INTO openreceive_meta"),
        ("mysql", "`key`", "INSERT IGNORE INTO openreceive_meta"),
    ],
)
def test_scaffold_sql_renders_both_tables_per_dialect(dialect: str, marker: str, seed: str) -> None:
    code, out, err = cli(["scaffold", "payments", "--sql", "--dialect", dialect])
    assert code == 0 and err == ""
    assert "CREATE TABLE openreceive_payments" in out
    assert "CREATE TABLE openreceive_meta" in out
    assert marker in out and seed in out
    assert "Fulfilling exactly once" in out  # the shared note rides along
    assert out.rstrip().endswith(";")


def test_scaffold_sql_honours_table_names() -> None:
    code, out, _ = cli(
        [
            "scaffold",
            "payments",
            "--sql",
            "--dialect",
            "sqlite",
            "--table-name",
            "pay_attempts",
            "--meta-table-name",
            "pay_meta",
        ]
    )
    assert code == 0
    assert "CREATE TABLE pay_attempts" in out and "CREATE TABLE pay_meta" in out
    assert "openreceive_payments" not in out.replace("-- OpenReceive", "")


def test_scaffold_alembic_writes_a_frozen_revision(tmp_path: Path) -> None:
    code, out, err = cli(
        [
            "scaffold",
            "payments",
            "--alembic",
            "--dialect",
            "sqlite",
            "--revision",
            "0123456789ab",
            "--down-revision",
            "deadbeef1234",
        ],
        cwd=tmp_path,
    )
    assert code == 0, err
    path = tmp_path / "alembic/versions/0123456789ab_openreceive_payments.py"
    assert path.exists() and "Wrote alembic/versions/0123456789ab_openreceive_payments.py" in out
    source = path.read_text()
    assert 'revision = "0123456789ab"' in source
    assert 'down_revision = "deadbeef1234"' in source
    assert "op.execute(" in source and "CREATE TABLE openreceive_payments" in source
    assert 'op.drop_table("openreceive_payments")' in source
    compile(source, str(path), "exec")  # valid Python
    # Rendered at scaffold time, never re-rendered by the library later.
    assert "payments_ddl_statements" not in source

    # A second run refuses to clobber the file without --force.
    code, _, err = cli(
        ["scaffold", "payments", "--alembic", "--revision", "0123456789ab"], cwd=tmp_path
    )
    assert code == 1 and "exists; pass --force" in err
    code, out, _ = cli(
        ["scaffold", "payments", "--alembic", "--revision", "0123456789ab", "--force"],
        cwd=tmp_path,
    )
    assert code == 0 and "down_revision is None" in out


@pytest.mark.parametrize(
    "argv",
    [
        ["scaffold", "payments"],
        ["scaffold", "payments", "--sql", "--alembic"],
        ["scaffold", "payments", "--sql", "--dialect", "oracle"],
        ["scaffold", "tables"],
        ["frobnicate"],
    ],
)
def test_usage_mistakes_exit_2(argv: list[str]) -> None:
    code, _, err = cli(argv)
    assert code == 2 and "Usage: openreceive" in err


# -------------------------------------------------------------------- doctor


class ReceiveOnlyWallet:
    def __init__(self, uri: str) -> None:
        self.uri = uri
        self.closed = False

    def preflight(self) -> dict[str, Any]:
        return {"methods": ["make_invoice", "list_transactions"], "encryption": ["nip44_v2"]}

    def close(self) -> None:
        self.closed = True


def test_doctor_never_prints_a_secret() -> None:
    wallets: list[ReceiveOnlyWallet] = []

    def factory(uri: str) -> ReceiveOnlyWallet:
        wallets.append(ReceiveOnlyWallet(uri))
        return wallets[-1]

    code, out, err = cli(["doctor"], env={"NWC_URI": NWC_URI}, wallet_client_factory=factory)
    assert code == 0, out + err
    assert "NWC_URI: present-redacted" in out
    assert "wallet: reachable, receive-only (make_invoice, list_transactions)" in out
    assert SECRET not in out and SCHEME not in out and PUBKEY not in out
    assert wallets and wallets[0].uri == NWC_URI and wallets[0].closed


def test_doctor_exit_codes_and_debug_report() -> None:
    code, out, _ = cli(["doctor", "--offline"], env={})
    assert code == 1 and "NWC_URI: missing" in out and "wallet: probe skipped (--offline)" in out
    code, out, _ = cli(["debug-report", "--offline"], env={})
    assert code == 0 and "OpenReceive debug-report" in out
    code, out, _ = cli(["doctor", "--offline"], env={"NWC_URI": "not-a-code"})
    assert (
        code == 1 and "not a valid NWC code" in out and "not-a-code" not in out.split("\n")[3][:8]
    )


def test_doctor_url_probe_reports_an_unreachable_app() -> None:
    code, out, _ = cli(
        ["doctor", "--offline", "--url", "http://127.0.0.1:9"], env={"NWC_URI": NWC_URI}
    )
    assert code == 1
    assert "routes: http://127.0.0.1:9/openreceive/__openreceive_doctor_probe unreachable" in out


# ---------------------------------------------------------- --app resolution

HOST_MODULE = """
from fastapi import FastAPI
from sqlalchemy import create_engine
from openreceive.fastapi import openreceive_lifespan, openreceive_router
from openreceive.server import Host
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider

engine = create_engine("sqlite:///{db}")
{migrate}
host = Host(amount_for=lambda reference: {{"sats": 1000}}, authorize=lambda ctx: True, on_paid=lambda s: None)
router = openreceive_router(
    host, engine=engine, nwc_client=FakeWallet(), price_provider=StaticPriceProvider(),
    swap_providers=[FakeSwapProvider()],
)
app = FastAPI(lifespan=openreceive_lifespan(host, engine=engine, lazy=True))
app.include_router(router, prefix="/openreceive")

def factory():
    return router.openreceive.app
"""


@pytest.fixture
def host_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db = tmp_path / "shop.sqlite3"
    (tmp_path / "shopmod.py").write_text(
        HOST_MODULE.format(db=db, migrate="SqlPaymentRepository(engine).create_tables()")
    )
    (tmp_path / "unmigrated.py").write_text(
        HOST_MODULE.format(db=tmp_path / "empty.sqlite3", migrate="")
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    for name in ("shopmod", "unmigrated"):
        sys.modules.pop(name, None)
    return tmp_path


def test_doctor_with_app_checks_tables_and_host(host_module: Path) -> None:
    env = {"NWC_URI": NWC_URI}
    for target in ("shopmod:app", "shopmod:router", "shopmod:factory"):
        code, out, err = cli(["doctor", "--offline", "--app", target], env=env)
        assert code == 0, target + out + err
        assert "database: openreceive_payments and openreceive_meta present" in out
        assert "host: amount_for, authorize and on_paid are set" in out

    code, out, _ = cli(["doctor", "--offline", "--app", "unmigrated:app"], env=env)
    assert code == 1 and "database:" in out and "present" not in out.split("database:")[1]

    code, out, _ = cli(["doctor", "--offline", "--app", "shopmod:host"], env=env)
    assert code == 1 and "app: --app shopmod:host is a Host, which has no database" in out

    code, _, err = cli(["doctor", "--offline", "--app", "shopmod"], env=env)
    assert code == 2 and "module:attr" in err


def test_doctor_db_url_checks_the_tables(host_module: Path) -> None:
    import importlib

    importlib.import_module("shopmod")  # creates and migrates shop.sqlite3
    code, out, _ = cli(
        ["doctor", "--offline", "--db", f"sqlite:///{host_module / 'shop.sqlite3'}"],
        env={"NWC_URI": NWC_URI},
    )
    assert code == 0 and "database: openreceive_payments and openreceive_meta present" in out


def test_reconcile_runs_one_pass(host_module: Path) -> None:
    code, out, err = cli(["reconcile", "--app", "shopmod:app"], env={})
    assert code == 0, err
    assert out == "openreceive reconcile: 0 pending attempt(s) checked (none)\n"
    code, _, err = cli(["reconcile"], env={})
    assert code == 2 and "needs --app" in err


def test_django_discovery_without_the_adapter_is_a_clear_error() -> None:
    # A subprocess: pytest-django has already configured Django in THIS process
    # (tests/django), and django.setup() ignores the env var once settings are
    # configured — so the "nonexistent settings" path can only be observed in a
    # fresh interpreter.
    completed = subprocess.run(
        [sys.executable, "-m", "openreceive.cli", "reconcile"],
        env={**os.environ, "DJANGO_SETTINGS_MODULE": "nonexistent.settings"},
        capture_output=True,
        text=True,
        check=False,
    )
    code, err = completed.returncode, completed.stderr
    assert code == 1, err
    assert "DJANGO_SETTINGS_MODULE is set" in err or "openreceive.django" in err


def test_help_exits_0() -> None:
    code, out, _ = cli(["--help"])
    assert code == 0 and "scaffold payments" in out
    assert os.environ.get("NWC_URI", "") not in out or not os.environ.get("NWC_URI")
