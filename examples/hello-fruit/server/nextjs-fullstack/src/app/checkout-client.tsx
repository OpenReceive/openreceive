"use client";

import type React from "react";
import { useCallback } from "react";
import { Checkout } from "@openreceive/react";
import { useRouter } from "next/navigation";
import type { HelloFruit, HelloFruitProduct } from "../server/shared-data.ts";
import { createHelloFruitDemoBrowserConsoleLogger } from "../../../../shared/demo-browser-logging.ts";
import { helloFruitCheckoutPath } from "../../../../shared/demo-checkout-resume.ts";
import {
  HelloFruitShopApp,
  type HelloFruitShopCheckoutSlotProps,
} from "../../../../shared/demo-shop-app.tsx";

const logDemo = createHelloFruitDemoBrowserConsoleLogger("nextjs-fullstack");

interface CheckoutClientProps {
  readonly product: HelloFruitProduct;
  readonly fruits: readonly HelloFruit[];
  /** When set (from `/checkout/[orderId]`), restore that guest checkout instead of the shop. */
  readonly resumeOrderId?: string;
}

/**
 * Thin Next.js host around the shared Hello Fruit shop UI: the app router owns
 * navigation, and the plain React `<Checkout>` owns payment creation/polling.
 */
export default function CheckoutClient({ product, fruits, resumeOrderId }: CheckoutClientProps) {
  const router = useRouter();

  const onEnterCheckout = useCallback(
    (orderId: string): void => {
      router.push(helloFruitCheckoutPath(orderId));
    },
    [router],
  );

  const onExitCheckout = useCallback(
    (options?: { readonly replace?: boolean }): void => {
      if (options?.replace === true) {
        router.replace("/");
        return;
      }
      router.push("/");
    },
    [router],
  );

  const renderCheckout = useCallback(
    (slot: HelloFruitShopCheckoutSlotProps): React.ReactElement => (
      <Checkout className="demo-checkout" {...slot} />
    ),
    [],
  );

  return (
    <HelloFruitShopApp
      logDemo={logDemo}
      product={product}
      fruits={fruits}
      resumeOrderId={resumeOrderId}
      onEnterCheckout={onEnterCheckout}
      onExitCheckout={onExitCheckout}
      renderCheckout={renderCheckout}
    />
  );
}
