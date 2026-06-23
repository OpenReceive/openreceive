import type {
  DispatchOpenReceiveFetchHandlerOptions,
  DispatchOpenReceiveFetchNoWalletRouteOptions,
  DispatchOpenReceiveFetchRouteOptions,
  ExpressLikeHandler,
  OpenReceiveNodeHandlers,
  OpenReceiveNodeOptions,
  OpenReceiveFetchNoWalletOptions,
  OpenReceiveFetchRouteMatch,
  OpenReceiveNodeRuntime
} from "@openreceive/node";
import {
  formatOpenReceiveMissingNwcMessage
} from "@openreceive/core";
import {
  createOpenReceiveFetchNoWalletResponse,
  createOpenReceiveFetchRouteNotFoundResponse,
  createOpenReceiveNodeRuntime,
  dispatchOpenReceiveFetchHandler,
  dispatchOpenReceiveFetchNoWalletRoute,
  dispatchOpenReceiveFetchRoute,
  matchOpenReceiveHttpRoute,
  openReceiveFetchJsonResponse
} from "@openreceive/node";

export type OpenReceiveNextRuntime = OpenReceiveNodeRuntime;

export interface CreateOpenReceiveNextRuntimeOptions
  extends OpenReceiveNodeOptions {}

export type OpenReceiveNextNoWalletOptions = OpenReceiveFetchNoWalletOptions;

export interface DispatchOpenReceiveNextHandlerOptions
  extends DispatchOpenReceiveFetchHandlerOptions {}

export interface DispatchOpenReceiveNextNoWalletHandlerOptions {
  readonly name: keyof OpenReceiveNodeHandlers;
  readonly noWallet?: OpenReceiveNextNoWalletOptions;
}

export type OpenReceiveNextRouteHandlerName = keyof OpenReceiveNodeHandlers;

export type OpenReceiveNextRouteMatch = OpenReceiveFetchRouteMatch;

export interface DispatchOpenReceiveNextRouteOptions
  extends DispatchOpenReceiveFetchRouteOptions {}

export interface DispatchOpenReceiveNextNoWalletRouteOptions
  extends DispatchOpenReceiveFetchNoWalletRouteOptions {}

export const OPENRECEIVE_NEXT_DEFAULT_BASE_PATH = "/openreceive/v1";
export const OPENRECEIVE_NEXT_DEFAULT_NO_WALLET_MESSAGE =
  formatOpenReceiveMissingNwcMessage();

export function createOpenReceiveNextRuntime(
  options: CreateOpenReceiveNextRuntimeOptions
): OpenReceiveNextRuntime {
  return createOpenReceiveNodeRuntime(options);
}

export function dispatchOpenReceiveNextRoute(
  options: DispatchOpenReceiveNextRouteOptions
): Promise<Response> {
  return dispatchOpenReceiveFetchRoute(options);
}

export function dispatchOpenReceiveNextNoWalletRoute(
  options: DispatchOpenReceiveNextNoWalletRouteOptions
): Response {
  return dispatchOpenReceiveFetchNoWalletRoute(options);
}

export function matchOpenReceiveNextRoute(
  method: string,
  path: readonly string[]
): OpenReceiveNextRouteMatch | undefined {
  return matchOpenReceiveHttpRoute(method, path);
}

export function dispatchOpenReceiveNextHandler(
  options: DispatchOpenReceiveNextHandlerOptions
): Promise<Response> {
  return dispatchOpenReceiveFetchHandler(options);
}

export function dispatchOpenReceiveNextNoWalletHandler(
  options: DispatchOpenReceiveNextNoWalletHandlerOptions
): Response {
  return createOpenReceiveFetchNoWalletResponse(options.name, options.noWallet);
}

export function createOpenReceiveNextNoWalletResponse(
  name: keyof OpenReceiveNodeHandlers,
  options: OpenReceiveNextNoWalletOptions = {}
): Response {
  return createOpenReceiveFetchNoWalletResponse(name, options);
}

export function openReceiveNextJsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return openReceiveFetchJsonResponse(body, status, headers);
}

export function openReceiveNextRouteNotFoundResponse(): Response {
  return createOpenReceiveFetchRouteNotFoundResponse();
}

export type {
  ExpressLikeHandler
};
