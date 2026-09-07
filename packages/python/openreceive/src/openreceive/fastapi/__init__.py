"""The FastAPI binding: `openreceive_router` mounts every OpenReceive route
through the framework-free engine, `openreceive_lifespan` runs the
fail-closed wallet preflight at startup. Requires the `fastapi` extra
(`pip install "openreceive[fastapi]"`)."""

from openreceive.fastapi.binding import OpenReceiveBinding
from openreceive.fastapi.lifespan import openreceive_lifespan
from openreceive.fastapi.router import openreceive_router

__all__ = ["OpenReceiveBinding", "openreceive_lifespan", "openreceive_router"]
