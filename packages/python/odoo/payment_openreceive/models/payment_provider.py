import logging

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, ValidationError

from .. import const, operations, runtime, schema

_logger = logging.getLogger(__name__)


class PaymentProvider(models.Model):
    _inherit = "payment.provider"

    code = fields.Selection(
        selection_add=[(const.CODE, "OpenReceive")], ondelete={const.CODE: "set default"}
    )
    # Set-only inputs: they always read empty, and saving one asks the wallet
    # first. The codes live in this module's own table, which no screen lists.
    openreceive_nwc_uri = fields.Char(
        string="Receive-only NWC code",
        compute="_compute_openreceive_inputs",
        inverse="_inverse_openreceive_nwc_uri",
        groups="base.group_system",
        copy=False,
    )
    openreceive_lsc_uri_primary = fields.Char(
        string="Swap provider code",
        compute="_compute_openreceive_inputs",
        inverse="_inverse_openreceive_lsc_uri_primary",
        groups="base.group_system",
        copy=False,
    )
    openreceive_lsc_uri_backup = fields.Char(
        string="Backup swap provider code",
        compute="_compute_openreceive_inputs",
        inverse="_inverse_openreceive_lsc_uri_backup",
        groups="base.group_system",
        copy=False,
    )
    openreceive_nwc_set = fields.Boolean(
        string="Wallet code saved",
        compute="_compute_openreceive_status",
        groups="base.group_system",
    )
    openreceive_lsc_set = fields.Boolean(
        string="Swap code saved", compute="_compute_openreceive_status", groups="base.group_system"
    )

    def init(self):
        super().init()
        schema.create_tables(self.env.cr)

    # === COMPUTE METHODS === #

    def _compute_openreceive_inputs(self):
        for provider in self:
            provider.openreceive_nwc_uri = False
            provider.openreceive_lsc_uri_primary = False
            provider.openreceive_lsc_uri_backup = False

    def _compute_openreceive_status(self):
        codes = runtime.read_codes(self.env.cr)
        for provider in self:
            provider.openreceive_nwc_set = bool(codes.get(const.NWC_KEY))
            provider.openreceive_lsc_set = bool(
                codes.get(const.LSC_PRIMARY_KEY) or codes.get(const.LSC_BACKUP_KEY)
            )

    def _inverse_openreceive_nwc_uri(self):
        for provider in self.filtered("openreceive_nwc_uri")[:1]:
            line = operations.save_wallet_code(self.env, provider.openreceive_nwc_uri)
            _logger.info("OpenReceive: wallet code saved (%s)", line)

    def _inverse_openreceive_lsc_uri_primary(self):
        for provider in self.filtered("openreceive_lsc_uri_primary")[:1]:
            operations.save_swap_code(
                self.env, const.LSC_PRIMARY_KEY, provider.openreceive_lsc_uri_primary
            )

    def _inverse_openreceive_lsc_uri_backup(self):
        for provider in self.filtered("openreceive_lsc_uri_backup")[:1]:
            operations.save_swap_code(
                self.env, const.LSC_BACKUP_KEY, provider.openreceive_lsc_uri_backup
            )

    # === CRUD METHODS === #

    @api.model_create_multi
    def create(self, vals_list):
        providers = super().create(vals_list)
        providers._check_openreceive_wallet_code()
        return providers

    def write(self, vals):
        result = super().write(vals)
        self._check_openreceive_wallet_code()
        return result

    def _check_openreceive_wallet_code(self):
        """Buyers only see OpenReceive once a wallet code is saved."""
        if not self.filtered(lambda p: p.code == const.CODE and operations.is_on(p)):
            return
        if not runtime.read_codes(self.env.cr).get(const.NWC_KEY):
            raise ValidationError(_("Save a receive-only NWC code before you enable OpenReceive."))

    # === ACTION METHODS === #

    def action_openreceive_remove_swap_codes(self):
        if not self.env.is_system():
            raise AccessError(_("Only an administrator can change the OpenReceive codes."))
        operations.save_swap_code(self.env, const.LSC_PRIMARY_KEY, "")
        operations.save_swap_code(self.env, const.LSC_BACKUP_KEY, "")
        return True

    # === BUSINESS METHODS === #

    def _get_default_payment_method_codes(self):
        """Override of `payment`: the method buyers pick."""
        default_codes = super()._get_default_payment_method_codes()
        if self.code != const.CODE:
            return default_codes
        return {const.PAYMENT_METHOD_CODE}

    @api.model
    def _cron_openreceive_reconcile(self):
        """One gated pass over the payments still pending: a buyer who closed
        the checkout before the wallet saw the payment is paid here."""
        codes = runtime.read_codes(self.env.cr)
        if not codes.get(const.NWC_KEY):
            return
        database = runtime.Database(self.env.cr.dbname)
        from ..repository import OdooPaymentRepository

        try:
            if OdooPaymentRepository(database).pending_count() == 0:
                return
            checks = runtime.get_app(self.env).reconcile()
        except Exception as error:
            _logger.warning(
                "OpenReceive: the reconcile pass failed: %s",
                runtime.sanitize_failure_message(error),
            )
            return
        _logger.info("OpenReceive: the reconcile pass checked %s pending payment(s)", len(checks))
