import CheckoutClient from "./checkout-client.tsx";
import {
  readHelloFruitProduct,
  readHelloFruits
} from "../server/shared-data.ts";

export default function Page() {
  const product = readHelloFruitProduct();
  const fruits = readHelloFruits();

  return (
    <main className="page min-h-screen grid justify-items-center content-start p-4 md:p-10 gap-4">
      <CheckoutClient product={product} fruits={fruits.fruits} />
    </main>
  );
}
