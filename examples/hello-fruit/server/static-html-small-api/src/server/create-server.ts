import type { Express } from "express";
import { createHelloFruitExpressApp } from "../../../../shared/demo-express-app.ts";

/**
 * Static HTML + small API demo. Rate limiting stays off in this minimal
 * variant; the express demo and the rate-limiting guide show it enabled.
 */
export async function createHelloFruitStaticServer(): Promise<Express> {
  return createHelloFruitExpressApp({
    demoId: "static-html-small-api",
    rateLimiting: false,
  });
}
