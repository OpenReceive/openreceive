import CheckoutClient from "./checkout-client.tsx";
import { readHelloFruitProduct, readHelloFruits } from "../server/shared-data.ts";

export default function Page() {
  const product = readHelloFruitProduct();
  const fruits = readHelloFruits();

  // The shared shop UI renders its own themed `main.page` wrapper.
  return <CheckoutClient product={product} fruits={fruits.fruits} />;
}
