from django.apps import AppConfig


class ShopConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "shop"

    def ready(self):
        from django.db import connection
        from django.db.utils import OperationalError, ProgrammingError

        from .models import Product

        try:
            tables = set(connection.introspection.table_names())
        except (OperationalError, ProgrammingError):
            return
        if "shop_product" not in tables:
            return
        for name, price, sku in [
            ("Facet", "7.00", "facet"),
            ("Bezel", "12.00", "bezel"),
            ("Hinge", "4.00", "hinge"),
            ("Latch", "9.00", "latch"),
            ("Knob", "3.00", "knob"),
        ]:
            Product.objects.get_or_create(sku=sku, defaults={"name": name, "price": price})
