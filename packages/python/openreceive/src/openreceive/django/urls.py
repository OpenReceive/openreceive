"""The shipped route set (spec/openapi/openreceive-http.v1.yaml), mounted by
the host with `path("openreceive/", include("openreceive.django.urls"))`.
Every path accepts any method: the engine answers a wrong method with its own
405 INVALID_REQUEST, so the wire semantics match every other adapter."""

from __future__ import annotations

from django.urls import path

from openreceive.django import views

app_name = "openreceive"

urlpatterns = [
    path("checkouts/prepare", views.prepare_checkout, name="checkouts-prepare"),
    path("checkouts", views.create_checkout, name="checkouts"),
    path("payments/check", views.check_payment, name="payments-check"),
    path("swaps/quote", views.quote_swap, name="swaps-quote"),
    path("swaps", views.create_swap, name="swaps"),
    path("swaps/status", views.swap_status, name="swaps-status"),
    path("swaps/refunds", views.refund_swap, name="swaps-refunds"),
    path("rates", views.rates, name="rates"),
]
