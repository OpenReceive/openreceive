/**
 * The engine's mount path is server-owned (config/routes.rb) and reaches the
 * client through the `#__app_bootstrap` blob, so the browser never keeps a
 * second copy that can drift from the route table.
 */
let mountPrefix = "";

export function setOpenReceivePrefix(prefix: string): void {
  mountPrefix = prefix.replace(/\/+$/, "");
}

export function openReceivePrefix(): string {
  if (mountPrefix === "") {
    throw new Error("OpenReceive mount path was not hydrated from #__app_bootstrap.");
  }
  return mountPrefix;
}

/** The engine's payment-status route; swap routes derive from its prefix. */
export function orderStatusUrl(): string {
  return `${openReceivePrefix()}/payments/check`;
}

/** Host-app routes. */
export const ORDERS_URL = "/orders";
export const RATES_URL = "/rates";
