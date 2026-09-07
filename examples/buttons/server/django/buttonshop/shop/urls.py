from django.urls import path, re_path

from buttonshop.shop import views

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
SKU = r"[a-z]+(?:-[a-z]+)*"

# The uuid constraints are not decoration: these are anonymous routes, and a
# malformed uuid literal raises in Postgres before any of our code sees it.
urlpatterns = [
    path("bootstrap", views.bootstrap, name="shop-bootstrap"),
    path("orders", views.create_order, name="shop-orders"),
    re_path(rf"^orders/(?P<reference>{UUID})$", views.show_order, name="shop-order"),
    re_path(
        rf"^orders/(?P<reference>{UUID})/downloads/(?P<sku>{SKU})$",
        views.download,
        name="shop-order-download",
    ),
    path("recent_orders", views.recent_orders, name="shop-recent-orders"),
]
