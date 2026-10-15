# Run in `odoo shell -d shop` on a new database: the merchant's setup, then a
# buyer's quotation with its payment transaction. PAIRING_CODE is a code the
# store owner approved in BTCPay (Store Settings > Access Tokens).
import os

params = env["ir.config_parameter"].sudo()
# The address BTCPay posts its notifications to.
params.set_param("web.base.url", "http://odoo:8069")
params.set_param("web.base.url.freeze", "True")

from odoo.addons.payment_btcpayserver.models.libs import crypto
from odoo.addons.payment_btcpayserver.models.libs.client import BTCPayClient

provider = env.ref("payment_btcpayserver.payment_provider_btcpayserver")
provider.write({"btcpay_location": "http://btcpayserver:49392", "state": "enabled", "is_published": True})
# What the provider form's pairing-code field does on change.
pem = crypto.generate_privkey()
token = BTCPayClient(host=provider.btcpay_location, pem=pem).pair_client(os.environ["PAIRING_CODE"])
provider.write({"btcpay_privateKey": pem, "btcpay_token": token.get(provider.btcpay_facade)})

product = env["product.product"].create({"name": "Bezel", "list_price": 12.0, "type": "consu"})
buyer = env["res.partner"].create({
    "name": "Widget Buyer",
    "email": "buyer@widget-shop.test",
    "street": "1 Main St",
    "city": "Austin",
    "zip": "78701",
    "country_id": env.ref("base.us").id,
})
# As the web shop makes it: paid online, no signature. A quotation that wants
# a signature is not confirmed by its payment.
order = env["sale.order"].create({
    "partner_id": buyer.id,
    "require_signature": False,
    "require_payment": True,
    "order_line": [(0, 0, {"product_id": product.id, "product_uom_qty": 1})],
})
tx = env["payment.transaction"].create({
    "provider_id": provider.id,
    "payment_method_id": env.ref("payment_btcpayserver.payment_method_btcpayserver").id,
    "amount": order.amount_total,
    "currency_id": order.currency_id.id,
    "partner_id": buyer.id,
    "operation": "online_redirect",
    "sale_order_ids": [(6, 0, [order.id])],
    "reference": env["payment.transaction"]._compute_reference(provider.code, prefix=order.name),
})
env.cr.commit()
print(f"RESULT paired={bool(provider.btcpay_token)} order={order.name} tx={tx.reference} amount={order.amount_total} {order.currency_id.name}")
