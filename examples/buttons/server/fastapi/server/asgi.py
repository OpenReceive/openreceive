"""The ASGI entry point uvicorn imports (`server.asgi:app`). Kept apart from
`main.py` so importing the factory — the tests, the CLI's `--app` — builds
nothing until asked."""

from .main import create_app

app = create_app()
