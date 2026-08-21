import { createHostBrowserConsoleLogger } from "@openreceive/browser";

/** Host-app console logger for Hello Fruit browser UI (not OpenReceive checkout). */
export function createHelloFruitDemoBrowserConsoleLogger(demoId: string) {
  return createHostBrowserConsoleLogger({
    prefix: `hello-fruit:${demoId}:browser`,
  });
}
