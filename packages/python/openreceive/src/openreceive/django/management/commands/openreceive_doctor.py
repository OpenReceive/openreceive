"""`manage.py openreceive_doctor` — Step 0 of the agent directions, as one
command: credentials (present/missing only — never a value), the wallet
probe, the payment tables, the mount, the host's placeholder hooks. Wraps
`openreceive.server.doctor.doctor_report`; exits 1 when anything failed."""

from __future__ import annotations

import os
import sys
from typing import Any

from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import BaseCommand, CommandParser
from django.urls import NoReverseMatch, reverse

from openreceive.django import conf
from openreceive.django.repository import DjangoPaymentRepository
from openreceive.server import Host, doctor_report
from openreceive.server.service import sanitize_failure_message


def mount_line() -> str:
    try:
        rates = reverse("openreceive:rates")
    except NoReverseMatch:
        return (
            "urls: NOT mounted — add path('openreceive/', include('openreceive.django.urls')) "
            "to your urlpatterns"
        )
    return f"urls: mounted at {rates[: -len('/rates')] or '/'}"


class Command(BaseCommand):
    help = (
        "Report OpenReceive's install state: credentials (present/missing), wallet, tables, hooks."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--offline", action="store_true", help="Skip the relay probe (no network)"
        )

    def handle(self, *args: Any, **options: Any) -> None:
        host: Host | None = None
        host_error: str | None = None
        try:
            config = conf.read_settings()
            host = conf.load_host(config)
            repository: Any = DjangoPaymentRepository(
                using=str(config.get("DATABASE") or "default")
            )
        except ImproperlyConfigured as error:
            host_error = str(error)
            repository = DjangoPaymentRepository()
        report = doctor_report(
            os.environ,
            host=host,
            repository=repository,
            offline=bool(options["offline"]),
            command="openreceive_doctor",
        )
        lines = list(report.lines)
        ok = report.ok
        if host_error is not None:
            lines.append(f"host: {sanitize_failure_message(ImproperlyConfigured(host_error))}")
            ok = False
        lines.append(mount_line())
        self.stdout.write("\n".join(lines))
        if not ok:
            sys.exit(1)
