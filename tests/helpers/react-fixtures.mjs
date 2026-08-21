// Shared fixtures for the tests/react-*.test.mjs suite.

export function invoice(overrides = {}) {
  const invoice = {
    invoice_id: overrides.invoice_id ?? "or_inv_test",
    invoice: overrides.invoice ?? "lnbc-test",
    payment_hash: overrides.payment_hash ?? "a".repeat(64),
    amount_msats: overrides.amount_msats ?? 200000,
    ...(Object.hasOwn(overrides, "fiat_quote")
      ? { fiat_quote: overrides.fiat_quote }
      : {
          fiat_quote: {
            fiat: {
              currency: "USD",
              value: "0.05",
            },
          },
        }),
    transaction_state: overrides.transaction_state ?? "pending",
    workflow_state: overrides.workflow_state ?? "invoice_created",
    ...(overrides.expires_at === undefined ? {} : { expires_at: overrides.expires_at }),
    ...(overrides.settled_at === undefined ? {} : { settled_at: overrides.settled_at }),
  };
  return {
    checkout_id: overrides.checkout_id ?? `or_chk_${invoice.invoice_id}`,
    order_id: overrides.order_id ?? `order_${invoice.invoice_id}`,
    status: overrides.status ?? "open",
    amount_msats: overrides.amount_msats ?? invoice.amount_msats,
    ...(overrides.fiat === undefined ? {} : { fiat: overrides.fiat }),
    active: invoice,
    invoices: [invoice],
    ...(overrides.paid_at === undefined ? {} : { paid_at: overrides.paid_at }),
  };
}
