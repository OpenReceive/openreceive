"""The prices went up so each button clears the swap providers' minimums. A
database that 0002 seeded keeps its old prices until the same idempotent
upsert from examples/buttons/shared/shop-catalog.json runs again."""

from __future__ import annotations

from typing import Any

from django.db import migrations

from buttonshop.shop import catalog


def reprice(apps: Any, schema_editor: Any) -> None:
    catalog.apply(apps.get_model("shop", "ShopProduct"))


class Migration(migrations.Migration):
    dependencies = [("shop", "0002_seed_catalog")]

    operations = [migrations.RunPython(reprice, migrations.RunPython.noop)]
