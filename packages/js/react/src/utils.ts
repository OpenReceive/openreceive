import type { OpenReceiveBrowserLogContext } from "@openreceive/browser/internal";

export function joinClassNames(...values: readonly (string | undefined)[]): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

export async function copyOpenReceiveText(
  text: string,
  clipboard?: Pick<Clipboard, "writeText">,
): Promise<void> {
  const target = clipboard ?? globalThis.navigator?.clipboard;
  if (target === undefined) throw new Error("Clipboard API is unavailable.");
  await target.writeText(text);
}

export function reactRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getCheckoutLogContext(data: {
  readonly invoice_id?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
}): OpenReceiveBrowserLogContext {
  return {
    ...(data.invoice_id === undefined ? {} : { invoice_id: data.invoice_id }),
    ...(data.payment_hash === undefined ? {} : { payment_hash: data.payment_hash }),
    ...(data.amount_msats === undefined ? {} : { amount_msats: data.amount_msats }),
    ...(data.transaction_state === undefined ? {} : { transaction_state: data.transaction_state }),
    ...(data.workflow_state === undefined ? {} : { workflow_state: data.workflow_state }),
  };
}
