"""The `openreceive` console script — the Python twin of `npx openreceive`.

    openreceive doctor [--app main:app] [--offline] [--db URL] [--url BASE]
    openreceive debug-report [...]            (same report, always exit 0)
    openreceive reconcile --app main:app      (one pass; prints the checks)
    openreceive notifications --app main:app  (long-lived NWC-02 listener + periodic pass)
    openreceive scaffold payments --sql --dialect postgres|sqlite|mysql
    openreceive scaffold payments --alembic [--dialect …] [--out-dir alembic/versions]

`--app module:attr` names the stack: the FastAPI app, the router from
`openreceive_router`, an `OpenReceiveApp`, or a zero-argument callable
returning one of those. Without `--app`, `DJANGO_SETTINGS_MODULE` selects
the Django app (`openreceive.django`). Exit codes: 0 ok, 1 a failing check
or error, 2 usage.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import sys
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

from openreceive._version import __version__
from openreceive.server.app import OpenReceiveApp
from openreceive.server.doctor import doctor_report
from openreceive.server.errors import ConfigurationError
from openreceive.server.hosts import Host
from openreceive.server.notifications import (
    DEFAULT_RECONCILE_INTERVAL_SECONDS,
    RECONCILE_INTERVAL_ENV,
    run_notifications_worker,
)
from openreceive.server.service import redact_secrets

DIALECTS = ("postgres", "sqlite", "mysql")
DEFAULT_TABLE = "openreceive_payments"
DEFAULT_META_TABLE = "openreceive_meta"
STORAGE_GUIDE_URL = "https://openreceive.org/guides/storage.md"
HTTP_PROBE_TIMEOUT_SECONDS = 5.0

USAGE = f"""\
Usage: openreceive <command> [options]

Commands:
  doctor              Validate server configuration: Python, NWC_URI, swap providers,
                      a receive-only wallet probe over the relay; with --app (or a
                      Django settings module) also the payment tables and the host's
                      hooks. Exits 1 on problems.
  debug-report        The same diagnostics as a redacted support report (always exit 0).
  reconcile           One reconciliation pass over pending attempts (needs --app).
  notifications       Long-lived NWC-02 listener + periodic reconcile pass (needs --app).
                      {RECONCILE_INTERVAL_ENV} sets the interval (default {DEFAULT_RECONCILE_INTERVAL_SECONDS} s).
  scaffold payments   Emit the openreceive_payments + openreceive_meta migration:
                      --sql prints the DDL, --alembic writes a revision file.

Options:
  -h, --help          Show this help.
  --app module:attr   The FastAPI app, the router from openreceive_router, an
                      OpenReceiveApp, or a zero-argument callable returning one.
                      Without it, DJANGO_SETTINGS_MODULE selects the Django app.

