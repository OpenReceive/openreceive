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

/**
 * A QR that follows a changing payload, without every host rewriting the same
 * effect.
 *
 * {@link createQrSvg} and {@link createQrPayloadSvg} are ASYNC, and that is the
 * trap: `dangerouslySetInnerHTML={{ __html: createQrSvg(invoice) }}` type-checks
 * (React types `__html` as `string | TrustedHTML`, and `TrustedHTML` is an empty
 * interface every object satisfies) and paints the literal text
 * "[object Promise]" inside the QR box. Resolving it by hand then needs the
 * other half nobody writes the first time: a slow encode that lands AFTER the
 * payload changed must not paint the old QR over the new one.
 *
 * So: call `show`/`showPayload` whenever the payload changes and render what
 * `onValue` last handed you. Only the newest call can publish — an earlier
 * encode still in flight is dropped, resolved or rejected. `stop()` drops the
 * one in flight, for a host going away. Same shape as
 * {@link createTickingValueController}: DOM-free, framework-free, one
 * implementation instead of one per renderer.
 */
export interface QrSvgControllerOptions {
  /** The newest encoded SVG. Not called for a superseded or stopped encode. */
  onValue(svg: string): void;
  /** Encode failures, on the same terms. */
  onError?(error: unknown): void;
  readonly encoder?: QrEncoder;
  readonly width?: number;
}

export interface QrSvgController {
  /** Encode a bolt11, as the `lightning:` URI a wallet expects. */
  show(invoice: string): void;
  /** Encode a payload verbatim — a swap deposit URI, say. */
  showPayload(payload: string): void;
  /** Publish nothing further; the encode in flight is abandoned. */
  stop(): void;
}

export function createQrSvgController(options: QrSvgControllerOptions): QrSvgController {
  // Monotonic, and bumped by `stop()` too: "is this still the newest request"
  // is the whole rule, and a stopped controller is one nobody can match.
  let generation = 0;

  const qrOptions = (): QrOptions => ({
    ...(options.encoder === undefined ? {} : { encoder: options.encoder }),
    ...(options.width === undefined ? {} : { width: options.width }),
  });

  const publish = (pending: Promise<string>): void => {
    generation += 1;
    const mine = generation;
    void pending.then(
      (svg) => {
        if (mine === generation) options.onValue(svg);
      },
      (error: unknown) => {
        if (mine === generation) options.onError?.(error);
      },
    );
  };

  return {
    show(invoice: string): void {
      publish(createQrSvg(invoice, qrOptions()));
    },
    showPayload(payload: string): void {
      publish(createQrPayloadSvg(payload, qrOptions()));
    },
    stop(): void {
      generation += 1;
    },
  };
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
