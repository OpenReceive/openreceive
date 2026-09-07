"""The test-only control surface (docs/internal/testkit-contract.md), mounted at
/__testkit in testkit wallet mode and a hard JSON 404 in every other mode.

It drives the SAME fakes the engine mints into (buttonshop.openreceive_service),
skips CSRF (curl must be able to drive it), never touches a shop table —
settling an invoice is a wallet event, not a visitor — and answers errors in
the demo's `{code, message, retryable}` shape.
"""

from __future__ import annotations

import json
from typing import Any

from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from buttonshop import openreceive_service
from buttonshop.openreceive_service import testkit_enabled
from openreceive._generated.tables import SWAP_PROVIDER_STATES

PREFIX = "/__testkit"


def error_body(status: int, message: str) -> dict[str, Any]:
    return {
        "code": "NOT_FOUND" if status == 404 else "INVALID_REQUEST",
        "message": message,
        "retryable": False,
    }


def read_string(params: dict[str, Any], field: str) -> str | None:
    value = params.get(field)
    return value if isinstance(value, str) and value else None


def control_action(action: str, params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """One control call, mirroring shared/server-node/testkit-controls.ts
    action for action. Not enabled means 404 for EVERY action — probing the
    surface from any other mode proves it is off."""
    if not testkit_enabled():
        return 404, error_body(404, "Not found.")
    # Read at call time: the fakes object is replaced per test.
    wallet, provider = openreceive_service.fakes.wallet, openreceive_service.fakes.provider
    if action in ("settle", "expire"):
        payment_hash = read_string(params, "payment_hash")
        if payment_hash is None:
            return 400, error_body(400, "payment_hash is required")
        try:
            if action == "settle":
                transaction = wallet.settle_invoice({"payment_hash": payment_hash}, notify=True)
            else:
                transaction = wallet.expire_invoice({"payment_hash": payment_hash})
        except KeyError as exc:
            return 404, error_body(404, str(exc.args[0]) if exc.args else "unknown invoice")
        return 200, {"ok": True, "transaction": transaction}
    if action == "swap-step":
        provider_order_id = read_string(params, "provider_order_id")
        pay_in_asset = read_string(params, "pay_in_asset")
        state = read_string(params, "state")
        if provider_order_id is None and pay_in_asset is None:
            return 400, error_body(400, "provider_order_id or pay_in_asset is required")
        if state is None or state not in SWAP_PROVIDER_STATES:
            return 400, error_body(400, f"state must be one of: {', '.join(SWAP_PROVIDER_STATES)}")
        selector: dict[str, str] = {}
        if provider_order_id is not None:
            selector["provider_order_id"] = provider_order_id
        if pay_in_asset is not None:
            selector["pay_in_asset"] = pay_in_asset
        if state == "refund_required":
            provider.force_refund_required(selector)
        elif state == "attention":
            provider.force_attention(
                selector, read_string(params, "attention_reason") or "provider_reported_emergency"
            )
        else:
            provider.script(selector, [state])
        return 200, {"ok": True, "state": state}
    if action == "state":
        return 200, {"wallet": {"invoices": wallet.list_invoices()}, "swap": provider.counters()}
    return 404, error_body(404, "Not found.")


@csrf_exempt
def control(request: HttpRequest, action: str = "") -> JsonResponse:
    params: dict[str, Any] = {}
    if request.method == "POST" and request.body:
        try:
            parsed = json.loads(request.body)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            params = parsed
    status, body = control_action(action, params)
    response = JsonResponse(body, status=status)
    response["Cache-Control"] = "no-store"
    return response
