from django.test import Client, TestCase

from .models import Product


class ShopTests(TestCase):
    def setUp(self):
        for name, price, sku in [
            ("Facet", "7.00", "facet"),
            ("Bezel", "12.00", "bezel"),
        ]:
            Product.objects.get_or_create(sku=sku, defaults={"name": name, "price": price})

    def test_home_lists_products(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Facet")
        self.assertContains(response, "Bezel")

    def test_buyer_sees_their_order_and_a_stranger_does_not(self):
        product = Product.objects.get(sku="facet")
        created = self.client.post("/orders", {"product_id": product.id})
        self.assertEqual(created.status_code, 302)
        order_path = created["Location"]
        self.assertEqual(self.client.get(order_path).status_code, 200)
        stranger = Client()
        self.assertIn(stranger.get(order_path).status_code, [401, 403, 404])
