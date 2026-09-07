"""The management commands: install writes the host module and prints the
wiring; doctor never prints a secret; reconcile and notifications wrap the
engine's own primitives."""

from __future__ import annotations

import threading
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from django.core.management import call_command

from openreceive.django import conf
from openreceive.django.management.commands import openreceive_notifications as worker_command
from openreceive.server import OpenReceiveApp
from openreceive.server.notifications import RECONCILE_INTERVAL_ENV
from tests.django import host as test_host

pytestmark = pytest.mark.django_db(transaction=True)


def test_install_writes_the_host_module_and_prints_the_wiring(tmp_path: Path) -> None:
    out = StringIO()
    call_command("openreceive_install", "testapp", path=str(tmp_path), stdout=out)
    written = (tmp_path / "openreceive_host.py").read_text()
    assert "class Host:" in written
    assert "authorize = staticmethod(ALLOW_ALL_AUTHORIZE)" in written
    assert "on_paid = staticmethod(LOGGING_ON_PAID)" in written
    assert "def amount_for(self, reference: str)" in written
    assert "def after_paid" in written
    # The shared fulfillment note, with the table name filled in.
    assert "Fulfilling exactly once" in written and "`openreceive_payments` rows" in written
    assert "WHERE id = :reference" in written
    assert not any(line.endswith(" ") for line in written.splitlines())
    # It compiles, and its placeholders are the engine's own objects.
    namespace: dict[str, Any] = {}
    exec(compile(written, "openreceive_host.py", "exec"), namespace)
    host = namespace["Host"]()
    from openreceive.server import ALLOW_ALL_AUTHORIZE, LOGGING_ON_PAID

    assert host.authorize is ALLOW_ALL_AUTHORIZE and host.on_paid is LOGGING_ON_PAID
    with pytest.raises(NotImplementedError, match="amount_for"):
        host.amount_for("order-1")
    printed = out.getvalue()
    assert 'INSTALLED_APPS += ["openreceive.django"]' in printed
    assert '"HOST": "testapp.openreceive_host.Host"' in printed
    assert 'path("openreceive/", include("openreceive.django.urls"))' in printed
    assert "manage.py migrate" in printed
    # Refuses to overwrite without --force.
    with pytest.raises(Exception, match="already exists"):
        call_command("openreceive_install", "testapp", path=str(tmp_path), stdout=StringIO())
    call_command(
        "openreceive_install", "testapp", path=str(tmp_path), force=True, stdout=StringIO()
    )


def test_install_refuses_an_unknown_app() -> None:
    with pytest.raises(Exception, match="No installed app"):
        call_command("openreceive_install", "nope", stdout=StringIO())


def test_doctor_never_prints_a_secret(monkeypatch: pytest.MonkeyPatch, app: OpenReceiveApp) -> None:
    secret = "cd" * 32
    # Assembled at runtime: no NWC-URI-shaped literal may live in a fixture.
    nwc = (
        "nostr+" + "walletconnect://" + "ab" * 32 + "?relay=wss%3A%2F%2Frelay.test&secret=" + secret
    )
    monkeypatch.setenv("NWC_URI", nwc)
    monkeypatch.delenv("LSC_URI_PRIMARY", raising=False)
    monkeypatch.delenv("LSC_URI_BACKUP", raising=False)
    out = StringIO()
    call_command("openreceive_doctor", offline=True, stdout=out)
    text = out.getvalue()
    assert secret not in text and "walletconnect" not in text
    assert "NWC_URI: present-redacted" in text
    assert "wallet: probe skipped (--offline)" in text
    assert "database: openreceive_payments and openreceive_meta present" in text
    assert "host: amount_for, authorize and on_paid are set" in text
    assert "urls: mounted at /openreceive" in text


def test_doctor_exits_nonzero_when_nwc_uri_is_missing(
    monkeypatch: pytest.MonkeyPatch, app: OpenReceiveApp
) -> None:
    monkeypatch.delenv("NWC_URI", raising=False)
    out = StringIO()
    with pytest.raises(SystemExit) as exit_info:
        call_command("openreceive_doctor", offline=True, stdout=out)
    assert exit_info.value.code == 1
    assert "NWC_URI: missing" in out.getvalue()


def test_reconcile_runs_one_pass(app: OpenReceiveApp, state: test_host.State) -> None:
    out = StringIO()
    call_command("openreceive_reconcile", stdout=out)
    assert "checked 0 pending attempt(s)" in out.getvalue()


def test_notifications_wraps_the_engine_worker(
    monkeypatch: pytest.MonkeyPatch, app: OpenReceiveApp
) -> None:
    captured: dict[str, Any] = {}

    def fake_worker(reconciler: Any, *, interval_seconds: int, stop: threading.Event) -> None:
        captured["reconciler"] = reconciler
        captured["interval"] = interval_seconds
        captured["stop"] = stop

    monkeypatch.setattr(worker_command, "run_notifications_worker", fake_worker)
    monkeypatch.setenv(RECONCILE_INTERVAL_ENV, "7")
    out = StringIO()
    call_command("openreceive_notifications", stdout=out)
    assert captured["reconciler"] is conf.get_app().reconciler
    assert captured["interval"] == 7 and isinstance(captured["stop"], threading.Event)
    assert "reconciling every 7s" in out.getvalue()
    monkeypatch.setenv(RECONCILE_INTERVAL_ENV, "0")
    with pytest.raises(Exception, match="positive integer"):
        call_command("openreceive_notifications", stdout=StringIO())
