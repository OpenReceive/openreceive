import type { Express } from "express";
import { createHelloFruitExpressApp } from "../../../../shared/demo-express-app.ts";

/**
 * Express + React/Vue/Svelte/Angular demo. Public web shops want the per-IP
 * invoice cap; see the rate-limiting guide.
 */
export async function createHelloFruitServer(): Promise<Express> {
  return createHelloFruitExpressApp({ demoId: "node-express", rateLimiting: true });
}
