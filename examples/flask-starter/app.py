"""A one-product Flask shop that takes Bitcoin over Lightning with OpenReceive."""

import os
import uuid
from decimal import Decimal
from importlib.resources import files

from flask import Flask, abort, redirect, render_template, send_from_directory, session
from flask_sqlalchemy import SQLAlchemy
from flask_wtf.csrf import CSRFProtect
from openreceive_flask import OpenReceiveFlask
from sqlalchemy import create_engine, inspect, text
from werkzeug.middleware.proxy_fix import ProxyFix

from openreceive.server import Host
from openreceive.storage.sql import payments_ddl_statements

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:////data/shop.sqlite3")

# The shop's one product. Prices are decimal strings: OpenReceive converts the
# order's own amount into the Lightning invoice and never reads a price from
# the browser.
PRODUCT = {"name": "Demo sticker", "price": "5.00", "currency": "USD"}

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or os.urandom(32)
app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URL
# One proxy in front (a load balancer, Caddy, nginx): the rate limiter then
# counts each payer's own IP rather than the proxy's.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
CSRFProtect(app)
db = SQLAlchemy(app)


class Order(db.Model):
    __tablename__ = "orders"
    id = db.Column(db.Integer, primary_key=True)
    visitor = db.Column(db.String(36), nullable=False)
    product_name = db.Column(db.String(255), nullable=False)
    amount = db.Column(db.String(32), nullable=False)
    currency = db.Column(db.String(3), nullable=False)
    status = db.Column(db.String(32), nullable=False, default="awaiting_payment")


def find_order(reference):
    reference = str(reference or "")
    return db.session.get(Order, int(reference)) if reference.isdigit() else None


host = Host(
    # The price comes from the order row, never from the request.
    amount_for=lambda reference: (
        {"currency": order.currency, "value": order.amount, "description": order.product_name}
        if (order := find_order(reference)) is not None and order.status == "awaiting_payment"
        else None
    ),
    # Only the browser that created the order may pay for it.
    authorize=lambda context: (
        (order := find_order(context.resource.get("reference"))) is not None
        and order.visitor == session.get("visitor")
    ),
    # Runs once, inside the settlement transaction: write through its connection.
    on_paid=lambda settlement: settlement.connection.execute(
        text("UPDATE orders SET status = 'paid' WHERE id = :id AND status = 'awaiting_payment'"),
        {"id": int(settlement.reference)},
    ),
)

# OpenReceive's own Engine on the same database. On SQLite it must not be
# Flask-SQLAlchemy's: the repository sets it up for one writer at a time.
payments_engine = create_engine(DATABASE_URL)
openreceive = OpenReceiveFlask(host, payments_engine, rate_limiting=True)
app.register_blueprint(openreceive.blueprint())

# The drop-in checkout ships inside the openreceive package: one ES module and
# one stylesheet, served from the installed copy, so there is nothing to build.
CHECKOUT_ASSETS = str(files("openreceive") / "django" / "static" / "openreceive")


@app.get("/checkout-assets/<path:name>")
def checkout_assets(name):
    return send_from_directory(CHECKOUT_ASSETS, name)


@app.get("/")
def index():
    return render_template("index.html", product=PRODUCT)


@app.post("/orders")
def create_order():
    visitor = session.setdefault("visitor", str(uuid.uuid4()))
    order = Order(
        visitor=visitor,
        product_name=PRODUCT["name"],
        amount=str(Decimal(PRODUCT["price"])),
        currency=PRODUCT["currency"],
    )
    db.session.add(order)
    db.session.commit()
    return redirect(f"/orders/{order.id}", 303)


# The order's own URL. A payer can reload or bookmark it to come back to a
# pending payment or a swap refund.
@app.get("/orders/<int:order_id>")
def show_order(order_id):
    order = db.session.get(Order, order_id)
    if order is None or order.visitor != session.get("visitor"):
        abort(404)
    return render_template("order.html", order=order)


@app.get("/health")
def health():
    return "ok\n", 200, {"Content-Type": "text/plain"}


def create_tables():
    """The shop's table and OpenReceive's two, at every start. The payment
    tables' DDL runs once: their presence is the marker."""
    with app.app_context():
        db.create_all()
    if not inspect(payments_engine).has_table("openreceive_payments"):
        with payments_engine.begin() as connection:
            for statement in payments_ddl_statements(payments_engine.dialect.name):
                connection.execute(text(statement))


create_tables()
# The receive-only wallet check: a missing or spend-capable code stops the
# server here, not at the first payer.
openreceive.start()
