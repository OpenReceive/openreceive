"""The `/__testkit` control surface (docs/internal/testkit-contract.md), live
only when the demo booted with `DEMO_WALLET=testkit`; a JSON 404 on the whole
prefix otherwise, which is how a probe proves it is off. Maps straight onto
the `openreceive.testing` fakes and never touches the shop's own tables."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from openreceive.testing import FakeSwapProvider, FakeWallet

SWAP_STATES = (
    "creating_provider_order", "awaiting_deposit", "confirming", "exchanging", "paying_invoice",
    "completed", "expired", "refund_required", "refund_pending", "refunded", "attention", "failed",
)


def error(status: int, message: str) -> JSONResponse:
    code = "NOT_FOUND" if status == 404 else "INVALID_REQUEST"
    return JSONResponse({"code": code, "message": message, "retryable": False}, status_code=status)


def testkit_router(fixtures: tuple[FakeWallet, FakeSwapProvider] | None) -> APIRouter:
    router = APIRouter()

    @router.api_route("/{action:path}", methods=["GET", "POST"], include_in_schema=False)
    async def control(request: Request, action: str) -> JSONResponse:
        if fixtures is None:
            return error(404, "Not found.")
        wallet, swap = fixtures
        body: dict[str, Any] = {}
        if request.method == "POST":
            raw = await request.json() if (await request.body()) else {}
            body = raw if isinstance(raw, dict) else {}
        if action in ("settle", "expire"):
            payment_hash = body.get("payment_hash")
            if not isinstance(payment_hash, str) or not payment_hash:
                return error(400, "payment_hash is required")
            try:
                transaction = (
                    wallet.settle_invoice(payment_hash, notify=True)
                    if action == "settle"
                    else wallet.expire_invoice(payment_hash)
                )
            except Exception as failure:
                return error(404, str(failure))
            return JSONResponse({"ok": True, "transaction": transaction})
        if action == "swap-step":
            selector = {
                key: body[key] for key in ("pay_in_asset", "provider_order_id") if isinstance(body.get(key), str)
            }
            state = body.get("state")
            if not selector:
                return error(400, "provider_order_id or pay_in_asset is required")
            if state not in SWAP_STATES:
                return error(400, f"state must be one of: {', '.join(SWAP_STATES)}")
            if state == "refund_required":
                swap.force_refund_required(selector)
            elif state == "attention":
                reason = body.get("attention_reason")
                swap.force_attention(selector, reason if isinstance(reason, str) else None)
            else:
                swap.script(selector, [state])
            return JSONResponse({"ok": True, "state": state})
        if action == "state":
            return JSONResponse({"wallet": {"invoices": wallet.list_invoices()}, "swap": swap.counters()})
        return error(404, "Not found.")

    return router
