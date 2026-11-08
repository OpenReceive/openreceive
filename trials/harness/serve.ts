import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ServedDirectory {
  readonly base: string;
  fileUrl: (name: string) => string;
  close: () => Promise<void>;
}

/** The directions as a tool that shows `bytes` of output leaves them: whole lines, then a marker. */
export function cutDirections(body: Buffer, bytes: number): Buffer {
  if (body.length <= bytes) return body;
  const end = body.lastIndexOf(10, bytes);
  return Buffer.concat([
    body.subarray(0, end + 1),
    Buffer.from(`\n[output truncated: showing the first ${end + 1} of ${body.length} bytes]\n`),
  ]);
}

/**
 * Serve the working tree's directions on 127.0.0.1. The agent fetches them by
 * URL. `?cut=<bytes>` answers the way a tool that truncates output would.
 */
export async function serveDirectory(directory: string): Promise<ServedDirectory> {
  const root = path.resolve(directory);
  const server: Server = createServer((request, response) => {
    const [rawPath, query] = (request.url ?? "/").split("?");
    const pathname = decodeURIComponent(rawPath ?? "/");
    const cut = Number(new URLSearchParams(query).get("cut") ?? "0");
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${path.sep}`) || !file.endsWith(".md")) {
      response.writeHead(404);
      response.end();
      return;
    }
    void readFile(file)
      .then((body) => {
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        response.end(cut > 0 ? cutDirections(body, cut) : body);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The directions server did not bind a port.");
  }
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    fileUrl: (name: string) => `${base}/${name}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
