import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { shopArtworkDir } from "../../../../../../shared/server-node/shop-routes.ts";

/**
 * The catalog thumbnails, from examples/buttons/images — the one copy every
 * stack reads. A route rather than a `public/` folder because copying the six
 * files into this stack is exactly what the shared layout exists to prevent.
 *
 * PUBLIC, and only public. The purchased DOWNLOAD is a different route,
 * gated on the paid order row.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await context.params;
  // `basename` because this segment is whatever the browser asked for: it must
  // not be able to walk out of the artwork directory.
  const filePath = path.join(shopArtworkDir, path.basename(file));
  if (!filePath.endsWith(".webp") || !existsSync(filePath)) {
    return new Response("Not found.", { status: 404 });
  }

  return new Response(new Uint8Array(readFileSync(filePath)), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
