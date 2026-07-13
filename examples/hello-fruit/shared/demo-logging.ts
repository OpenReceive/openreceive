import type { Logger } from "@openreceive/node";
import {
  createHostConsoleLogger,
  createOpenReceiveConsoleLogger,
} from "@openreceive/node";

export function createHelloFruitOpenReceiveLogger(demoId: string): Logger {
  return createOpenReceiveConsoleLogger({
    prefix: `openreceive:${demoId}`,
    minLevel: "info",
  });
}

export function createHelloFruitDemoServerLogger(demoId: string) {
  return createHostConsoleLogger({
    prefix: `hello-fruit:${demoId}:server`,
  });
}
