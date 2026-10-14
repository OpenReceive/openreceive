import { randomUUID } from "node:crypto";
import type { APIRoute } from "astro";
import { createOrder, createUser, findProduct, userExists } from "../../lib/shop";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const product = await findProduct(Number(form.get("product_id")));
  if (!product) return new Response("That product is not in the catalog.", { status: 404 });

  let userId = cookies.get("widget_user")?.value;
  if (!userId || !(await userExists(userId))) {
    userId = randomUUID();
    await createUser(userId);
    cookies.set("widget_user", userId, { httpOnly: true, path: "/", sameSite: "lax" });
  }
  const id = await createOrder(userId, product);
  // A relative Location: without security.allowedDomains, Astro builds
  // request.url from localhost and the container port, not the buyer's host.
  return redirect(`/orders/${id}`, 303);
};
