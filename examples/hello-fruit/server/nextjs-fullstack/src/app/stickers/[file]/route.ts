import { readFileSync } from "node:fs";
import path from "node:path";
import { helloFruitSharedFile, readHelloFruits } from "../../../server/shared-data.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Only files the catalog actually points at are public — never a name pattern. */
function catalogStickerFiles(): ReadonlySet<string> {
  return new Set(readHelloFruits().fruits.map((fruit) => path.basename(fruit.sticker)));
}

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly file: string }> },
): Promise<Response> {
  const { file } = await context.params;
  if (!catalogStickerFiles().has(file)) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(readFileSync(helloFruitSharedFile(`stickers/${file}`)), {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "image/svg+xml",
    },
  });
}
