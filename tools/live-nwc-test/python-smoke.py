#!/usr/bin/env python3
"""Optional Python live-wallet smoke — the twin of ruby-smoke.rb. Reads NWC_URI
from the environment or the root .env, skips clearly when unset, redacts the
connection string, runs the receive-only preflight over the relay, and creates
an invoice only with OPENRECEIVE_LIVE_CREATE_INVOICE=1 (then proves settlement
through the PRODUCTION reconcile path with OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1).
Never prints the URI. Run through `npm run test:live:python:nwc`."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "python" / "openreceive" / "src"))

from openreceive.nwc.receive_client import NwcReceiveClient  # noqa: E402
from openreceive.nwc.uri import parse_uri  # noqa: E402
from openreceive.server.service import Service  # noqa: E402

DEFAULT_EXPECTED_CAPABILITIES = ROOT / "tools" / "live-nwc-test" / "expected_capabilities.json"
SECRET_NAMES = ("NWC_URI", "LSC_URI_PRIMARY", "LSC_URI_BACKUP")


def load_root_dotenv() -> None:
    """Mirrors the JS twin's env loading: `export NAME=value` lines and quoted values."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if entry.startswith("export "):
            entry = entry[len("export ") :].strip()
        name, separator, value = entry.partition("=")
        if not separator or name not in SECRET_NAMES or name in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[name] = value


def read_expected_capabilities() -> dict[str, Any]:
    path = Path(
        os.environ.get("OPENRECEIVE_EXPECTED_CAPABILITIES") or DEFAULT_EXPECTED_CAPABILITIES
    )
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def check_live_payment(service: Service, invoice: dict[str, Any]) -> dict[str, Any]:
    checked = service.reconcile_payments(
        {
            "attempts": [
                {"payment_hash": invoice["payment_hash"], "created_at": invoice["created_at"]}
            ]
        }
    )
    # A truncated walk proves nothing; report it as still pending and scan again.
    return (
        checked[0]
        if checked
        else {"payment_hash": invoice["payment_hash"], "status": "scan_incomplete"}
    )


def main() -> int:
    load_root_dotenv()
    nwc = (os.environ.get("NWC_URI") or "").strip()
    if not nwc:
        print("NWC_URI is not set; skipping Python live NWC smoke test.")
        return 0
    parsed = parse_uri(nwc)
    expected = read_expected_capabilities()
    print(f"Python NWC URI parsed for wallet profile: {expected['wallet_profile']}")
    print(f"Wallet pubkey prefix: {parsed.wallet_pubkey[:8]}...")
    print(f"Relay count: {len(parsed.relays)}")
    print(f"Connection: {parsed.redacted}")
    print(f"Expected methods: {', '.join(expected['required_methods'])}")

    client = NwcReceiveClient(nwc)
    try:
        # The service constructor IS the receive-only preflight (fail closed on a
        # spend-capable code unless the operator overrides, as in every engine).
        service = Service(
            client,
            price_provider=False,
            swap_providers=[],
            allow_spend_capable_wallet=(os.environ.get("OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC") or "")
            .strip()
            .lower()
            in ("1", "true", "yes"),
        )
        methods = list(client.preflight().get("methods") or [])
        missing = [method for method in expected["required_methods"] if method not in methods]
        if missing:
            print(
                f"Python NWC preflight missing required methods: {', '.join(missing)}",
                file=sys.stderr,
            )
            return 1
        print("Python NWC preflight ready: true")
        print(f"Advertised method count: {len(methods)}")

        if os.environ.get("OPENRECEIVE_LIVE_CREATE_INVOICE") != "1":
            print("OPENRECEIVE_LIVE_CREATE_INVOICE is not 1; skipping Python invoice creation.")
            return 0

        invoice = client.make_invoice(
            {
                "amount_msats": int(os.environ.get("OPENRECEIVE_LIVE_AMOUNT_MSATS", "1000")),
                "description": "OpenReceive Python live smoke",
            }
        )
        print(f"Created Python live invoice payment hash prefix: {invoice['payment_hash'][:8]}...")
        check = check_live_payment(service, invoice)
        print(f"Initial Python payment status via production reconcile: {check['status']}")
        if os.environ.get("OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT") != "1":
            print(
                "Set OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1 to poll the production reconcile until settlement."
            )
            return 0
        expires_at = invoice.get("expires_at") or (invoice["created_at"] + 900)
        status = check["status"]
        while status not in ("settled", "expired", "failed"):
            if time.time() > expires_at:
                print("Final Python outcome: expired (local_expiry_elapsed)")
                return 1
            time.sleep(2)
            status = check_live_payment(service, invoice)["status"]
            print(f"Python workflow transition: {status}")
        print(f"Final Python outcome: {status}")
        return 0 if status == "settled" else 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
