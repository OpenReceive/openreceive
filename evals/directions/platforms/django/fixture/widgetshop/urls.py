from django.urls import path

from shop import views

urlpatterns = [
    path("", views.index, name="index"),
    path("health", views.health, name="health"),
    path("orders", views.create_order, name="create_order"),
    path("orders/<int:order_id>", views.order, name="order"),
]
