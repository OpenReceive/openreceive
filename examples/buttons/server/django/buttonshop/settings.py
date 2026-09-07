"""Buy a Button on Django. The host: its routes, its models, its build.

Three environment variables shape a boot, none of them OpenReceive's:
  DATABASE_URL         postgres://… (compose). Unset → SQLite under
                       OPENRECEIVE_DEMO_DB (or examples/buttons/.data).
  DEMO_WALLET=testkit  the E2E harness switch: the wallet, the swap provider and
                       the price feed become in-memory fakes and /__testkit
                       comes alive. See buttonshop/openreceive_service.py.
  SECRET_KEY           signs the visitor cookie; fixed by default so a restart
                       does not log every visitor out.
OpenReceive's own secrets (NWC_URI, LSC_URI_*) are read by the engine from
os.environ and never appear here.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent.parent
# examples/buttons: the shared client, the seed catalog and the ONE copy of the artwork.
BUTTONS_ROOT = BASE_DIR.parent.parent
SHARED_DIR = BUTTONS_ROOT / "shared"
IMAGES_DIR = BUTTONS_ROOT / "images"
# The Vite production bundle, served by WhiteNoise in the container.
DIST_DIR = BASE_DIR / "dist"

SECRET_KEY = os.environ.get("SECRET_KEY") or "buy-a-button-django-demo-secret-key-change-me"
DEBUG = (os.environ.get("DJANGO_DEBUG") or "").strip().lower() in ("1", "true", "yes")
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "openreceive.django",
    "buttonshop.shop",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    # CSRF stays ON. The shop's own POST and the mounted OpenReceive routes both
    # carry the token: the SPA reads the `csrftoken` cookie into
    # <meta name="csrf-token"> and sends it as X-CSRFToken (src/client/csrf.ts).
    "django.middleware.csrf.CsrfViewMiddleware",
]

ROOT_URLCONF = "buttonshop.urls"
WSGI_APPLICATION = "buttonshop.wsgi.application"
TEMPLATES: list[dict[str, object]] = []

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
USE_I18N = False

# --------------------------------------------------------------- the database
#
# HOST-OWNED. Postgres in compose (DATABASE_URL), SQLite for a wallet-free
# local run and the E2E harness. The engine's two tables live in this same
# database; OpenReceive has no datastore of its own.
_database_url = (os.environ.get("DATABASE_URL") or "").strip()
if _database_url:
    _parsed = urlparse(_database_url)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": _parsed.path.lstrip("/"),
            "USER": _parsed.username or "",
            "PASSWORD": _parsed.password or "",
            "HOST": _parsed.hostname or "127.0.0.1",
            "PORT": str(_parsed.port or 5432),
            "CONN_MAX_AGE": 60,
        }
    }
else:
    _data_dir = Path(os.environ.get("OPENRECEIVE_DEMO_DB") or (BUTTONS_ROOT / ".data")).resolve()
    _data_dir.mkdir(parents=True, exist_ok=True)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": str(_data_dir / "buttons-django.sqlite3"),
            # IMMEDIATE transactions + a busy timeout: two concurrent commits
            # for one reference queue instead of raising "database is locked".
            "OPTIONS": {"transaction_mode": "IMMEDIATE", "timeout": 10},
        }
    }

# ------------------------------------------------------------------- OpenReceive
#
# The engine reads this dict; the three hooks live in buttonshop/openreceive_host.py
# and are THE ONLY BRIDGE to the shop's tables.
OPENRECEIVE = {
    "HOST": "buttonshop.openreceive_host.Host",
    # The testkit switch: fakes under DEMO_WALLET=testkit, the real NWC client
    # (from NWC_URI) otherwise.
    "SERVICE": "buttonshop.openreceive_service.build_service",
    "PRICE_CURRENCIES": ["USD"],
    # Cap invoice creation per client IP, counted from the engine-owned rows:
    # this is a public web shop and every payer arrives on their own address.
    # Behind a proxy, make REMOTE_ADDR the payer first (a trusted-proxy
    # middleware) or the cap counts the proxy.
    "RATE_LIMITING": True,
}

# ---------------------------------------------------------------------- static
#
# WhiteNoise serves the Vite build (dist/) from the URL root in the container:
# /assets/<hashed>.js, the provider images copied beside them, and nothing
# else. index.html is a VIEW (buttonshop.views.spa), never a static file, so a
# cached copy cannot leave browsers on a dead bundle after a deploy.
STATIC_URL = "/static/"
if DIST_DIR.is_dir():
    WHITENOISE_ROOT = str(DIST_DIR)
WHITENOISE_INDEX_FILE = False
WHITENOISE_MAX_AGE = 3600

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO").upper()},
    "loggers": {"django.request": {"level": "WARNING"}},
}
