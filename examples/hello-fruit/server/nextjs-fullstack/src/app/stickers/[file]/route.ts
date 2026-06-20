import { readFileSync } from "node:fs";
import {
  helloFruitSharedFile
} from "../../../server/shared-data.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly file: string }> }
): Promise<Response> {
  const { file } = await context.params;
  if (!/^(apple|banana|orange|pear)\.svg$/.test(file)) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(readFileSync(helloFruitSharedFile(`stickers/${file}`)), {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "image/svg+xml"
    }
  });
}
