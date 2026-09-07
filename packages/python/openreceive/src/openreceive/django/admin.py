"""A read-only admin for the attempt ledger, registered only when the host
runs `django.contrib.admin` (autodiscover imports this module). `swap_data`
is excluded on purpose — it may carry a swap-provider credential — and no
row is editable: the repository owns every write."""

from __future__ import annotations

from typing import Any

from django.contrib import admin
from django.http import HttpRequest

from openreceive.django.models import OpenReceiveMeta, OpenReceivePayment


@admin.register(OpenReceivePayment)
class OpenReceivePaymentAdmin(admin.ModelAdmin[OpenReceivePayment]):
    list_display = ("reference", "payment_hash", "status", "status_reason", "paid_at", "expires_at")
    list_filter = ("status",)
    search_fields = ("reference", "payment_hash")
    ordering = ("-created_at",)
    exclude = ("swap_data",)
    readonly_fields = (
        "reference",
        "payment_hash",
        "status",
        "status_reason",
        "paid_at",
        "expires_at",
        "checkout_data",
        "client_ip",
        "inserted_at",
        "created_at",
        "updated_at",
    )

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False

    def has_delete_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False


@admin.register(OpenReceiveMeta)
class OpenReceiveMetaAdmin(admin.ModelAdmin[OpenReceiveMeta]):
    list_display = ("key", "value", "rev")
    readonly_fields = ("key", "value", "rev")

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False

    def has_delete_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return False
