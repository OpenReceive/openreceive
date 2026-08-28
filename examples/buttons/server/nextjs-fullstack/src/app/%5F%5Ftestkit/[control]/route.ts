import { testkitControl } from "../../../../../../shared/server-node/testkit-controls.ts";
import { testkitFixtures } from "../../../server/shop.ts";

/**
 * The testkit control surface, as an app-router route.
 *
 * THE DIRECTORY NAME IS NOT A TYPO. The App Router treats a folder starting
 * with `_` as PRIVATE and excludes it from routing, so `__testkit/` would
 * silently never register and every control call would fall through to the
 * page. `%5F` is Next's documented escape for a literal underscore, and the
 * URL it serves is plain `/__testkit/...` — the same path the Express stacks
 * mount, which is the point.
 *
 * The behaviour is `testkitControl` in shared/server-node — the same function
 * the Express stacks mount — so the harness can drive any Node stack rather
 * than only the one whose glue happened to be written. Outside testkit wallet
 * mode `testkitFixtures()` is undefined and every action here is a 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ control: string }> }) {
  const { control } = await context.params;
  const body = await request.json().catch(() => undefined);
  const result = testkitControl(control, body, await testkitFixtures());
  return new Response(JSON.stringify(result.json), {
    status: result.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export { handle as GET, handle as POST };
