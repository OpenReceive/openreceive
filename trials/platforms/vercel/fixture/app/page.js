import { listProducts } from "../lib/shop.js";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const products = await listProducts();
  return (
    <>
      <h1>Widget Shop</h1>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            {product.name} — ${product.price}
            <form method="post" action="/orders">
              <input type="hidden" name="product_id" value={product.id} />
              <button type="submit">Buy</button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
