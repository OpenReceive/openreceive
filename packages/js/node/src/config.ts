import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { fixedFloatCompatibleSwapProvider } from "./swap/fixedfloat.ts";
import type { SwapProvider } from "./swap/provider.ts";

export const OPENRECEIVE_CONFIG_FILE = "openreceive.yml";

export interface OpenReceiveFileConfig {
  readonly nwc?: string;
  readonly priceCurrencies?: readonly string[];
  readonly swap?: OpenReceiveFileSwapConfig;
  readonly logging?: OpenReceiveFileLoggingConfig;
}

export interface OpenReceiveFileLoggingConfig {
  readonly enabled?: boolean;
  readonly directory?: string;
  readonly filename?: string;
  readonly maxFileSizeMb?: number;
  readonly maxFiles?: number;
  readonly level?: string;
}

export interface OpenReceiveFileSwapConfig {
  readonly providers?: readonly SwapProvider[];
}

export interface ReadOpenReceiveConfigFileOptions {
  readonly cwd?: string;
  readonly configPath?: string | false;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  /** Override for incomplete swap-provider warnings. Defaults to `console.warn`. */
  readonly emitWarning?: (message: string) => void;
}

export function readOpenReceiveConfigFile(
  options: ReadOpenReceiveConfigFileOptions = {},
): OpenReceiveFileConfig | undefined {
  if (options.configPath === false) return undefined;
  const explicitPath = options.configPath !== undefined;
  const sourcePath = resolveOpenReceiveConfigPath(options.cwd, options.configPath);
  if (!existsSync(sourcePath)) {
    if (explicitPath) {
      throw new TypeError(`OpenReceive config file does not exist: ${sourcePath}`);
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new TypeError(`OpenReceive config file could not be read or parsed: ${sourcePath}`, {
      cause: error,
    });
  }

  const root = readRecord(parsed, sourcePath);
  rejectPersistenceConfig(root, sourcePath);
  return {
    ...readOptionalStringConfig(root, ["nwc"], "nwc"),
    ...readPriceCurrencies(root, sourcePath),
    ...readSwapConfig(root, sourcePath, options),
    ...readLoggingConfig(root, sourcePath),
  };
}

function rejectPersistenceConfig(root: Record<string, unknown>, sourcePath: string): void {
  const removed = ["store", "storage", "database_url", "redis_url", "namespace"];
  const found = removed.find((key) => root[key] !== undefined);
  if (found !== undefined) {
    throw new TypeError(`${sourcePath}.${found} is not supported; OpenReceive has no storage configuration.`);
  }
}

function resolveOpenReceiveConfigPath(
  cwd: string | undefined,
  configPath: string | undefined,
): string {
  const raw = configPath ?? OPENRECEIVE_CONFIG_FILE;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new TypeError("OpenReceive config path must not be empty.");
  }
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(cwd ?? globalThis.process?.cwd?.() ?? ".", trimmed);
}

function readPriceCurrencies(
  root: Record<string, unknown>,
  sourcePath: string,
): Pick<OpenReceiveFileConfig, "priceCurrencies"> {
  const value = root.price_currencies;
  if (value === undefined) return {};
  if (typeof value === "string") {
    return { priceCurrencies: value.split(",") };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { priceCurrencies: value };
  }
  throw new TypeError(`${sourcePath}.price_currencies must be a string array or comma string.`);
}

function readLoggingConfig(
  root: Record<string, unknown>,
  sourcePath: string,
): Pick<OpenReceiveFileConfig, "logging"> {
  const logging = readOptionalRecord(root.logging, `${sourcePath}.logging`);
  if (logging === undefined) return {};
  const label = `${sourcePath}.logging`;
  const enabled = readOptionalBoolean(logging.enabled, `${label}.enabled`);
  const directory = readOptionalString(logging.directory, `${label}.directory`);
  const filename = readOptionalString(logging.filename, `${label}.filename`);
  const level = readOptionalString(logging.level, `${label}.level`);
  if (level !== undefined && !["debug", "info", "warn", "error"].includes(level)) {
    throw new TypeError(`${label}.level must be one of debug, info, warn, error.`);
  }
  const maxFileSizeMb = readOptionalPositiveInteger(
    logging.max_file_size_mb ?? logging.maxFileSizeMb,
    `${label}.max_file_size_mb`,
  );
  const maxFiles = readOptionalPositiveInteger(
    logging.max_files ?? logging.maxFiles,
    `${label}.max_files`,
  );
  const result: OpenReceiveFileLoggingConfig = {
    ...(enabled === undefined ? {} : { enabled }),
    ...(directory === undefined ? {} : { directory }),
    ...(filename === undefined ? {} : { filename }),
    ...(maxFileSizeMb === undefined ? {} : { maxFileSizeMb }),
    ...(maxFiles === undefined ? {} : { maxFiles }),
    ...(level === undefined ? {} : { level }),
  };
  return Object.keys(result).length === 0 ? {} : { logging: result };
}

function readSwapConfig(
  root: Record<string, unknown>,
  sourcePath: string,
  options: ReadOpenReceiveConfigFileOptions,
): Pick<OpenReceiveFileConfig, "swap"> {
  const swap = readOptionalRecord(root.swap, `${sourcePath}.swap`);
  if (swap === undefined) return {};
  const providers = readSwapProviders(swap, `${sourcePath}.swap`, options);
  return {
    swap: {
      ...(providers === undefined ? {} : { providers }),
    },
  };
}

