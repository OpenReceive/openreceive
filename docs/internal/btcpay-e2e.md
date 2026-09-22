# BTCPay plugin manual E2E checklist

The regtest stack (`packages/dotnet/docker/up.sh` + `e2e.sh`) proves the
plugin against fakes: a testkit NWC wallet and a fake provider. This page lists
what only a real wallet, a real provider and a second plugin can prove.
It is a checklist, not a record of a run. Tick it for each release, and
write the date and BTCPay version next to each item in the release notes.
None of it runs in CI.

## Mutinynet: BTCPay + Alby Hub

Setup: BTCPay's `docker-compose.mutinynet.yml` from the BTCPay repository, an Alby
Hub on mutinynet (run with the hub's local compose), and a second Alby Hub as the
payer.

- [ ] In Alby Hub, create an app connection with only the receive scopes
      (`make_invoice`, `list_transactions`, `lookup_invoice` optional,
      `get_info`, notifications). Paste it on the setup page. **Test
      connection** reports `nip44_v2`, `payment_received`, network `signet`,
      and no spend methods.
- [ ] The BTCPay log has the `nwc.preflight.ok … encryption=nip44_v2`
      line. No line contains the secret. Grep for `secret=` and the
      64-hex value.
- [ ] **Save NWC Code** succeeds; Store → Lightning
      shows `type=openreceive;nwc=…` (redacted on the OpenReceive page).
- [ ] Create an invoice and pay it from the second hub. The invoice turns
      `Settled` on the `nwc.notification.received` line, not on a scan.
      There is no `nwc.scan.settled` line for that hash.
- [ ] Disable notifications on the connection, or use a wallet without
      them. Pay again. The invoice settles from the scan within 12 s.
- [ ] Restart BTCPay with a pending invoice open, and pay it after the restart.
      One `nwc.scan.memo` line serves the startup `GetInvoice` pass. The
      invoice settles.
- [ ] Create a connection that also grants `pay_invoice`. The setup page
      refuses it with `spend_capability_advertised`. With the override
      ticked, it saves and the log has the spend-capability warning.
- [ ] Create a top-up (amountless) invoice. BTCPay shows the payment method
      as unavailable, with the plugin's "top-up invoices are not supported"
      message. The doctor lists the probe.
- [ ] Lightning address / LNURL-pay on the store still works
      (`description_hash` invoices mint in the hub).
- [ ] Let an invoice expire unpaid. BTCPay marks it expired on its own
      clock. The plugin logs no `Expired` from `GetInvoice`.

## Nostr plugin coexistence

Install Kukks' Nostr plugin (`BTCPayServer.Plugins.NIP05`) next to ours.

- [ ] Both plugins load. The store navigation shows both entries.
- [ ] A store with `type=openreceive;nwc=…` still mints and settles through
      OpenReceive. The `DisplayName` on the Lightning page says
      "OpenReceive (receive-only NWC)".
- [ ] A bare `nostr+walletconnect://…` pasted into the Lightning node screen
      goes to the Nostr plugin, not ours. The OpenReceive accordion on that
      screen says so.
- [ ] `type=nwc;key=…` goes to the Nostr plugin.
- [ ] Uninstall the Nostr plugin. The OpenReceive store is unaffected.

## Real provider, once per release

Use a real Lightning Swap Connect provider with a real key, and small amounts.

- [ ] **Test provider** lists the catalog with limits.
- [ ] Enable swaps. If the store's invoice expiration was shorter than 60 minutes,
      it is raised to 60 minutes.
- [ ] Create an invoice, pick a stablecoin pill, and send the exact deposit
      amount. The state moves through `awaiting_deposit → confirming → exchanging →
      … → completed`. The BOLT11 is paid into the wallet, the BTCPay
      invoice turns `Settled`, and the row shows "Lightning settled" on the
      invoice page.
- [ ] Underpay a second swap. The provider reports `refund_required` and the
      checkout shows the refund form. An address with a wrong checksum is refused.
      A good one moves the row to `refund_pending`, then to `refunded`, with a
      `refund_tx_id` on the invoice page.
- [ ] Close the tab mid-swap, reopen the invoice's checkout page, and pick the
      same asset. The same order, with the same deposit address, is served again.
- [ ] Partially pay an invoice over Lightning. Confirm that no swap pills
      are offered and that an existing swap row carries
      `invoice_reminted_after_partial_payment`.
- [ ] Greenfield `GET …/openreceive/swaps` and
      `…/invoices/{id}/swaps` return the rows without a token.
- [ ] The doctor's "Swaps needing attention" is zero at the end, or names
      the row you expect.

## Record

In the release PR, record the date, BTCPay version, plugin version, wallet,
provider, and any item that did not pass. If an item cannot be run (no provider
key, no second hub), write it down as skipped. Never tick it.
