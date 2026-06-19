export const OPENRECEIVE_QR_QUIET_ZONE_MODULES = 4 as const;
export const OPENRECEIVE_QR_DARK_COLOR = "#000000" as const;
export const OPENRECEIVE_QR_LIGHT_COLOR = "#FFFFFFFF" as const;
export const OPENRECEIVE_QR_ERROR_CORRECTION = "M" as const;

export interface OpenReceiveQrEncoder {
  toString(
    payload: string,
    options: Record<string, unknown>
  ): Promise<string> | string;
  toDataURL?(
    payload: string,
    options: Record<string, unknown>
  ): Promise<string> | string;
}

export interface OpenReceiveQrOptions {
  encoder?: OpenReceiveQrEncoder;
  width?: number;
}

export interface CopyInvoiceOptions {
  invoice: string;
  clipboard?: Pick<Clipboard, "writeText">;
}

export interface OpenWalletOptions {
  invoice: string;
  open?: (uri: string) => void;
}

export function createLightningUri(invoice: string): string {
  assertInvoice(invoice);
  return `lightning:${invoice}`;
}

export async function createQrSvg(
  invoice: string,
  options: OpenReceiveQrOptions = {}
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);
  const svg = await encoder.toString(createLightningUri(invoice), {
    type: "svg",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR
    }
  });

  return String(svg);
}

export async function createQrPngDataUrl(
  invoice: string,
  options: OpenReceiveQrOptions = {}
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);

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
      light: OPENRECEIVE_QR_LIGHT_COLOR
    }
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
}

export function openWallet(options: OpenWalletOptions): string {
  const uri = createLightningUri(options.invoice);

  if (options.open !== undefined) {
    options.open(uri);
    return uri;
  }

  const location = globalThis.window?.location;
  if (location === undefined) {
    throw new Error("window.location is unavailable.");
  }

  location.assign(uri);
  return uri;
}

async function getQrEncoder(
  encoder: OpenReceiveQrEncoder | undefined
): Promise<OpenReceiveQrEncoder> {
  if (encoder !== undefined) return encoder;

  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<unknown>;
  const imported = asRecord(await dynamicImport("qrcode"));
  const candidate = (imported.default ?? imported) as unknown;

  if (isQrEncoder(candidate)) return candidate;

  throw new Error("qrcode package did not expose a compatible encoder.");
}

function isQrEncoder(value: unknown): value is OpenReceiveQrEncoder {
  const record = asRecord(value);
  return typeof record.toString === "function";
}

function assertInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new TypeError("invoice must be a non-empty BOLT11 string");
  }

  if (invoice.startsWith("nostr+walletconnect://")) {
    throw new TypeError("invoice must not be an NWC connection string");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}
