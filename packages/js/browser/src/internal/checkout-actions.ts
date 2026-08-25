/// <reference path="../qrcode.d.ts" />

// What the payer can do with an invoice: render it as a QR (SVG or PNG data
// URL), copy it, or hand it to a wallet. Each action logs what it did and
// refuses anything `assertInvoice` rejects.

import * as defaultQrEncoder from "qrcode";
import {
  type CopyInvoiceOptions,
  OPENRECEIVE_QR_DARK_COLOR,
  OPENRECEIVE_QR_ERROR_CORRECTION,
  OPENRECEIVE_QR_LIGHT_COLOR,
  OPENRECEIVE_QR_QUIET_ZONE_MODULES,
  type QrEncoder,
  type QrOptions,
  type OpenWalletOptions,
} from "./ui.ts";
import { recordOrEmpty } from "@openreceive/core";
import { assertInvoice, createLightningUri } from "./checkout-invoice.ts";
import { emitBrowserLog } from "./checkout-log.ts";

export async function createQrSvg(invoice: string, options: QrOptions = {}): Promise<string> {
  return await createQrPayloadSvg(createLightningUri(invoice), options);
}

export async function createQrPayloadSvg(
  payload: string,
  options: QrOptions = {},
): Promise<string> {
  const encoder = getQrEncoder(options.encoder);
  const svg = await encoder.toString(payload, {
    type: "svg",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(svg);
}

export async function createQrPngDataUrl(
  invoice: string,
  options: QrOptions = {},
): Promise<string> {
  const encoder = getQrEncoder(options.encoder);

  if (encoder.toDataURL === undefined) {
    throw new Error("QR encoder does not support PNG data URL output.");
  }

  const png = await encoder.toDataURL(createLightningUri(invoice), {
    type: "image/png",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(png);
}

export async function copyInvoice(options: CopyInvoiceOptions): Promise<void> {
  assertInvoice(options.invoice);
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  if (clipboard === undefined) {
    throw new Error("Clipboard API is unavailable.");
  }

  await clipboard.writeText(options.invoice);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.invoice.copied",
    "Copied Lightning invoice to clipboard.",
    options.logContext,
  );
}

/**
 * Hand the invoice to the payer's wallet as a `lightning:` URI, and return the
 * URI. **Touch devices.**
 *
 * The default path is `location.assign` on the CURRENT window — the right
 * primitive for a custom-scheme deep link on a phone, and the wrong thing
 * anywhere else. With no registered `lightning:` handler the call does nothing
 * visible; with one, it navigates the payer off a checkout that is still
 * polling `/payments/check`. Pass `open` to route the URI somewhere that is not
 * the checkout window.
 *
 * This is why the shipped `<Checkout>` renders no wallet button of its own and
 * exposes `components.OpenWalletButton` as an opt-in slot instead: a desktop
 * payer is never sent to a handler that does not exist, next to the QR code
 * that IS the desktop payment path. A custom UI drawing its own button owns
 * that decision — see docs/guides/headless-checkout.md.
 */
export function openWallet(options: OpenWalletOptions): string {
  const uri = createLightningUri(options.invoice);

  if (options.open !== undefined) {
    options.open(uri);
    emitBrowserLog(
      options.logger,
      "info",
      "checkout.wallet.opened",
      "Opened Lightning invoice URI.",
      options.logContext,
    );
    return uri;
  }

  const location = globalThis.window?.location;
  if (location === undefined) {
    throw new Error("window.location is unavailable.");
  }

  location.assign(uri);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.wallet.opened",
    "Opened Lightning invoice URI.",
    options.logContext,
  );
  return uri;
}

function getQrEncoder(encoder: QrEncoder | undefined): QrEncoder {
  if (encoder !== undefined) return encoder;
  if (isQrEncoder(defaultQrEncoder)) return defaultQrEncoder;
  throw new Error("qrcode package did not expose a compatible encoder.");
}

function isQrEncoder(value: unknown): value is QrEncoder {
  const record = recordOrEmpty(value);
  // Every object inherits Object.prototype.toString, so probing for `toString`
  // alone accepts anything — and a wrong import would then silently render a QR
  // of "[object Object]". Require the module's own encoder entry points.
  return (
    typeof record.toString === "function" &&
    record.toString !== Object.prototype.toString &&
    (typeof record.create === "function" || typeof record.toDataURL === "function")
  );
}
