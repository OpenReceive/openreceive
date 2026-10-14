import { shopReady } from "~/shop.server";

// A resource route: it answers once the database is reachable and the shop's
// tables are in place.
export async function loader() {
  await shopReady();
  return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
}
