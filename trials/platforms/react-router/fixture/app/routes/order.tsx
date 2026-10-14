import { data } from "react-router";
import { currentUserId, findOrder } from "~/shop.server";
import type { Route } from "./+types/order";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `Order ${loaderData.order.id} — Widget Shop` : "Widget Shop" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const userId = await currentUserId(request);
  const id = Number(params.id);
  const order = userId && Number.isSafeInteger(id) ? await findOrder(id, userId) : undefined;
  if (!order) throw data("That order is not yours.", { status: 404 });
  return { order };
}

export default function OrderPage({ loaderData: { order } }: Route.ComponentProps) {
  return (
    <main>
      <h1>{`Order ${order.id}`}</h1>
      <p>{`${order.product_name} — $${order.amount} ${order.currency}`}</p>
      {order.status === "paid" ? (
        <p>Paid.</p>
      ) : (
        <p>Awaiting payment. Online payments are not set up yet.</p>
      )}
    </main>
  );
}
