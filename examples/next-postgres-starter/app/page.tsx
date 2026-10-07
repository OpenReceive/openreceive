import { product } from "@/lib/catalog";
import { buy } from "./actions";

export default function Home() {
  return (
    <main>
      <h1>{product.name}</h1>
      <p>
        ${product.price} {product.currency}, paid in bitcoin over Lightning, straight to the shop's
        wallet.
      </p>
      <form action={buy}>
        <button type="submit">Buy</button>
      </form>
    </main>
  );
}
