import { pathToFileURL } from "node:url";
import {
  mountShopDist,
  startShopServer,
} from "../../../../shared/server-node/production-server.ts";
import { createButtonsStaticServer } from "./create-server.ts";

export async function createButtonsStaticProductionServer() {
  return mountShopDist(await createButtonsStaticServer(), new URL("../../dist/", import.meta.url));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startShopServer(await createButtonsStaticProductionServer(), {
    name: "buttons-static-html-small-api",
    port: process.env.PORT,
  });
}
