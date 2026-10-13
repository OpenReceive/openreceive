# Widget Shop

A small Flask store. Five products, orders and customers in SQLite through
Flask-SQLAlchemy, pages are Jinja templates, and Flask-WTF's CSRF protection
covers every form. A customer is an id in Flask's signed session cookie.
There is no React, Vue, Svelte, or Angular app.

## Run

```sh
docker compose up --build
```

Compose publishes port 3000 of the `web` service on the host port set in
`compose.yml`. Print that address with:

```sh
docker compose port web 3000
```

The shop listens on that address. `GET /health` answers when it is up.
Gunicorn serves the app object `app` in `app.py`. Packages are installed into
the image. Rebuild after changing `requirements.txt`.
