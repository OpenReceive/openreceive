import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { FastifyInstance } from "fastify";

/** Serve a built Vite bundle, with the SPA fallback under every other GET. */
export function mountShopDist(app: Express, staticRootUrl: URL): Express {
  const staticRoot = fileURLToPath(staticRootUrl);
  app.use(express.static(staticRoot));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    res.sendFile(path.join(staticRoot, "index.html"));
  });
  return app;
}

/**
 * The Fastify twin of `mountShopDist`: the built bundle from @fastify/static,
 * and index.html for every GET nothing else answered — `/checkout/:reference`
 * is the SPA, and a payer with a deposit in flight has to be able to reload it.
 *
 * `decorateReply: false` because the artwork mount in fastify-app.ts already
 * registered the plugin once and owns `reply.sendFile`.
 */
export async function mountShopDistFastify(
  app: FastifyInstance,
  staticRootUrl: URL,
): Promise<FastifyInstance> {
  const staticRoot = fileURLToPath(staticRootUrl);
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/", decorateReply: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Not found.", retryable: false });
    }
    return reply.sendFile("index.html", staticRoot);
  });
  return app;
}

export function startShopServer(
  app: Express,
  input: { readonly name: string; readonly port?: string | undefined },
): void {
  const port = parsePort(input.port);
  app.listen(port, "0.0.0.0", () => {
    console.log(`${input.name} listening on 0.0.0.0:${port}`);
  });
}

export async function startShopFastifyServer(
  app: FastifyInstance,
  input: { readonly name: string; readonly port?: string | undefined },
): Promise<void> {
  const port = parsePort(input.port);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`${input.name} listening on 0.0.0.0:${port}`);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 3000;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("PORT must be an integer from 1 to 65535");
  }
  return port;
}
