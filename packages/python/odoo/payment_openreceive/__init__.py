import base64
from pathlib import Path

from odoo import Command
from odoo.addons.payment import reset_payment_provider, setup_provider

from . import const, controllers, models, runtime

METHOD_XMLID = "payment_method_openreceive"
STATIC = Path(__file__).resolve().parent / "static"


def _image(relative):
    """Base64 text: the one image value Odoo 19 and 20 both accept."""
    return base64.b64encode((STATIC / relative).read_bytes()).decode()


def _payment_method_values(env, provider):
    values = {
        "name": const.PAYMENT_METHOD_NAME,
        "code": const.PAYMENT_METHOD_CODE,
        "sequence": 1,
        "active": True,
        "image": _image("img/openreceive.png"),
        "support_tokenization": False,
        "support_express_checkout": False,
        "support_manual_capture": "none",
        "support_refund": "none",
    }
    # Odoo 20 gives each payment method one provider; Odoo 19 shares methods.
    if "provider_id" in env["payment.method"]._fields:
        values["provider_id"] = provider.id
    else:
        values["provider_ids"] = [Command.link(provider.id)]
    return values


def post_init_hook(env):
    provider = env.ref("payment_openreceive.payment_provider_openreceive")
    if not provider.image_128:
        provider.image_128 = _image("description/icon.png")
    method = env.ref(f"payment_openreceive.{METHOD_XMLID}", raise_if_not_found=False)
    if method is None:
        method = env["payment.method"].create(_payment_method_values(env, provider))
        env["ir.model.data"].create(
            {
                "module": "payment_openreceive",
                "name": METHOD_XMLID,
                "model": "payment.method",
                "res_id": method.id,
                "noupdate": True,
            }
        )
    setup_provider(env, const.CODE)


def uninstall_hook(env):
    reset_payment_provider(env, const.CODE)
    # The payment tables stay: they record payments received. The codes go.
    for key in const.CODE_KEYS:
        runtime.write_code(env.cr, key, None)
    runtime.forget_apps()
