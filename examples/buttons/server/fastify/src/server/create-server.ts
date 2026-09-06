import type { FastifyInstance } from "fastify";
import { createShopFastifyApp } from "../../../../shared/server-node/fastify-app.ts";

/**
 * Fastify + React. Public web shops want the per-IP invoice cap; see the
 * rate-limiting guide. `trustProxy` on the instance (in fastify-app.ts) is
 * what makes that cap count the payer behind a reverse proxy.
 */
export async function createButtonsFastifyServer(): Promise<FastifyInstance> {
  const { app } = await createShopFastifyApp({ demoId: "fastify", rateLimiting: true });
  return app;
}
