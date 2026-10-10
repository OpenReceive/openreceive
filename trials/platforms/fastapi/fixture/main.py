import sqlite3
from contextlib import asynccontextmanager
from html import escape
from uuid import uuid4

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse

DB = "/data/shop.sqlite"
CATALOG = [
    ("Facet", "7.00", "facet"),
    ("Bezel", "12.00", "bezel"),
    ("Hinge", "4.00", "hinge"),
    ("Latch", "9.00", "latch"),
    ("Knob", "3.00", "knob"),
]


def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    return db


def init():
    db = connect()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          price TEXT NOT NULL,
          sku TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          product_name TEXT NOT NULL,
          amount TEXT NOT NULL,
          currency TEXT NOT NULL,
          status TEXT NOT NULL
        );
        """
    )
    for name, price, sku in CATALOG:
        db.execute(
            "INSERT INTO products (name, price, sku) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = ?)",
            (name, price, sku, sku),
        )
    db.commit()
    db.close()


def page(title, body):
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{escape(title)}</title></head>
<body><main><h1>{escape(title)}</h1>{body}</main></body>
</html>"""


def user_id(request: Request):
    return request.cookies.get("widget_user")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return PlainTextResponse("ok\n")


@app.get("/", response_class=HTMLResponse)
def index():
    db = connect()
    products = db.execute("SELECT id, name, price FROM products ORDER BY id").fetchall()
    db.close()
    items = "".join(
        f"""<li>
          {escape(product["name"])} — ${escape(product["price"])}
          <form method="post" action="/orders">
            <input type="hidden" name="product_id" value="{product["id"]}">
            <button type="submit">Buy</button>
          </form>
        </li>"""
        for product in products
    )
    return page("Widget Shop", f"<ul>{items}</ul>")


@app.post("/orders")
def create_order(request: Request, product_id: int = Form()):
    db = connect()
    product = db.execute("SELECT name, price FROM products WHERE id = ?", (product_id,)).fetchone()
    if product is None:
        db.close()
        return HTMLResponse(page("Not found", "<p>That product is not in the catalog.</p>"), status_code=404)
    existing = user_id(request)
    fresh = existing is None or db.execute("SELECT id FROM users WHERE id = ?", (existing,)).fetchone() is None
    current = str(uuid4()) if fresh else existing
    if fresh:
        db.execute("INSERT INTO users (id, created_at) VALUES (?, datetime('now'))", (current,))
    cursor = db.execute(
        "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES (?, ?, ?, 'USD', 'awaiting_payment')",
        (current, product["name"], product["price"]),
    )
    db.commit()
    order_id = cursor.lastrowid
    db.close()
    response = RedirectResponse(f"/orders/{order_id}", status_code=303)
    if fresh:
        response.set_cookie("widget_user", current, httponly=True, samesite="lax", path="/")
    return response


@app.get("/orders/{order_id}", response_class=HTMLResponse)
def show_order(order_id: int, request: Request):
    current = user_id(request)
    db = connect()
    order = db.execute(
        "SELECT id, product_name, amount, currency FROM orders WHERE id = ? AND user_id = ?",
        (order_id, current),
    ).fetchone()
    db.close()
    if order is None:
        return PlainTextResponse("That order is not yours.", status_code=404)
    return page(
        f"Order {order['id']}",
        f"<p>{escape(order['product_name'])} — ${escape(order['amount'])} {escape(order['currency'])}</p>"
        "<p>Awaiting payment. Online payments are not set up yet.</p>",
    )
