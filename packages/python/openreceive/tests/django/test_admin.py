"""The ledger admin on a stock project. `startproject` installs
django.contrib.admin, whose autodiscover imports openreceive.django.admin
during django.setup(): a class that only type-checks there stops the whole app
from booting."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]

BOOT = """
import django
from django.conf import settings
from tests.django import settings as base

settings.configure(
    **{name: getattr(base, name) for name in dir(base) if name.isupper()},
)
settings.INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.messages",
    *base.INSTALLED_APPS,
]
django.setup()
from django.contrib import admin
from openreceive.django.models import OpenReceiveMeta, OpenReceivePayment

assert admin.site.is_registered(OpenReceivePayment)
assert admin.site.is_registered(OpenReceiveMeta)
print("admin registered")
"""


def test_a_project_with_django_admin_boots() -> None:
    result = subprocess.run(
        [sys.executable, "-c", BOOT],
        cwd=PACKAGE_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert "admin registered" in result.stdout
