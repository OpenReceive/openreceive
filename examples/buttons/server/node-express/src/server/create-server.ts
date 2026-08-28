import type { Express } from "express";
import { createShopExpressApp } from "../../../../shared/server-node/express-app.ts";

/**
 * Express + React/Vue/Svelte/Angular. Public web shops want the per-IP invoice
 * cap; see the rate-limiting guide.
 */
export async function createButtonsExpressServer(): Promise<Express> {
  const { app } = await createShopExpressApp({ demoId: "node-express", rateLimiting: true });
  return app;
}
