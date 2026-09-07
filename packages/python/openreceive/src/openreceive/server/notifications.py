"""The OPTIONAL long-lived worker: listen for NWC-02 `payment_received`
notifications AND run the periodic reconcile pass in the same process — the
safety net for notifications missed while the worker was down. The web
process never does this; its default is the request-path opportunistic
reconcile. Every pass claims the same durable gate, so running both never
double-scans the wallet. Twin of the Rails `openreceive:notifications` task."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from openreceive.server.errors import ConfigurationError
from openreceive.server.reconcile import Reconciler, notifications_retry_delay
from openreceive.server.service import sanitize_failure_message

log = logging.getLogger("openreceive")

DEFAULT_RECONCILE_INTERVAL_SECONDS = 15
RECONCILE_INTERVAL_ENV = "OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS"


def run_notifications_worker(
    reconciler: Reconciler,
    *,
    interval_seconds: int = DEFAULT_RECONCILE_INTERVAL_SECONDS,
    stop: threading.Event | None = None,
    sleep: Callable[[float], None] = time.sleep,
    overlap_seconds: int = 60,
) -> None:
    """Blocks until `stop` is set. Raises ConfigurationError when the wallet
    client cannot notify (no `subscribe_notifications`): the periodic pass
    alone would be a silent downgrade the operator asked this worker to exceed."""
    client = reconciler.service.nwc_client
    subscribe = getattr(client, "subscribe_notifications", None)
    if not callable(subscribe):
        raise ConfigurationError(
            "The configured NWC client does not support NWC-02 notifications (no subscribe_notifications method). "
            "Notifications are optional; keep polling with `openreceive reconcile`."
        )
    stop = stop or threading.Event()
    log.info(
        "openreceive notifications: listening for NWC-02 payment_received and reconciling every %ds. "
        "The periodic pass covers notifications missed while this worker was down.",
        interval_seconds,
    )

    def periodic() -> None:
        while not stop.is_set():
            try:
                reconciler.reconcile(overlap_seconds=overlap_seconds)
            except Exception as error:
                log.warning(
                    "openreceive notifications periodic reconcile failed (will retry): %s",
                    sanitize_failure_message(error),
                )
            stop.wait(interval_seconds)

    thread = threading.Thread(target=periodic, name="openreceive-reconcile", daemon=True)
    thread.start()

    def handler(notification: dict[str, Any]) -> None:
        try:
            reconciler.handle_notification(notification, overlap_seconds=overlap_seconds)
        except Exception as error:
            log.warning(
                "openreceive notifications handler failed: %s", sanitize_failure_message(error)
            )

    backoff: int | None = None
    try:
        while not stop.is_set():
            subscribed_at = time.monotonic()
            failure: BaseException | None = None
            try:
                subscribe(handler, stop=stop)
            except Exception as error:
                failure = error
            if stop.is_set():
                break
            backoff = notifications_retry_delay(backoff, time.monotonic() - subscribed_at)
            if failure is None:
                log.warning(
                    "openreceive notifications subscription ended; retrying in %ds", backoff
                )
            else:
                log.warning(
                    "openreceive notifications error: %s; retrying in %ds (the periodic reconcile pass still covers settlements)",
                    sanitize_failure_message(failure),
                    backoff,
                )
            if stop.wait(backoff):
                break
            sleep(0)
    finally:
        stop.set()
        thread.join(timeout=interval_seconds + 1)
