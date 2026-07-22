import path from "node:path";
import { OpenReceiveConfigError } from "./config-error.ts";

export type OpenReceiveSqlitePolicy =
  | "allow-local"
  | "explicit-mounted-only"
  | "never";

export type OpenReceiveStoreKind =
  | "unset"
  | "local-sqlite"
  | "sqlite"
  | "postgres"
  | "redis"
  | "mysql"
  | "other";

export interface OpenReceiveDetectedPlatform {
  readonly id: string;
  readonly source: string;
  readonly policy: OpenReceiveSqlitePolicy;
}

type Env = Record<string, string | undefined>;

interface StoreConfigurationInput {
  readonly storeUri?: string;
  readonly store?: unknown;
  readonly env?: Env;
  readonly emitWarning?: false | ((message: string) => void);
}

const DOCS_LINK = "See docs/guides/storage.md.";
const POSTGRES_STEP =
  "Set `store: postgres://USER:PASS@HOST:5432/DB` in openreceive.yml, or omit it when DATABASE_URL (or DATABASE_PRIVATE_URL) is already a Postgres URI.";
const MOUNTED_SQLITE_STEP =
  "Or set `store: sqlite:/absolute/mounted/volume/openreceive.sqlite3` in openreceive.yml on a single instance with durable mounted storage.";
const EMPTY_ENV: Env = Object.freeze({});

export function policyForOpenReceivePlatform(id: string): OpenReceiveSqlitePolicy {
  switch (id) {
    case "vercel":
    case "netlify":
    case "heroku":
    case "google-cloud-run":
    case "aws-lambda":
    case "aws-apprunner":
    case "digitalocean-app-platform":
    case "cloudflare-workers":
    case "cloudflare-pages":
    case "cloudflare-containers":
      return "never";
    case "render":
    case "railway":
    case "fly":
    case "azure-app-service":
    case "aws-elastic-beanstalk":
    case "kubernetes":
    case "dokku":
    case "coolify":
    case "caprover":
      return "explicit-mounted-only";
    case "vps":
    case "bare-metal":
    case "raw-linux":
      return "allow-local";
    default:
      return "explicit-mounted-only";
  }
}

export function detectOpenReceivePlatform(
  env: Env = globalThis.process?.env ?? EMPTY_ENV
): OpenReceiveDetectedPlatform {
  const mk = (id: string, source: string): OpenReceiveDetectedPlatform => ({
    id,
    source,
    policy: policyForOpenReceivePlatform(id)
  });
  const override = env.OPENRECEIVE_PLATFORM?.trim().toLowerCase();
  if (override) return mk(override, "OPENRECEIVE_PLATFORM");

  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (nav?.userAgent === "Cloudflare-Workers") return mk("cloudflare-workers", "navigator.userAgent");
  if (env.CF_PAGES === "1") return mk("cloudflare-pages", "CF_PAGES");
  if (env.CLOUDFLARE_APPLICATION_ID || env.CLOUDFLARE_DURABLE_OBJECT_ID) return mk("cloudflare-containers", "CLOUDFLARE_*");
  if (env.VERCEL === "1") return mk("vercel", "VERCEL");
  if (env.DYNO) return mk("heroku", "DYNO");
  if (env.RENDER === "true") return mk("render", "RENDER");
  if (env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID) return mk("railway", "RAILWAY_*");
  if (env.FLY_APP_NAME || env.FLY_MACHINE_ID) return mk("fly", "FLY_*");
  if (env.NETLIFY === "true") return mk("netlify", "NETLIFY");
  if (env.K_SERVICE || env.K_REVISION || env.CLOUD_RUN_JOB) return mk("google-cloud-run", "K_SERVICE/K_REVISION/CLOUD_RUN_JOB");
  if (env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV?.startsWith("AWS_Lambda_")) return mk("aws-lambda", "AWS_LAMBDA_*");
  if (env.WEBSITE_SITE_NAME || env.WEBSITE_HOSTNAME) return mk("azure-app-service", "WEBSITE_*");
  if (env.KUBERNETES_SERVICE_HOST) return mk("kubernetes", "KUBERNETES_SERVICE_HOST");
  if (env.COOLIFY_RESOURCE_UUID || env.COOLIFY_CONTAINER_NAME) return mk("coolify", "COOLIFY_*");
  if (env.DOKKU_APP_NAME) return mk("dokku", "DOKKU_APP_NAME");
  if (env.CAPROVER_GIT_COMMIT_SHA) return mk("caprover", "CAPROVER_GIT_COMMIT_SHA");
  return {
    id: "unknown",
    source: "none",
    policy: "allow-local"
  };
}

