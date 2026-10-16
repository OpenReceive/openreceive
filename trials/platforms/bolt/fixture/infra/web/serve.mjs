// Bolt's hosting, in miniature: the built site from dist/, any unknown path
// answered with index.html so the app's routes load, and GET /health.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve("dist");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

http
  .createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://shop").pathname);
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end("ok\n");
    }
    let file = path.join(root, pathname);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      file = path.join(root, "index.html");
    }
    response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  })
  .listen(3000, "0.0.0.0");
