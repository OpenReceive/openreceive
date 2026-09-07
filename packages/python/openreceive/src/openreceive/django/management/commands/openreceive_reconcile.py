"""`manage.py openreceive_reconcile` — one bounded reconciliation pass over the
pending attempts (the `openreceive:reconcile` rake task twin). Not needed in
normal operation: every OpenReceive request runs the durably gated
opportunistic pass. A one-shot primitive for operators and cron-minded hosts."""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand

from openreceive.django import conf


class Command(BaseCommand):
    help = "Run one OpenReceive reconciliation pass over pending payment attempts."

    def handle(self, *args: Any, **options: Any) -> None:
        checks = conf.get_app().reconcile()
        self.stdout.write(f"openreceive_reconcile checked {len(checks)} pending attempt(s)")
