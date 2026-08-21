import { createHostConsoleLogger } from "@openreceive/node";

/** Host-app console logger for Hello Fruit server routes (not OpenReceive itself). */
export function createHelloFruitDemoServerLogger(demoId: string) {
  return createHostConsoleLogger({
    prefix: `hello-fruit:${demoId}:server`,
  });
}
