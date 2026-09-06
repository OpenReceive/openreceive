import { pathToFileURL } from "node:url";
import {
  mountShopDistFastify,
  startShopFastifyServer,
} from "../../../../shared/server-node/production-server.ts";
import { createButtonsFastifyServer } from "./create-server.ts";

export async function createButtonsFastifyProductionServer() {
  return mountShopDistFastify(
    await createButtonsFastifyServer(),
    new URL("../../dist/", import.meta.url),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startShopFastifyServer(await createButtonsFastifyProductionServer(), {
    name: "buttons-fastify",
    port: process.env.PORT,
  });
}
