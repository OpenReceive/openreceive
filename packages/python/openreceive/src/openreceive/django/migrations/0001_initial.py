"""The two engine-owned tables, their indexes and CHECK constraints, and the
`schema_version` seed row. Twin of the Rails install generator's migration and
of `openreceive.storage.sql.ddl.payments_schema_sql`. Hosts apply it through
`manage.py migrate`; it never touches a host table.

MySQL note (plan PART 4): `CheckConstraint` is ignored below MySQL 8.0.16 and
`JSONField` needs MySQL >= 5.7.8 / MariaDB >= 10.2.7 — the repository enforces
the invariants in code regardless.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations, models

from openreceive.storage.repository import (
    ATTEMPT_STATUSES,
    PAYMENTS_SCHEMA_VERSION,
    SCHEMA_VERSION_KEY,
)


def seed_schema_version(apps: Any, schema_editor: Any) -> None:
    """Every migration path must record the installed schema generation: the
    newer-schema refusal only engages when the marker exists."""
    meta = apps.get_model("openreceive", "OpenReceiveMeta")
    meta.objects.using(schema_editor.connection.alias).get_or_create(
        key=SCHEMA_VERSION_KEY, defaults={"value": str(PAYMENTS_SCHEMA_VERSION), "rev": 0}
    )


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="OpenReceiveMeta",
            fields=[
                ("key", models.CharField(max_length=255, primary_key=True, serialize=False)),
                ("value", models.TextField()),
                ("rev", models.BigIntegerField(default=0)),
            ],
            options={"db_table": "openreceive_meta"},
        ),
        migrations.CreateModel(
            name="OpenReceivePayment",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("reference", models.CharField(max_length=255)),
                ("payment_hash", models.CharField(max_length=64, unique=True)),
                ("status", models.CharField(default="pending", max_length=32)),
                ("status_reason", models.CharField(blank=True, max_length=255, null=True)),
                ("paid_at", models.DateTimeField(blank=True, null=True)),
                ("expires_at", models.DateTimeField()),
                ("checkout_data", models.JSONField()),
                ("swap_data", models.JSONField(blank=True, null=True)),
                ("client_ip", models.CharField(blank=True, max_length=255, null=True)),
                ("inserted_at", models.DateTimeField()),
                ("created_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField()),
            ],
            options={
                "db_table": "openreceive_payments",
                "indexes": [
                    models.Index(
                        fields=["reference", "created_at"], name="or_payments_ref_created_idx"
                    ),
                    models.Index(
                        fields=["status", "created_at"], name="or_payments_status_created_idx"
                    ),
                    models.Index(
                        fields=["client_ip", "inserted_at"], name="or_payments_ip_inserted_idx"
                    ),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(status__in=list(ATTEMPT_STATUSES)),
                        name="openreceive_payments_status_check",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(payment_hash__regex="^[0-9a-f]{64}$"),
                        name="openreceive_payments_payment_hash_check",
                    ),
                ],
            },
        ),
        migrations.RunPython(seed_schema_version, migrations.RunPython.noop),
    ]
