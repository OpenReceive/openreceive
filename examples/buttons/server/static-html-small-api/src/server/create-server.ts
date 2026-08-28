import type { Express } from "express";
import { createShopExpressApp } from "../../../../shared/server-node/express-app.ts";

/**
 * Static HTML + a small API. Rate limiting stays off in this minimal variant;
 * the Express demo and the rate-limiting guide show it enabled.
 */
export async function createButtonsStaticServer(): Promise<Express> {
  const { app } = await createShopExpressApp({
    demoId: "static-html-small-api",
    rateLimiting: false,
  });
  return app;
}
