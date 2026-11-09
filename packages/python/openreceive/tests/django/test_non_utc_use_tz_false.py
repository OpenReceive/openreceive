"""A Django project with USE_TZ = False on a database that is not UTC.

Django rewrites the connection's time zone from its settings, so this runs in
its own process: `TIME_ZONE = "Asia/Tokyo"` with `USE_TZ = False` makes every
connection session-local to Tokyo, the combination where the engine's naive-UTC
`to_datetime` could be read back nine hours off. Runs only against a real
PostgreSQL (OPENRECEIVE_TEST_PGSQL_URL); tools/ci/deployment-edge-tests.sh
also runs the rest of tests/django against a server started in that zone."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from urllib.parse import urlparse

import pytest

URL = (os.environ.get("OPENRECEIVE_TEST_PGSQL_URL") or "").strip()

pytestmark = pytest.mark.skipif(not URL, reason="needs a real PostgreSQL test database")


def test_use_tz_false_round_trips_expiry_and_paid_at() -> None:
    parsed = urlparse(URL)
    name = f"edge_django_{os.getpid()}"
    script = textwrap.dedent(
        f"""
        import os, sys
        import django
        from django.conf import settings

        settings.configure(
            USE_TZ=False,
            TIME_ZONE="Asia/Tokyo",
            INSTALLED_APPS=["openreceive.django"],
            DATABASES={{
                "default": {{
                    "ENGINE": "django.db.backends.postgresql",
                    "NAME": {name!r},
                    "USER": {parsed.username!r},
                    "PASSWORD": {parsed.password!r},
                    "HOST": {parsed.hostname!r},
                    "PORT": {str(parsed.port or 5432)!r},
                }}
            }},
            DEFAULT_AUTO_FIELD="django.db.models.BigAutoField",
        )
        django.setup()

        from django.core.management import call_command
        from django.db import connection

        call_command("migrate", "openreceive", verbosity=0, interactive=False)

        from openreceive.django.repository import DjangoPaymentRepository
        from openreceive.storage import PaymentInsert, SettlementRecord

        NOW = 1_794_210_000
        repository = DjangoPaymentRepository(clock=lambda: NOW)
        hash_ = "1" * 64
        checkout = {{
            "reference": "ord",
            "payment_hash": hash_,
            "bolt11": "lnbcfixture",
            "amount_msats": 1000,
            "created_at": NOW,
            "expires_at": NOW + 600,
            "fiat_quote": None,
        }}
        record = repository.commit_attempt(PaymentInsert("ord", hash_, checkout, client_ip="203.0.113.3"))
        assert (record.created_at, record.expires_at) == (NOW, NOW + 600), record

        with connection.cursor() as cursor:
            cursor.execute("SHOW TimeZone")
            zone = cursor.fetchone()[0]
        assert zone == "Asia/Tokyo", zone

        record = repository.find_by_payment_hash(hash_)
        assert (record.created_at, record.expires_at) == (NOW, NOW + 600), record
        assert repository.count_attempts_from_ip("203.0.113.3", NOW - 1) == 1
        assert repository.count_attempts_from_ip("203.0.113.3", NOW + 1) == 0
        assert [a.expires_at for a in repository.list_reconcilable_attempts()] == [NOW + 600]

        repository.record_settlement(SettlementRecord(hash_, NOW + 5), lambda settlement: None)
        record = repository.find_by_payment_hash(hash_)
        assert record.paid_at == NOW + 5 and record.status == "settled", record

        print("ok")
        """
    )
    admin = URL.replace("postgresql+psycopg://", "postgresql://")
    import psycopg

    with psycopg.connect(admin, autocommit=True) as connection:
        connection.execute(f"CREATE DATABASE {name}")
    try:
        environment = {**os.environ, "DJANGO_SETTINGS_MODULE": "", "TZ": "America/New_York"}
        result = subprocess.run(
            [sys.executable, "-c", script],
            env=environment,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().endswith("ok"), result.stdout
    finally:
        with psycopg.connect(admin, autocommit=True) as connection:
            connection.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
