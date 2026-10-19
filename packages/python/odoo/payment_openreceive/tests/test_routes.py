import json

from odoo.tests import HttpCase, tagged

from openreceive.server import Service
from openreceive.testing import FakeWallet, StaticPriceProvider

from .. import const, runtime
from .common import TEST_NWC


@tagged("post_install", "-at_install")
class TestRoutes(HttpCase):
    """The routes over HTTP: only the session paying a transaction sees its
    checkout, and the engine refuses a request without Odoo's CSRF token."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        wallet = FakeWallet()
        runtime.SERVICE_FACTORY = lambda _codes, env: Service(
            wallet, price_provider=StaticPriceProvider(), swap_providers=[], env=env
        )
        runtime.forget_apps()
        runtime.write_code(cls.env.cr, const.NWC_KEY, TEST_NWC)
        provider = cls.env.ref("payment_openreceive.payment_provider_openreceive")
        Transaction = cls.env["payment.transaction"].sudo()
        cls.tx = Transaction.create(
            {
                "provider_id": provider.id,
                "payment_method_id": cls.env.ref(
                    "payment_openreceive.payment_method_openreceive"
                ).id,
                "reference": Transaction._compute_reference(const.CODE, prefix="ORROUTE"),
                "amount": 7.0,
                "currency_id": cls.env.ref("base.USD").id,
                "partner_id": cls.env["res.partner"].create({"name": "Buyer"}).id,
                "operation": "online_redirect",
                "landing_route": "/",
            }
        )

    @classmethod
    def tearDownClass(cls):
        runtime.SERVICE_FACTORY = None
        runtime.forget_apps()
        super().tearDownClass()

    def test_another_session_gets_the_status_page(self):
        response = self.url_open(f"{const.CHECKOUT_ROUTE}?reference={self.tx.reference}")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.url.endswith(const.STATUS_ROUTE), response.url)
        self.assertNotIn("openreceive-checkout", response.text)

    def test_the_engine_refuses_a_post_without_the_csrf_token(self):
        response = self.url_open(
            f"{const.ROUTE_PREFIX}/checkouts",
            data=json.dumps({"reference": self.tx.reference}),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "FORBIDDEN")

    def test_rates_answer_json(self):
        response = self.url_open(f"{const.ROUTE_PREFIX}/rates")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("bitcoin", response.json())
