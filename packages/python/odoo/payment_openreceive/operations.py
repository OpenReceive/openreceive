"""What the provider form and the `odoo openreceive` command share: saving the
codes, the doctor, and a test invoice. Codes never reach a log line, a
message or the screen: only "set" or "not set"."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from odoo.exceptions import UserError

import openreceive
from openreceive.server import HttpRequest
from openreceive.server.doctor import doctor_report, probe_wallet
from openreceive.server.service import redact_secrets, sanitize_failure_message
from openreceive.swap import lsc_uri

from . import const, runtime
from .repository import OdooPaymentRepository

# Tests answer the wallet probe without a relay: callable(nwc_uri) -> client.
WALLET_CLIENT_FACTORY: Callable[[str], Any] | None = None

TEST_PARTNER_EMAIL = "openreceive-test@example.invalid"
ASSET_DIR = Path(__file__).resolve().parent / "static" / "lib" / "openreceive"


def module_version(env: Any) -> str:
    module = env["ir.module.module"].sudo().search([("name", "=", "payment_openreceive")], limit=1)
    version = module.installed_version or module.latest_version or ""
    # Odoo shows the version under its own series, e.g. 20.0.0.4.30.
    parts = str(version).split(".")
    return ".".join(parts[2:]) if len(parts) > 3 else str(version)


def providers(env: Any) -> Any:
    return (
        env["payment.provider"]
        .sudo()
        .with_context(active_test=False)
        .search([("code", "=", const.CODE)])
    )


def payment_methods(env: Any) -> Any:
    return (
        env["payment.method"]
        .sudo()
        .with_context(active_test=False)
        .search([("code", "=", const.PAYMENT_METHOD_CODE)])
    )


# ----------------------------------------------------------- configure


def save_wallet_code(env: Any, uri: str) -> str:
    """Ask the wallet first; save the code only when it answers as a wallet
    that can make invoices and cannot spend."""
    uri = (uri or "").strip()
    if not uri:
        raise UserError("Paste a receive-only NWC code.")
    probe = probe_wallet(uri, runtime.engine_env({}), WALLET_CLIENT_FACTORY)
    if not probe.ok:
        lines = " ".join(redact_secrets(line) for line in probe.lines)
        raise UserError(
            f"The wallet code was not saved. {lines} Use a receive-only code: {const.WALLET_HELP_URL}"
        )
    runtime.write_code(env.cr, const.NWC_KEY, uri)
    return probe.lines[-1] if probe.lines else "wallet: reachable, receive-only"


def save_swap_code(env: Any, key: str, uri: str) -> str:
    uri = (uri or "").strip()
    if key not in (const.LSC_PRIMARY_KEY, const.LSC_BACKUP_KEY):
        raise ValueError(key)
    if not uri:
        runtime.write_code(env.cr, key, None)
        rename_payment_method(env)
        return f"{const.CODE_ENV_NAMES[key]}: removed"
    try:
        lsc_uri.parse(uri)
    except lsc_uri.LscUriError as error:
        raise UserError(
            f"The swap provider code was not saved: {redact_secrets(str(error))}"
        ) from None
    runtime.write_code(env.cr, key, uri)
    rename_payment_method(env)
    return f"{const.CODE_ENV_NAMES[key]}: saved"


def rename_payment_method(env: Any) -> None:
    """The default name says what buyers can pay with: "Bitcoin & stablecoins"
    with a swap provider, "Bitcoin Lightning" without. A name the shop chose
    itself stays."""
    codes = runtime.read_codes(env.cr)
    swaps = bool(codes.get(const.LSC_PRIMARY_KEY) or codes.get(const.LSC_BACKUP_KEY))
    wanted = const.PAYMENT_METHOD_SWAP_NAME if swaps else const.PAYMENT_METHOD_NAME
    defaults = (const.PAYMENT_METHOD_NAME, const.PAYMENT_METHOD_SWAP_NAME)
    for method in payment_methods(env):
        if method.name in defaults and method.name != wanted:
            method.name = wanted


def is_on(provider: Any) -> bool:
    """Whether buyers can see the provider: Odoo 19 has a state field; Odoo 20
    has live mode and publishing instead."""
    if "state" in provider._fields:
        return provider.state != "disabled"
    return bool(provider.active and (provider.is_published or provider.is_live))


def status(provider: Any) -> str:
    if "state" in provider._fields:
        state = provider.state
    else:
        state = "live" if provider.is_live else "test mode"
    published = "published" if provider.is_published else "not published"
    return f"{state}, {published}"


def enable(env: Any) -> list[str]:
    """Turn the provider on and show it at checkout, in every company."""
    if not runtime.read_codes(env.cr).get(const.NWC_KEY):
        raise UserError(const.NOT_CONFIGURED_MESSAGE)
    lines = []
    for provider in providers(env):
        if "state" in provider._fields:
            provider.write({"state": "enabled", "is_published": True})
        else:
            provider.write({"active": True, "is_live": True, "is_published": True})
        lines.append(f"provider: {provider.name} ({provider.company_id.name}): {status(provider)}")
    payment_methods(env).write({"active": True})
    return lines


# --------------------------------------------------------------- doctor


def doctor(env: Any) -> tuple[bool, list[str]]:
    """Every check the shop needs, as lines; a failed check is reported, never
    raised."""
    codes = runtime.read_codes(env.cr)
    engine_env = runtime.engine_env(codes)
    database = runtime.Database(env.cr.dbname)
    repository = OdooPaymentRepository(database)
    report = doctor_report(
        engine_env,
        repository=repository,
        wallet_client_factory=WALLET_CLIENT_FACTORY,
        command="doctor",
    )
    ok = report.ok
    lines = list(report.lines)

    addon = module_version(env)
    lines.insert(1, f"module: payment_openreceive {addon or '(not installed)'}")
    if addon and addon != openreceive.__version__:
        lines.append(
            f"version: the module is {addon} but the openreceive Python package is "
            f"{openreceive.__version__}; install openreceive=={addon}"
        )
        ok = False

    for provider in providers(env):
        line = f"provider: {provider.name} ({provider.company_id.name}): {status(provider)}"
        if not is_on(provider) or not provider.is_published:
            line += " — buyers do not see it (odoo openreceive configure --enable)"
        lines.append(line)
    if not providers(env):
        lines.append("provider: missing — upgrade payment_openreceive under Apps")
        ok = False
    methods = payment_methods(env)
    if not methods or not any(methods.mapped("active")):
        lines.append("payment method: missing or archived")
        ok = False
    else:
        lines.append(f"payment method: {', '.join(sorted(set(methods.mapped('name'))))}")

    manifest = ASSET_DIR / "MANIFEST.json"
    if manifest.is_file() and (ASSET_DIR / "openreceive-checkout.js").is_file():
        version = json.loads(manifest.read_text(encoding="utf-8")).get("version")
        lines.append(f"checkout files: present ({version})")
    else:
        lines.append("checkout files: MISSING — install the release ZIP, not the source tree")
        ok = False

    cron = env.ref("payment_openreceive.cron_reconcile", raise_if_not_found=False)
    if cron is None:
        lines.append("reconcile cron: missing")
        ok = False
    else:
        last = cron.sudo().lastcall
        lines.append(
            f"reconcile cron: {'active' if cron.sudo().active else 'INACTIVE'}, every "
            f"{cron.sudo().interval_number} {cron.sudo().interval_type}, last run "
            f"{last or 'never'}"
        )
        ok = ok and bool(cron.sudo().active)

    if codes.get(const.NWC_KEY) and report.ok:
        try:
            service = runtime.build_service(codes, runtime.company_currencies(env))
        except Exception as error:
            lines.append(f"engine: {sanitize_failure_message(error)}")
            return False, lines
        price = service.price_provider
        for currency in runtime.company_currencies(env):
            try:
                rate = price.btc_fiat_price(currency) if price else None
                lines.append(f"price feed: 1 BTC = {rate} {currency}")
            except Exception as error:
                lines.append(f"price feed: {currency}: {sanitize_failure_message(error)}")
                ok = False
        for index, provider in enumerate(service.swap_providers):
            name = getattr(provider, "name", None) or f"provider {index + 1}"
            lines.append(f"swap provider: {name} configured")
        try:
            pending = repository.pending_count()
            lines.append(f"payments: {pending} pending")
        except Exception as error:
            lines.append(f"payments: {sanitize_failure_message(error)}")
    return ok, lines


# --------------------------------------------------------- test invoice


def test_partner(env: Any) -> Any:
    Partner = env["res.partner"].sudo().with_context(active_test=False)
    partner = Partner.search([("email", "=", TEST_PARTNER_EMAIL)], limit=1)
    return partner or Partner.create({"name": "OpenReceive test", "email": TEST_PARTNER_EMAIL})


def new_test_transaction(env: Any, amount: str) -> Any:
    company = env.company
    provider = providers(env).filtered(lambda p: p.company_id == company)[:1] or providers(env)[:1]
    if not provider:
        raise UserError("The OpenReceive payment provider is missing.")
    method = payment_methods(env).filtered("active")[:1]
    Transaction = env["payment.transaction"].sudo()
    reference = Transaction._compute_reference(const.CODE, prefix="openreceive-test")
    return Transaction.create(
        {
            "provider_id": provider.id,
            "payment_method_id": method.id,
            "reference": reference,
            "amount": float(amount),
            "currency_id": provider.company_id.currency_id.id,
            "partner_id": test_partner(env).id,
            "operation": "online_redirect",
            "landing_route": "/",
        }
    )


def _call(app: Any, route: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(body).encode()
    request = HttpRequest(
        method="POST",
        path=f"{const.ROUTE_PREFIX}{route}",
        headers={"content-type": "application/json", "accept": "application/json"},
        body=payload,
        content_length=len(payload),
        framework_request=runtime.CONSOLE_REQUEST,
    )
    status, response, _headers = app.handle(request)
    return status, response


def test_invoice(env: Any, reference: str | None, amount: str = "5.00") -> list[str]:
    """A Lightning invoice through the same route the checkout page calls,
    for a transaction's reference or for a new test transaction."""
    if reference:
        tx = runtime.find_transaction(env, reference)
        if not tx:
            raise UserError(f"No OpenReceive payment transaction has the reference {reference}.")
    else:
        tx = new_test_transaction(env, amount)
        # The checkout must see the new transaction from its own cursor.
        env.cr.commit()
    app = runtime.get_app(env)
    status, created = _call(app, "/checkouts", {"reference": tx.reference})
    if status != 201:
        raise UserError(f"The checkout answered {status}: {json.dumps(created)[:400]}")
    checkout = created.get("checkout") or created
    amount_msats = int(checkout.get("amount_msats") or 0)
    lines = [
        f"transaction: {tx.reference} ({runtime.amount_text(tx)} {tx.currency_id.name}, partner {tx.partner_id.email or tx.partner_id.name})",
        f"amount: {amount_msats // 1000} sats",
        f"invoice: {checkout.get('bolt11') or checkout.get('invoice')}",
        "methods:",
        "  Bitcoin Lightning: available",
    ]
    status, prepared = _call(app, "/checkouts/prepare", {"reference": tx.reference})
    for method in prepared.get("payment_methods") or [] if status == 200 else []:
        availability = (
            "available"
            if method.get("available")
            else method.get("unavailable_message") or method.get("unavailable_reason")
        )
        lines.append(f"  {method.get('label')} on {method.get('network_label')}: {availability}")
    if status != 200:
        lines.append(f"  swaps: prepare answered {status}")
    return lines
