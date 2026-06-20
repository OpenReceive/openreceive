import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response
} from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function mountHelloFruitDist(
  app: Express,
  staticRootUrl: URL
): Express {
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

export function startHelloFruitServer(
  app: Express,
  input: {
    readonly name: string;
    readonly port?: string | undefined;
  }
): void {
  const port = parsePort(input.port);
  app.listen(port, "0.0.0.0", () => {
    console.log(`${input.name} listening on 0.0.0.0:${port}`);
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 3000;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("PORT must be an integer from 1 to 65535");
  }
  return port;
}
