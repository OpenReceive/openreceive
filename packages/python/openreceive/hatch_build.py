"""Hatchling build hook: carry the standalone checkout build into the wheel.

`openreceive.django` templates load `{% static "openreceive/openreceive-checkout.js" %}`
and its stylesheet; those files are the output of `npm run build:packages`
(tools/package/build-standalone-elements.mjs → packages/js/elements/dist/standalone/),
not Python source, so they are NOT committed under src/. This hook copies that
tree into `src/openreceive/django/static/openreceive/` whenever it exists next
to this package in the monorepo — for `uv build` (sdist and wheel) and for the
editable install `uv sync` performs — so the wheel carries the assets and their
MANIFEST.json. Outside the monorepo (a wheel built from the sdist) the copy is
already inside the sdist and nothing happens. With neither present the build
still succeeds and warns: the engine works without the static files; only the
packaged-static render path in the quickstart needs them.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

STANDALONE_SOURCE = Path("..", "..", "js", "elements", "dist", "standalone")
STATIC_TARGET = Path("src", "openreceive", "django", "static", "openreceive")


class StandaloneCheckoutHook(BuildHookInterface):  # type: ignore[type-arg]
    PLUGIN_NAME = "standalone-checkout"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        root = Path(self.root)
        source = (root / STANDALONE_SOURCE).resolve()
        target = root / STATIC_TARGET
        if (source / "MANIFEST.json").is_file():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target)
            return
        if (target / "MANIFEST.json").is_file():
            return
        self.app.display_warning(
            f"openreceive: {STATIC_TARGET} is empty — the standalone checkout build was not found at "
            f"{STANDALONE_SOURCE} (run `npm run build:packages` in the monorepo first). The wheel "
            "will ship without the packaged static checkout files."
        )
