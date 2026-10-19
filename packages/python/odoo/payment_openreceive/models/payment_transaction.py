from odoo import models

from .. import const


class PaymentTransaction(models.Model):
    _inherit = "payment.transaction"

    def _get_specific_rendering_values(self, processing_values):
        """Override of `payment`: the redirect form opens this module's checkout
        page for the transaction, in the same browser session."""
        res = super()._get_specific_rendering_values(processing_values)
        if self.provider_code != const.CODE:
            return res
        return {"api_url": const.CHECKOUT_ROUTE, "reference": self.reference}