export function classifyOpenReceiveStore(uri: string | undefined): OpenReceiveStoreKind {
  const storeUri = uri?.trim();
  if (storeUri === undefined || storeUri.length === 0) return "unset";
  if (storeUri === "local-sqlite") return "local-sqlite";
  if (storeUri.startsWith("sqlite:")) return "sqlite";
  if (/^postgres(?:ql)?:\/\//.test(storeUri)) return "postgres";
  if (/^redis(?:s)?:\/\//.test(storeUri)) return "redis";
  if (/^mysql:\/\//.test(storeUri)) return "mysql";
  return "other";
}

export function isOpenReceiveProductionEnv(env: Env = globalThis.process?.env ?? EMPTY_ENV): boolean {
  return ["NODE_ENV", "VERCEL_ENV", "RAILS_ENV", "RACK_ENV", "APP_ENV"]
    .some((key) => env[key] === "production");
}

export function sqlitePathFromUri(uri: string): string {
  if (uri.startsWith("sqlite:///")) return uri.slice("sqlite://".length);
  if (uri.startsWith("sqlite://")) return uri.slice("sqlite://".length);
  return uri.replace(/^sqlite:/, "");
}

export function isAbsoluteDurableSqlitePath(uri: string | undefined): boolean {
  if (uri === undefined) return false;
  const sqlitePath = sqlitePathFromUri(uri.trim());
  return path.isAbsolute(sqlitePath);
}

export function assertOpenReceiveStoreConfiguration(input: StoreConfigurationInput = {}): void {
  const env = input.env ?? globalThis.process?.env ?? EMPTY_ENV;
  const platform = detectOpenReceivePlatform(env);
  const detected = platform.id !== "unknown";

  if (input.store !== undefined) {
    if (!isOpenReceiveMemoryStore(input.store)) return;
    if (!detected && !isOpenReceiveProductionEnv(env)) return;
    throw unsafeMemoryStoreError(platform, detected);
  }

  const storeUri = input.storeUri;
  const kind = classifyOpenReceiveStore(storeUri);
  if (kind === "postgres") return;
  if (kind === "redis") throw unsupportedRedisStoreError(platform);
  if (kind === "mysql") throw storeNotImplementedError(platform, "MySQL");
  if (kind === "other") throw unsupportedStoreUriError(platform, storeUri);

  if (detected) {
    switch (platform.policy) {
      case "allow-local":
        return;
      case "explicit-mounted-only":
        if (kind === "sqlite" && isAbsoluteDurableSqlitePath(storeUri)) return;
        throw ephemeralStoreUnsafeError(platform, "mounted-sqlite");
      case "never":
        throw ephemeralStoreUnsafeError(platform, "postgres-only");
    }
  }

  if (!isOpenReceiveProductionEnv(env)) return;
  if (env.OPENRECEIVE_REQUIRE_EXPLICIT_STORE === "1") {
    throw storeMustBeExplicitError(platform);
  }

  emitProductionWarning(input.emitWarning, kind);
}

export function isOpenReceiveMemoryStore(store: unknown): boolean {
  if (store === undefined || store === null) return false;
  const candidate = store as { constructor?: { name?: string } };
  return candidate.constructor?.name === "InMemoryInvoiceKvStore";
}

function unsupportedRedisStoreError(platform: OpenReceiveDetectedPlatform): OpenReceiveConfigError {
  return new OpenReceiveConfigError({
    code: "UNSUPPORTED_STORE_REDIS",
    message: `${platformLine(platform)} Redis is not a supported OpenReceive store; its in-memory/eviction model is wrong for payment truth. Use Postgres.`,
    hint: `Redis is not a supported store; use Postgres. ${POSTGRES_STEP} ${DOCS_LINK}`
  });
}

function storeNotImplementedError(
  platform: OpenReceiveDetectedPlatform,
  storeName: string
): OpenReceiveConfigError {
  return new OpenReceiveConfigError({
    code: "STORE_NOT_IMPLEMENTED",
    message: `${platformLine(platform)} ${storeName} store URI support is not yet implemented in this package build.`,
    hint: `${POSTGRES_STEP} ${DOCS_LINK}`
  });
}

function unsupportedStoreUriError(
  platform: OpenReceiveDetectedPlatform,
  storeUri: string | undefined
): OpenReceiveConfigError {
  const normalized = storeUri?.trim();
  return new OpenReceiveConfigError({
    code: "UNSUPPORTED_STORE_URI",
    message: `${platformLine(platform)} Unsupported store URI: ${redactStoreUri(normalized ?? "")}.`,
    hint: `${POSTGRES_STEP} ${DOCS_LINK}`
  });
}

function unsafeMemoryStoreError(
  platform: OpenReceiveDetectedPlatform,
  detected: boolean
): OpenReceiveConfigError {
  const cause = detected
    ? "a platform signal means this is a deployed environment, and invoice state would be lost on restart or redeploy"
    : "production mode requires durable invoice storage, and invoice state would be lost on restart";
  return new OpenReceiveConfigError({
    code: "UNSAFE_MEMORY_STORE",
    message: `${platformLine(platform)} OpenReceive refuses to use InMemoryInvoiceKvStore: ${cause}.`,
    hint: `${POSTGRES_STEP} ${DOCS_LINK}`
  });
}

function ephemeralStoreUnsafeError(
  platform: OpenReceiveDetectedPlatform,
  mode: "postgres-only" | "mounted-sqlite"
): OpenReceiveConfigError {
  const postgresOnly = mode === "postgres-only";
  const cause = postgresOnly
    ? "this platform has no durable local filesystem; invoice state would be lost on the next deploy/cold start"
    : "implicit local SQLite is unsafe unless it points at a durable mounted volume for one running instance";
  return new OpenReceiveConfigError({
    code: "EPHEMERAL_STORE_UNSAFE",
    message: `${platformLine(platform)} OpenReceive refuses this SQLite/local store because ${cause}.`,
    hint: ephemeralHint(platform, postgresOnly)
  });
}

function storeMustBeExplicitError(platform: OpenReceiveDetectedPlatform): OpenReceiveConfigError {
  return new OpenReceiveConfigError({
    code: "STORE_MUST_BE_EXPLICIT",
    message: `${platformLine(platform)} OpenReceive is running in production without an explicit durable store; an undetected ephemeral host could lose invoice state on deploy/cold start.`,
    hint: `${POSTGRES_STEP} Or declare a known raw host with OPENRECEIVE_PLATFORM=vps, bare-metal, or raw-linux. ${DOCS_LINK}`
  });
}

function ephemeralHint(
  platform: OpenReceiveDetectedPlatform,
  postgresOnly: boolean
): string {
  const parts = [POSTGRES_STEP];
  if (platform.id === "vercel") {
    parts.push("On Vercel, install a Neon Postgres integration from the Vercel Marketplace and use the injected connection string; Vercel KV/Postgres are Marketplace provider-backed services such as Upstash/Neon.");
  }
  if (!postgresOnly) {
    parts.push(MOUNTED_SQLITE_STEP);
    parts.push("SQLite on a mounted volume is only for a single running instance.");
  }
  if (platform.id === "azure-app-service") {
    parts.push("Prefer Postgres on Azure App Service; /home is SMB-backed and SQLite over SMB can corrupt data.");
  }
  if (platform.source === "none" || platform.source === "DOKKU_APP_NAME" || platform.source === "CAPROVER_GIT_COMMIT_SHA") {
    parts.push("For weak/no-signal hosts, set OPENRECEIVE_PLATFORM=<id> to declare the platform.");
  }
  parts.push(DOCS_LINK);
  return parts.join(" ");
}

function platformLine(platform: OpenReceiveDetectedPlatform): string {
  return `Detected ${platform.id} via ${platform.source}.`;
}

function emitProductionWarning(
  emitWarning: StoreConfigurationInput["emitWarning"],
  kind: OpenReceiveStoreKind
): void {
  if (emitWarning === false) return;
  const warn = emitWarning ?? ((message: string) => console.warn(message));
  warn(
    `OPENRECEIVE WARNING: Detected unknown via none while production mode is enabled and the store is ${kind}. ` +
    "Implicit local SQLite is allowed only for a known durable single machine; an undetected ephemeral host could lose invoice state on deploy/cold start. " +
    `${POSTGRES_STEP} Or declare the host with OPENRECEIVE_PLATFORM=vps, bare-metal, or raw-linux. ${DOCS_LINK}`
  );
}

function redactStoreUri(uri: string): string {
  if (uri.length === 0) return "(empty)";
  try {
    const parsed = new URL(uri);
    if (parsed.password.length > 0) parsed.password = "REDACTED";
    return parsed.toString();
  } catch {
    return uri.length > 120 ? `${uri.slice(0, 117)}...` : uri;
  }
}
