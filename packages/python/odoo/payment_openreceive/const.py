CODE = "openreceive"

# The payment method buyers pick at checkout.
PAYMENT_METHOD_CODE = "openreceive"
PAYMENT_METHOD_NAME = "Bitcoin Lightning"
PAYMENT_METHOD_SWAP_NAME = "Bitcoin & stablecoins"

# The engine's routes, which the checkout in the browser calls.
ROUTE_PREFIX = "/openreceive"
CHECKOUT_ROUTE = "/payment/openreceive/checkout"
STATUS_ROUTE = "/payment/status"
ASSET_PATH = "/payment_openreceive/static/lib/openreceive"

# The saved codes, and the names the engine reads them under.
NWC_KEY = "nwc_uri"
LSC_PRIMARY_KEY = "lsc_uri_primary"
LSC_BACKUP_KEY = "lsc_uri_backup"
CODE_KEYS = (NWC_KEY, LSC_PRIMARY_KEY, LSC_BACKUP_KEY)
CODE_ENV_NAMES = {
    NWC_KEY: "NWC_URI",
    LSC_PRIMARY_KEY: "LSC_URI_PRIMARY",
    LSC_BACKUP_KEY: "LSC_URI_BACKUP",
}

# A transaction the buyer can still pay. A buyer who pays after Odoo cancelled
# the transaction is still recorded: see runtime.OdooHost.on_paid.
PAYABLE_STATES = ("draft", "pending")

NOT_CONFIGURED_MESSAGE = (
    "OpenReceive has no wallet code yet. Paste a receive-only NWC code on the OpenReceive "
    "payment provider, or run `odoo openreceive configure --nwc-uri=-`."
)
WALLET_HELP_URL = "https://openreceive.org/get_a_nwc_code_to_receive_payments"
GUIDE_URL = "https://openreceive.org/guides/quickstart-odoo"
