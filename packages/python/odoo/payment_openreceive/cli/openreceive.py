"""`odoo openreceive <command>`: configure, doctor, test-invoice, reconcile.

    odoo openreceive configure --nwc-uri=- -d <database> < /secure/path/wallet-code
    odoo openreceive configure --lsc-uri-primary=- -d <database> < /secure/path/swap-code
    odoo openreceive configure --enable -d <database>
    odoo openreceive doctor -d <database>
    odoo openreceive test-invoice --new -d <database>
    odoo openreceive test-invoice --reference S00012-1 -d <database>
    odoo openreceive reconcile -d <database>

A code is read from stdin when its option is `-`: never type one as an
argument, where the shell history and the process list would keep it.
"""

import logging
import optparse
import sys

import odoo
from odoo.cli import Command
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

COMMANDS = ("configure", "doctor", "test-invoice", "reconcile")


class Openreceive(Command):
    """OpenReceive: save the codes, check the setup, make a test invoice."""

    def run(self, args):
        if not args or args[0] not in COMMANDS:
            sys.exit(
                f"usage: odoo openreceive <{'|'.join(COMMANDS)}> -d <database> [options]\n{__doc__}"
            )
        command, args = args[0], args[1:]
        parser = odoo.tools.config.parser
        parser.prog = f"{self.prog} {command}"
        group = optparse.OptionGroup(parser, "OpenReceive")
        group.add_option(
            "--nwc-uri", dest="openreceive_nwc_uri", help="'-' reads the wallet code from stdin"
        )
        group.add_option(
            "--lsc-uri-primary",
            dest="openreceive_lsc_uri_primary",
            help="'-' reads the swap code from stdin; '' removes it",
        )
        group.add_option(
            "--lsc-uri-backup",
            dest="openreceive_lsc_uri_backup",
            help="'-' reads the backup swap code from stdin; '' removes it",
        )
        group.add_option(
            "--enable",
            dest="openreceive_enable",
            action="store_true",
            help="enable and publish the provider",
        )
        group.add_option(
            "--new",
            dest="openreceive_new",
            action="store_true",
            help="test-invoice: a new test transaction",
        )
        group.add_option(
            "--reference",
            dest="openreceive_reference",
            help="test-invoice: a payment transaction's reference",
        )
        group.add_option(
            "--amount",
            dest="openreceive_amount",
            my_default="5.00",
            help="test-invoice --new: the amount, in the company's currency",
        )
        parser.add_option_group(group)
        opt = odoo.tools.config.parse_config(args, setup_logging=True)
        dbnames = odoo.tools.config["db_name"]
        if not dbnames:
            sys.exit("odoo openreceive needs a database: -d <database>")
        dbname = dbnames[0] if isinstance(dbnames, (list, tuple)) else str(dbnames).split(",")[0]

        registry = odoo.modules.registry.Registry(dbname)
        from odoo.addons.payment_openreceive import operations, runtime

        ok = True
        with registry.cursor() as cr:
            env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
            try:
                if command == "configure":
                    lines = configure(env, opt, operations)
                elif command == "doctor":
                    ok, lines = operations.doctor(env)
                elif command == "test-invoice":
                    if not opt.openreceive_new and not opt.openreceive_reference:
                        sys.exit("test-invoice needs --new or --reference <transaction reference>")
                    lines = operations.test_invoice(
                        env,
                        None if opt.openreceive_new else opt.openreceive_reference,
                        opt.openreceive_amount or "5.00",
                    )
                else:
                    checks = runtime.get_app(env).reconcile()
                    lines = [f"openreceive reconcile checked {len(checks)} pending payment(s)"]
            except (UserError, runtime.NotConfigured) as error:
                cr.rollback()
                sys.exit(str(error.args[0] if error.args else error))
        print("\n".join(lines))  # noqa: T201
        if not ok:
            sys.exit(1)


def read_code(value):
    if value == "-":
        return sys.stdin.readline().strip()
    return value


def configure(env, opt, operations):
    from odoo.addons.payment_openreceive import const

    lines = []
    if opt.openreceive_nwc_uri is not None:
        lines.append(operations.save_wallet_code(env, read_code(opt.openreceive_nwc_uri)))
    for key, value in (
        (const.LSC_PRIMARY_KEY, opt.openreceive_lsc_uri_primary),
        (const.LSC_BACKUP_KEY, opt.openreceive_lsc_uri_backup),
    ):
        if value is not None:
            lines.append(operations.save_swap_code(env, key, read_code(value)))
    if opt.openreceive_enable:
        lines.extend(operations.enable(env))
    if not lines:
        sys.exit("configure needs --nwc-uri, --lsc-uri-primary, --lsc-uri-backup or --enable")
    return lines
