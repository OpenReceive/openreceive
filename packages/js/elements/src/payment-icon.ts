// The payment-method icons, drawn INLINE. @openreceive/browser compiles the
// SVG markup in (`paymentIconSvgs`), and this element renders into a shadow
// root, so the markup can go straight into the tree: no image request, no
// `img-src` rule, no page CSS reaching in, no ids leaking out. This is the one
// place inline SVG is allowed: the strings are first-party and gated at build
// time by tools/package/generate-payment-icons.mjs (no script, handlers,
// foreign content or external references). Never route host- or
// payer-supplied markup through here.
//
// A host resolver (`resolveAssetUrl` / `asset-base-url`) still wins and keeps
// the `<img>` form: that host serves the files itself and chose to.
import {
  type AssetUrlResolver,
  escapeHtml,
  type PaymentIconId,
  paymentIconPaths,
  paymentIconSvgs,
} from "@openreceive/browser/headless";

export interface PaymentIconHtmlOptions {
  readonly className: string;
  /** What the icon stands for — the tile's own title, network or route label. */
  readonly label: string;
  readonly resolveAssetUrl?: AssetUrlResolver | undefined;
}

export function renderPaymentIconHtml(id: PaymentIconId, options: PaymentIconHtmlOptions): string {
  if (options.resolveAssetUrl !== undefined) {
    const src = escapeHtml(options.resolveAssetUrl(paymentIconPaths[id]));
    return `<img class="${options.className}" alt="" src="${src}">`;
  }
  // The source may carry its own role/aria-label (some icons ship one for
  // standalone use); the rendered element speaks for THIS tile.
  return paymentIconSvgs[id].replace(
    /^<svg\b([^>]*)>/,
    (_match, attributes: string) =>
      `<svg${attributes.replace(/\s(?:class|role|aria-label)="[^"]*"/g, "")} class="${options.className}" role="img" aria-label="${escapeHtml(options.label)}">`,
  );
}
