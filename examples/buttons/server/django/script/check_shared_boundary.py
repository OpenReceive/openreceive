#!/usr/bin/env python
"""THE SHARED BOUNDARY, enforced (the Rails demo's check-shared-boundary.rb twin).

examples/buttons/shared/ is named so that a wrong import is visible in the diff:
  client/          React + Mantine + mobx-keystone — this stack's UI.
  client-vanilla/  the no-framework host ONLY.
  server-node/     SQLite and Express — the Node stacks ONLY.
Django has the ORM and its own views, so its client may import
shared/shop-types.ts, shared/http.ts, shared/bootstrap.ts,
shared/checkout-resume.ts, shared/shop.css and shared/client/**, and never
shared/server-node/** or shared/client-vanilla/**.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [*ROOT.glob("src/**/*.ts"), *ROOT.glob("src/**/*.tsx"), ROOT / "vite.config.ts"]
FORBIDDEN = ("server-node", "client-vanilla")

violations: list[str] = []
for path in SOURCES:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if "shared/" not in line:
            continue
        for directory in FORBIDDEN:
            if f"shared/{directory}/" in line:
                violations.append(f"{path.relative_to(ROOT)}:{number} imports shared/{directory}/")

if violations:
    print(
        "The Django demo may only import shared/shop-types.ts, shared/http.ts and shared/client/**:"
    )
    for violation in violations:
        print(f"- {violation}")
    sys.exit(1)

print(
    f"Shared-boundary check passed: {len(SOURCES)} client files, no shared/server-node or "
    "shared/client-vanilla imports."
)
