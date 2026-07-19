import {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  isOpenReceiveErrorCode,
  NwcUriParseError,
  type OpenReceiveErrorCode,
  type OpenReceiveInvoiceKvStore,
  type OpenReceiveReceiveNwcClient,
} from "@openreceive/core";
import { createNwcReceiveClient } from "../alby-nwc.ts";
import { type OpenReceiveFileConfig, readOpenReceiveConfigFile } from "../config.ts";
import { OpenReceiveConfigError } from "../config-error.ts";
import { assertOpenReceiveStoreConfiguration } from "../storage-guard.ts";
import {
  applyStoreSchemaMode,
  resolveOpenReceiveStore,
  resolveOpenReceiveStoreUri,
} from "../store-uri.ts";
import type { SwapProvider } from "../swap/index.ts";
import { isRecord, OpenReceiveServiceError } from "./core-utils.ts";
import { createNwcEndpointLogger, emitLog } from "./logging.ts";
import type {
  CreateOpenReceiveOptions,
  LoggingOptions,
  OpenReceiveServiceContext,
} from "./types.ts";

export async function runOpenReceiveOperation<T>(
  context: OpenReceiveServiceContext,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const normalized = normalizeOpenReceiveServiceError(error);
    if (normalized instanceof OpenReceiveServiceError) throw normalized;
    emitLog(context.options, "error", "service.error", "OpenReceive service method failed.", {
      error_message: normalized instanceof Error ? normalized.message : String(normalized),
    });
    throw normalized;
  }
}

export function normalizeOpenReceiveServiceError(error: unknown): unknown {
  if (error instanceof OpenReceiveServiceError) return error;
  if (isStatusCodeError(error)) {
    return new OpenReceiveServiceError(error.status, {
      code: error.code,
      message: error.message,
    });
  }
  return error;
}

export function createConfiguredClient(
  options: CreateOpenReceiveOptions,
): OpenReceiveReceiveNwcClient {
  if (options.client !== undefined) return options.client;
  try {
    return createNwcReceiveClient({
      connectionString: readOpenReceiveNwc(options.nwc),
      logger: createNwcEndpointLogger(options),
    });
  } catch (error) {
    if (error instanceof OpenReceiveConfigError) throw error;
    const reason = error instanceof NwcUriParseError ? error.description : undefined;
    throw new OpenReceiveConfigError({
      code: "INVALID_NWC",
      message: formatOpenReceiveInvalidNwcMessage({ reason }),
      hint: "Set OPENRECEIVE_NWC in openreceive.yml to a receive-only nostr+walletconnect URI from your wallet.",
      cause: error,
    });
  }
}

export async function preflightConfiguredClient(
  client: OpenReceiveReceiveNwcClient,
): Promise<void> {
  try {
    await client.preflight();
  } catch (error) {
    throw new OpenReceiveConfigError({
      code: "WALLET_PREFLIGHT_FAILED",
      message: "OpenReceive wallet preflight failed.",
      hint: "Check that OPENRECEIVE_NWC in openreceive.yml is receive-only, reachable, and advertises make_invoice plus list_transactions.",
      cause: error,
    });
  }
}

export async function resolveConfiguredStore(
  options: CreateOpenReceiveOptions,
  namespace: string,
): Promise<OpenReceiveInvoiceKvStore> {
  try {
    const store =
      options.store ??
      (await resolveOpenReceiveStore(options.storeUri, {
        cwd: options.cwd,
        namespace,
        schemaMode: options.schemaMode,
        loadSqlite: options.loadSqlite,
        loadPostgres: options.loadPostgres,
      }));
    if (options.store !== undefined) {
      await ensureOpenReceiveStoreSchema(store, options.schemaMode ?? "check", namespace);
    }
    return store;
  } catch (error) {
    if (error instanceof OpenReceiveConfigError) throw error;
    throw new OpenReceiveConfigError({
      code: "STORE_UNAVAILABLE",
      message: "OpenReceive store is unavailable.",
      hint: "Check the openreceive.yml store/namespace settings, database credentials, and migrations.",
      cause: error,
    });
  }
}

export function isStatusCodeError(
  error: unknown,
): error is Error & { readonly status: number; readonly code: OpenReceiveErrorCode } {
  return (
    error instanceof Error &&
    typeof (error as { status?: unknown }).status === "number" &&
    isOpenReceiveErrorCode((error as { code?: unknown }).code)
  );
}

export function mergeOpenReceiveConfigFile(
  options: CreateOpenReceiveOptions,
): CreateOpenReceiveOptions {
  let fileConfig: OpenReceiveFileConfig | undefined;
  try {
    fileConfig = readOpenReceiveConfigFile({
      cwd: options.cwd,
      configPath: options.configPath,
      now: options.clock,
    });
  } catch (error) {
    throw new OpenReceiveConfigError({
      code: "INVALID_CONFIG_FILE",
      message: "OpenReceive config file is invalid.",
      hint: "Fix openreceive.yml or pass createOpenReceive({ configPath: false }) to disable config-file loading.",
      cause: error,
    });
  }
  if (fileConfig === undefined) return options;

  const mergedSwap = mergeSwapConfig(fileConfig.swap, options.swap);
  const configured: CreateOpenReceiveOptions = {
    ...openReceiveConfigToOptions(fileConfig),
    ...options,
    ...(mergedSwap === undefined ? {} : { swap: mergedSwap }),
  };
  return configured;
}

