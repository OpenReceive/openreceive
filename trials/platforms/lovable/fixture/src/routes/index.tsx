import { createFileRoute } from "@tanstack/react-router";
import { listProducts } from "@/lib/shop.functions";

export const Route = createFileRoute("/")({
  loader: () => listProducts(),
  component: Home,
});

function Home() {
  const products = Route.useLoaderData();
  return (
    <main>
      <h1>Widget Shop</h1>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            {product.name}: {product.price} {product.currency}
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
