import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createOrder, createUser, findProduct, findUser } from "../../lib/shop.js";

export const dynamic = "force-dynamic";

function userIdFrom(request) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const split = trimmed.indexOf("=");
    if (split === -1) continue;
    if (trimmed.slice(0, split) === "widget_user") return decodeURIComponent(trimmed.slice(split + 1));
  }
  return undefined;
}

export async function POST(request) {
  const form = await request.formData();
  const product = findProduct(Number(form.get("product_id")));
  if (!product) return new NextResponse("That product is not in the catalog.", { status: 404 });

  let userId = userIdFrom(request);
  let fresh = false;
  if (!userId || !findUser(userId)) {
    userId = randomUUID();
    createUser(userId);
    fresh = true;
  }
  const id = createOrder(userId, product);
  const response = NextResponse.redirect(new URL(`/orders/${id}`, request.url), 303);
  if (fresh) {
    response.cookies.set("widget_user", userId, { httpOnly: true, path: "/", sameSite: "lax" });
  }
  return response;
}
