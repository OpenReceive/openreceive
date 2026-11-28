/**
 * True once the shop has a wallet code to create invoices with. Read on every
 * request, so a page shows the setup steps instead of failing at checkout.
 */
export function walletConfigured(): boolean {
  return Boolean(process.env.NWC_URI?.trim());
}
