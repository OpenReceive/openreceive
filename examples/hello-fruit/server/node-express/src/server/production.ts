import { pathToFileURL } from "node:url";
import {
  mountHelloFruitDist,
  startHelloFruitServer,
} from "../../../../shared/production-server.ts";
import { createHelloFruitServer } from "./create-server.ts";

export async function createHelloFruitProductionServer() {
  return mountHelloFruitDist(
    await createHelloFruitServer(),
    new URL("../../dist/", import.meta.url),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHelloFruitServer(await createHelloFruitProductionServer(), {
    name: "hello-fruit-node-express",
    port: process.env.PORT,
  });
}
