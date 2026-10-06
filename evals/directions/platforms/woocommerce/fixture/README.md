# Widget Shop

A small WooCommerce store. Five products, orders in WooCommerce, customers sign in with WordPress.

## Run

```sh
docker compose up
```

Compose publishes port 80 of the `wordpress` service on a host port chosen when the
stack starts. Print that address with:

```sh
docker compose port wordpress 80
```

WP-CLI is the `cli` service, run from this directory:

```sh
docker compose run --rm -T cli wp plugin list
```

The admin user is `shop`.
