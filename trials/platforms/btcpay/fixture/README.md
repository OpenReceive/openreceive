# Widget Shop on BTCPay Server

Our BTCPay Server 2.4.5, run with Docker Compose. The Widget Shop store sells
five products through a Point of Sale app. It takes no payments yet: the
store has no wallet.

## Run

```sh
docker compose up -d
```

Compose publishes BTCPay's port 49392 on the host port set in `compose.yml`.
Print that address with:

```sh
docker compose port btcpayserver 49392
```

`.env` holds what the Greenfield API needs: `BTCPAY_URL`, `BTCPAY_API_KEY`
(an admin's key) and `BTCPAY_STORE_ID` for the Widget Shop store.
