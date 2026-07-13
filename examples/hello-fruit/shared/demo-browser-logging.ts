import {
  createHostBrowserConsoleLogger,
  createOpenReceiveBrowserConsoleLogger,
  type OpenReceiveBrowserLogger,
} from "@openreceive/browser";

export function createHelloFruitBrowserLogger(demoId: string): OpenReceiveBrowserLogger {
  return createOpenReceiveBrowserConsoleLogger({
    prefix: `openreceive:${demoId}:client`,
  });
}

export function createHelloFruitDemoBrowserConsoleLogger(demoId: string) {
  return createHostBrowserConsoleLogger({
    prefix: `hello-fruit:${demoId}:browser`,
  });
}
