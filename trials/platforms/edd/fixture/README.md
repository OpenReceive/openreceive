# Widget Downloads

A small Easy Digital Downloads store. Five downloads, orders in EDD, customers sign in with WordPress.

## Run

```sh
docker compose up
```

Compose publishes port 80 of the `wordpress` service on the host port set in
`compose.yml`. Print that address with:

```sh
docker compose port wordpress 80
```

WP-CLI is the `cli` service, run from this directory:

```sh
docker compose run --rm -T cli wp plugin list
```

The admin user is `shop`.
