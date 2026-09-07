"""The package's own Django test settings (pytest-django reads
DJANGO_SETTINGS_MODULE from pyproject.toml). SQLite on a temp FILE — not the
shared in-memory database — so the concurrency tests can open one connection
per thread with real file locking; PostgreSQL when OPENRECEIVE_TEST_PGSQL_URL
is set (the CI job's service)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

SECRET_KEY = "openreceive-django-tests-not-a-secret"
DEBUG = False
ALLOWED_HOSTS = ["*"]
USE_TZ = True
TIME_ZONE = "UTC"
ROOT_URLCONF = "tests.django.urls"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.sessions",
    "openreceive.django",
    "tests.django.testapp",
]

MIDDLEWARE = [
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]

_sqlite_dir = Path(tempfile.gettempdir()) / f"openreceive-django-tests-{os.getpid()}"
_sqlite_dir.mkdir(parents=True, exist_ok=True)

_pgsql_url = (os.environ.get("OPENRECEIVE_TEST_PGSQL_URL") or "").strip()
if _pgsql_url:
    _parsed = urlparse(_pgsql_url)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": _parsed.path.lstrip("/") or "openreceive",
            "USER": _parsed.username or "",
            "PASSWORD": _parsed.password or "",
            "HOST": _parsed.hostname or "127.0.0.1",
            "PORT": str(_parsed.port or 5432),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": str(_sqlite_dir / "openreceive.sqlite3"),
            # The quickstart's SQLite advice: IMMEDIATE transactions queue two
            # concurrent commits on the busy timeout instead of raising
            # "database is locked".
            "OPTIONS": {"transaction_mode": "IMMEDIATE", "timeout": 10},
            "TEST": {"NAME": str(_sqlite_dir / "openreceive-test.sqlite3")},
        }
    }

OPENRECEIVE = {
    "HOST": "tests.django.host.Host",
    "SERVICE": "tests.django.host.build_service",
    "PRICE_CURRENCIES": ["USD"],
    "RATE_LIMITING": False,
}
