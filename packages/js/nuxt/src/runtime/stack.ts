import {
  type AuthorizeContext,
  type CreateStackOptions,
  createProxyRateLimitingConfig,
  createStack,
  type IpRateLimitConfig,
  type Stack,
} from "@openreceive/http";
import { type H3Event, getRequestIP, toWebRequest } from "h3";
import type { OpenReceiveNuxtConfig } from "../server.ts";

/** What the module bakes into the route at build time. */
export interface OpenReceiveNuxtRouteOptions {
  readonly prefix: string;
}

type EventHandler = (event: H3Event) => Promise<Response>;

/** The socket address h3 sees for this request. */
function socketIp(context: AuthorizeContext): string | undefined {
  return getRequestIP(context.native as H3Event) ?? undefined;
}

/**
 * `rateLimiting` with a client IP source. The h3 event has the socket, so a
 * limiter on with no `ip` of its own counts the socket address; a trusted
 * proxy header replaces it.
 */
function rateLimitingFor(config: OpenReceiveNuxtConfig): Pick<CreateStackOptions, "rateLimiting"> {
  const rateLimiting = config.rateLimiting as boolean | IpRateLimitConfig | undefined;
  if (rateLimiting === undefined || rateLimiting === false) {
    return rateLimiting === false ? { rateLimiting } : {};
  }
  if (config.trustProxyIpHeader !== undefined && config.trustProxyIpHeader !== false) {
    return createProxyRateLimitingConfig(rateLimiting, config.trustProxyIpHeader);
  }
  const limits = rateLimiting === true ? {} : rateLimiting;
  return { rateLimiting: { ...limits, ip: limits.ip ?? socketIp } };
}

/** The stack options for one config: the host's hooks, the module's prefix, the env wallet. */
export function stackOptions(
  config: OpenReceiveNuxtConfig,
  route: OpenReceiveNuxtRouteOptions,
  env: NodeJS.ProcessEnv = process.env,
): CreateStackOptions {
  const { trustProxyIpHeader: _header, rateLimiting: _limits, wallet, ...hooks } = config;
  return {
    ...(hooks as Omit<CreateStackOptions, "wallet" | "prefix">),
    ...rateLimitingFor(config),
    wallet: wallet ?? { nwc: env.NWC_URI ?? "" },
    prefix: route.prefix,
  };
}

/**
 * The route's event handler. The stack is built on the first request, never
 * at import, so `nuxt build` and prerendering never connect to the wallet.
 * One stack serves the whole server process.
 */
export function createOpenReceiveEventHandler(
  config: OpenReceiveNuxtConfig,
  route: OpenReceiveNuxtRouteOptions,
): EventHandler & { readonly stack: () => Stack | undefined } {
  let stack: Stack | undefined;
  const handler = (event: H3Event): Promise<Response> => {
    stack ??= createStack(stackOptions(config, route));
    return stack.handler(toWebRequest(event), { native: event });
  };
  return Object.assign(handler, { stack: () => stack });
}
