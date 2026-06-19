# OpenReceive

OpenReceive is an open source receive-payments kit for apps that want to
create one Bitcoin Lightning BOLT11 invoice, show payer-side route suggestions,
and unlock fulfillment only after backend-verified settlement.

OpenReceive is not a bank, exchange, wallet, broker, custodian, or payment
processor. It does not transmit money or hold customer funds. A merchant brings
their own server-side Nostr Wallet Connect (NWC / NIP-47) connection to a wallet
they control, and OpenReceive helps the merchant backend create and verify
receive-only invoices.

The v0.1 work starts with the contract before the demo:

- `spec/` is the source of truth for schemas, shared data, and test vectors.
- `packages/js/` will hold the first Node and browser packages.
- `examples/` and `demos/` will prove the flow in real stacks after the
  contracts are green.
- `tools/` holds validation, conformance, and live-wallet smoke helpers.

## Current Status

This repository is at the v0.1 foundation stage. The first safe goal is to
freeze the shared contracts enough that package work can happen without each
SDK inventing payment semantics independently.

Run the current local checks:

```sh
npm test
```

Run the live-wallet smoke skeleton:

```sh
npm run test:live:nwc
```

The live smoke command skips when `OPENRECEIVE_NWC` is absent. Real live wallet
behavior will be wired in once the Node receive-checkout adapter exists.

## Product Boundary

OpenReceive creates one Lightning invoice and can show payer-side route
suggestions for wallets, exchanges, swap services, or fiat onramps that may be
able to pay that invoice. Provider routes are suggestions, not payment
guarantees. The payer chooses and uses third-party services outside
OpenReceive.

Browser, mobile, and static frontend code never receive NWC secrets. Live
checkout always needs a merchant-controlled backend component.
