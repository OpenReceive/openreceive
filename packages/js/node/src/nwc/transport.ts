/**
 * Everything that reaches a wallet: the compatible-client shape OpenReceive
 * accepts, method dispatch across naming conventions, the lazily loaded
 * @getalby/sdk client, and subscription teardown.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { recordOrEmpty } from "@openreceive/core";
import { WalletPreflightError } from "./errors.ts";

const require = createRequire(import.meta.url);

export interface AlbyNwcCompatibleClient {
  getInfo?: () => Promise<unknown>;
  get_info?: () => Promise<unknown>;
  getWalletServiceInfo?: () => Promise<unknown>;
  makeInvoice?: (request: Record<string, unknown>) => Promise<unknown>;
  make_invoice?: (request: Record<string, unknown>) => Promise<unknown>;
  listTransactions?: (request: Record<string, unknown>) => Promise<unknown>;
  list_transactions?: (request: Record<string, unknown>) => Promise<unknown>;
  subscribeNotifications?: (
    callback: (notification: unknown) => void,
    notificationTypes?: string[],
  ) => unknown;
  close?: () => Promise<void> | void;
}

/** Call the first method the client actually exposes under any accepted name. */
export async function callRequiredMethod(
  client: AlbyNwcCompatibleClient,
  names: readonly (keyof AlbyNwcCompatibleClient)[],
  request: Record<string, unknown>,
): Promise<unknown> {
  for (const name of names) {
    const method = client[name] as unknown;
    if (typeof method === "function") {
      return await (method as (request: Record<string, unknown>) => Promise<unknown>).call(
        client,
        request,
      );
    }
  }

  throw new WalletPreflightError(
    "wallet_unavailable",
    `NWC client does not expose ${names.join(" or ")}.`,
  );
}

export async function createDefaultAlbyNwcClient(
  connectionString: string,
): Promise<AlbyNwcCompatibleClient> {
  ensureNodeWebSocket();
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const namespace = recordOrEmpty(
    await dynamicImport(pathToFileURL(require.resolve("@getalby/sdk/nwc")).href),
  );
  const Constructor = namespace.NWCClient as unknown;

  if (typeof Constructor !== "function") {
    throw new WalletPreflightError(
      "wallet_unavailable",
      "@getalby/sdk/nwc did not expose NWCClient.",
    );
  }

  const NWCClientConstructor = Constructor as new (options: {
    nostrWalletConnectUrl: string;
  }) => AlbyNwcCompatibleClient;

  return new NWCClientConstructor({
    nostrWalletConnectUrl: connectionString,
  });
}

function ensureNodeWebSocket(): void {
  if (globalThis.WebSocket !== undefined) return;
  throw new WalletPreflightError(
    "wallet_unavailable",
    "OpenReceive requires Node 22 or newer with the built-in WebSocket API.",
  );
}

/**
 * ONE unsubscribe contract: `subscribeNotifications` resolves to a function
 * that ends the subscription — the shape the committed @getalby/sdk returns.
 */
export async function closeNwcNotificationSubscription(subscription: unknown): Promise<void> {
  if (typeof subscription !== "function") {
    throw new TypeError("NWC subscribeNotifications must resolve to an unsubscribe function.");
  }
  await (subscription as () => unknown)();
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
