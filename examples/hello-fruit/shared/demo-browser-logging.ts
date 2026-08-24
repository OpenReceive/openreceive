import { createAppBrowserConsoleLogger } from "@openreceive/browser";

/** Host-app console logger for Hello Fruit browser UI (not OpenReceive checkout). */
export function createHelloFruitDemoBrowserConsoleLogger(demoId: string) {
  return createAppBrowserConsoleLogger({
    prefix: `hello-fruit:${demoId}:browser`,
  });
}
