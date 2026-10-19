import json
from contextlib import contextmanager

from odoo.tests import TransactionCase

from openreceive.server import HttpRequest, Service
from openreceive.testing import FakeWallet, StaticPriceProvider

from .. import const, operations, runtime

# A well-formed code the tests save; the fake wallet answers for it.
TEST_NWC = (
    "nostr+walletconnect://" + "a" * 64 + "?relay=wss%3A%2F%2Frelay.example&secret=" + "b" * 64
)


class SpendingWallet(FakeWallet):
    """A wallet whose code can also pay: the module must refuse it."""

    def preflight(self):
        info = super().preflight()
        return {**info, "methods": [*info["methods"], "pay_invoice"]}


@contextmanager
def savepoint(cr):
    with cr.savepoint():
        yield cr


class OpenReceiveCommon(TransactionCase):
    """The module over a fake wallet and the static BTC/USD 50,000.00 price,
    on the test's own cursor: every commit of the engine is a savepoint."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.wallet = FakeWallet()
        runtime.SERVICE_FACTORY = lambda _codes, env: Service(
            cls.wallet, price_provider=StaticPriceProvider(), swap_providers=[], env=env
        )
        operations.WALLET_CLIENT_FACTORY = lambda _uri: FakeWallet()
        runtime.write_code(cls.env.cr, const.NWC_KEY, TEST_NWC)
        cls.provider = cls.env.ref("payment_openreceive.payment_provider_openreceive")
        cls.method = cls.env.ref("payment_openreceive.payment_method_openreceive")
        cls.usd = cls.env.ref("base.USD")
        cls.usd.active = True
        cls.partner = cls.env["res.partner"].create(
            {"name": "Demo Buyer", "email": "buyer@example.test"}
        )

    @classmethod
    def tearDownClass(cls):
        runtime.SERVICE_FACTORY = None
        operations.WALLET_CLIENT_FACTORY = None
        runtime.forget_apps()
        super().tearDownClass()

    def database(self):
        return runtime.Database(self.env.cr.dbname, cursor=lambda: savepoint(self.env.cr))

    def app(self):
        return runtime.get_app(self.env, database=self.database())

    def make_transaction(self, amount=12.0):
        Transaction = self.env["payment.transaction"].sudo()
        return Transaction.create(
            {
                "provider_id": self.provider.id,
                "payment_method_id": self.method.id,
                "reference": Transaction._compute_reference(const.CODE, prefix="ORTEST"),
                "amount": amount,
                "currency_id": self.usd.id,
                "partner_id": self.partner.id,
                "operation": "online_redirect",
                "landing_route": "/",
            }
        )

    def call(self, app, route, body, request=runtime.CONSOLE_REQUEST):
        payload = json.dumps(body).encode()
        status, answer, _headers = app.handle(
            HttpRequest(
                method="POST",
                path=f"{const.ROUTE_PREFIX}{route}",
                headers={"content-type": "application/json", "accept": "application/json"},
                body=payload,
                content_length=len(payload),
                framework_request=request,
            )
        )
        return status, answer
