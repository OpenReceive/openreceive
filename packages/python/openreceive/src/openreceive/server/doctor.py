"""`openreceive doctor`: validate server configuration — NWC_URI (presence and
parse only, never the value), LSC connections, a receive-only wallet probe
over the relay, the payment tables, and the host's placeholder hooks. The
report is a list of lines plus an `ok` verdict; a probe that fails is
REPORTED, never raised, because a doctor that dies at line six tells the
operator less than one that finishes. Twin of the JS CLI `doctor` and the
Rails `openreceive:doctor` task."""

from __future__ import annotations

import platform
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from openreceive._version import __version__
from openreceive.nwc import info as wallet_info
from openreceive.nwc.uri import NWC_CODE_HELP_URL, NwcUriParseError, parse_uri
from openreceive.server.hosts import Host
from openreceive.server.service import redact_secrets
from openreceive.swap import lsc_uri

WALLET_PROBE_TIMEOUT_SECONDS = 10.0
SPEND_OVERRIDE_TRUE = ("1", "true", "yes")


@dataclass
class DoctorReport:
    ok: bool
    lines: list[str] = field(default_factory=list)

    def text(self) -> str:
        return "\n".join(self.lines)


def doctor_report(
    env: Mapping[str, str],
    *,
    host: Host | None = None,
    repository: Any | None = None,
    wallet_client_factory: Callable[[str], Any] | None = None,
    offline: bool = False,
    command: str = "doctor",
) -> DoctorReport:
    """`wallet_client_factory(nwc_uri)` builds the object whose `preflight()`
    answers the probe (default: the production NwcReceiveClient). `repository`
    is probed for `assert_supported_schema()` when given."""
    nwc = (env.get("NWC_URI") or "").strip()
    nwc_error: str | None = None
    if nwc:
        try:
            parse_uri(nwc)
        except NwcUriParseError as error:
            nwc_error = f"NWC_URI is set, but it is not a valid NWC code. Reason: {error} Get a receive-only NWC code here: {NWC_CODE_HELP_URL}"
    lsc_line: str
    lsc_failed = False
    try:
        lsc_line = str(len(lsc_uri.read_environment(env)))
    except lsc_uri.LscUriError as error:
        lsc_line = redact_secrets(str(error))
        lsc_failed = True

    lines = [
        f"OpenReceive {command} (openreceive {__version__})",
        f"python: {platform.python_version()}",
        "storage: payment-attempt rows live in the host database (no separate store)",
        f"NWC_URI: {nwc_error or ('present-redacted' if nwc else 'missing')}",
        f"LSC_URI connections: {lsc_line}",
    ]
    failed = nwc_error is not None or not nwc or lsc_failed

    if nwc and nwc_error is None and not offline:
        probe = probe_wallet(nwc, env, wallet_client_factory)
        failed = failed or not probe.ok
        lines.extend(probe.lines)
    elif offline:
        lines.append("wallet: probe skipped (--offline)")
    else:
        lines.append("wallet: probe skipped (no parseable NWC_URI to probe)")

    if repository is None:
        lines.append(
            "database: skipped — pass a repository (or --app) to check the payment tables exist"
        )
    else:
        try:
            checker = getattr(repository, "assert_supported_schema", None)
            if callable(checker):
                checker()
            lines.append("database: openreceive_payments and openreceive_meta present")
        except Exception as error:
            failed = True
            lines.append(f"database: {redact_secrets(str(error))}")

    if host is not None:
        warnings = host.placeholder_warnings()
        lines.extend(f"host: {warning}" for warning in warnings)
        if not warnings:
            lines.append("host: amount_for, authorize and on_paid are set")

    return DoctorReport(ok=not failed, lines=lines)


def probe_wallet(
    nwc: str, env: Mapping[str, str], factory: Callable[[str], Any] | None
) -> DoctorReport:
    """Connect to the relay and prove the code is receive-only, exactly as boot
    preflight would."""
    allow_spend = (
        env.get("OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC") or ""
    ).strip().lower() in SPEND_OVERRIDE_TRUE
    client: Any = None
    try:
        if factory is None:
            from openreceive.nwc.receive_client import NwcReceiveClient

            client = NwcReceiveClient(nwc, deadline_seconds=WALLET_PROBE_TIMEOUT_SECONDS)
        else:
            client = factory(nwc)
        summary = wallet_info.summarize(client.preflight())
        if not summary["receive_checkout_ready"]:
            return DoctorReport(
                False,
                [
                    "wallet: reachable but NOT receive-ready (missing make_invoice or list_transactions)"
                ],
            )
        if summary["spend_capability_advertised"]:
            verdict = "override active" if allow_spend else "refused at boot"
            return DoctorReport(
                False,
                [
                    f"wallet: reachable but SPEND-CAPABLE ({verdict}). A leaked code can drain this wallet — mint a receive-only code: {NWC_CODE_HELP_URL}",
                    *(f"wallet: {warning}" for warning in summary["warnings"]),
                ],
            )
        return DoctorReport(
            True, [f"wallet: reachable, receive-only ({', '.join(summary['methods'])})"]
        )
    except Exception as error:
        return DoctorReport(
            False, [f"wallet: {redact_secrets(f'{type(error).__name__}: {error}')}"]
        )
    finally:
        closer = getattr(client, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass
