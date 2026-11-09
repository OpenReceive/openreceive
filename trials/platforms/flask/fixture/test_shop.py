import unittest

from app import app


class ShopTests(unittest.TestCase):
    def setUp(self):
        app.config["WTF_CSRF_ENABLED"] = False
        self.client = app.test_client()

    def test_home_lists_products(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Facet", response.data)
        self.assertIn(b"Bezel", response.data)

    def test_buyer_sees_their_order_and_a_stranger_does_not(self):
        created = self.client.post("/orders", data={"product_id": 1})
        self.assertEqual(created.status_code, 303)
        order_path = created.headers["Location"]
        self.assertEqual(self.client.get(order_path).status_code, 200)
        stranger = app.test_client()
        self.assertIn(stranger.get(order_path).status_code, [401, 403, 404])


if __name__ == "__main__":
    unittest.main()
