import CheckoutClient from "./checkout-client.tsx";
import {
  readHelloFruitProduct,
  readHelloFruits
} from "../server/shared-data.ts";

export default function Page() {
  const product = readHelloFruitProduct();
  const fruits = readHelloFruits();

  return (
    <main className="page">
      <CheckoutClient product={product} fruits={fruits.fruits} />
    </main>
  );
}
