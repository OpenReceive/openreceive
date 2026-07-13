import CheckoutClient from "../../checkout-client.tsx";
import {
  readHelloFruitProduct,
  readHelloFruits,
} from "../../../server/shared-data.ts";

export default async function CheckoutPage({
  params,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
}) {
  const { orderId } = await params;
  const product = readHelloFruitProduct();
  const fruits = readHelloFruits();

  return (
    <main className="page min-h-screen grid justify-items-center content-start p-4 md:p-8 gap-3">
      <CheckoutClient product={product} fruits={fruits.fruits} resumeOrderId={orderId} />
    </main>
  );
}
