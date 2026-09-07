"""The six buttons, from examples/buttons/shared/shop-catalog.json — the ONE
seed source of truth every stack reads. Idempotent by sku."""

from __future__ import annotations

from typing import Any

from django.db import migrations

from buttonshop.shop import catalog


def seed(apps: Any, schema_editor: Any) -> None:
    catalog.apply(apps.get_model("shop", "ShopProduct"))


class Migration(migrations.Migration):
    dependencies = [("shop", "0001_initial")]

    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
