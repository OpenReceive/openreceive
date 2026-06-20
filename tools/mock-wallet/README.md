# OpenReceive Mock Wallet

`tools/mock-wallet` is a deterministic local service for conformance tests. It
uses `@openreceive/testkit` under the hood and returns non-payable invoice
fixtures. It does not replace live NWC wallet profile tests.

Start it with:

```sh
npm run mock-wallet
```

Useful environment variables:

```text
OPENRECEIVE_MOCK_WALLET_HOST=127.0.0.1
OPENRECEIVE_MOCK_WALLET_PORT=3798
OPENRECEIVE_MOCK_NWC=nostr+walletconnect://...
```

The default `OPENRECEIVE_MOCK_NWC` is a deterministic test URI. The service logs
the redacted URI and never needs real wallet funds.

## Endpoints

- `GET /healthz`
- `GET /nwc/get_info`
- `POST /nwc/make_invoice`
- `POST /nwc/lookup_invoice`
- `GET /nwc/invoices`
- `GET /notifications`
- `POST /control/settle`
- `POST /control/expire`
- `POST /control/fail`
- `POST /control/replay-notification`

`/notifications` is an SSE stream that emits `payment_received` events after
`/control/settle` or `/control/replay-notification`.

Example:

```sh
curl -sS -X POST http://127.0.0.1:3798/nwc/make_invoice \
  -H 'content-type: application/json' \
  -d '{"amount_msats":"200000","description":"Fruit sticker"}'
```

This tool is intentionally not a Nostr relay and does not prove real BOLT11
invoice creation, NIP-04/NIP-44 compatibility with a real wallet, Lightning
routing, or human payment UX.
