import { randomUUID } from "node:crypto";
import { redirect } from "react-router";
import { widgetUser } from "~/cookies.server";
import { createOrder, createUser, currentUserId, findProduct } from "~/shop.server";
import type { Route } from "./+types/orders";

// A resource route: the home page's Buy forms post here, and the buyer goes
// on to the order's own page.
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const productId = Number(form.get("product_id"));
  const product = Number.isSafeInteger(productId) ? await findProduct(productId) : undefined;
  if (!product) return new Response("That product is not in the catalog.", { status: 404 });

  const headers = new Headers();
  let userId = await currentUserId(request);
  if (!userId) {
    userId = randomUUID();
    await createUser(userId);
    headers.append("Set-Cookie", await widgetUser.serialize(userId));
  }
  const id = await createOrder(userId, product);
  return redirect(`/orders/${id}`, { status: 303, headers });
}
