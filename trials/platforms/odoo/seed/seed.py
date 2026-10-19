# Fills a new Odoo database that has eCommerce installed with a small widget
# shop: the five trial products, published, at the trial's prices with no tax,
# and two portal customers the live checks sign in as. The harness pipes it
# into `odoo shell` once, before the agent sees the shop; the agent does not.
# `env` is the shell's environment.

from odoo import Command

company = env.company  # noqa: F821
company.name = "Widget Shop"
usd = env.ref("base.USD")  # noqa: F821
if company.currency_id != usd:
    company.currency_id = usd

catalog = [
    ("Facet", 7.0, "facet"),
    ("Bezel", 12.0, "bezel"),
    ("Hinge", 4.0, "hinge"),
    ("Latch", 9.0, "latch"),
    ("Knob", 3.0, "knob"),
]
Product = env["product.template"]  # noqa: F821
for name, price, code in catalog:
    product = Product.search([("default_code", "=", code)], limit=1)
    values = {
        "name": name,
        "list_price": price,
        "default_code": code,
        "sale_ok": True,
        "is_published": True,
        "taxes_id": [Command.clear()],
    }
    if product:
        product.write(values)
    else:
        Product.create(values)

portal = env.ref("base.group_portal")  # noqa: F821
Users = env["res.users"].with_context(no_reset_password=True)  # noqa: F821
for login, name in (
    ("buyer@example.test", "Demo Buyer"),
    ("stranger@example.test", "Other Customer"),
):
    user = Users.search([("login", "=", login)], limit=1)
    if not user:
        user = Users.create(
            {
                "name": name,
                "login": login,
                "email": login,
                "password": "widget-shop-local",
                "group_ids": [Command.set([portal.id])],
            }
        )
    user.partner_id.write(
        {
            "street": "1 Widget Way",
            "city": "Springfield",
            "zip": "12345",
            "country_id": env.ref("base.us").id,  # noqa: F821
            "state_id": env.ref("base.state_us_5").id,  # noqa: F821
            "phone": "+1 555 0100",
        }
    )

env.cr.commit()  # noqa: F821
print(
    Product.search_count(
        [("is_published", "=", True), ("default_code", "in", [c for _, _, c in catalog])]
    )
)
