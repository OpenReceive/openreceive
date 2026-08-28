import { pathToFileURL } from "node:url";
import {
  mountShopDist,
  startShopServer,
} from "../../../../shared/server-node/production-server.ts";
import { createButtonsExpressServer } from "./create-server.ts";

export async function createButtonsExpressProductionServer() {
  return mountShopDist(await createButtonsExpressServer(), new URL("../../dist/", import.meta.url));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startShopServer(await createButtonsExpressProductionServer(), {
    name: "buttons-node-express",
    port: process.env.PORT,
  });
}
