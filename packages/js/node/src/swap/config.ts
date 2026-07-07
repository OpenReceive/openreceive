import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { fixedFloatCompatibleSwapProvider } from "./fixedfloat.ts";
import type { OpenReceiveSwapProvider } from "./provider.ts";

export const OPENRECEIVE_SWAP_CONFIG_ENV = "OPENRECEIVE_SWAP_CONFIG";

export interface OpenReceiveSwapConfigLoaderOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export function createConfiguredSwapProvidersFromEnv(
  options: OpenReceiveSwapConfigLoaderOptions = {},
): readonly OpenReceiveSwapProvider[] | undefined {
  const env = options.env ?? globalThis.process?.env ?? {};
  const configPath = readOptionalEnv(env, OPENRECEIVE_SWAP_CONFIG_ENV);
  if (configPath === undefined) return undefined;
  return createConfiguredSwapProvidersFromFile(configPath, {
    ...options,
    env,
  });
}

export function createConfiguredSwapProvidersFromFile(
  configPath: string,
  options: OpenReceiveSwapConfigLoaderOptions = {},
): readonly OpenReceiveSwapProvider[] {
  const env = options.env ?? globalThis.process?.env ?? {};
  const sourcePath = resolveOpenReceiveSwapConfigPath(configPath, options.cwd);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new TypeError(`${OPENRECEIVE_SWAP_CONFIG_ENV} could not be read or parsed.`, {
      cause: error,
    });
  }

  return createConfiguredSwapProvidersFromDocument(parsed, {
    env,
    fetch: options.fetch,
    now: options.now,
    sourceLabel: sourcePath,
  });
}

function createConfiguredSwapProvidersFromDocument(
  document: unknown,
  options: OpenReceiveSwapConfigLoaderOptions & { readonly sourceLabel: string },
): readonly OpenReceiveSwapProvider[] {
  const env = options.env ?? {};
  const root = readRecord(document, options.sourceLabel);
  const swap = readRecord(root.swap, `${options.sourceLabel}.swap`);
  if (!Array.isArray(swap.providers)) {
    throw new TypeError(`${options.sourceLabel}.swap.providers must be an array.`);
  }

  const seenIds = new Set<string>();
  return swap.providers.map((item, index) => {
    const label = `${options.sourceLabel}.swap.providers[${index}]`;
    const provider = readRecord(item, label);
    rejectInlineSwapSecrets(provider, label);
    const id = readRequiredString(provider, "id", label);
    if (seenIds.has(id)) {
      throw new TypeError(`${label}.id duplicates swap provider id ${JSON.stringify(id)}.`);
    }
    seenIds.add(id);

    const protocol = readRequiredString(provider, "protocol", label);
    if (protocol !== "fixedfloat") {
      throw new TypeError(`${label}.protocol must be "fixedfloat".`);
    }

    const keyEnv = readRequiredString(provider, "key_env", label);
    const secretEnv = readRequiredString(provider, "secret_env", label);
    const key = readRequiredSecretEnv(env, keyEnv, `${label}.key_env`);
    const secret = readRequiredSecretEnv(env, secretEnv, `${label}.secret_env`);

    return fixedFloatCompatibleSwapProvider({
      id,
      key,
      secret,
      baseUrl: readRequiredString(provider, "base_url", label),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...readOptionalStringOption(provider, "lightning_ccy", "lightningCcy", label),
      ...readOptionalPositiveIntegerOption(
        provider,
        "request_timeout_ms",
        "requestTimeoutMs",
        label,
      ),
      ...readOptionalPositiveIntegerOption(
        provider,
        "invoice_expiry_seconds",
        "invoiceExpirySeconds",
        label,
      ),
      ...readOptionalPositiveIntegerOption(
        provider,
        "deposit_window_seconds",
        "depositWindowSeconds",
        label,
      ),
      ...readOptionalPositiveIntegerOption(
        provider,
        "settlement_sla_seconds",
        "settlementSlaSeconds",
        label,
      ),
      ...readOptionalPositiveIntegerOption(
        provider,
        "invoice_expiry_margin_seconds",
        "invoiceExpiryMarginSeconds",
        label,
      ),
    });
  });
}

function resolveOpenReceiveSwapConfigPath(configPath: string, cwd: string | undefined): string {
  const trimmed = configPath.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${OPENRECEIVE_SWAP_CONFIG_ENV} must not be empty.`);
  }
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(cwd ?? globalThis.process?.cwd?.() ?? ".", trimmed);
}

function rejectInlineSwapSecrets(record: Record<string, unknown>, label: string): void {
  for (const field of ["key", "secret"] as const) {
    if (Object.hasOwn(record, field)) {
      throw new TypeError(`${label}.${field} is not allowed; use ${field}_env instead.`);
    }
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalStringOption<TargetField extends string>(
  record: Record<string, unknown>,
  field: string,
  targetField: TargetField,
  label: string,
): { readonly [key in TargetField]?: string } {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string when set.`);
  }
  return { [targetField]: value.trim() } as { readonly [key in TargetField]?: string };
}

function readOptionalPositiveIntegerOption<TargetField extends string>(
  record: Record<string, unknown>,
  field: string,
  targetField: TargetField,
  label: string,
): { readonly [key in TargetField]?: number } {
  const value = record[field];
  if (value === undefined) return {};
  const parsed = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label}.${field} must be a positive safe integer when set.`);
  }
  return { [targetField]: parsed } as { readonly [key in TargetField]?: number };
}

function readRequiredSecretEnv(
  env: Record<string, string | undefined>,
  name: string,
  label: string,
): string {
  const value = readOptionalEnv(env, name);
  if (value === undefined) {
    throw new TypeError(`Set ${name} for ${label}.`);
  }
  return value;
}

function readOptionalEnv(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
