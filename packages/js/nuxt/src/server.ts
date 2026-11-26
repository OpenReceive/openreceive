import type {
  AuthorizeContext,
  CreateStackOptions,
  IpRateLimitConfig,
  StackWallet,
} from "@openreceive/http";
import type { H3Event } from "h3";

// @openreceive/nuxt/server — what the app's server/openreceive.ts imports.
// It holds no payment logic: the module's route builds one @openreceive/http
// stack from this config on the first request, passes it the request's
// H3Event as `native`, and returns the Response it answers with.
//
// tools/validate/check-public-api.mjs pins this surface.

export * from "@openreceive/http/adapter-surface";

/** `AuthorizeContext` with `native` typed as the request's `H3Event`. */
export interface NuxtAuthorizeContext extends AuthorizeContext {
  readonly native: H3Event;
}

/** `rateLimiting`, with `ip` reading the `H3Event` when you replace it. */
export interface NuxtIpRateLimitConfig extends Omit<IpRateLimitConfig, "ip"> {
  readonly ip?: (context: NuxtAuthorizeContext) => string | undefined;
}

/**
 * The host's half of the integration: the three hooks and the database
 * handle, as `createStack` takes them. The module supplies the rest:
 * `prefix` comes from `openreceive.prefix` in nuxt.config, and the wallet
 * from `NWC_URI` (with `LSC_URI_PRIMARY` / `LSC_URI_BACKUP` for swaps), read
 * from `process.env` when the first request arrives.
 */
export interface OpenReceiveNuxtConfig<Transaction = unknown>
  extends Omit<
    CreateStackOptions<Transaction>,
    "wallet" | "prefix" | "authorize" | "rateLimiting" | "rateLimitHook"
  > {
  /** Defaults to `{ nwc: process.env.NWC_URI }`, read on the first request. */
  readonly wallet?: StackWallet;
  /** Return `true` to allow, `false` for 403. `native` is the request's `H3Event`. */
  readonly authorize: (context: NuxtAuthorizeContext) => boolean | Promise<boolean>;
  /**
   * The per-IP limit on new invoices, off by default (`true` for 60 an hour).
   * The client IP is the socket address, unless `trustProxyIpHeader` names a
   * header your own reverse proxy sets.
   */
  readonly rateLimiting?: boolean | NuxtIpRateLimitConfig;
  /** Your own limiter in place of `rateLimiting`. */
  readonly rateLimitHook?: (context: NuxtAuthorizeContext) => boolean | Promise<boolean>;
  /**
   * Read the client IP from a header instead of the socket: `true` for the
   * first address in `x-forwarded-for`, or another header's name. Only behind
   * a reverse proxy of your own that sets it: a client can send any header.
   */
  readonly trustProxyIpHeader?: boolean | string;
}

/**
 * The default export of `server/openreceive.ts`. It returns the config as it
 * is; it exists for the types, so `native` is an `H3Event` in your hooks.
 */
export function defineOpenReceive<Transaction = unknown>(
  config: OpenReceiveNuxtConfig<Transaction>,
): OpenReceiveNuxtConfig<Transaction> {
  return config;
}
