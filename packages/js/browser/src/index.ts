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

export type OpenReceiveCheckoutPhase =
  | "invoice_created"
  | "verifying"
  | "settled"
  | "fulfilled"
  | "expired"
  | "failed"
  | "cancelled";

export interface OpenReceiveCheckoutSnapshot {
  readonly invoice_id: string;
  readonly invoice: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly expires_at?: number;
  readonly checkout?: {
    readonly events_url?: string;
    readonly routes_url?: string;
  };
}

export interface OpenReceiveCheckoutState {
  readonly invoice_id: string;
  readonly invoice: string;
  readonly lightningUri: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state: string;
  readonly workflow_state: string;
  readonly expires_at?: number;
  readonly expiresInSeconds?: number;
  readonly events_url?: string;
  readonly routes_url?: string;
  readonly phase: OpenReceiveCheckoutPhase;
  readonly settled: boolean;
  readonly terminal: boolean;
  readonly settled_at?: number;
  readonly last_event?: string;
}

export interface OpenReceiveInvoiceEventPayload {
  readonly invoice_id: string;
  readonly type?: string;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly settled_at?: number;
}

export interface CreateOpenReceiveCheckoutStateOptions {
  readonly now?: number;
}

export interface ApplyOpenReceiveInvoiceEventOptions {
  readonly eventName?: string;
  readonly now?: number;
}

export function createLightningUri(invoice: string): string {
  assertInvoice(invoice);
  return `lightning:${invoice}`;
}

export function createOpenReceiveCheckoutState(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: CreateOpenReceiveCheckoutStateOptions = {}
): OpenReceiveCheckoutState {
  const transactionState = snapshot.transaction_state ?? "pending";
  const workflowState = snapshot.workflow_state ?? "invoice_created";

  return normalizeCheckoutState({
    invoice_id: snapshot.invoice_id,
    invoice: snapshot.invoice,
    lightningUri: createLightningUri(snapshot.invoice),
    ...(snapshot.payment_hash === undefined
      ? {}
      : { payment_hash: snapshot.payment_hash }),
    ...(snapshot.amount_msats === undefined
      ? {}
      : { amount_msats: snapshot.amount_msats }),
    transaction_state: transactionState,
    workflow_state: workflowState,
    ...(snapshot.expires_at === undefined
      ? {}
      : { expires_at: snapshot.expires_at }),
    ...(snapshot.checkout?.events_url === undefined
      ? {}
      : { events_url: snapshot.checkout.events_url }),
    ...(snapshot.checkout?.routes_url === undefined
      ? {}
      : { routes_url: snapshot.checkout.routes_url })
  }, options.now);
}

export function applyOpenReceiveInvoiceEvent(
  state: OpenReceiveCheckoutState,
  event: OpenReceiveInvoiceEventPayload,
  options: ApplyOpenReceiveInvoiceEventOptions = {}
): OpenReceiveCheckoutState {
  if (event.invoice_id !== state.invoice_id) return state;
  if (
    event.payment_hash !== undefined &&
    state.payment_hash !== undefined &&
    event.payment_hash !== state.payment_hash
  ) {
    return state;
  }

  return normalizeCheckoutState({
    ...state,
    ...(event.payment_hash === undefined
      ? {}
      : { payment_hash: event.payment_hash }),
    ...(event.amount_msats === undefined
      ? {}
      : { amount_msats: event.amount_msats }),
    transaction_state: event.transaction_state ?? state.transaction_state,
    workflow_state: event.workflow_state ?? state.workflow_state,
    ...(event.settled_at === undefined
      ? {}
      : { settled_at: event.settled_at }),
    ...(options.eventName === undefined
      ? {}
      : { last_event: options.eventName })
  }, options.now);
}

export function parseOpenReceiveInvoiceEvent(
  data: string
): OpenReceiveInvoiceEventPayload {
  const parsed = asRecord(JSON.parse(data));

  if (typeof parsed.invoice_id !== "string" || parsed.invoice_id.length === 0) {
    throw new TypeError("invoice event must include invoice_id");
  }

  return {
    invoice_id: parsed.invoice_id,
    ...(typeof parsed.type === "string" ? { type: parsed.type } : {}),
    ...(typeof parsed.transaction_state === "string"
      ? { transaction_state: parsed.transaction_state }
      : {}),
    ...(typeof parsed.workflow_state === "string"
      ? { workflow_state: parsed.workflow_state }
      : {}),
    ...(typeof parsed.payment_hash === "string"
      ? { payment_hash: parsed.payment_hash }
      : {}),
    ...(typeof parsed.amount_msats === "number"
      ? { amount_msats: parsed.amount_msats }
      : {}),
    ...(typeof parsed.settled_at === "number"
      ? { settled_at: parsed.settled_at }
      : {})
  };
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

function normalizeCheckoutState(
  state: Omit<
    OpenReceiveCheckoutState,
    "phase" | "settled" | "terminal" | "expiresInSeconds"
  > &
    Partial<
      Pick<
        OpenReceiveCheckoutState,
        "phase" | "settled" | "terminal" | "expiresInSeconds"
      >
    >,
  now?: number
): OpenReceiveCheckoutState {
  const {
    phase: _phase,
    settled: _settled,
    terminal: _terminal,
    expiresInSeconds: _expiresInSeconds,
    ...base
  } = state;
  const phase = getCheckoutPhase(state.transaction_state, state.workflow_state);

  return {
    ...base,
    phase,
    settled: base.transaction_state === "settled",
    terminal: isTerminalPhase(phase),
    ...(base.expires_at === undefined || now === undefined
      ? {}
      : { expiresInSeconds: Math.max(0, base.expires_at - now) })
  };
}

function getCheckoutPhase(
  transactionState: string,
  workflowState: string
): OpenReceiveCheckoutPhase {
  if (workflowState === "fulfilled") return "fulfilled";
  if (workflowState === "cancelled") return "cancelled";
  if (transactionState === "settled") return "settled";
  if (transactionState === "expired" || workflowState === "expired_closed") {
    return "expired";
  }
  if (transactionState === "failed" || workflowState === "failed_closed") {
    return "failed";
  }
  if (
    workflowState === "verifying" ||
    workflowState === "expiry_pending_verification"
  ) {
    return "verifying";
  }
  return "invoice_created";
}

function isTerminalPhase(phase: OpenReceiveCheckoutPhase): boolean {
  return (
    phase === "fulfilled" ||
    phase === "expired" ||
    phase === "failed" ||
    phase === "cancelled"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}
