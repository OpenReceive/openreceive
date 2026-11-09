/// <reference path="../qrcode.d.ts" />

// What the payer can do with an invoice: render it as a QR (SVG or PNG data
// URL) or copy it. Each action refuses anything `assertInvoice` rejects, and a
// copy logs what it did.

import { recordOrEmpty } from "@openreceive/core";
import * as defaultQrEncoder from "qrcode";
import { assertInvoice, createLightningUri } from "./checkout-invoice.ts";
import { emitBrowserLog } from "./checkout-log.ts";
import {
  type CopyInvoiceOptions,
  OPENRECEIVE_QR_DARK_COLOR,
  OPENRECEIVE_QR_ERROR_CORRECTION,
  OPENRECEIVE_QR_LIGHT_COLOR,
  OPENRECEIVE_QR_QUIET_ZONE_MODULES,
  type QrEncoder,
  type QrOptions,
} from "./ui.ts";

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
  try {
    await writeToClipboard(options.invoice, options.clipboard);
  } catch (error) {
    emitBrowserLog(
      options.logger,
      "warn",
      "checkout.invoice.copy_refused",
      "The browser refused to copy the Lightning invoice.",
      options.logContext,
    );
    throw error;
  }
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.invoice.copied",
    "Copied Lightning invoice to clipboard.",
    options.logContext,
  );
}

async function writeToClipboard(
  text: string,
  injected: Pick<Clipboard, "writeText"> | undefined,
): Promise<void> {
  const clipboard = injected ?? globalThis.navigator?.clipboard;
  try {
    if (clipboard === undefined) throw new Error("Clipboard API is unavailable.");
    await clipboard.writeText(text);
  } catch (error) {
    if (!copyBySelection(text)) throw error;
  }
}

/**
 * The older copy command, for where the clipboard API is missing or refuses:
 * a page on plain http, and some in-app browsers. It works on a selection, so
 * a field the payer never sees holds the text for a moment.
 */
function copyBySelection(text: string): boolean {
  const page = globalThis.document;
  if (page?.body === undefined || page.body === null) return false;
  if (typeof page.execCommand !== "function") return false;
  const focused = page.activeElement as HTMLElement | null;
  const field = page.createElement("textarea");
  field.value = text;
  // Read-only, so a phone doesn't open its keyboard for it.
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  page.body.append(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return page.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    focused?.focus?.();
  }
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
