from __future__ import annotations

from django.apps import AppConfig


class OpenReceiveConfig(AppConfig):
    """`openreceive.django` in INSTALLED_APPS; the app label (and the migration
    namespace) is `openreceive`. Deliberately NO wallet preflight here:
    `ready()` runs for every management command, and a relay probe inside it
    would break `migrate` on a box with no relay access. The first request
    builds the service (openreceive.django.conf); `manage.py check --deploy`
    with `OPENRECEIVE_PREFLIGHT=1` is the deploy-time probe.

    `ready()` does install the DEBUG page filter that hides NWC_URI and
    LSC_URI_* (openreceive.django.debug), unless the project set its own
    DEFAULT_EXCEPTION_REPORTER_FILTER."""

    name = "openreceive.django"
    label = "openreceive"
    verbose_name = "OpenReceive"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Registers the openreceive.E001/E002/W001/W002/W003 system checks.
        from openreceive.django import checks  # noqa: F401
        from openreceive.django.debug import install_default_filter

        install_default_filter()
