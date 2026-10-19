"""The OpenReceive engine inside Odoo: the saved codes, one engine per process
and per set of codes, and the host hooks over Odoo's payment transactions.

The engine is the `openreceive` Python package. Its reference is the payment
transaction's reference. The amount is the transaction's amount in its
currency, read on the server: the browser never names a price. Only the
browser session that started the payment may pay it: Odoo records that
transaction in the session, and the payment status page relies on the same
record. Settlement marks the transaction done in the database transaction that
settles the payment, then runs Odoo's post-processing, which confirms the
order or reconciles the invoice as it does for any provider.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from odoo import SUPERUSER_ID, api
from odoo.modules.registry import Registry

from openreceive.server import HookContext, Host, OpenReceiveApp, Service
from openreceive.server.service import sanitize_failure_message
from openreceive.storage import PaymentSettlement

from . import const
from .repository import OdooPaymentRepository
from .schema import SETTINGS_TABLE

_logger = logging.getLogger(__name__)

# Odoo's payment status page reads the transaction a session is paying from
# this session key; Odoo 19 and 20 both set it when they create a transaction.
MONITORED_TX_ID_KEY = "__payment_monitored_tx_id__"

# Marks a request made by this module's own console command (test-invoice):
# the shop owner, not a payer.
CONSOLE_REQUEST = object()

# Tests swap the wallet: callable(codes, env) -> Service.
SERVICE_FACTORY: Callable[[Mapping[str, str], Mapping[str, str]], Service] | None = None

_lock = threading.RLock()
_apps: dict[str, tuple[str, OpenReceiveApp]] = {}


class NotConfigured(RuntimeError):
    """No wallet code is saved yet."""


# ------------------------------------------------------------- database


class Database:
    """Cursors on one Odoo database. `transaction()` yields a cursor that runs
    READ COMMITTED and commits when the block ends. Tests pass `cursor`, a
    callable returning a context manager over the test's own cursor."""

    def __init__(self, dbname: str, cursor: Callable[[], Any] | None = None) -> None:
        self.dbname = dbname
        self._cursor = cursor

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        if self._cursor is not None:
            with self._cursor() as cr:
                yield cr
            return
        with Registry(self.dbname).cursor() as cr:
            # Odoo's test cursors share one transaction; a real one is fresh.
            if type(cr).__name__ != "TestCursor":
                cr.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
            yield cr

    @contextmanager
    def environment(self) -> Iterator[api.Environment]:
        """A superuser environment on a cursor of its own, committed at the end."""
        with self.transaction() as cr:
            yield api.Environment(cr, SUPERUSER_ID, {})


# ------------------------------------------------------------- the codes


def read_codes(cr: Any) -> dict[str, str]:
    """The saved codes by name. Never log the result."""
    cr.execute(f"SELECT key, value FROM {SETTINGS_TABLE}")
    return {str(key): str(value) for key, value in cr.fetchall() if value}


def write_code(cr: Any, key: str, value: str | None) -> None:
    if key not in const.CODE_KEYS:
        raise ValueError(f"unknown OpenReceive setting {key}")
    if not value:
        cr.execute(f"DELETE FROM {SETTINGS_TABLE} WHERE key = %s", [key])
        return
    cr.execute(
        f"INSERT INTO {SETTINGS_TABLE} (key, value, updated_at) VALUES (%s, %s, %s) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
        [key, value, datetime.now(timezone.utc).replace(tzinfo=None)],
    )


def engine_env(codes: Mapping[str, str]) -> dict[str, str]:
    """What the engine reads as its environment: the codes under their usual
    names, plus the process's own OPENRECEIVE_* tuning (price feed URLs, the
    spend-capable override). Nothing else from the process environment."""
    env = {key: value for key, value in os.environ.items() if key.startswith("OPENRECEIVE_")}
    for key, name in const.CODE_ENV_NAMES.items():
        if codes.get(key):
            env[name] = codes[key]
    return env


def codes_revision(codes: Mapping[str, str]) -> str:
    digest = hashlib.sha256()
    for key in sorted(codes):
        digest.update(f"{key}\0{codes[key]}\0".encode())
    return digest.hexdigest()


# --------------------------------------------------------------- engine


def build_service(codes: Mapping[str, str], currencies: list[str]) -> Service:
    """The engine's service, with its fail-closed wallet check: a code that can
    spend, or a wallet that cannot make invoices, raises here."""
    env = engine_env(codes)
    if SERVICE_FACTORY is not None:
        return SERVICE_FACTORY(codes, env)
    if not codes.get(const.NWC_KEY):
        raise NotConfigured(const.NOT_CONFIGURED_MESSAGE)
    from openreceive.nwc.receive_client import NwcReceiveClient

    return Service(
        NwcReceiveClient(codes[const.NWC_KEY]),
        price_currencies=currencies or ["USD"],
        env=env,
        logger=_logger,
    )


def report_unexpected_error(error: BaseException, request_id: str) -> None:
    """An unexpected exception became an opaque 500: log its class and its
    message with any code removed, never the raw message."""
    _logger.error("OpenReceive request %s failed: %s", request_id, sanitize_failure_message(error))


def client_ip(request: Any) -> str | None:
    httprequest = getattr(request, "httprequest", None)
    value = getattr(httprequest, "remote_addr", None)
    return str(value) if value else None


def build_app(
    database: Database, codes: Mapping[str, str], currencies: list[str]
) -> OpenReceiveApp:
    hooks = OdooHost(database)
    return OpenReceiveApp(
        service=build_service(codes, currencies),
        host=Host(
            amount_for=hooks.amount_for,
            authorize=hooks.authorize,
            on_paid=hooks.on_paid,
            after_paid=hooks.after_paid,
        ),
        repository=OdooPaymentRepository(database),
        prefix=const.ROUTE_PREFIX,
        client_ip=client_ip,
        report_unexpected_error=report_unexpected_error,
    )