function readSwapProviders(
  swap: Record<string, unknown>,
  label: string,
  options: ReadOpenReceiveConfigFileOptions,
): readonly SwapProvider[] | undefined {
  if (swap.providers === undefined) return undefined;
  if (!Array.isArray(swap.providers)) {
    throw new TypeError(`${label}.providers must be an array.`);
  }
  const seenIds = new Set<string>();
  return swap.providers.flatMap((item, index): SwapProvider[] => {
    const providerLabel = `${label}.providers[${index}]`;
    const provider = readRecord(item, providerLabel);
    if (provider.enabled === false) return [];

    const protocol =
      readOptionalString(provider.protocol, `${providerLabel}.protocol`) ?? "fixedfloat";
    if (protocol !== "fixedfloat") {
      throw new TypeError(
        `${providerLabel}.protocol must be "fixedfloat" (or omitted; that is the default).`,
      );
    }

    const baseUrl = readRequiredString(provider, "base_url", providerLabel);
    const explicitId = readOptionalString(provider.id, `${providerLabel}.id`);
    const id = explicitId ?? swapProviderIdFromBaseUrl(baseUrl, providerLabel);
    if (seenIds.has(id)) {
      throw new TypeError(
        `${providerLabel}.id duplicates swap provider id ${JSON.stringify(id)}` +
          (explicitId === undefined ? ` (derived from base_url ${JSON.stringify(baseUrl)})` : "") +
          ".",
      );
    }

    const key = readOptionalString(provider.key, `${providerLabel}.key`);
    const secret = readOptionalString(provider.secret, `${providerLabel}.secret`);
    if (key === undefined || secret === undefined) {
      const missing =
        key === undefined && secret === undefined
          ? "key and secret are not set"
          : key === undefined
            ? "key is not set"
            : "secret is not set";
      emitSwapProviderConfigWarning(
        options,
        `OpenReceive: ignoring swap provider ${JSON.stringify(id)} (${providerLabel}): ${missing}.`,
      );
      return [];
    }
    seenIds.add(id);

    return [
      fixedFloatCompatibleSwapProvider({
        id,
        key,
        secret,
        baseUrl,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...readOptionalStringConfig(provider, ["lightning_ccy"], "lightningCcy"),
        ...readOptionalPositiveIntegerField(
          provider,
          "request_timeout_ms",
          "requestTimeoutMs",
          providerLabel,
        ),
        ...readOptionalPositiveIntegerField(
          provider,
          "invoice_expiry_seconds",
          "invoiceExpirySeconds",
          providerLabel,
        ),
        ...readOptionalPositiveIntegerField(
          provider,
          "deposit_window_seconds",
          "depositWindowSeconds",
          providerLabel,
        ),
        ...readOptionalPositiveIntegerField(
          provider,
          "settlement_sla_seconds",
          "settlementSlaSeconds",
          providerLabel,
        ),
        ...readOptionalPositiveIntegerField(
          provider,
          "invoice_expiry_margin_seconds",
          "invoiceExpiryMarginSeconds",
          providerLabel,
        ),
      }),
    ];
  });
}

function emitSwapProviderConfigWarning(
  options: ReadOpenReceiveConfigFileOptions,
  message: string,
): void {
  const emitWarning = options.emitWarning ?? ((text: string) => console.warn(text));
  emitWarning(message);
}

/** Derive a stable provider id from `base_url` hostname (+ non-default port). */
export function swapProviderIdFromBaseUrl(baseUrl: string, label = "base_url"): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new TypeError(`${label} must be a valid absolute URL.`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must be an http(s) URL.`);
  }
  const host = url.hostname.trim().toLowerCase();
  const portSuffix =
    url.port.length > 0 && url.port !== "80" && url.port !== "443" ? `-${url.port}` : "";
  const id = `${host}${portSuffix}`
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new TypeError(
      `${label} hostname could not be converted into a provider id; set id explicitly.`,
    );
  }
  return id;
}

function readOptionalStringConfig<TargetField extends string>(
  record: Record<string, unknown>,
  fields: readonly string[],
  targetField: TargetField,
): { readonly [key in TargetField]?: string } {
  for (const field of fields) {
    const value = readOptionalString(record[field], field);
    if (value !== undefined) {
      return { [targetField]: value } as { readonly [key in TargetField]?: string };
    }
  }
  return {};
}

function readOptionalPositiveIntegerField<TargetField extends string>(
  record: Record<string, unknown>,
  field: string,
  targetField: TargetField,
  label: string,
): { readonly [key in TargetField]?: number } {
  const value = readOptionalPositiveInteger(record[field], `${label}.${field}`);
  return value === undefined
    ? {}
    : ({ [targetField]: value } as { readonly [key in TargetField]?: number });
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean.`);
  }
  return value;
}

function readOptionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return readRecord(value, label);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = readOptionalString(record[field], `${label}.${field}`);
  if (value === undefined) {
    throw new TypeError(`${label}.${field} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = readOptionalInteger(value, label);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function readOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  return parsed;
}
