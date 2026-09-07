// Payment-method icons. Everything the checkout draws ships inside the
// JavaScript: the SVG markup is compiled into this package (see
// ../generated/payment-icon-svgs.ts), so nothing here depends on where the
// module was loaded from and no host copies, serves or resolves an icon file,
// under any bundler or with none. The same strings back two representations —
//
// - `paymentIconSvgs`: raw markup, which the shipped custom element draws
//   inline in its shadow root (no CSP image rule, no page-CSS bleed).
// - `paymentIconUrls`: `data:image/svg+xml` URIs derived from it, for every
//   seam that carries a URL string — display models, `<img src>`, the React
//   wrapper, headless hosts.
import {
  OPENRECEIVE_PAYMENT_ICON_IDS,
  type PaymentIconId,
  paymentIconSvgs,
} from "../generated/payment-icon-svgs.ts";
import type { PaymentMethod } from "./checkout-types.ts";

export { type PaymentIconId, paymentIconSvgs };

/**
 * Percent-encoded, not base64: smaller, and the markup stays readable in the
 * DOM inspector. Only the characters that break a URL or an HTML attribute are
 * encoded; `decodeURIComponent` of the payload gives the SVG back byte-for-byte.
 */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${svg.replace(/[%#"<>&]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Each packaged payment icon as a `data:image/svg+xml` URI, keyed by id. */
export const paymentIconUrls: Readonly<Record<PaymentIconId, string>> = Object.freeze(
  Object.fromEntries(
    OPENRECEIVE_PAYMENT_ICON_IDS.map((id) => [id, svgDataUri(paymentIconSvgs[id])]),
  ),
) as Readonly<Record<PaymentIconId, string>>;

export const paymentMethodIconIds: Readonly<Record<PaymentMethod, PaymentIconId>> = {
  bitcoin: "btc",
} as const;

export const assetIconIds: Readonly<Record<string, PaymentIconId>> = {
  btc: "btc",
  eth: "eth",
  ltc: "ltc",
  sol: "sol",
  trx: "trx",
  usdc: "usdc",
  usdt: "usdt",
  xmr: "xmr",
  xrp: "xrp",
} as const;
