import { fixedFloatCompatibleSwapProvider } from "./swap/fixedfloat.ts";
import type { SwapProvider } from "./swap/provider.ts";

export const LSC_URI_PROTOCOL = "lightning+swapconnect:" as const;
export const LSC_ENV_NAMES = ["LSC_URI_PRIMARY", "LSC_URI_BACKUP"] as const;

const LSC_QUERY_PARAMETERS = new Set(["key", "secret"]);
const MAX_LSC_URI_LENGTH = 8_192;
const MAX_LSC_CREDENTIAL_LENGTH = 2_048;

export type LscEnvironmentName = (typeof LSC_ENV_NAMES)[number];

export interface LscConnection {
  readonly uriProtocol: typeof LSC_URI_PROTOCOL;
  readonly baseUrl: string;
  readonly providerId: string;
  readonly key: string;
  readonly secret: string;
}

export interface FormatLscUriInput {
  readonly baseUrl: string;
  readonly key: string;
  readonly secret: string;
}

export interface CreateLscSwapProvidersOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/**
 * Parse a Lightning Swap Connect credential URI without ever including the
 * credential values in an error message.
 */
export function parseLscUri(value: string): LscConnection {
  const input = requiredCredential(value, "LSC URI", MAX_LSC_URI_LENGTH);
  let uri: URL;
  try {
    uri = new URL(input);
  } catch {
    throw new TypeError("LSC URI is not a valid absolute URI.");
  }

  if (uri.protocol !== LSC_URI_PROTOCOL) {
    throw new TypeError(`LSC URI must use ${LSC_URI_PROTOCOL}//.`);
  }
  if (uri.username !== "" || uri.password !== "") {
    throw new TypeError("LSC URI must not use URI userinfo.");
  }
  if (uri.hostname === "") {
    throw new TypeError("LSC URI requires a provider hostname.");
  }
  if (uri.hash !== "") {
    throw new TypeError("LSC URI must not contain a fragment.");
  }
  if (/%(?![0-9a-f]{2})/i.test(uri.search)) {
    throw new TypeError("LSC URI query encoding is invalid.");
  }
  for (const parameter of uri.searchParams.keys()) {
    if (!LSC_QUERY_PARAMETERS.has(parameter)) {
      throw new TypeError("LSC URI contains an unsupported query parameter.");
    }
  }

  const key = requiredCredential(
    singleParameter(uri, "key"),
    "LSC URI key",
    MAX_LSC_CREDENTIAL_LENGTH,
  );
  const secret = requiredCredential(
    singleParameter(uri, "secret"),
    "LSC URI secret",
    MAX_LSC_CREDENTIAL_LENGTH,
  );
  const baseUrl = `https://${uri.host}${normalizeEndpointPath(uri.pathname)}`;

  return {
    uriProtocol: LSC_URI_PROTOCOL,
    baseUrl,
    providerId: providerIdFromUri(uri),
    key,
    secret,
  };
}

export function formatLscUri(input: FormatLscUriInput): string {
  const endpoint = parseHttpsEndpoint(input.baseUrl);
  const key = requiredCredential(input.key, "LSC key", MAX_LSC_CREDENTIAL_LENGTH);
  const secret = requiredCredential(input.secret, "LSC secret", MAX_LSC_CREDENTIAL_LENGTH);
  const uri = new URL(
    `${LSC_URI_PROTOCOL}//${endpoint.host}${normalizeEndpointPath(endpoint.pathname)}`,
  );
  uri.searchParams.set("key", key);
  uri.searchParams.set("secret", secret);
  return uri.toString();
}

export function readLscConnectionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly LscConnection[] {
  const connections: LscConnection[] = [];
  const providerIds = new Set<string>();
  for (const name of LSC_ENV_NAMES) {
    const value = environment[name]?.trim();
    if (!value) continue;
    let connection: LscConnection;
    try {
      connection = parseLscUri(value);
    } catch (error) {
      throw new TypeError(
        `${name} is invalid: ${error instanceof Error ? error.message : "invalid LSC URI"}`,
      );
    }
    if (providerIds.has(connection.providerId)) {
      throw new TypeError(`${name} duplicates another LSC provider id.`);
    }
    providerIds.add(connection.providerId);
    connections.push(connection);
  }
  return connections;
}

export function createLscSwapProvidersFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: CreateLscSwapProvidersOptions = {},
): readonly SwapProvider[] {
  return readLscConnectionsFromEnvironment(environment).map((connection) =>
    fixedFloatCompatibleSwapProvider({
      id: connection.providerId,
      baseUrl: connection.baseUrl,
      key: connection.key,
      secret: connection.secret,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
}

function singleParameter(uri: URL, name: string): string {
  const values = uri.searchParams.getAll(name);
  if (values.length !== 1) {
    throw new TypeError(`LSC URI requires exactly one ${name} parameter.`);
  }
  return values[0] ?? "";
}

function requiredCredential(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty.`);
  if (normalized.length > maximumLength) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function parseHttpsEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("LSC baseUrl must be a valid HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname === "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError(
      "LSC baseUrl must be an HTTPS URL without userinfo, query parameters, or a fragment.",
    );
  }
  return endpoint;
}

function normalizeEndpointPath(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function providerIdFromUri(uri: URL): string {
  const path = uri.pathname.split("/").filter(Boolean).join("-");
  const raw = `${uri.hostname}${uri.port ? `-${uri.port}` : ""}${path ? `-${path}` : ""}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!raw) throw new TypeError("LSC URI could not derive a provider id.");
  return raw;
}
