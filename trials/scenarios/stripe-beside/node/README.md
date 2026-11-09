# Widget Shop

A small Express store. Five products, orders and customers in SQLite, pages are server-rendered HTML. There is no React, Vue, Svelte, or Angular app.

Customers can already pay by card: `routes/stripe.js` is the Stripe route (a stubbed Stripe client in `lib/stripe.js`, because the shop's staging keys stay offline), and `test/stripe.test.js` covers it.

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
Its tests run with `npm test`.