Doctor options:
  --offline                 Skip the wallet relay probe.
  --db <sqlalchemy-url>     Check the payment tables in this database instead of --app's
                            (postgresql+psycopg://…, sqlite:///file, mysql+pymysql://…).
  --url <base-url>          Check the OpenReceive routes answer on a running app.
  --prefix <path>           Route prefix for --url (default /openreceive).
  --table-name <name>       Payments table for --db (default {DEFAULT_TABLE}).
  --meta-table-name <name>  Reconcile-gate table for --db (default {DEFAULT_META_TABLE}).

Scaffold options:
  --sql                     Print the DDL for --dialect to stdout.
  --alembic                 Write an Alembic revision into --out-dir.
  --dialect <name>          postgres | sqlite | mysql (default postgres).
  --out-dir <path>          Alembic versions directory (default alembic/versions).
  --revision <id>           Alembic revision id (default: generated).
  --down-revision <id>      The current head this revision follows (default: none — set it!).
  --force                   Overwrite an existing revision file.
  --table-name / --meta-table-name  As above.
"""


@dataclass
class CliIo:
    stdout: TextIO
    stderr: TextIO


class CliError(Exception):
    """A user-facing failure: printed to stderr, exit 1."""


class UsageError(CliError):
    """A command-line mistake: printed with the usage, exit 2."""


def main(argv: Sequence[str] | None = None) -> int:
    return run(list(sys.argv[1:] if argv is None else argv))


def run(
    argv: list[str],
    *,
    env: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    wallet_client_factory: Callable[[str], Any] | None = None,
    cwd: Path | None = None,
) -> int:
    """The testable entry point. `wallet_client_factory` is the doctor's probe seam."""
    io = CliIo(stdout or sys.stdout, stderr or sys.stderr)
    environ: Mapping[str, str] = os.environ if env is None else env
    command, args = (argv[0], argv[1:]) if argv else ("help", [])
    try:
        if command in ("help", "--help", "-h"):
            io.stdout.write(USAGE)
            return 0
        if command in ("doctor", "debug-report"):
            return run_doctor(command, args, environ, io, wallet_client_factory)
        if command == "reconcile":
            return run_reconcile(args, environ, io)
        if command == "notifications":
            return run_notifications(args, environ, io)
        if command == "scaffold":
            return run_scaffold(args, io, cwd or Path.cwd())
        raise UsageError(f"Unknown OpenReceive command: {command}")
    except UsageError as error:
        io.stderr.write(f"{error}\n\n{USAGE}")
        return 2
    except CliError as error:
        io.stderr.write(f"{redact_secrets(str(error))}\n")
        return 1
    except ConfigurationError as error:
        io.stderr.write(f"{redact_secrets(str(error))}\n")
        return 1


# ------------------------------------------------------------------- parsing


def _parser(prog: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"openreceive {prog}", add_help=False)
    parser.add_argument("--app")
    return parser


def _parse(parser: argparse.ArgumentParser, args: list[str]) -> argparse.Namespace:
    try:
        namespace, unknown = parser.parse_known_args(args)
    except SystemExit as exit_:  # argparse's own error path
        raise UsageError("Invalid options.") from exit_
    if unknown:
        raise UsageError(f"Unexpected option: {' '.join(unknown)}. See `openreceive --help`.")
    return namespace


# ----------------------------------------------------------- app resolution


def resolve_target(spec: str) -> Any:
    """`module:attr` (or `module.attr` when the module has no dotted attr)
    imported from the current directory, the way uvicorn spells it."""
    module_name, _, attr = spec.partition(":")
    if not module_name or not attr:
        raise UsageError(f"--app must be module:attr, got {spec!r}.")
    if str(Path.cwd()) not in sys.path:
        sys.path.insert(0, str(Path.cwd()))
    try:
        module = importlib.import_module(module_name)
    except ImportError as error:
        raise CliError(f"--app {spec}: could not import {module_name}: {error}") from error
    target: Any = module
    for part in attr.split("."):
        if not hasattr(target, part):
            raise CliError(f"--app {spec}: {module_name} has no attribute {attr!r}.")
        target = getattr(target, part)
    return target


def is_binding(value: Any) -> bool:
    """Duck-typed `openreceive.fastapi.OpenReceiveBinding`: never import the
    FastAPI extra here, the CLI must run in a Django-only install."""
    return all(hasattr(value, name) for name in ("start", "host", "repository", "app"))


def find_binding(target: Any) -> Any | None:
    """The binding behind a FastAPI app / router: `app.state.openreceive`
    once the lifespan ran, else the router's `openreceive`, else the one the
    endpoint carries (FastAPI ≥ 0.141 wraps an included router in
    `original_router`; older versions copy its routes flat)."""
    if is_binding(target):
        return target
    state = getattr(target, "state", None)
    nested = getattr(state, "openreceive", None) if state is not None else None
    if is_binding(nested):
        return nested
    nested = getattr(target, "openreceive", None)
    if is_binding(nested):
        return nested
    for route in getattr(target, "routes", None) or []:
        endpoint = getattr(route, "endpoint", None)
        nested = getattr(endpoint, "openreceive_binding", None)
        if is_binding(nested):
            return nested
        for inner in ("original_router", "app"):
            found = find_binding(getattr(route, inner, None))
            if found is not None:
                return found
    return None


@dataclass
class Stack:
    """What the verbs need from `--app`: the host and repository without
    touching the wallet (doctor), and the full app on demand (the rest)."""

    host: Host | None
    repository: Any | None
    build_app: Callable[[], OpenReceiveApp]
    notes: list[str] = field(default_factory=list)


def resolve_stack(spec: str | None, env: Mapping[str, str]) -> Stack | None:
    if spec is None:
        if env.get("DJANGO_SETTINGS_MODULE"):
            return django_stack()
        return None
    target = resolve_target(spec)
    if isinstance(target, OpenReceiveApp):
        return Stack(target.host, target.repository, lambda: target)
    binding = find_binding(target)
    if binding is None and callable(target) and not hasattr(target, "routes"):
        # A factory: `def openreceive_app() -> OpenReceiveApp`.
        produced = target()
        if isinstance(produced, OpenReceiveApp):
            return Stack(produced.host, produced.repository, lambda: produced)
        binding = find_binding(produced)
    if binding is None:
        if isinstance(target, Host):
            raise CliError(
                f"--app {spec} is a Host, which has no database. Pass the FastAPI app, the router "
                "from openreceive_router, or an OpenReceiveApp."
            )
        raise CliError(
            f"--app {spec} does not lead to an OpenReceive stack (a FastAPI app with "
            "openreceive_router included, that router, or an OpenReceiveApp)."
        )
    return Stack(binding.host, binding.repository, lambda: binding.app)


def django_stack() -> Stack:
    """`DJANGO_SETTINGS_MODULE` → `openreceive.django.conf`: the host from
    `settings.OPENRECEIVE["HOST"]`, the ORM repository, and `get_app()` for
    the verbs that need the wallet."""
    try:
        import django

        django.setup()
        conf = importlib.import_module("openreceive.django.conf")
        repository_module = importlib.import_module("openreceive.django.repository")
    except Exception as error:  # ImportError, ImproperlyConfigured, a missing settings module
        raise CliError(
            "DJANGO_SETTINGS_MODULE is set but the Django app could not be loaded: "
            f"{type(error).__name__}: {error}. Install `openreceive[django]` and run from the "
            "project directory, or pass --app for a FastAPI host."
        ) from error
    notes: list[str] = []
    host: Host | None = None
    repository: Any | None = None
    try:
        config = conf.read_settings()
        host = conf.load_host(config)
        repository = repository_module.DjangoPaymentRepository(
            using=str(config.get("DATABASE") or "default")
        )
    except Exception as error:
        notes.append(f"host: {type(error).__name__}: {error}")
    return Stack(host, repository, conf.get_app, notes)


# -------------------------------------------------------------------- doctor


def run_doctor(
    command: str,
    args: list[str],
    env: Mapping[str, str],
    io: CliIo,
    wallet_client_factory: Callable[[str], Any] | None,
) -> int:
    parser = _parser(command)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--db")
    parser.add_argument("--url")
    parser.add_argument("--prefix", default="/openreceive")
    parser.add_argument("--table-name", default=DEFAULT_TABLE)
    parser.add_argument("--meta-table-name", default=DEFAULT_META_TABLE)
    options = _parse(parser, args)

    host: Host | None = None
    repository: Any | None = None
    stack_error: str | None = None
    try:
        stack = resolve_stack(options.app, env)
    except UsageError:
        raise
    except CliError as error:
        # A stack that cannot be loaded is a FINDING for the doctor, not a crash.
        stack_error = redact_secrets(str(error))
        stack = None
    notes: list[str] = []
    if stack is not None:
        host = stack.host
        repository = stack.repository
        notes = stack.notes
    if options.db is not None:
        repository = repository_for_url(options.db, options.table_name, options.meta_table_name)

    report = doctor_report(
        env,
        host=host,
        repository=repository,
        wallet_client_factory=wallet_client_factory,
        offline=options.offline,
        command=command,
    )
    lines = list(report.lines)
    ok = report.ok
    if notes:
        lines.extend(notes)
        ok = False
    if stack_error is not None:
        lines.append(f"app: {stack_error}")
        ok = False
    if options.url is None:
        lines.append(
            "routes: skipped — pass --url http://localhost:8000 to check the OpenReceive routes answer"
        )
    else:
        routes_ok, line = probe_routes(options.url, options.prefix)
        ok = ok and routes_ok
        lines.append(line)
    io.stdout.write("\n".join(lines) + "\n")
    if command == "debug-report":
        return 0
    return 0 if ok else 1


def repository_for_url(url: str, table_name: str, meta_table_name: str) -> Any:
    try:
        from sqlalchemy import create_engine

        from openreceive.storage.sql import SqlPaymentRepository
    except ImportError as error:
        raise CliError(
            f"--db needs SQLAlchemy and the database driver: pip install 'openreceive[sqlalchemy]' ({error})"
        ) from error
    try:
        engine = create_engine(url)
    except Exception as error:
        raise CliError(f"--db: {type(error).__name__}: {error}") from error
    return SqlPaymentRepository(engine, table_name=table_name, meta_table_name=meta_table_name)


def probe_routes(base_url: str, prefix: str) -> tuple[bool, str]:
    """An unknown path under the prefix must answer the engine's own JSON
    404 — proof the router is mounted there and not the framework's fallback."""
    import urllib.error
    import urllib.request

    prefix = "/" + prefix.strip("/")
    probe = f"{base_url.rstrip('/')}{prefix}/__openreceive_doctor_probe"
    try:
        with urllib.request.urlopen(probe, timeout=HTTP_PROBE_TIMEOUT_SECONDS) as response:
            status, payload = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read()
    except Exception as error:
        return False, f"routes: {probe} unreachable — {type(error).__name__}: {error}"
    try:
        body = json.loads(payload.decode("utf-8", errors="replace"))
    except ValueError:
        body = None
    if status == 404 and isinstance(body, dict) and body.get("code") == "NOT_FOUND":
        return True, f"routes: OpenReceive answers under {prefix} on {base_url}"
    return (
        False,
        f"routes: {probe} answered {status} without the OpenReceive 404 body — the router is not "
        f"mounted at {prefix}; check include_router(..., prefix=...) and --prefix",
    )


# ---------------------------------------------------------- reconcile/worker


def _require_stack(
    options: argparse.Namespace, env: Mapping[str, str], verb: str
) -> OpenReceiveApp:
    stack = resolve_stack(options.app, env)
    if stack is None:
        raise UsageError(f"openreceive {verb} needs --app module:attr (or DJANGO_SETTINGS_MODULE).")
    return stack.build_app()


def run_reconcile(args: list[str], env: Mapping[str, str], io: CliIo) -> int:
    parser = _parser("reconcile")
    parser.add_argument("--overlap-seconds", type=int, default=60)
    options = _parse(parser, args)
    app = _require_stack(options, env, "reconcile")
    checks = app.reconcile(overlap_seconds=options.overlap_seconds)
    counts: dict[str, int] = {}
    for check in checks:
        status = str(check.get("status", "unknown"))
        counts[status] = counts.get(status, 0) + 1
    summary = ", ".join(f"{status}: {count}" for status, count in sorted(counts.items())) or "none"
    io.stdout.write(
        f"openreceive reconcile: {len(checks)} pending attempt(s) checked ({summary})\n"
    )
    return 0


def run_notifications(args: list[str], env: Mapping[str, str], io: CliIo) -> int:
    parser = _parser("notifications")
    parser.add_argument("--interval-seconds", type=int)
    options = _parse(parser, args)
    app = _require_stack(options, env, "notifications")
    interval = options.interval_seconds
    if interval is None:
        raw = (env.get(RECONCILE_INTERVAL_ENV) or "").strip()
        interval = (
            int(raw) if raw.isdigit() and int(raw) > 0 else DEFAULT_RECONCILE_INTERVAL_SECONDS
        )
    io.stdout.write(
        f"openreceive notifications: listening for NWC-02 payment_received, reconciling every "
        f"{interval} s (Ctrl-C to stop)\n"
    )
    io.stdout.flush()
    try:
        run_notifications_worker(app.reconciler, interval_seconds=interval)
    except KeyboardInterrupt:
        io.stdout.write("openreceive notifications: stopped\n")
    return 0


# ------------------------------------------------------------------ scaffold


def run_scaffold(args: list[str], io: CliIo, cwd: Path) -> int:
    if not args or args[0] in ("help", "--help", "-h"):
        io.stdout.write(USAGE)
        return 0
    target, rest = args[0], args[1:]
    if target != "payments":
        raise UsageError(f'Unknown scaffold target: {target}. Only "payments" is supported.')
    parser = argparse.ArgumentParser(prog="openreceive scaffold payments", add_help=False)
    parser.add_argument("--sql", action="store_true")
    parser.add_argument("--alembic", action="store_true")
    parser.add_argument("--dialect", default="postgres")
    parser.add_argument("--table-name", default=DEFAULT_TABLE)
    parser.add_argument("--meta-table-name", default=DEFAULT_META_TABLE)
    parser.add_argument("--out-dir", default="alembic/versions")
    parser.add_argument("--revision")
    parser.add_argument("--down-revision")
    parser.add_argument("--force", action="store_true")
    options = _parse(parser, rest)
    if options.sql == options.alembic:
        raise UsageError("openreceive scaffold payments needs exactly one of --sql or --alembic.")
    dialect = options.dialect.lower()
    if dialect not in DIALECTS:
        raise UsageError(
            f"--dialect must be one of {', '.join(DIALECTS)}, got {options.dialect!r}."
        )
    if options.sql:
        io.stdout.write(render_sql(dialect, options.table_name, options.meta_table_name))
        return 0
    path = write_alembic_revision(
        cwd / options.out_dir,
        dialect=dialect,
        table_name=options.table_name,
        meta_table_name=options.meta_table_name,
        revision=options.revision,
        down_revision=options.down_revision,
        force=options.force,
    )
    io.stdout.write(
        f"Wrote {path.relative_to(cwd) if path.is_relative_to(cwd) else path}\n"
        + (
            ""
            if options.down_revision
            else "down_revision is None: set it to your current head (`alembic heads`) before "
            "`alembic upgrade head`, or Alembic will see two bases.\n"
        )
        + "Apply it through your normal workflow (`alembic upgrade head`); OpenReceive owns the "
        f"tables' logic at runtime and needs nothing else. {STORAGE_GUIDE_URL}\n"
    )
    return 0


def _ddl() -> tuple[Callable[..., list[str]], Callable[..., str]]:
    try:
        from openreceive.storage.sql.ddl import payments_ddl_statements, payments_schema_sql
    except ImportError as error:
        raise CliError(
            f"scaffold needs SQLAlchemy to render the DDL: pip install 'openreceive[sqlalchemy]' ({error})"
        ) from error
    return payments_ddl_statements, payments_schema_sql


def fulfillment_note(table_name: str) -> list[str]:
    from openreceive._generated.fulfillment_note import FULFILLMENT_NOTE_TEMPLATE

    return [line.replace("{{table}}", table_name) for line in FULFILLMENT_NOTE_TEMPLATE]


def render_sql(dialect: str, table_name: str, meta_table_name: str) -> str:
    _statements, schema_sql = _ddl()
    note = "\n".join(f"-- {line}".rstrip() for line in fulfillment_note(table_name))
    return (
        f"-- OpenReceive {__version__}: {table_name} (payment attempts) + {meta_table_name} "
        f"(reconcile gate), {dialect}.\n"
        f"-- Rendered by `openreceive scaffold payments --sql --dialect {dialect}`; apply once "
        "through your own migration workflow.\n"
        f"{note}\n\n{schema_sql(dialect, table_name, meta_table_name)}\n"
    )


REVISION_ID = re.compile(r"^[0-9a-f]{12}$")


def write_alembic_revision(
    out_dir: Path,
    *,
    dialect: str,
    table_name: str,
    meta_table_name: str,
    revision: str | None,
    down_revision: str | None,
    force: bool,
) -> Path:
    statements, _schema_sql = _ddl()
    revision = revision or uuid.uuid4().hex[:12]
    if not REVISION_ID.match(revision):
        raise UsageError("--revision must be 12 lowercase hex characters.")
    if down_revision is not None and not re.match(r"^[0-9A-Za-z_.-]+$", down_revision):
        raise UsageError("--down-revision must be an Alembic revision id.")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{revision}_openreceive_payments.py"
    if path.exists() and not force:
        raise CliError(f"{path} exists; pass --force to overwrite it.")
    ddl = statements(dialect, table_name, meta_table_name)
    note = "\n".join(line.rstrip() for line in fulfillment_note(table_name))
    body = "\n".join(f"    op.execute({json.dumps(statement)})" for statement in ddl)
    down = json.dumps(down_revision) if down_revision else "None"
    source = f'''"""OpenReceive payment tables ({dialect}).

{table_name} holds the payment attempts, {meta_table_name} the durable reconcile
gate and the schema-version marker. Rendered by
`openreceive scaffold payments --alembic --dialect {dialect}` (openreceive {__version__});
the DDL is frozen here on purpose — a migration must not change under a
library upgrade. OpenReceive owns the tables' locking, write-once settlement
and reconciliation at runtime.

{note}

Revision ID: {revision}
Revises: {down_revision or ""}
"""

from alembic import op

revision = "{revision}"
down_revision = {down}
branch_labels = None
depends_on = None


def upgrade() -> None:
{body}


def downgrade() -> None:
    op.drop_table("{table_name}")
    op.drop_table("{meta_table_name}")
'''
    path.write_text(source, encoding="utf-8")
    return path


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
