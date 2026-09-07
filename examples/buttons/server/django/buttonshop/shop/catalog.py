"""The six buttons, from the ONE catalog file every stack's data migration
reads: examples/buttons/shared/shop-catalog.json. Idempotent by sku, so the
data migration and a re-seed can both run it."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CATALOG_PATH = Path(__file__).resolve().parents[4] / "shared" / "shop-catalog.json"


def entries() -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return data


def apply(model: Any) -> int:
    """`model` is passed in so the data migration hands over its own
    migration-local class rather than the app's ShopProduct."""
    for entry in entries():
        model.objects.update_or_create(
            sku=entry["sku"],
            defaults={
                "name": entry["name"],
                "price_cents": entry["price_cents"],
                "position": entry["position"],
                "image_name": entry.get("image_name") or f"openreceive-{entry['sku']}-button.webp",
                "active": True,
            },
        )
    return len(entries())