/**
 * Merge swap config from `openreceive.yml` with swap options passed to
 * `createOpenReceive()` instead of letting the programmatic value silently replace the
 * whole file block. Providers are combined and de-duplicated by `.name` (a programmatic
 * provider with the same name overrides the YAML one in place; new names are appended
 * after the YAML providers, which stay in priority order). Scalar options such as
 * `settlementAttentionSeconds` take the programmatic value when set, else the file value.
 * This lets you register a custom provider in code while keeping a YAML fixedfloat
 * fallback, and lets a test inject a fake provider without discarding real config.
 */
export function mergeSwapConfig(
  fileSwap: OpenReceiveFileConfig["swap"],
  optionSwap: CreateOpenReceiveOptions["swap"],
): CreateOpenReceiveOptions["swap"] {
  if (fileSwap === undefined) return optionSwap;
  if (optionSwap === undefined) return fileSwap;

  const byName = new Map<string, SwapProvider>();
  for (const provider of fileSwap.providers ?? []) byName.set(provider.name, provider);
  for (const provider of optionSwap.providers ?? []) byName.set(provider.name, provider);
  const providers = [...byName.values()];

  const settlementAttentionSeconds =
    optionSwap.settlementAttentionSeconds ?? fileSwap.settlementAttentionSeconds;
  return {
    ...(providers.length === 0 ? {} : { providers }),
    ...(settlementAttentionSeconds === undefined ? {} : { settlementAttentionSeconds }),
  };
}

export function openReceiveConfigToOptions(
  config: OpenReceiveFileConfig,
): CreateOpenReceiveOptions {
  return {
    ...(config.nwc === undefined ? {} : { nwc: config.nwc }),
    ...(config.namespace === undefined ? {} : { namespace: config.namespace }),
    ...(config.storeUri === undefined ? {} : { storeUri: config.storeUri }),
    ...(config.priceCurrencies === undefined ? {} : { priceCurrencies: config.priceCurrencies }),
    ...(config.swap === undefined ? {} : { swap: config.swap }),
    ...(config.logging === undefined
      ? {}
      : { logging: config.logging as LoggingOptions }),
    ...(config.operation?.actionLeaseTtlSeconds === undefined
      ? {}
      : { actionLeaseTtlSeconds: config.operation.actionLeaseTtlSeconds }),
    ...(config.operation?.transactionScanIntervalSeconds === undefined
      ? {}
      : { transactionScanIntervalSeconds: config.operation.transactionScanIntervalSeconds }),
    ...(config.operation?.transactionScanPageLimit === undefined
      ? {}
      : { transactionScanPageLimit: config.operation.transactionScanPageLimit }),
    ...(config.operation?.transactionScanWindowPaddingSeconds === undefined
      ? {}
      : {
          transactionScanWindowPaddingSeconds: config.operation.transactionScanWindowPaddingSeconds,
        }),
    ...(config.operation?.transactionScanOverlapSeconds === undefined
      ? {}
      : { transactionScanOverlapSeconds: config.operation.transactionScanOverlapSeconds }),
    ...(config.operation?.sweepOpenInvoiceCap === undefined
      ? {}
      : { sweepOpenInvoiceCap: config.operation.sweepOpenInvoiceCap }),
    ...(config.operation?.transactionScanTimeoutMs === undefined
      ? {}
      : { transactionScanTimeoutMs: config.operation.transactionScanTimeoutMs }),
  };
}

export function readOpenReceiveNwc(configured: string | undefined): string {
  const nwc = configured;
  if (nwc === undefined || nwc.trim().length === 0) {
    throw new OpenReceiveConfigError({
      code: "MISSING_NWC",
      message: formatOpenReceiveMissingNwcMessage(),
      hint: "Create a receive-only NWC connection in your wallet and set OPENRECEIVE_NWC in openreceive.yml.",
    });
  }

  return nwc;
}

export function resolveConfiguredSwapProviders(
  options: CreateOpenReceiveOptions,
): readonly SwapProvider[] {
  return options.swap?.providers ?? [];
}

export async function ensureOpenReceiveStoreSchema(
  store: OpenReceiveInvoiceKvStore,
  schemaMode: "auto" | "check" | "skip" = "check",
  namespace = "default",
): Promise<void> {
  if (!isRecord(store)) return;
  await applyStoreSchemaMode(store, schemaMode, "custom", namespace);
}

export async function closeOpenReceiveResource(resource: unknown): Promise<void> {
  const close = isRecord(resource) ? resource.close : undefined;
  if (typeof close === "function") {
    await close.call(resource);
  }
}

export function assertDurableStoreConfiguration(input: {
  readonly configuredStoreUri: string | undefined;
  readonly store: OpenReceiveInvoiceKvStore | undefined;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): void {
  if (input.store !== undefined) {
    assertOpenReceiveStoreConfiguration({
      store: input.store,
      env: input.env,
      emitWarning: false,
    });
    return;
  }
  const resolved = resolveOpenReceiveStoreUri({
    storeUri: input.configuredStoreUri,
    env: input.env,
  });
  assertOpenReceiveStoreConfiguration({
    storeUri: resolved.storeUri,
    env: input.env,
    emitWarning: false,
  });
}
