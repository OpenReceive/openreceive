# OpenReceive Flask starter

A one-product shop on Flask that takes Bitcoin payments over Lightning,
paid straight into your own wallet. Orders and payment attempts live in the
shop's own database: SQLite by default, or Postgres. There is no OpenReceive
account, no JavaScript build and no worker process: payments settle during
normal requests.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH** instead.
A swap provider you configure converts the payment to **BTC over Lightning**,
which settles into the same wallet. Available assets and networks depend on
the provider; swaps are optional.

## Run it

Requires Docker. Copy this folder into a project of your own:

```sh
npx degit OpenReceive/openreceive/examples/flask-starter my-shop
cd my-shop
cp env.example .env   # then fill in NWC_URI and SECRET_KEY
docker compose up --build
```

`NWC_URI` is a receive-only code from your Lightning wallet
([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)). To
accept swaps, also set `LSC_URI_PRIMARY`
([set up a swap provider](https://openreceive.org/set_up_swap_provider)).
Without `NWC_URI` the server stops at start and says where to get one.

Open http://localhost:5000 and buy the sticker to see a Lightning invoice.
To check the setup, run doctor in the container:

```sh
docker compose exec web openreceive doctor --app app:openreceive --url http://127.0.0.1:5000
```

Without Docker, use Python 3.10 or newer: `pip install -r requirements.txt`,
set `DATABASE_URL=sqlite:///shop.sqlite3`, then
`flask --app app run` (Flask loads `.env` when python-dotenv is installed).

## How it fits together

| File | What it does |
| --- | --- |
| `app.py` | The pages, order creation, the tables, and the three hooks: `amount_for`, `authorize` and `on_paid` |
| `openreceive_flask.py` | The OpenReceive routes as a Flask Blueprint. Copied from the [Flask quickstart](https://openreceive.org/guides/quickstart-flask) |
| `templates/` | The shop's pages. `order.html` renders the checkout |

The order's id is the payment reference. `authorize` lets only the browser
whose session created the order pay for it, and `on_paid` marks the order
paid inside the settlement transaction. Flask-WTF's CSRF protection covers
the payment routes too: the checkout sends the page's token in `X-CSRFToken`.

The checkout is the `<openreceive-checkout>` element. Its script and
stylesheet ship inside the `openreceive` Python package, and the server sends
them from the installed copy, so there is nothing to build.

The full walkthrough is the [Flask quickstart](https://openreceive.org/guides/quickstart-flask).
