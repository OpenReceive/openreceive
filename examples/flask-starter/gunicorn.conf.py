"""gunicorn loads this file from the working directory by itself."""


def post_worker_init(worker):
    """The receive-only wallet check: a missing or spend-capable code raises
    here, the worker never boots, and gunicorn stops instead of failing the
    first payer."""
    from app import openreceive

    openreceive.start()
