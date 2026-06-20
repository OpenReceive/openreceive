import { pathToFileURL } from "node:url";
import {
  mountHelloFruitDist,
  startHelloFruitServer
} from "../../../../shared/production-server.ts";
import { createHelloFruitStaticServer } from "./create-server.ts";

export function createHelloFruitStaticProductionServer() {
  return mountHelloFruitDist(
    createHelloFruitStaticServer(),
    new URL("../../dist/", import.meta.url)
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startHelloFruitServer(createHelloFruitStaticProductionServer(), {
    name: "hello-fruit-static-html-small-api",
    port: process.env.PORT
  });
}
