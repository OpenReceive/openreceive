import { listProducts } from "~/shop.server";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Widget Shop" }];
}

export async function loader() {
  return { products: await listProducts() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Widget Shop</h1>
      <ul>
        {loaderData.products.map((product) => (
          <li key={product.id}>
            {`${product.name} — $${product.price}`}
            <form method="post" action="/orders">
              <input type="hidden" name="product_id" value={product.id} />
              <button type="submit">Buy</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
