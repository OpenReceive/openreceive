import uuid

from flask import Flask, abort, redirect, render_template, request, session
from flask_sqlalchemy import SQLAlchemy
from flask_wtf.csrf import CSRFProtect

CATALOG = [
    ("Facet", "7.00", "facet"),
    ("Bezel", "12.00", "bezel"),
    ("Hinge", "4.00", "hinge"),
    ("Latch", "9.00", "latch"),
    ("Knob", "3.00", "knob"),
]

app = Flask(__name__)
app.config["SECRET_KEY"] = "widget-shop-development-key"
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:////data/shop.sqlite"
csrf = CSRFProtect(app)
db = SQLAlchemy(app)


class Product(db.Model):
    __tablename__ = "products"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    price = db.Column(db.String(16), nullable=False)
    sku = db.Column(db.String(40), nullable=False, unique=True)


class Customer(db.Model):
    __tablename__ = "customers"
    id = db.Column(db.String(36), primary_key=True)


class Order(db.Model):
    __tablename__ = "orders"
    id = db.Column(db.Integer, primary_key=True)
    customer_id = db.Column(db.String(36), db.ForeignKey("customers.id"), nullable=False)
    product_name = db.Column(db.String(80), nullable=False)
    amount = db.Column(db.String(16), nullable=False)
    currency = db.Column(db.String(3), nullable=False, default="USD")
    status = db.Column(db.String(32), nullable=False, default="awaiting_payment")


with app.app_context():
    db.create_all()
    for name, price, sku in CATALOG:
        if db.session.execute(db.select(Product).filter_by(sku=sku)).scalar_one_or_none() is None:
            db.session.add(Product(name=name, price=price, sku=sku))
    db.session.commit()


def current_customer():
    customer_id = session.get("customer_id")
    return db.session.get(Customer, customer_id) if customer_id else None


@app.get("/health")
def health():
    return "ok\n", 200, {"Content-Type": "text/plain"}


@app.get("/")
def index():
    products = db.session.execute(db.select(Product).order_by(Product.id)).scalars()
    return render_template("index.html", products=products)


@app.post("/orders")
def create_order():
    product = db.session.get(Product, request.form.get("product_id", type=int))
    if product is None:
        abort(404)
    customer = current_customer()
    if customer is None:
        customer = Customer(id=str(uuid.uuid4()))
        db.session.add(customer)
        session["customer_id"] = customer.id
    order = Order(customer_id=customer.id, product_name=product.name, amount=product.price)
    db.session.add(order)
    db.session.commit()
    return redirect(f"/orders/{order.id}", 303)


@app.get("/orders/<int:order_id>")
def show_order(order_id):
    order = db.session.get(Order, order_id)
    customer = current_customer()
    if order is None or customer is None or order.customer_id != customer.id:
        abort(404)
    return render_template("order.html", order=order)
