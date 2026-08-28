import { createAppConsoleLogger } from "@openreceive/node";

/** Host-app console logger for the shop's own server routes (not OpenReceive itself). */
export function createShopServerLogger(demoId: string) {
  return createAppConsoleLogger({ prefix: `buttons:${demoId}:server` });
}
