import { fossbillingPayerOrders } from "./fossbilling.ts";
import { medusaPayerOrders } from "./medusa.ts";
import { odooPayerOrders } from "./odoo.ts";
import type { PlaceOrder } from "./payer.ts";
import { paymenterPayerOrders } from "./paymenter.ts";
import { prestashopPayerOrders } from "./prestashop.ts";
import type { Platform } from "./types.ts";
import { vendurePayerOrders } from "./vendure.ts";
import { wordpressKind, wordpressPayerOrders } from "./wordpress.ts";

// How the payer walk (payer.ts) reaches each platform's checkout.

/**
 * BTCPay shows its own checkout, not ours, and Bolt's routes are on another
 * site: those two stay out of the walk.
 */
export function hasPayerWalk(platform: Pick<Platform, "host">): boolean {
  return platform.host !== "btcpay" && platform.host !== "bolt";
}

/** The platform's own way to the checkout; undefined for the framework fixtures' home-page form. */
export function payerOrders(
  platform: Pick<Platform, "slug" | "directions_slug" | "host">,
  directory: string,
  baseUrl: string,
): PlaceOrder | undefined {
  const wordpress = wordpressKind(platform);
  if (wordpress !== undefined) return wordpressPayerOrders(wordpress, baseUrl);
  switch (platform.host) {
    case "paymenter":
      return paymenterPayerOrders(baseUrl);
    case "fossbilling":
      return fossbillingPayerOrders(baseUrl);
    case "prestashop":
      return prestashopPayerOrders(baseUrl);
    case "odoo":
      return odooPayerOrders(baseUrl);
    case "medusa":
      return medusaPayerOrders(baseUrl);
    case "vendure":
      return vendurePayerOrders(directory, baseUrl);
    default:
      return undefined;
  }
}
