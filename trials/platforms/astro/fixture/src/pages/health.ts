import type { APIRoute } from "astro";
import { ready } from "../lib/db";

export const prerender = false;

/** Answers once the database is reachable and the shop's tables exist. */
export const GET: APIRoute = async () => {
  await ready();
  return new Response("ok\n", { headers: { "content-type": "text/plain" } });
};
