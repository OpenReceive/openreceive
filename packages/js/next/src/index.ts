import type {
  DispatchOpenReceiveFetchHandlerOptions,
  DispatchOpenReceiveFetchNoWalletRouteOptions,
  DispatchOpenReceiveFetchRouteOptions,
  ExpressLikeHandler,
  OpenReceiveExpressHandlers,
  OpenReceiveExpressOptions,
  OpenReceiveFetchNoWalletOptions,
  OpenReceiveFetchRouteMatch,
  OpenReceiveFetchRuntime
} from "@openreceive/express";
import {
  formatOpenReceiveMissingNwcMessage
} from "@openreceive/core";
import {
  createOpenReceiveFetchInvoiceEventsResponse,
  createOpenReceiveFetchNoWalletResponse,
  createOpenReceiveFetchRouteNotFoundResponse,
  createOpenReceiveFetchRuntime,
  dispatchOpenReceiveFetchHandler,
  dispatchOpenReceiveFetchNoWalletRoute,
  dispatchOpenReceiveFetchRoute,
  matchOpenReceiveHttpRoute,
  openReceiveFetchJsonResponse
} from "@openreceive/express";

export type OpenReceiveNextRuntime = OpenReceiveFetchRuntime;

export interface CreateOpenReceiveNextRuntimeOptions
  extends OpenReceiveExpressOptions {}

export type OpenReceiveNextNoWalletOptions = OpenReceiveFetchNoWalletOptions;

export interface DispatchOpenReceiveNextHandlerOptions
  extends DispatchOpenReceiveFetchHandlerOptions {}

export interface DispatchOpenReceiveNextNoWalletHandlerOptions {
  readonly name: keyof OpenReceiveExpressHandlers;
  readonly noWallet?: OpenReceiveNextNoWalletOptions;
}

export type OpenReceiveNextRouteHandlerName = keyof OpenReceiveExpressHandlers;

export type OpenReceiveNextRouteMatch = OpenReceiveFetchRouteMatch;

export interface DispatchOpenReceiveNextRouteOptions
  extends DispatchOpenReceiveFetchRouteOptions {}

export interface DispatchOpenReceiveNextNoWalletRouteOptions
  extends DispatchOpenReceiveFetchNoWalletRouteOptions {}

export interface CreateOpenReceiveNextInvoiceEventsResponseOptions {
  readonly runtime: OpenReceiveNextRuntime;
  readonly request: Request;
  readonly invoiceId: string;
  readonly heartbeatMs?: number;
}

export const OPENRECEIVE_NEXT_DEFAULT_BASE_PATH = "/openreceive/v1";
export const OPENRECEIVE_NEXT_DEFAULT_NO_WALLET_MESSAGE =
  formatOpenReceiveMissingNwcMessage();
export const OPENRECEIVE_NEXT_DEFAULT_HEARTBEAT_MS = 20_000;

export function createOpenReceiveNextRuntime(
  options: CreateOpenReceiveNextRuntimeOptions
): OpenReceiveNextRuntime {
  return createOpenReceiveFetchRuntime(options);
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

export function createOpenReceiveNextInvoiceEventsResponse(
  options: CreateOpenReceiveNextInvoiceEventsResponseOptions
): Promise<Response> {
  return createOpenReceiveFetchInvoiceEventsResponse(options);
}

export function createOpenReceiveNextNoWalletResponse(
  name: keyof OpenReceiveExpressHandlers,
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
