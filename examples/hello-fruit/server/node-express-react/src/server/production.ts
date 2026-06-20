import { pathToFileURL } from "node:url";
import {
  mountHelloFruitDist,
  startHelloFruitServer
} from "../../../../shared/production-server.ts";
import { createHelloFruitServer } from "./create-server.ts";

export function createHelloFruitProductionServer() {
  return mountHelloFruitDist(
    createHelloFruitServer(),
    new URL("../../dist/", import.meta.url)
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startHelloFruitServer(createHelloFruitProductionServer(), {
    name: "hello-fruit-node-express-react",
    port: process.env.PORT
  });
}
