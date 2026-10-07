"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { product } from "@/lib/catalog";
import { db } from "@/lib/db";
import { VISITOR_COOKIE } from "@/lib/orders";

/** Creates the order first; its id is the OpenReceive reference. */
export async function buy(): Promise<void> {
  const jar = await cookies();
  let visitor = jar.get(VISITOR_COOKIE)?.value;
  if (!visitor) {
    visitor = randomUUID();
    jar.set(VISITOR_COOKIE, visitor, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  const id = randomUUID();
  await db().query(
    "INSERT INTO orders (id, visitor, product_name, amount, currency) VALUES ($1, $2, $3, $4, $5)",
    [id, visitor, product.name, product.price, product.currency],
  );
  redirect(`/checkout/${id}`);
}
