# BTCPay plugin manual E2E checklist

The regtest stack (`packages/dotnet/docker/up.sh` + `e2e.sh`) proves the
plugin against fakes: a testkit NWC wallet and a fake provider. This is the
list of things only a real wallet, a real provider and a second plugin can
prove. It is a checklist, not a record of a run: tick it per release and
write the date and BTCPay version next to each item in the release notes.
None of it runs in CI.

## Mutinynet: BTCPay + Alby Hub

BTCPay's `docker-compose.mutinynet.yml` in the BTCPay repository plus an Alby
Hub on mutinynet (the hub's local compose), and a second Alby Hub as the
payer.

- [ ] In Alby Hub, create an app connection with only the receive scopes
      (`make_invoice`, `list_transactions`, `lookup_invoice` optional,
      `get_info`, notifications). Paste it on the setup page. **Test
      connection** reports `nip44_v2`, `payment_received`, network `signet`,
      and no spend methods.
- [ ] The BTCPay log carries the `nwc.preflight.ok … encryption=nip44_v2`
      line and no line contains the secret (grep for `secret=` and the
      64-hex value).
- [ ] **Use as this store's Lightning node** succeeds; Store → Lightning
      shows `type=openreceive;nwc=…` (redacted on the OpenReceive page).
- [ ] Create an invoice; pay it from the second hub. The invoice turns
      `Settled` on the `nwc.notification.received` line, not on a scan
      (`nwc.scan.settled` absent for that hash).
- [ ] Disable notifications on the connection (or use a wallet without
      them); pay again. The invoice settles from the scan within 12 s.
- [ ] Restart BTCPay with a pending invoice open; pay it after the restart.
      One `nwc.scan.memo` line serves the startup `GetInvoice` pass; the
      invoice settles.
- [ ] Create a connection that also grants `pay_invoice`. The setup page
      refuses it with `spend_capability_advertised`; with the override
      ticked it saves and the log carries the spend-capability warning.
- [ ] Create a top-up (amountless) invoice. BTCPay shows the payment method
      unavailable with the plugin's "top-up invoices are not supported"
      message; the doctor lists the probe.
- [ ] Lightning address / LNURL-pay on the store still works
      (`description_hash` invoices mint in the hub).
- [ ] Let an invoice expire unpaid. BTCPay marks it expired on its own
      clock; the plugin logs no `Expired` from `GetInvoice`.

## Nostr plugin coexistence

Install Kukks' Nostr plugin (`BTCPayServer.Plugins.NIP05`) alongside.

- [ ] Both plugins load; the store navigation shows both entries.
- [ ] A store with `type=openreceive;nwc=…` still mints and settles through
      OpenReceive (the `DisplayName` on the Lightning page says
      "OpenReceive (receive-only NWC)").
- [ ] A bare `nostr+walletconnect://…` pasted into the Lightning node screen
      goes to the Nostr plugin, not ours; the OpenReceive accordion on that
      screen says so.
- [ ] `type=nwc;key=…` goes to the Nostr plugin.
- [ ] Uninstall the Nostr plugin; the OpenReceive store is unaffected.

## Real provider, once per release

A real Lightning Swap Connect provider with a real key. Small amounts.

- [ ] **Test provider** lists the catalog with limits.
- [ ] Enable swaps; the store's invoice expiration is raised to 60 minutes
      when it was shorter.
- [ ] Create an invoice; pick a stablecoin pill; send the exact deposit
      amount. The state walks `awaiting_deposit → confirming → exchanging →
      … → completed`, the BOLT11 is paid into the wallet, the BTCPay
      invoice turns `Settled`, and the row shows "Lightning settled" on the
      invoice page.
- [ ] Underpay a second swap. The provider reports `refund_required`; the
      checkout shows the refund form; a wrong-checksum address is refused;
      a good one moves the row to `refund_pending`, then `refunded` with a
      `refund_tx_id` on the invoice page.
- [ ] Close the tab mid-swap, reopen the invoice's checkout page, pick the
      same asset: the same order (same deposit address) is re-served.
- [ ] Partially pay an invoice over Lightning, then confirm no swap pills
      are offered and an existing swap row carries
      `invoice_reminted_after_partial_payment`.
- [ ] Greenfield `GET …/openreceive/swaps` and
      `…/invoices/{id}/swaps` return the rows without a token.
- [ ] The doctor's "Swaps needing attention" is zero at the end, or names
      the row you expect.

## Record

Date, BTCPay version, plugin version, wallet, provider, and any item that
did not pass, in the release PR. An item that cannot be run (no provider
key, no second hub) is written down as skipped, never ticked.
