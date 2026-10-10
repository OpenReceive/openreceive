# Widget Shop

A small Laravel store. Five products, orders and customers in SQLite, pages are Blade. There is no React, Vue, Svelte, or Angular app.

## Run

```sh
docker compose up --build
```

Compose publishes port 3000 of the `web` service on the host port set in
`compose.yml`. Print that address with:

```sh
docker compose port web 3000
```

`GET /health` answers when it is up. Composer packages are installed into the image. Rebuild after changing `composer.json`.