def company_currencies(env: api.Environment) -> list[str]:
    names = env["res.company"].sudo().search([]).mapped("currency_id.name")
    return sorted({str(name) for name in names if name}) or ["USD"]


def get_app(env: api.Environment, database: Database | None = None) -> OpenReceiveApp:
    """This process's engine for the codes saved now. Saving new codes builds a
    new one, in every worker, on its next request."""
    dbname = env.cr.dbname
    codes = read_codes(env.cr)
    if not codes.get(const.NWC_KEY) and SERVICE_FACTORY is None:
        raise NotConfigured(const.NOT_CONFIGURED_MESSAGE)
    revision = codes_revision(codes)
    cached = _apps.get(dbname)
    if cached is not None and cached[0] == revision and database is None:
        return cached[1]
    with _lock:
        cached = _apps.get(dbname)
        if cached is not None and cached[0] == revision and database is None:
            return cached[1]
        app = build_app(database or Database(dbname), codes, company_currencies(env))
        if database is None:
            _apps[dbname] = (revision, app)
        return app


def forget_apps() -> None:
    with _lock:
        _apps.clear()


# ----------------------------------------------------------------- host


def find_transaction(env: api.Environment, reference: str) -> Any:
    return (
        env["payment.transaction"]
        .sudo()
        .search(
            [("reference", "=", reference), ("provider_code", "=", const.CODE)],
            limit=1,
        )
    )


def amount_text(tx: Any) -> str:
    """The transaction's amount as a decimal string, rounded to its currency."""
    places = max(int(tx.currency_id.decimal_places), 0)
    quantum = Decimal(1).scaleb(-places)
    return str(Decimal(repr(tx.amount)).quantize(quantum, rounding=ROUND_HALF_UP))


def description(tx: Any) -> str:
    company = tx.company_id.name or ""
    return f"{company} {tx.reference}".strip()


def post_process(tx: Any) -> None:
    """Odoo's own post-processing of a done transaction: the sale order is
    confirmed or the invoice paid, as for any provider. It runs under a
    savepoint; a failure leaves the transaction done for Odoo's
    post-processing cron to finish."""
    if hasattr(tx, "_try_post_process"):  # Odoo 20
        tx._try_post_process()
        return
    try:
        with tx.env.cr.savepoint():
            if not tx.is_post_processed:
                tx._post_process()
    except Exception as error:
        _logger.warning(
            "OpenReceive: post-processing %s failed; Odoo's post-processing cron retries it: %s",
            tx.reference,
            sanitize_failure_message(error),
        )


def is_session_payer(request: Any, tx: Any) -> bool:
    session = getattr(request, "session", None)
    if session is None or not tx:
        return False
    try:
        return int(session.get(MONITORED_TX_ID_KEY) or 0) == tx.id
    except (TypeError, ValueError):
        return False


class OdooHost:
    """The engine's host contract over `payment.transaction`."""

    def __init__(self, database: Database) -> None:
        self.database = database

    @contextmanager
    def _reading(self, request: Any = None) -> Iterator[api.Environment]:
        env = getattr(request, "env", None)
        if env is not None and env.cr.dbname == self.database.dbname:
            yield env(su=True)
            return
        with self.database.environment() as env:
            yield env

    def amount_for(self, reference: str) -> dict[str, Any] | None:
        from odoo.http import request

        with self._reading(request if request else None) as env:
            tx = find_transaction(env, reference)
            if not tx or tx.state not in const.PAYABLE_STATES:
                return None
            return {
                "currency": tx.currency_id.name,
                "value": amount_text(tx),
                "description": description(tx),
            }

    def authorize(self, context: HookContext) -> bool:
        request = context.request
        if request is CONSOLE_REQUEST:
            return True
        reference = str(context.resource.get("reference") or "")
        env = getattr(request, "env", None)
        if not reference or env is None:
            return False
        tx = find_transaction(env, reference)
        return is_session_payer(request, tx)

    def on_paid(self, settlement: PaymentSettlement) -> None:
        """Inside the settlement's database transaction: the payment
        transaction is done in the same commit as the payment."""
        env = api.Environment(settlement.connection, SUPERUSER_ID, {})
        tx = find_transaction(env, settlement.reference)
        if not tx:
            _logger.warning(
                "OpenReceive: payment %s settled for %s, which is no payment transaction of this module",
                settlement.payment_hash,
                settlement.reference,
            )
            return
        # Odoo 20 refuses a direct write unless it tolerates a rollback; this
        # one does: a rollback undoes the settlement too, and the next pass
        # settles both again.
        tx = tx.with_context(payment_safe_write=True)
        tx.provider_reference = settlement.payment_hash
        # Money arrived even when the transaction was cancelled meanwhile.
        tx._set_done(extra_allowed_states=("cancel",))
        _logger.info("OpenReceive: %s paid (payment %s)", tx.reference, settlement.payment_hash)
        # In the same commit, under a savepoint: the order is confirmed when
        # the checkout reports the payment, and a failure leaves only the
        # post-processing to Odoo's cron, never the payment.
        post_process(tx)

    def after_paid(self, settlement: PaymentSettlement) -> None:
        """After the commit: one more try at a post-processing that failed."""
        with self.database.environment() as env:
            tx = find_transaction(env, settlement.reference)
            if tx and tx.state == "done" and not tx.is_post_processed:
                post_process(tx.with_context(payment_safe_write=True))
