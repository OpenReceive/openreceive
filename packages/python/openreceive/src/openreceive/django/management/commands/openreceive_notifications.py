"""`manage.py openreceive_notifications` — the one OPTIONAL long-lived worker:
listen for NWC-02 `payment_received` notifications AND run the periodic
reconcile pass in the same process (the safety net for notifications missed
while it was down). By default no worker is needed at all — every OpenReceive
request runs the durably gated opportunistic reconcile. Run this only when
settlement should land the moment the wallet reports payment_received.
`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS` (default 15) sets the
periodic pass. Twin of the `openreceive:notifications` rake task."""

from __future__ import annotations

import os
import signal
import threading
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from openreceive.django import conf
from openreceive.server.errors import ConfigurationError
from openreceive.server.notifications import (
    DEFAULT_RECONCILE_INTERVAL_SECONDS,
    RECONCILE_INTERVAL_ENV,
    run_notifications_worker,
)


def reconcile_interval_seconds() -> int:
    raw = (os.environ.get(RECONCILE_INTERVAL_ENV) or "").strip()
    if not raw:
        return DEFAULT_RECONCILE_INTERVAL_SECONDS
    value = int(raw)
    if value <= 0:
        raise CommandError(f"{RECONCILE_INTERVAL_ENV} must be a positive integer (got {raw}).")
    return value


class Command(BaseCommand):
    help = (
        "Optional worker: listen for NWC-02 payment_received notifications and reconcile "
        "periodically (long-running)."
    )

    def handle(self, *args: Any, **options: Any) -> None:
        interval = reconcile_interval_seconds()
        app = conf.get_app()
        stop = threading.Event()

        def request_stop(*_signal: Any) -> None:
            stop.set()

        for name in ("SIGTERM", "SIGINT"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), request_stop)
        self.stdout.write(
            f"openreceive_notifications listening for NWC-02 payment_received and reconciling "
            f"every {interval}s. The periodic pass covers notifications missed while this worker was down."
        )
        try:
            run_notifications_worker(app.reconciler, interval_seconds=interval, stop=stop)
        except ConfigurationError as error:
            raise CommandError(str(error))
