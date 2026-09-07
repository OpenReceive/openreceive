"""The shipped migration is the whole schema: it applies on sqlite (and on
Postgres when OPENRECEIVE_TEST_PGSQL_URL is set), seeds `schema_version`, and
the models it creates match it exactly (`makemigrations --check`)."""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from openreceive.django.models import OpenReceiveMeta, OpenReceivePayment
from openreceive.storage.repository import PAYMENTS_SCHEMA_VERSION, SCHEMA_VERSION_KEY

pytestmark = pytest.mark.django_db(transaction=True)


def test_migration_created_both_tables_and_seeded_the_schema_version() -> None:
    # Unapply and re-apply on the live test database: the transactional
    # fixture flushes seed rows between tests, and this is also the migration
    # applying against tables that already existed once.
    call_command("migrate", "openreceive", "zero", verbosity=0)
    assert "openreceive_meta" not in set(connection.introspection.table_names())
    call_command("migrate", "openreceive", verbosity=0)
    tables = set(connection.introspection.table_names())
    assert {"openreceive_payments", "openreceive_meta"} <= tables
    marker = OpenReceiveMeta.objects.get(key=SCHEMA_VERSION_KEY)
    assert marker.value == str(PAYMENTS_SCHEMA_VERSION) and marker.rev == 0


def test_models_and_migration_agree() -> None:
    out = StringIO()
    call_command("makemigrations", "openreceive", check=True, dry_run=True, stdout=out)
    assert "No changes detected" in out.getvalue()


def test_check_constraints_are_enforced_by_the_database() -> None:
    stamp = timezone.now()
    row = {
        "reference": "ord-1",
        "payment_hash": "a" * 64,
        "expires_at": stamp,
        "checkout_data": {},
        "inserted_at": stamp,
        "created_at": stamp,
        "updated_at": stamp,
    }
    with pytest.raises(IntegrityError), transaction.atomic():
        OpenReceivePayment.objects.create(**{**row, "status": "bogus"})
    with pytest.raises(IntegrityError), transaction.atomic():
        OpenReceivePayment.objects.create(**{**row, "payment_hash": "A" * 64})
    created = OpenReceivePayment.objects.create(**row)
    assert "swap_data" not in repr(created) and created.status == "pending"
